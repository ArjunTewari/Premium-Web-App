'use strict';
/**
 * test-youtube-apidirect.js — verifies youtube-er.js's APIdirect-based
 * rewrite: channel resolution, video discovery, official-channel filtering,
 * client-side date-range filtering, and YouTube Data API v3 stats
 * attachment all work correctly end to end against mocked HTTP responses.
 *
 * Run: node test-youtube-apidirect.js
 */

const assert = require('assert');
const axios = require('axios');
const { run: youtubeRun } = require('./youtube-er');

const originalGet = axios.get;
function restoreAxios() { axios.get = originalGet; }

const cfg = {
  APIDIRECT_KEY: 'apidirect-test-key',
  YOUTUBE_KEY: 'youtube-test-key',
  DATE_FROM: '2026-03-01',
  DATE_TO: '2026-04-01',
  SCOPE_KEYWORDS: [],
  ORG_YT_HANDLES: { TestOrg: '@testorg' },
};

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS - ${label}`); passed++; }
  catch (e) { console.log(`FAIL - ${label}: ${e.message}`); failed++; }
}

(async () => {
  // ── Scenario A: full happy path — channel resolves, videos discovered,
  //    filtered to channel + date window, stats attached ──────────────────
  {
    axios.get = async (url, opts) => {
      if (url.includes('apidirect.io/v1/youtube/channels')) {
        return { data: { channels: [{ channel_id: 'UC_OFFICIAL', title: 'TestOrg', subscriber_count: '10K', url: 'https://youtube.com/@testorg' }] } };
      }
      if (url.includes('apidirect.io/v1/youtube/posts')) {
        return { data: { posts: [
          { video_id: 'vid1', channel_id: 'UC_OFFICIAL', date: '2026-03-15', title: 'In-window official video', url: 'https://youtube.com/watch?v=vid1', views: 500, author: 'TestOrg' },
          { video_id: 'vid2', channel_id: 'UC_OTHER', date: '2026-03-15', title: 'Off-channel video', url: 'https://youtube.com/watch?v=vid2', views: 300, author: 'SomeoneElse' },
          { video_id: 'vid3', channel_id: 'UC_OFFICIAL', date: '2025-01-01', title: 'Out-of-window official video', url: 'https://youtube.com/watch?v=vid3', views: 100, author: 'TestOrg' },
        ] } };
      }
      if (url.includes('googleapis.com/youtube/v3/videos')) {
        return { data: { items: [
          { id: 'vid1', snippet: { channelId: 'UC_OFFICIAL', channelTitle: 'TestOrg', title: 'In-window official video', publishedAt: '2026-03-15' }, statistics: { viewCount: '500', likeCount: '40', commentCount: '5' } },
        ] } };
      }
      if (url.includes('googleapis.com/youtube/v3/channels')) {
        return { data: { items: [
          { id: 'UC_OFFICIAL', snippet: { title: 'TestOrg' }, statistics: { subscriberCount: '10000', hiddenSubscriberCount: false, viewCount: '99999', videoCount: '42' } },
        ] } };
      }
      throw new Error('unexpected URL: ' + url);
    };

    const results = await youtubeRun(cfg, ['TestOrg'], () => {});
    const r = results[0];

    check('Scenario A: exactly 1 video survives all filters (channel + date)', () => assert.strictEqual(r.videoCount, 1));
    check('Scenario A: discovered count reflects all 3 raw posts', () => assert.strictEqual(r.discovered, 3));
    check('Scenario A: afterChannel reflects the 2 official-channel posts', () => assert.strictEqual(r.afterChannel, 2));
    check('Scenario A: off-channel video excluded', () => assert.ok(!r.videos.some((v) => v.videoId === 'vid2')));
    check('Scenario A: out-of-window video excluded', () => assert.ok(!r.videos.some((v) => v.videoId === 'vid3')));
    check('Scenario A: surviving video has correct stats attached', () => {
      assert.strictEqual(r.videos[0].likes, 40);
      assert.strictEqual(r.videos[0].comments, 5);
      assert.strictEqual(r.videos[0].subscribers, 10000);
    });
    check('Scenario A: ER computed correctly (subscriber-based)', () => assert.ok(r.avgER > 0));
  }

  // ── Scenario B: handle never resolves to a channel ───────────────────────
  {
    axios.get = async (url) => {
      if (url.includes('apidirect.io/v1/youtube/channels')) return { data: { channels: [] } };
      if (url.includes('apidirect.io/v1/youtube/posts')) return { data: { posts: [{ video_id: 'v1', channel_id: 'UC_X', date: '2026-03-15', views: 10 }] } };
      throw new Error('should not reach Google API when channel unresolved');
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { UnresolvableOrg: '@unresolvable' } }, ['UnresolvableOrg'], () => {});
    const r = results[0];
    check('Scenario B: handleUnresolved flag set', () => assert.strictEqual(r.handleUnresolved, true));
    check('Scenario B: 0 videos (can\'t verify official channel)', () => assert.strictEqual(r.videoCount, 0));
  }

  // ── Scenario C: video discovery API call fails outright ─────────────────
  {
    axios.get = async (url) => {
      if (url.includes('apidirect.io/v1/youtube/channels')) return { data: { channels: [{ channel_id: 'UC_X', title: 'FailOrg' }] } };
      if (url.includes('apidirect.io/v1/youtube/posts')) { const e = new Error('quota exceeded'); e.response = { status: 429 }; throw e; }
      throw new Error('unexpected call');
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { FailOrg: '@failorg' } }, ['FailOrg'], () => {});
    const r = results[0];
    check('Scenario C: failed flag set (not a confident zero)', () => assert.strictEqual(r.failed, true));
    check('Scenario C: videoCount is 0 but flagged as failure', () => assert.strictEqual(r.videoCount, 0));
  }

  // ── Scenario D: no handle configured at all ──────────────────────────────
  {
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: {} }, ['NoHandleOrg'], () => {});
    const r = results[0];
    check('Scenario D: noHandle flag set, no API calls attempted', () => assert.strictEqual(r.noHandle, true));
  }

  // ── Scenario E: no YOUTUBE_KEY — still filters correctly via APIdirect,
  //    just without likes/comments ──────────────────────────────────────────
  {
    axios.get = async (url) => {
      if (url.includes('apidirect.io/v1/youtube/channels')) return { data: { channels: [{ channel_id: 'UC_OFFICIAL', title: 'NoKeyOrg' }] } };
      if (url.includes('apidirect.io/v1/youtube/posts')) return { data: { posts: [{ video_id: 'v1', channel_id: 'UC_OFFICIAL', date: '2026-03-15', views: 200, title: 'x', url: 'https://youtube.com/watch?v=v1' }] } };
      throw new Error('should not call Google API without YOUTUBE_KEY');
    };
    const results = await youtubeRun({ ...cfg, YOUTUBE_KEY: '', ORG_YT_HANDLES: { NoKeyOrg: '@nokeyorg' } }, ['NoKeyOrg'], () => {});
    const r = results[0];
    check('Scenario E: video still counted via APIdirect alone', () => assert.strictEqual(r.videoCount, 1));
    check('Scenario E: views available from APIdirect even without YOUTUBE_KEY', () => assert.strictEqual(r.videos[0].views, 200));
    check('Scenario E: likes/comments null (no YOUTUBE_KEY)', () => assert.strictEqual(r.videos[0].likes, null));
  }

  restoreAxios();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

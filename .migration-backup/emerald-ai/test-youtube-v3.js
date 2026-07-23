'use strict';
/**
 * test-youtube-v3.js — verifies youtube-er.js's YouTube Data API v3-only
 * rewrite: channel resolution (channels.list?forHandle), video discovery
 * (search.list scoped to channelId + server-side publishedAfter/Before),
 * client-side AQ-relevance filtering, per-video stats attachment, and the
 * page-cap truncation flag. Replaces test-youtube-apidirect.js — APIdirect
 * is no longer used anywhere in this module.
 *
 * Run: node test-youtube-v3.js
 */

const assert = require('assert');
const axios = require('axios');
const { run: youtubeRun } = require('./youtube-er');

const originalGet = axios.get;
function restoreAxios() { axios.get = originalGet; }

const cfg = {
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
  // ── Scenario A: full happy path — channel resolves via forHandle, videos
  //    discovered via search.list (already channel+date scoped server-side),
  //    AQ-irrelevant video filtered client-side, stats attached ────────────
  {
    axios.get = async (url, opts) => {
      if (url.includes('youtube/v3/channels')) {
        assert.strictEqual(opts.params.forHandle, '@testorg', 'forHandle param should carry the @ prefix');
        return { data: { items: [{ id: 'UC_OFFICIAL', snippet: { title: 'TestOrg' }, statistics: { subscriberCount: '10000', hiddenSubscriberCount: false } }] } };
      }
      if (url.includes('youtube/v3/search')) {
        assert.strictEqual(opts.params.channelId, 'UC_OFFICIAL', 'search.list must be scoped to the resolved channel');
        assert.ok(opts.params.publishedAfter, 'search.list must pass publishedAfter for server-side date scoping');
        return { data: { items: [
          { id: { videoId: 'vid1' }, snippet: { title: 'Air quality report launched', description: 'AQI trends this quarter', publishedAt: '2026-03-15T00:00:00Z', channelId: 'UC_OFFICIAL' } },
          { id: { videoId: 'vid2' }, snippet: { title: 'Unrelated hiring announcement', description: 'We are hiring', publishedAt: '2026-03-16T00:00:00Z', channelId: 'UC_OFFICIAL' } },
        ], nextPageToken: undefined } };
      }
      if (url.includes('youtube/v3/videos')) {
        return { data: { items: [
          { id: 'vid1', snippet: { title: 'Air quality report launched', publishedAt: '2026-03-15T00:00:00Z' }, statistics: { viewCount: '500', likeCount: '40', commentCount: '5' } },
        ] } };
      }
      throw new Error('unexpected URL: ' + url);
    };

    const results = await youtubeRun(cfg, ['TestOrg'], () => {});
    const r = results[0];

    check('Scenario A: only the AQ-relevant video survives (client-side keyword filter)', () => assert.strictEqual(r.videoCount, 1));
    check('Scenario A: discovered reflects both search.list results (pre-AQ-filter)', () => assert.strictEqual(r.discovered, 2));
    check('Scenario A: unrelated video excluded', () => assert.ok(!r.videos.some((v) => v.videoId === 'vid2')));
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
      if (url.includes('youtube/v3/channels')) return { data: { items: [] } };
      throw new Error('should not call search.list when channel unresolved');
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { UnresolvableOrg: '@unresolvable' } }, ['UnresolvableOrg'], () => {});
    const r = results[0];
    check('Scenario B: handleUnresolved flag set', () => assert.strictEqual(r.handleUnresolved, true));
    check('Scenario B: 0 videos (channel never resolved)', () => assert.strictEqual(r.videoCount, 0));
  }

  // ── Scenario C: channel resolution call fails outright ───────────────────
  {
    axios.get = async (url) => {
      if (url.includes('youtube/v3/channels')) { const e = new Error('quota exceeded'); e.response = { status: 403 }; throw e; }
      throw new Error('unexpected call');
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { FailOrg: '@failorg' } }, ['FailOrg'], () => {});
    const r = results[0];
    check('Scenario C: failed flag set (not a confident zero)', () => assert.strictEqual(r.failed, true));
    check('Scenario C: videoCount is 0 but flagged as failure', () => assert.strictEqual(r.videoCount, 0));
  }

  // ── Scenario D: no handle configured at all — zero API calls ─────────────
  {
    axios.get = async () => { throw new Error('should not call any API without a handle'); };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: {} }, ['NoHandleOrg'], () => {});
    const r = results[0];
    check('Scenario D: noHandle flag set, no API calls attempted', () => assert.strictEqual(r.noHandle, true));
  }

  // ── Scenario E: no YOUTUBE_KEY at all — skip entirely, zero API calls ────
  {
    axios.get = async () => { throw new Error('should not call any API without YOUTUBE_KEY — no APIdirect fallback anymore'); };
    const results = await youtubeRun({ ...cfg, YOUTUBE_KEY: '' }, ['TestOrg'], () => {});
    const r = results[0];
    check('Scenario E: noKey flag set', () => assert.strictEqual(r.noKey, true));
    check('Scenario E: videoCount is 0, not a confident zero', () => assert.strictEqual(r.videoCount, 0));
  }

  // ── Scenario F: video-search page cap hit while still inside the date
  //    window — flagged as a possible coverage gap ─────────────────────────
  {
    let searchCalls = 0;
    axios.get = async (url, opts) => {
      if (url.includes('youtube/v3/channels')) {
        return { data: { items: [{ id: 'UC_PROLIFIC', snippet: { title: 'Prolific' }, statistics: { subscriberCount: '1000', hiddenSubscriberCount: false } }] } };
      }
      if (url.includes('youtube/v3/search')) {
        searchCalls++;
        // Every page still has more (nextPageToken) — a channel that never runs dry within MAX_SEARCH_PAGES
        return { data: { items: [{ id: { videoId: `v${searchCalls}` }, snippet: { title: 'irrelevant', description: '', publishedAt: '2026-03-10T00:00:00Z', channelId: 'UC_PROLIFIC' } }], nextPageToken: 'next' } };
      }
      throw new Error('unexpected call: ' + url);
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { Prolific: '@prolific' } }, ['Prolific'], () => {});
    const r = results[0];
    check('Scenario F: truncated flag set after hitting the page cap', () => assert.strictEqual(r.truncated, true));
    check('Scenario F: stopped at exactly MAX_SEARCH_PAGES (3) search.list calls', () => assert.strictEqual(searchCalls, 3));
  }

  // ── Scenario G: video-stats call fails — video list still returned
  //    (graceful degrade), just without likes/comments, flagged as failed ──
  {
    axios.get = async (url) => {
      if (url.includes('youtube/v3/channels')) {
        return { data: { items: [{ id: 'UC_X', snippet: { title: 'StatsFailOrg' }, statistics: { subscriberCount: '500', hiddenSubscriberCount: false } }] } };
      }
      if (url.includes('youtube/v3/search')) {
        return { data: { items: [{ id: { videoId: 'v1' }, snippet: { title: 'air quality video', description: '', publishedAt: '2026-03-10T00:00:00Z', channelId: 'UC_X' } }], nextPageToken: undefined } };
      }
      if (url.includes('youtube/v3/videos')) { const e = new Error('rate limited'); e.response = { status: 429 }; throw e; }
      throw new Error('unexpected call: ' + url);
    };
    const results = await youtubeRun({ ...cfg, ORG_YT_HANDLES: { StatsFailOrg: '@statsfail' } }, ['StatsFailOrg'], () => {});
    const r = results[0];
    check('Scenario G: video is still counted despite the stats failure', () => assert.strictEqual(r.videoCount, 1));
    check('Scenario G: failed flag set (likes/comments unavailable, not zero)', () => assert.strictEqual(r.failed, true));
    check('Scenario G: likes null (stats never arrived)', () => assert.strictEqual(r.videos[0].likes, null));
  }

  restoreAxios();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

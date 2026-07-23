'use strict';
/**
 * test-instagram-user-posts.js — verifies fetchInstagram()'s migration to
 * instagram/user/posts (the account's own feed by username) instead of the
 * old instagram/posts free-text search + author-substring-guess approach.
 *
 * Covers: no authorship filter needed (every post already belongs to the
 * account), the 120-post/10-page ceiling and truncation detection, AQ-
 * relevance filtering on `snippet`, and follower-lookup failure not
 * crashing the whole fetch.
 *
 * Run: node emerald-ai/test-instagram-user-posts.js
 */

const axios = require('axios');
const originalGet = axios.get;
function restoreAxios() { axios.get = originalGet; }

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL: ${msg}`); }
}

function post(overrides) {
  return {
    url: 'https://instagram.com/p/abc123',
    snippet: 'Generic caption',
    date: '2026-03-01 10:00:00',
    author: 'testorg',
    likes: 1, comments: 0, views: 0,
    is_video: false,
    ...overrides,
  };
}

async function run() {
  // ── Scenario A: basic fetch — no author filter, date + AQ filters apply ──
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url, params) => {
      if (url.includes('/instagram/user/posts')) {
        return {
          data: {
            posts: [
              post({ snippet: 'Our new air quality report', likes: 10 }),
              post({ snippet: 'Unrelated hiring announcement', likes: 5 }),
              // Different display-name-ish author than the handle passed in —
              // must NOT be excluded, this endpoint is already account-scoped.
              post({ snippet: 'Air pollution insights', author: 'Test Org Official', likes: 50 }),
            ],
            pages: 10, count: 3,
          },
        };
      }
      if (url.includes('/instagram/user')) return { data: { user: { follower_count: 4862 } } };
      throw new Error('unexpected endpoint: ' + url);
    };
    const r = await APIdirect.fetchInstagram('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality', 'air pollution'], null);
    assert(r.fetched === 3, `A: fetched should be 3, got ${r.fetched}`);
    assert(r.postCount === 2, `A: postCount (AQ-relevant) should be 2, got ${r.postCount}`);
    assert(r.followers === 4862, `A: followers should be 4862, got ${r.followers}`);
    assert(r.afterAuthor === undefined, 'A: no more afterAuthor field — authorship is no longer filtered');
    assert(r.topPosts.some(p => p.likes === 50), 'A: differently-named author post must be kept, not excluded');
  }

  // ── Scenario B: truncation — hits the 120-post ceiling while still in-range ──
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url, params) => {
      if (url.includes('/instagram/user/posts')) {
        const posts = Array.from({ length: 120 }, (_, i) => post({ date: '2026-03-01 10:00:00', snippet: `post ${i}` }));
        return { data: { posts, pages: 10, count: 120 } };
      }
      return { data: { user: { follower_count: 0 } } };
    };
    const r = await APIdirect.fetchInstagram('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality'], null);
    assert(r.truncated === true, 'B: should be truncated — hit the 120-post ceiling while still inside the date window');
  }

  // ── Scenario C: NOT truncated — account has fewer posts than the ceiling ──
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url, params) => {
      if (url.includes('/instagram/user/posts')) {
        return { data: { posts: [post({ date: '2026-03-01 10:00:00' })], pages: 1, count: 1 } };
      }
      return { data: { user: { follower_count: 0 } } };
    };
    const r = await APIdirect.fetchInstagram('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality'], null);
    assert(r.truncated === false, "C: should NOT be truncated — we've seen the account's entire history (fewer posts than the ceiling)");
  }

  // ── Scenario D: follower lookup fails, posts fetch still succeeds ────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url, params) => {
      if (url.includes('/instagram/user/posts')) {
        return { data: { posts: [post({ snippet: 'air quality update', likes: 7 })], pages: 1, count: 1 } };
      }
      if (url.includes('/instagram/user')) throw new Error('rate limited');
      throw new Error('unexpected endpoint');
    };
    const r = await APIdirect.fetchInstagram('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality'], null);
    assert(r.followers === 0, 'D: followers should default to 0 when the follower lookup fails');
    assert(r.postCount === 1, 'D: post fetch itself should still succeed independently of the follower lookup');
  }

  // ── Scenario E: rejected posts call is a FAILURE, not a zero ─────────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url) => {
      if (url.includes('/instagram/user/posts')) throw new Error('upstream error');
      return { data: { user: { follower_count: 0 } } };
    };
    const r = await APIdirect.fetchInstagram('Test Org', '@testorg', 'key', {}, [], null);
    assert(r.failed === true, 'E: a rejected posts call must set failed:true, not render as a confident zero');
  }

  // ── Scenario F: noHandle unaffected ───────────────────────────────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    const r = await APIdirect.fetchInstagram('Test Org', null, 'key', {}, [], null);
    assert(r.noHandle === true, 'F: no handle should short-circuit with noHandle:true');
  }

  restoreAxios();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); restoreAxios(); process.exit(1); });

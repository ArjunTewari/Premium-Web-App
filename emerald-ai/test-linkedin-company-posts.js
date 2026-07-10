'use strict';
/**
 * test-linkedin-company-posts.js — verifies fetchLinkedIn()'s migration to
 * linkedin/company/posts (org's own page timeline by URL) instead of the old
 * keyword-search + author-substring-guess approach.
 *
 * Covers: repost exclusion (is_repost:true posts aren't the org's own
 * content), date-cutoff pagination stop, AQ-relevance filtering on `text`,
 * and the new truncation flag (hit MAX_PAGES while still inside the date
 * window — a possible coverage gap, not a verified zero).
 *
 * Run: node emerald-ai/test-linkedin-company-posts.js
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
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:1',
    text: 'Generic post text',
    date: '2026-03-01 10:00:00',
    author: 'Test Org',
    likes: 1, comments: 0, shares: 0,
    is_repost: false,
    ...overrides,
  };
}

async function run() {
  // ── Scenario A: repost exclusion ──────────────────────────────────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    axios.get = async (url, opts) => {
      if (opts.params.page > 1) return { data: { posts: [], total: 3 } };
      return {
        data: {
          posts: [
            post({ text: 'Our new air quality report shows AQI trends', is_repost: false, likes: 10 }),
            post({ text: 'Unrelated hiring announcement', is_repost: false, likes: 5 }),
            post({ text: 'Partner event on air pollution', author: 'Some Partner Org', is_repost: true, likes: 99 }),
          ],
          total: 3,
        },
      };
    };
    const r = await APIdirect.fetchLinkedIn('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality', 'aqi', 'air pollution'], null);
    assert(r.fetched === 3, `A: fetched should be 3, got ${r.fetched}`);
    assert(r.afterAuthor === 2, `A: afterAuthor (post-repost-filter) should be 2, got ${r.afterAuthor}`);
    assert(r.postCount === 1, `A: postCount (AQ-relevant, non-repost) should be 1, got ${r.postCount}`);
    assert(!r.topPosts.some(p => p.likes === 99), 'A: repost with 99 likes must not leak into topPosts');
  }

  // ── Scenario B: date-cutoff pagination stop ───────────────────────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    let calls = 0;
    axios.get = async (url, opts) => {
      calls++;
      const page = opts.params.page;
      if (page === 1) {
        return { data: { posts: [post({ date: '2026-03-15 10:00:00', text: 'air quality update' })], total: 30 } };
      }
      if (page === 2) {
        // oldest post on this page predates dateRange.from (2026-02-01) -> should stop here
        return { data: { posts: [post({ date: '2026-01-10 10:00:00', text: 'air quality old post' })], total: 30 } };
      }
      // page 3 should never be requested
      return { data: { posts: [post({ date: '2025-01-01 10:00:00' })], total: 30 } };
    };
    const r = await APIdirect.fetchLinkedIn('Test Org', '@testorg', 'key', { from: new Date('2026-02-01'), to: new Date('2026-12-31') }, ['air quality'], null);
    assert(calls === 2, `B: should stop after page 2 (date cutoff hit), made ${calls} calls`);
    assert(r.fetched === 2, `B: fetched should be 2 (page1 + page2 post), got ${r.fetched}`);
    assert(r.truncated === false, 'B: should NOT be truncated — stopped due to date cutoff, not page cap');
  }

  // ── Scenario C: truncation (hits MAX_PAGES=8 while still in-range) ───
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    let calls = 0;
    axios.get = async (url, opts) => {
      calls++;
      // Every page returns recent, in-range, non-AQ posts — never triggers date cutoff
      return {
        data: {
          posts: [post({ date: '2026-03-01 10:00:00', text: 'unrelated content, no keywords here' })],
          total: 500,
        },
      };
    };
    const r = await APIdirect.fetchLinkedIn('Test Org', '@testorg', 'key', { from: new Date('2026-01-01'), to: new Date('2026-12-31') }, ['air quality', 'aqi'], null);
    assert(calls === 8, `C: should fetch exactly MAX_PAGES=8 pages, made ${calls} calls`);
    assert(r.truncated === true, 'C: should be truncated — hit page cap while still inside date window');
    assert(r.postCount === 0, `C: postCount should be 0 (no AQ matches), got ${r.postCount}`);

    // Confirm diagnoseZero() surfaces the truncation caveat instead of claiming a verified zero
    const Sentinel = require('./sentinel');
    const diag = Sentinel.diagnoseZero(r, 'LinkedIn');
    assert(/coverage gap|not fully verified/.test(diag), `C: diagnoseZero should flag possible coverage gap, got: "${diag}"`);
  }

  // ── Scenario D: all-repost zero uses the LinkedIn-specific message ───
  {
    const Sentinel = require('./sentinel');
    const p = { fetched: 3, afterAuthor: 0, inRangeCount: undefined, postCount: 0 };
    const diag = Sentinel.diagnoseZero(p, 'LinkedIn');
    assert(/reposts of other pages/.test(diag), `D: LinkedIn afterAuthor=0 should mention reposts, got: "${diag}"`);
    const diagIg = Sentinel.diagnoseZero(p, 'Instagram');
    assert(/authorship filter/.test(diagIg), `D: Instagram afterAuthor=0 should keep the old authorship-filter message, got: "${diagIg}"`);
  }

  // ── Scenario E: noHandle unaffected ───────────────────────────────────
  {
    delete require.cache[require.resolve('./apidirect-collector')];
    const APIdirect = require('./apidirect-collector');
    const r = await APIdirect.fetchLinkedIn('Test Org', null, 'key', {}, [], null);
    assert(r.noHandle === true, 'E: no handle should short-circuit with noHandle:true');
  }

  restoreAxios();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error(e); restoreAxios(); process.exit(1); });

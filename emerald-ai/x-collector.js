'use strict';
/**
 * x-collector.js — X (Twitter) data via APIDirectio
 *
 * Replaces X API v2 Bearer Token with APIDirectio /v1/twitter/user/tweets.
 * Fetches only from the org's own account (not keyword mentions).
 *
 * Per org:
 *   1. GET /v1/twitter/user/tweets?username={handle}&pages=3
 *   2. Client-side date filter to report window
 *   3. Client-side AQ keyword filter → aqTweets
 */

const axios     = require('axios');
const ORG_SOCIAL = require('./org-handles');

const APIDIR_BASE = 'https://apidirect.io';

const AQ_KEYWORDS = [
  'air quality', 'air pollution', 'pm2.5', 'pm10', 'aqi', 'ncap', 'smog',
  'clean air', 'particulate', 'airshed', 'emission', 'emissions',
  'pollution', 'grap', 'black carbon', 'ozone',
];

function isAQPost(text) {
  const lower = (text || '').toLowerCase();
  return AQ_KEYWORDS.some(kw => lower.includes(kw));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOrgXData(orgName, handle, dateFrom, dateTo, apidirKey, cb) {
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : 0;
  const toMs   = dateTo   ? new Date(dateTo  ).getTime() : Date.now();

  try {
    const res = await axios.get(`${APIDIR_BASE}/v1/twitter/user/tweets`, {
      params:  { username: handle, pages: 3 },
      headers: { 'X-API-Key': apidirKey },
      timeout: 30000,
    });

    const tweets = res.data.tweets || res.data.posts || [];

    const inPeriod = tweets.filter(t => {
      if (!t.date) return true;
      try {
        const d = new Date(t.date);
        if (isNaN(d.getTime())) return true;
        const ms = d.getTime();
        return ms >= fromMs && ms <= toMs;
      } catch { return true; }
    });

    const aqTweets = inPeriod.filter(t => isAQPost(t.snippet || t.title || ''));

    const totalLikes   = aqTweets.reduce((s, t) => s + (t.likes    || 0), 0);
    const totalReplies = aqTweets.reduce((s, t) => s + (t.replies  || 0), 0);

    const topPosts = aqTweets
      .sort((a, b) => (b.likes || 0) - (a.likes || 0))
      .slice(0, 3)
      .map(t => ({
        text:       t.snippet || t.title || '',
        likes:      t.likes    || 0,
        replies:    t.replies  || 0,
        reposts:    t.retweets || 0,
        views:      t.views    || 0,
        created_at: t.date     || '',
        url:        t.url      || `https://x.com/${handle}`,
      }));

    return {
      handle,
      followers:   res.data.user?.followers_count || res.data.followers || 0,
      totalPosts:  inPeriod.length,
      aqPosts:     aqTweets.length,
      totalLikes,
      totalReplies,
      topPosts,
    };
  } catch (e) {
    const msg = e.response?.data?.error || e.response?.data?.message || e.message;
    cb?.(`  X: @${handle} — ${msg}`, 'warn');
    return { handle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalReplies: 0, topPosts: [], error: msg };
  }
}

/**
 * Collect X data for all orgs via APIDirectio.
 * @param {string[]} orgs       - org names matching keys in org-handles.js
 * @param {string}   dateFrom   - YYYY-MM-DD
 * @param {string}   dateTo     - YYYY-MM-DD
 * @param {string}   apidirKey  - APIDirectio API key
 * @param {Function} cb         - log callback(msg, level)
 * @returns {Object} { [orgName]: { handle, followers, totalPosts, aqPosts, topPosts, ... } }
 */
async function run(orgs, dateFrom, dateTo, apidirKey, cb) {
  if (!apidirKey) {
    cb?.('  X: no APIDIRECT_KEY — skipping', 'warn');
    return {};
  }

  cb?.(`  X (APIDirectio): collecting tweets for ${orgs.length} orgs…`);
  const results = {};

  for (const orgName of orgs) {
    const handle = ORG_SOCIAL[orgName]?.twitter;
    if (!handle) {
      cb?.(`  X: no handle configured for "${orgName}" — skipping`, 'warn');
      results[orgName] = { handle: null, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalReplies: 0, topPosts: [] };
      continue;
    }

    cb?.(`  X: @${handle} (${orgName})…`);
    results[orgName] = await fetchOrgXData(orgName, handle, dateFrom, dateTo, apidirKey, cb);
    const r = results[orgName];
    cb?.(
      `  X → ${orgName}: ${r.aqPosts} AQ tweets / ${r.totalPosts} in period (${(r.followers || 0).toLocaleString()} followers)`,
      r.aqPosts > 0 ? 'ok' : 'warn'
    );

    await sleep(500);
  }

  cb?.('  X (APIDirectio): collection complete', 'ok');
  return results;
}

module.exports = { run, isAQPost };

'use strict';
/**
 * x-collector.js — X (Twitter) API v2 data collection
 * Uses Bearer Token (App-only auth) — no user login required.
 *
 * Per org:
 *   1. GET /users/by/username/:handle  → userId + follower count
 *   2. GET /users/:id/tweets           → paginate all tweets in period
 *   3. Client-side AQ keyword filter   → aqTweets
 */

const axios = require('axios');

const AQ_KEYWORDS = [
  'air quality', 'air pollution', 'pm2.5', 'pm10', 'aqi', 'ncap', 'smog',
  'clean air', 'particulate', 'airshed', 'emission', 'emissions',
  'pollution', 'grap', 'black carbon', 'ozone',
];

// Default X handles for tracked AQ orgs
const ORG_X_HANDLES = {
  'CEEW':                             'CEEWIndia',
  'WRI India':                        'WRIIndia',
  'CSE India':                        'CSEIndia',
  'CSTEP':                            'cstep_india',
  'Air Pollution Action Group':       'APAGIndia',
  'Chintan':                          'ChintanIndia',
  'IIT Delhi':                        'iitdelhi',
  'IIT Kanpur':                       'IITKanpur',
  'Health Effects Institute':         'healtheffects',
  'ICCT':                             'theicct',
  'EPIC India':                       'EPIC_India',
  'Climate Trends':                   'ClimateTrends_',
  'Sustainable Futures Collaborative':'SFC_India',
};

function isAQPost(text) {
  const lower = (text || '').toLowerCase();
  return AQ_KEYWORDS.some(kw => lower.includes(kw));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getWithRetry(url, headers, cb) {
  try {
    const res = await axios.get(url, { headers, timeout: 20000 });
    return res.data;
  } catch (e) {
    if (e.response?.status === 429) {
      cb?.('  X API: rate limited — waiting 60s…', 'warn');
      await sleep(60000);
      const res2 = await axios.get(url, { headers, timeout: 20000 });
      return res2.data;
    }
    throw e;
  }
}

async function fetchOrgXData(orgName, handle, dateFrom, dateTo, bearerToken, cb) {
  const headers = { Authorization: `Bearer ${bearerToken}` };
  const BASE    = 'https://api.twitter.com/2';

  // ── Step 1: resolve user ID + followers ──────────────────────────────────
  let userId, followers;
  try {
    const ud = await getWithRetry(
      `${BASE}/users/by/username/${handle}?user.fields=public_metrics`,
      headers, cb
    );
    if (ud.errors || !ud.data) {
      const detail = ud.errors?.[0]?.detail || 'not found';
      cb?.(`  X: @${handle} — ${detail}`, 'warn');
      return { handle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalReplies: 0, topPosts: [], error: detail };
    }
    userId    = ud.data.id;
    followers = ud.data.public_metrics?.followers_count || 0;
  } catch (e) {
    cb?.(`  X: @${handle} lookup failed — ${e.message}`, 'warn');
    return { handle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalReplies: 0, topPosts: [], error: e.message };
  }

  // ── Step 2: paginate tweets in period ────────────────────────────────────
  // X API start_time must be > 7 days ago for Basic tier; silently clamp
  const startISO = dateFrom ? new Date(dateFrom).toISOString() : undefined;
  const endISO   = dateTo   ? new Date(dateTo  ).toISOString() : undefined;

  let allTweets = [];
  let nextToken = null;
  let pages     = 0;

  do {
    let url = `${BASE}/users/${userId}/tweets?max_results=100&tweet.fields=public_metrics,created_at,text,id`;
    if (startISO) url += `&start_time=${startISO}`;
    if (endISO)   url += `&end_time=${endISO}`;
    if (nextToken) url += `&pagination_token=${nextToken}`;

    try {
      const data = await getWithRetry(url, headers, cb);
      if (data.data) allTweets.push(...data.data);
      nextToken = data.meta?.next_token || null;
      pages++;
      if (nextToken) await sleep(300);
    } catch (e) {
      cb?.(`  X: tweet page error @${handle}: ${e.message}`, 'warn');
      break;
    }
  } while (nextToken && pages < 10); // cap: 1 000 tweets

  // ── Step 3: client-side AQ filter ────────────────────────────────────────
  const aqTweets = allTweets.filter(t => isAQPost(t.text));

  const totalLikes   = aqTweets.reduce((s, t) => s + (t.public_metrics?.like_count    || 0), 0);
  const totalReplies = aqTweets.reduce((s, t) => s + (t.public_metrics?.reply_count   || 0), 0);

  const topPosts = aqTweets
    .sort((a, b) => (b.public_metrics?.like_count || 0) - (a.public_metrics?.like_count || 0))
    .slice(0, 3)
    .map(t => ({
      text:       t.text,
      likes:      t.public_metrics?.like_count      || 0,
      replies:    t.public_metrics?.reply_count     || 0,
      reposts:    t.public_metrics?.retweet_count   || 0,
      views:      t.public_metrics?.impression_count || 0,
      created_at: t.created_at,
      url:        `https://twitter.com/${handle}/status/${t.id}`,
    }));

  return { handle, followers, totalPosts: allTweets.length, aqPosts: aqTweets.length, totalLikes, totalReplies, topPosts };
}

/**
 * Collect X data for all orgs.
 * @param {string[]} orgs      - org names matching keys in ORG_X_HANDLES
 * @param {string}   dateFrom  - YYYY-MM-DD
 * @param {string}   dateTo    - YYYY-MM-DD
 * @param {string}   bearerToken
 * @param {Function} cb        - log callback(msg, level)
 * @returns {Object}  { [orgName]: { handle, followers, totalPosts, aqPosts, topPosts, ... } }
 */
async function run(orgs, dateFrom, dateTo, bearerToken, cb) {
  if (!bearerToken) {
    cb?.('  X API: no X_BEARER_TOKEN — skipping', 'warn');
    return {};
  }

  cb?.(`  X API: collecting tweets for ${orgs.length} orgs…`);
  const results = {};

  for (const orgName of orgs) {
    const handle = ORG_X_HANDLES[orgName];
    if (!handle) {
      cb?.(`  X: no handle configured for "${orgName}" — skipping`, 'warn');
      results[orgName] = { handle: null, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalReplies: 0, topPosts: [] };
      continue;
    }

    cb?.(`  X: @${handle} (${orgName})…`);
    results[orgName] = await fetchOrgXData(orgName, handle, dateFrom, dateTo, bearerToken, cb);
    const r = results[orgName];
    cb?.(
      `  X → ${orgName}: ${r.aqPosts} AQ tweets / ${r.totalPosts} total (${(r.followers || 0).toLocaleString()} followers)`,
      r.aqPosts > 0 ? 'ok' : 'warn'
    );

    await sleep(1000); // 1s between orgs to respect rate limits
  }

  cb?.('  X API: collection complete', 'ok');
  return results;
}

module.exports = { run, ORG_X_HANDLES, isAQPost };

'use strict';
/**
 * Emerald AI — Trend-Filtered Social Intelligence
 * Exports: fetchTrendSocial(trendEvent, config, cb)
 *
 * Called from pipeline.js ONLY when detectTrend() fires a spike.
 * Fetches social data for orgs in trendEvent.orgsToFetch only.
 *
 * Platforms:
 *   X/Twitter  — Serper site:twitter.com search (no X API key needed)
 *   YouTube    — YouTube Data API v3 (cfg.YOUTUBE_KEY, optional)
 *   Instagram  — Serper site:instagram.com search
 *   LinkedIn   — Serper site:linkedin.com search
 */

const axios = require('axios');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Serper web search helper ───────────────────────────────────────────────
async function serperSiteSearch(query, serperKey) {
  const res = await axios.post('https://google.serper.dev/search',
    { q: query, num: 10 },
    { headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  return res.data.organic || [];
}

// ── Platform helpers ───────────────────────────────────────────────────────
async function fetchX(org, topic, serperKey) {
  const results = await serperSiteSearch(`site:twitter.com "${org}" "${topic}"`, serperKey);
  const top = results[0];
  return {
    count: results.length,
    topResult: top
      ? { url: top.link || '', snippet: (top.snippet || '').slice(0, 200), date: top.date || '' }
      : null
  };
}

async function fetchYouTubeForTrend(org, topic, youtubeKey) {
  if (!youtubeKey) return { count: 0, topVideo: null };

  const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
    params: {
      part: 'snippet',
      q: `"${org}" "${topic}"`,
      type: 'video',
      maxResults: 5,
      order: 'relevance',
      key: youtubeKey,
      relevanceLanguage: 'en'
    },
    timeout: 15000
  });

  const items = searchRes.data.items || [];
  const count = searchRes.data.pageInfo?.totalResults || items.length;
  if (!items[0]) return { count, topVideo: null };

  const top = items[0];
  let views = 0;

  try {
    const statsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: { part: 'statistics', id: top.id?.videoId || '', key: youtubeKey },
      timeout: 10000
    });
    views = parseInt(statsRes.data.items?.[0]?.statistics?.viewCount || 0);
  } catch { /* views stays 0 */ }

  return {
    count,
    topVideo: {
      title: (top.snippet?.title || '').slice(0, 100),
      url: `https://youtube.com/watch?v=${top.id?.videoId || ''}`,
      views,
      publishedAt: (top.snippet?.publishedAt || '').slice(0, 10)
    }
  };
}

async function fetchInstagram(org, topic, serperKey) {
  const results = await serperSiteSearch(`site:instagram.com "${org}" "${topic}"`, serperKey);
  const top = results[0];
  return {
    count: results.length,
    topResult: top
      ? { url: top.link || '', snippet: (top.snippet || '').slice(0, 200) }
      : null
  };
}

async function fetchLinkedIn(org, topic, serperKey) {
  const results = await serperSiteSearch(`site:linkedin.com "${org}" "${topic}"`, serperKey);
  const top = results[0];
  return {
    count: results.length,
    topResult: top
      ? { url: top.link || '', snippet: (top.snippet || '').slice(0, 200) }
      : null
  };
}

// ── Trend Visibility Score (0–100) ─────────────────────────────────────────
function computeTrendScore(platforms, isMentioned) {
  let score = 0;
  if ((platforms.x?.count        || 0) > 0) score += 25;
  if ((platforms.youtube?.count  || 0) > 0) score += 25;
  if ((platforms.instagram?.count|| 0) > 0) score += 15;
  if ((platforms.linkedin?.count || 0) > 0) score += 15;
  if (isMentioned)                           score += 20;
  return Math.min(score, 100);
}

// ── Main export ────────────────────────────────────────────────────────────
/**
 * fetchTrendSocial(trendEvent, config, cb)
 *
 * trendEvent: { detected, topic, orgsToFetch, orgsMentioned, ... }
 * config:     { SERPER_KEY, YOUTUBE_KEY }
 * cb:         SSE log callback (msg, level)
 *
 * Returns: Array of per-org result objects (one per org in orgsToFetch).
 */
async function fetchTrendSocial(trendEvent, config, cb) {
  const { orgsToFetch = [], topic, orgsMentioned = [] } = trendEvent;
  const { SERPER_KEY: serperKey, YOUTUBE_KEY: youtubeKey } = config;
  const log = (msg, level = '') => { if (cb) cb(msg, level); };

  const results = [];

  for (const org of orgsToFetch) {
    const isMentioned = orgsMentioned.includes(org);

    const [xRes, ytRes, igRes, liRes] = await Promise.allSettled([
      fetchX(org, topic, serperKey),
      fetchYouTubeForTrend(org, topic, youtubeKey),
      fetchInstagram(org, topic, serperKey),
      fetchLinkedIn(org, topic, serperKey)
    ]);

    if (xRes.status  === 'rejected') log(`[TREND-SOCIAL] X fetch failed for ${org}: ${xRes.reason?.message}`, 'warn');
    if (ytRes.status === 'rejected') log(`[TREND-SOCIAL] YouTube fetch failed for ${org}: ${ytRes.reason?.message}`, 'warn');
    if (igRes.status === 'rejected') log(`[TREND-SOCIAL] Instagram fetch failed for ${org}: ${igRes.reason?.message}`, 'warn');
    if (liRes.status === 'rejected') log(`[TREND-SOCIAL] LinkedIn fetch failed for ${org}: ${liRes.reason?.message}`, 'warn');

    const platforms = {
      x:         xRes.status  === 'fulfilled' ? xRes.value  : { count: 0, topResult: null },
      youtube:   ytRes.status === 'fulfilled' ? ytRes.value : { count: 0, topVideo: null },
      instagram: igRes.status === 'fulfilled' ? igRes.value : { count: 0, topResult: null },
      linkedin:  liRes.status === 'fulfilled' ? liRes.value : { count: 0, topResult: null }
    };

    const score = computeTrendScore(platforms, isMentioned);

    log(
      `[TREND-SOCIAL] ${org} — X: ${platforms.x.count} results, YouTube: ${platforms.youtube.count} results, Instagram: ${platforms.instagram.count} results, LinkedIn: ${platforms.linkedin.count} results`,
      'ok'
    );

    results.push({
      org,
      trendRelevance: isMentioned ? 'mentioned' : 'implicated',
      trendVisibilityScore: score,
      platforms
    });

    await sleep(300);
  }

  return results;
}

module.exports = { fetchTrendSocial };

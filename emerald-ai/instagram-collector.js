'use strict';
/**
 * instagram-collector.js — Instagram data via APIDirectio
 *
 * Replaces HikerAPI with APIDirectio /v1/instagram/user/posts.
 * Fetches only from the org's own account (not keyword mentions).
 *
 * Per org:
 *   1. GET /v1/instagram/user/posts?username={handle}&pages=3
 *   2. Client-side date filter to report window
 *   3. Claude Haiku AQ classification (captions use hashtags/emoji)
 */

const axios      = require('axios');
const ORG_SOCIAL = require('./org-handles');

const APIDIR_BASE = 'https://apidirect.io';
const CLAUDE_API  = 'https://api.anthropic.com/v1/messages';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function classifyPost(caption, claudeKey) {
  if (!caption || !claudeKey) return false;
  try {
    const res = await axios.post(CLAUDE_API, {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system:     'You classify social media posts. Reply with only YES or NO.',
      messages: [{
        role:    'user',
        content: `Is this post about air quality, air pollution, AQI, PM2.5, smog, clean air, emissions, or environmental air health?\n\nPost: "${caption.slice(0, 500)}"\n\nAnswer YES or NO only.`,
      }],
    }, {
      headers: {
        'x-api-key':         claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 15000,
    });
    return res.data.content?.[0]?.text?.trim().toUpperCase() === 'YES';
  } catch {
    return false;
  }
}

async function fetchOrgIGData(orgName, igHandle, dateFrom, dateTo, apidirKey, claudeKey, cb) {
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : 0;
  const toMs   = dateTo   ? new Date(dateTo  ).getTime() : Date.now();

  try {
    const res = await axios.get(`${APIDIR_BASE}/v1/instagram/user/posts`, {
      params:  { username: igHandle, pages: 3 },
      headers: { 'X-API-Key': apidirKey },
      timeout: 60000,
    });

    const posts = res.data.posts || [];

    const inPeriod = posts.filter(p => {
      if (!p.date) return true;
      try {
        const d = new Date(p.date);
        if (isNaN(d.getTime())) return true;
        const ms = d.getTime();
        return ms >= fromMs && ms <= toMs;
      } catch { return true; }
    });

    cb?.(`  IG: @${igHandle} fetched ${posts.length} posts, ${inPeriod.length} in period`);

    if (inPeriod.length === 0) {
      return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
    }

    const normalised = inPeriod.map(p => ({
      caption:        p.snippet || p.title || p.description || '',
      like_count:     p.likes    || 0,
      comments_count: p.comments || 0,
      timestamp:      p.date     || '',
      permalink:      p.url      || '',
    }));

    // Haiku AQ classification in batches of 5
    const aqMedia = [];
    for (let i = 0; i < normalised.length; i += 5) {
      const batch = normalised.slice(i, i + 5);
      const flags = await Promise.all(batch.map(m => classifyPost(m.caption, claudeKey)));
      flags.forEach((isAQ, j) => { if (isAQ) aqMedia.push(batch[j]); });
      if (i + 5 < normalised.length) await sleep(500);
    }

    const followers    = res.data.user?.followers || res.data.followers || 0;
    const totalLikes   = aqMedia.reduce((s, m) => s + m.like_count,    0);
    const totalComments = aqMedia.reduce((s, m) => s + m.comments_count, 0);

    const topPosts = aqMedia
      .sort((a, b) => b.like_count - a.like_count)
      .slice(0, 3)
      .map(m => ({
        caption:   m.caption.slice(0, 300),
        likes:     m.like_count,
        comments:  m.comments_count,
        timestamp: m.timestamp,
        permalink: m.permalink,
      }));

    return {
      handle:           igHandle,
      followers,
      totalPosts:       inPeriod.length,
      aqPosts:          aqMedia.length,
      totalLikes,
      totalComments,
      topPosts,
      ig_not_available: false,
    };
  } catch (e) {
    const errMsg = e.response?.data?.error || e.response?.data?.message || e.message;
    cb?.(`  IG: @${igHandle} — ${errMsg}`, 'warn');
    return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: true, error: errMsg };
  }
}

/**
 * Collect Instagram data for all orgs via APIDirectio.
 * @param {string[]} orgs
 * @param {string}   dateFrom   - YYYY-MM-DD
 * @param {string}   dateTo     - YYYY-MM-DD
 * @param {string}   apidirKey  - APIDirectio API key
 * @param {string}   claudeKey  - Anthropic API key (for Haiku classification)
 * @param {Function} cb         - log callback
 * @returns {Object} { [orgName]: { handle, followers, aqPosts, topPosts, ... } }
 */
async function run(orgs, dateFrom, dateTo, apidirKey, claudeKey, cb) {
  if (!apidirKey) {
    cb?.('  Instagram: no APIDIRECT_KEY — skipping', 'warn');
    return {};
  }
  if (!claudeKey) {
    cb?.('  Instagram: no CLAUDE_KEY for Haiku classification — skipping', 'warn');
    return {};
  }

  cb?.(`  Instagram (APIDirectio): collecting posts for ${orgs.length} orgs…`);
  const results = {};

  for (const orgName of orgs) {
    const handle = ORG_SOCIAL[orgName]?.instagram;
    if (!handle) {
      cb?.(`  IG: no handle configured for "${orgName}" — skipping`, 'warn');
      results[orgName] = { handle: null, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
      continue;
    }

    cb?.(`  IG: @${handle} (${orgName})…`);
    results[orgName] = await fetchOrgIGData(orgName, handle, dateFrom, dateTo, apidirKey, claudeKey, cb);
    const r = results[orgName];

    if (r.ig_not_available) {
      cb?.(`  IG → ${orgName}: not available`, 'warn');
    } else {
      cb?.(
        `  IG → ${orgName}: ${r.aqPosts} AQ posts / ${r.totalPosts} in period (${(r.followers || 0).toLocaleString()} followers)`,
        r.aqPosts > 0 ? 'ok' : 'warn'
      );
    }

    await sleep(500);
  }

  cb?.('  Instagram (APIDirectio): collection complete', 'ok');
  return results;
}

module.exports = { run };

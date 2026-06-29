'use strict';
/**
 * instagram-collector.js — Instagram data via HikerAPI
 *
 * HikerAPI wraps Instagram's private API to provide public profile + media data
 * for ANY public account — no Meta app review, Business account, or user OAuth needed.
 *
 * Per org:
 *   1. GET /v1/user/by/username → pk (user ID) + follower_count (User object, no wrapper)
 *   2. GET /v1/user/medias/chunk → [items[], end_cursor] — paginate up to 3 pages
 *   3. Date filter (client-side — no server-side date range supported)
 *   4. Claude Haiku classification (captions use hashtags/emoji, not plain keywords)
 *
 * Auth: x-access-key header with HIKER_API_KEY
 */

const axios = require('axios');

const HIKER_BASE = 'https://api.hikerapi.com';
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

// Default IG handles for tracked AQ orgs
const ORG_IG_HANDLES = {
  'CEEW':                             'ceewindia',
  'WRI India':                        'wriindia',
  'CSE India':                        'cseindia',
  'CSTEP':                            'cstep_india',
  'Air Pollution Action Group':       'apagindia',
  'Chintan':                          'chintanindia',
  'IIT Delhi':                        'iitdelhi',
  'IIT Kanpur':                       'iitkanpur',
  'Health Effects Institute':         'healtheffectsinstitute',
  'ICCT':                             'theicct',
  'EPIC India':                       'epic_india',
  'Climate Trends':                   'climatetrendsindia',
  'Sustainable Futures Collaborative':'sfc_india',
};

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
        'x-api-key':          claudeKey,
        'anthropic-version':  '2023-06-01',
        'Content-Type':       'application/json',
      },
      timeout: 15000,
    });
    return res.data.content?.[0]?.text?.trim().toUpperCase() === 'YES';
  } catch {
    return false;
  }
}

async function fetchOrgIGData(orgName, igHandle, dateFrom, dateTo, hikerKey, claudeKey, cb) {
  const fromTs = dateFrom ? new Date(dateFrom).getTime() : 0;
  const toTs   = dateTo   ? new Date(dateTo  ).getTime() : Date.now();
  const headers = { 'x-access-key': hikerKey };

  // ── Step 1: get user info (pk + followers) ────────────────────────────────
  // /v1/user/by/username returns the User object directly (no wrapper)
  let userId, followers;
  try {
    const res = await axios.get(`${HIKER_BASE}/v1/user/by/username`, {
      params:  { username: igHandle },
      headers,
      timeout: 15000,
    });
    const u = res.data;
    if (!u?.pk) {
      cb?.(`  IG: @${igHandle} — not found or private`, 'warn');
      return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: true };
    }
    userId    = String(u.pk);
    followers = u.follower_count || 0;
  } catch (e) {
    const errMsg = e.response?.data?.detail || e.response?.data?.message || e.message;
    cb?.(`  IG: @${igHandle} — ${errMsg}`, 'warn');
    return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: true, error: errMsg };
  }

  // ── Step 2: paginate media via /v1/user/medias/chunk ─────────────────────
  // Returns [mediaItems[], end_cursor | null] — posts are newest-first.
  // Stop when we've gone back past dateFrom or hit the page cap.
  let allItems  = [];
  let endCursor = null;
  let page      = 0;
  const MAX_PAGES = 15;

  do {
    try {
      const params = { user_id: userId };
      if (endCursor) params.end_cursor = endCursor;

      const res = await axios.get(`${HIKER_BASE}/v1/user/medias/chunk`, {
        params,
        headers,
        timeout: 30000,
      });

      // Response is [items[], end_cursor]
      const [items, cursor] = Array.isArray(res.data) ? res.data : [[], null];
      if (!items?.length) break;

      // Debug: log first item's keys + timestamp fields on page 1
      if (page === 0 && items[0]) {
        const sample = items[0];
        cb?.(`  IG DEBUG keys: ${Object.keys(sample).join(', ')}`, 'warn');
        cb?.(`  IG DEBUG taken_at=${sample.taken_at} timestamp=${sample.timestamp} created_at=${sample.created_at} date=${sample.date}`, 'warn');
      }

      allItems.push(...items);
      endCursor = cursor || null;
      page++;

      // Early stop: oldest post on this page is before our window — no point going further
      // Use whichever timestamp field exists
      const getTs = (m) => {
        const raw = m.taken_at ?? m.timestamp ?? m.created_at ?? m.date ?? 0;
        const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
        // If value looks like seconds (< 1e10), convert; if ms already, use as-is
        return n > 1e10 ? n : n * 1000;
      };
      const oldestTs = items.reduce((min, m) => Math.min(min, getTs(m)), Infinity);
      if (oldestTs > 0 && oldestTs < fromTs) break;

      if (endCursor) await sleep(400);
    } catch (e) {
      cb?.(`  IG: @${igHandle} media page ${page + 1} error — ${e.message}`, 'warn');
      break;
    }
  } while (endCursor && page < MAX_PAGES);

  // ── Step 3: filter by report period ──────────────────────────────────────
  const getTs = (m) => {
    const raw = m.taken_at ?? m.timestamp ?? m.created_at ?? m.date ?? 0;
    const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
    return n > 1e10 ? n : n * 1000;
  };

  const inPeriod = allItems.filter(m => {
    const ts = getTs(m);
    return ts >= fromTs && ts <= toTs;
  });

  cb?.(`  IG: @${igHandle} fetched ${allItems.length} total items, ${inPeriod.length} in period`);

  if (inPeriod.length === 0) {
    return { handle: igHandle, followers, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
  }

  // Normalise fields to match downstream expectations
  const normalised = inPeriod.map(m => {
    const ts = getTs(m);
    const code = m.code || m.shortcode || '';
    return {
      caption:        m.caption_text || (typeof m.caption === 'string' ? m.caption : m.caption?.text) || '',
      like_count:     m.like_count     || 0,
      comments_count: m.comment_count  || m.comments_count || 0,
      timestamp:      new Date(ts).toISOString(),
      permalink:      code ? `https://www.instagram.com/p/${code}/` : '',
    };
  });

  // ── Step 4: classify with Claude Haiku in batches of 5 ───────────────────
  const aqMedia = [];
  for (let i = 0; i < normalised.length; i += 5) {
    const batch = normalised.slice(i, i + 5);
    const flags = await Promise.all(batch.map(m => classifyPost(m.caption, claudeKey)));
    flags.forEach((isAQ, j) => { if (isAQ) aqMedia.push(batch[j]); });
    if (i + 5 < normalised.length) await sleep(500);
  }

  const totalLikes    = aqMedia.reduce((s, m) => s + m.like_count,    0);
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
}

/**
 * Collect Instagram data for all orgs via HikerAPI.
 * @param {string[]} orgs
 * @param {string}   dateFrom   - YYYY-MM-DD
 * @param {string}   dateTo     - YYYY-MM-DD
 * @param {string}   hikerKey   - HikerAPI access key
 * @param {string}   claudeKey  - Anthropic API key (for Haiku classification)
 * @param {Function} cb         - log callback
 * @returns {Object} { [orgName]: { handle, followers, aqPosts, topPosts, ... } }
 */
async function run(orgs, dateFrom, dateTo, hikerKey, claudeKey, cb) {
  if (!hikerKey) {
    cb?.('  Instagram API: missing HIKER_API_KEY — skipping', 'warn');
    return {};
  }
  if (!claudeKey) {
    cb?.('  Instagram API: no CLAUDE_KEY for Haiku classification — skipping', 'warn');
    return {};
  }

  cb?.(`  Instagram API (HikerAPI): collecting media for ${orgs.length} orgs…`);
  const results = {};

  for (const orgName of orgs) {
    const handle = ORG_IG_HANDLES[orgName];
    if (!handle) {
      cb?.(`  IG: no handle configured for "${orgName}" — skipping`, 'warn');
      results[orgName] = { handle: null, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
      continue;
    }

    cb?.(`  IG: @${handle} (${orgName})…`);
    results[orgName] = await fetchOrgIGData(orgName, handle, dateFrom, dateTo, hikerKey, claudeKey, cb);
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

  cb?.('  Instagram API: collection complete', 'ok');
  return results;
}

module.exports = { run, ORG_IG_HANDLES };

'use strict';
/**
 * instagram-collector.js — Instagram Graph API (Business Discovery)
 *
 * Uses Business Discovery to read OTHER orgs' public Business/Creator accounts
 * WITHOUT requiring them to authenticate. Requires:
 *   - Your own Facebook Page linked to an Instagram Business Account
 *   - A long-lived Page Access Token (META_ACCESS_TOKEN)
 *   - Your IG Business Account ID (IG_BUSINESS_ACCOUNT_ID)
 *
 * Per org:
 *   1. Business Discovery → get target account's followers_count
 *   2. Business Discovery → paginate up to 150 recent media items
 *   3. Date filter (client-side — Meta API has no date range on Discovery)
 *   4. Claude Haiku classification (captions use hashtags/emoji, not plain keywords)
 */

const axios = require('axios');

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
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

async function fetchOrgIGData(orgName, igHandle, dateFrom, dateTo, accessToken, igBusinessAccountId, claudeKey, cb) {
  const fromTs = dateFrom ? new Date(dateFrom).getTime() : 0;
  const toTs   = dateTo   ? new Date(dateTo  ).getTime() : Date.now();

  // ── Step 1: get target account info (followers) ───────────────────────────
  let followers = 0;
  try {
    const infoRes = await axios.get(`${GRAPH_BASE}/${igBusinessAccountId}`, {
      params: {
        fields:       'business_discovery.fields(id,username,followers_count)',
        username:     igHandle,
        access_token: accessToken,
      },
      timeout: 15000,
    });
    const bd = infoRes.data?.business_discovery;
    if (!bd) {
      cb?.(`  IG: @${igHandle} — not a Business/Creator account (Business Discovery returned no data)`, 'warn');
      return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: true };
    }
    followers = bd.followers_count || 0;
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    cb?.(`  IG: @${igHandle} — ${errMsg}`, 'warn');
    return { handle: igHandle, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: true, error: errMsg };
  }

  // ── Step 2: paginate media via Business Discovery (max 3 pages × 50) ────
  const MEDIA_FIELDS = 'id,caption,timestamp,like_count,comments_count,media_type,permalink';
  let allMedia  = [];
  let afterCursor = null;
  let page      = 0;

  do {
    const mediaField = afterCursor
      ? `business_discovery.fields(media.after(${afterCursor}).limit(50){${MEDIA_FIELDS}})`
      : `business_discovery.fields(media.limit(50){${MEDIA_FIELDS}})`;

    try {
      const res = await axios.get(`${GRAPH_BASE}/${igBusinessAccountId}`, {
        params: { fields: mediaField, username: igHandle, access_token: accessToken },
        timeout: 15000,
      });
      const edge = res.data?.business_discovery?.media;
      if (!edge) break;

      allMedia.push(...(edge.data || []));
      afterCursor = edge.paging?.next ? (edge.paging?.cursors?.after || null) : null;
      page++;
      if (afterCursor) await sleep(300);
    } catch (e) {
      cb?.(`  IG: @${igHandle} media page error — ${e.message}`, 'warn');
      break;
    }
  } while (afterCursor && page < 3); // cap: 150 posts

  // ── Step 3: filter by report period ──────────────────────────────────────
  const inPeriod = allMedia.filter(m => {
    const ts = new Date(m.timestamp).getTime();
    return ts >= fromTs && ts <= toTs;
  });

  if (inPeriod.length === 0) {
    return { handle: igHandle, followers, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
  }

  // ── Step 4: classify with Claude Haiku in batches of 5 ───────────────────
  const aqMedia = [];
  for (let i = 0; i < inPeriod.length; i += 5) {
    const batch   = inPeriod.slice(i, i + 5);
    const flags   = await Promise.all(batch.map(m => classifyPost(m.caption, claudeKey)));
    flags.forEach((isAQ, j) => { if (isAQ) aqMedia.push(batch[j]); });
    if (i + 5 < inPeriod.length) await sleep(500);
  }

  const totalLikes    = aqMedia.reduce((s, m) => s + (m.like_count    || 0), 0);
  const totalComments = aqMedia.reduce((s, m) => s + (m.comments_count || 0), 0);

  const topPosts = aqMedia
    .sort((a, b) => (b.like_count || 0) - (a.like_count || 0))
    .slice(0, 3)
    .map(m => ({
      snippet:   (m.caption || '').slice(0, 300),
      url:       m.permalink || '',
      likes:     m.like_count     || 0,
      comments:  m.comments_count || 0,
      views:     0,
      date:      m.timestamp ? m.timestamp.slice(0, 10) : '',
    }));

  return {
    handle:          igHandle,
    followers,
    totalPosts:      inPeriod.length,
    aqPosts:         aqMedia.length,
    totalLikes,
    totalComments,
    topPosts,
    ig_not_available: false,
  };
}

/**
 * Collect Instagram data for all orgs.
 * @param {string[]} orgs
 * @param {string}   dateFrom              - YYYY-MM-DD
 * @param {string}   dateTo                - YYYY-MM-DD
 * @param {string}   accessToken           - long-lived Page Access Token
 * @param {string}   igBusinessAccountId   - your own IG Business Account ID
 * @param {string}   claudeKey             - Anthropic API key (for Haiku classification)
 * @param {Function} cb                    - log callback
 * @returns {Object} { [orgName]: { handle, followers, aqPosts, topPosts, ... } }
 */
async function run(orgs, dateFrom, dateTo, accessToken, igBusinessAccountId, claudeKey, cb) {
  if (!accessToken || !igBusinessAccountId) {
    cb?.('  Instagram API: missing META_ACCESS_TOKEN or IG_BUSINESS_ACCOUNT_ID — skipping', 'warn');
    return {};
  }
  if (!claudeKey) {
    cb?.('  Instagram API: no CLAUDE_KEY for Haiku classification — skipping', 'warn');
    return {};
  }

  cb?.(`  Instagram API: collecting media for ${orgs.length} orgs…`);
  const results = {};

  for (const orgName of orgs) {
    const handle = ORG_IG_HANDLES[orgName];
    if (!handle) {
      cb?.(`  IG: no handle configured for "${orgName}" — skipping`, 'warn');
      results[orgName] = { handle: null, followers: 0, totalPosts: 0, aqPosts: 0, totalLikes: 0, totalComments: 0, topPosts: [], ig_not_available: false };
      continue;
    }

    cb?.(`  IG: @${handle} (${orgName})…`);
    results[orgName] = await fetchOrgIGData(orgName, handle, dateFrom, dateTo, accessToken, igBusinessAccountId, claudeKey, cb);
    const r = results[orgName];

    if (r.ig_not_available) {
      cb?.(`  IG → ${orgName}: not available (not a Business account)`, 'warn');
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

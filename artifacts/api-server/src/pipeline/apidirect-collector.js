'use strict';
/**
 * apidirect-collector.js — Social AQ Presence via APIdirect.io
 *
 * Replaces: x-collector.js, instagram-collector.js, Serper social fallbacks
 * Platforms: LinkedIn · Twitter/X · Instagram
 * YouTube subscriber count also fetched here via APIdirect channels endpoint.
 *
 * Engagement Rate (ER) definitions:
 *   LinkedIn ER  = (likes + comments + shares) / posts * (if no followers)
 *                  OR (likes + comments + shares) / followers * 100
 *   Twitter ER   = (likes + replies + retweets) / followers * 100
 *   Instagram ER = (likes + comments) / followers * 100
 *
 * Returns per-org: { org, li, tw, ig, yt } where each platform block has:
 *   postCount, totalLikes, totalComments, totalShares/totalRetweets,
 *   totalViews, followers, er (%), topPosts [{url, snippet, likes, ...}]
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE = 'https://apidirect.io/v1';

// ── LinkedIn company_id persistent cache ──────────────────────────────────────
// Stored in linkedin-company-id-cache.json next to this file.
// Structure: { "<normalised company URL>": { company_id, name, cachedAt } }
// The linkedin/company resolution call costs ~$0.006 and is idempotent, so
// caching it means it runs once per org ever, not once per report run.
const CACHE_FILE = path.join(__dirname, 'linkedin-company-id-cache.json');

let _companyIdCache = null;

function loadCompanyIdCache() {
  if (_companyIdCache) return _companyIdCache;
  try {
    _companyIdCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    _companyIdCache = {};
  }
  return _companyIdCache;
}

function saveCompanyIdCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_companyIdCache, null, 2), 'utf8');
  } catch (e) {
    // Non-fatal — next run will just re-resolve
    console.warn('[apidirect] could not save company_id cache:', e.message);
  }
}

/** Normalise a LinkedIn company URL to a cache key (lowercase, no trailing slash). */
function normaliseLiUrl(url) {
  return url.toLowerCase().replace(/\/+$/, '');
}

/**
 * Resolve a LinkedIn company URL to { company_id, name }.
 * Returns the cached value immediately if already known; otherwise calls the
 * APIdirect linkedin/company endpoint, stores the result, and returns it.
 */
async function resolveCompanyId(companyUrl, apiKey, cb) {
  const cache = loadCompanyIdCache();
  const key   = normaliseLiUrl(companyUrl);

  if (cache[key]) {
    cb?.(`  [APIdirect/LI] company_id=${cache[key].company_id} (${cache[key].name}) — from cache`);
    return cache[key];
  }

  const data = await apiFetch('linkedin/company', { url: companyUrl }, apiKey);
  if (!data.company_id) throw new Error('linkedin/company returned no company_id');

  const entry = { company_id: data.company_id, name: data.name || companyUrl, cachedAt: new Date().toISOString() };
  cache[key] = entry;
  _companyIdCache = cache;
  saveCompanyIdCache();

  cb?.(`  [APIdirect/LI] company_id=${entry.company_id} (${entry.name}) — resolved & cached`);
  return entry;
}
// Base AQ keywords. 'pollution' removed — bare substring matches water/noise/soil/light
// pollution and produces false positives; 'air pollution' in the list already covers the AQ case.
const AQ_KW_BASE = ['air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
                    'smog', 'clean air', 'particulate', 'emission'];

// Hardcoded topic columns used as LinkedIn search queries and Instagram local filter.
// Each entry maps to exactly one column in the Social AQ report table.
const AQ_KEYWORDS_SEARCH = [
  'ncap',
  'policy regulations',
  'pm2.5',
  'stubble burning',
  'clean air finance',
  'vehicular pollution',
  'health impact',
  'industrial pollution',
  'heat-aqi',
  'brick kiln',
  'petrol emission',
  'diesel emission',
  'super emitter',
  'thermal power',
  'household pollution',
  'indoor pollution',
  'biomass',
  'rice residue',
  'wheat residue',
  'road dust',
  'air quality',
];

// Merge base keywords with user-supplied SCOPE_KEYWORDS (lowercased, deduplicated).
function buildAqKeywords(scopeKeywords) {
  const extra = Array.isArray(scopeKeywords)
    ? scopeKeywords.map(k => k.toLowerCase().trim()).filter(Boolean)
    : [];
  return [...new Set([...AQ_KW_BASE, ...extra])];
}

function isAQ(text, aqKw) {
  const t = (text || '').toLowerCase();
  return (aqKw || AQ_KW_BASE).some(k => t.includes(k));
}

// ── Adaptive per-endpoint concurrency gate ──────────────────────────────────
// APIdirect caps each endpoint at 3 concurrent requests. We start at 2 for
// headroom and ADAPT DOWN to 1 (serial) the instant an endpoint returns 429,
// so the agent backs off on its own instead of repeatedly slamming the limit.
// Each endpoint throttles independently; gating at this single choke point
// means every caller — fetchers, pagination loops, sentinel retries — inherits
// the throttle automatically.
const START_CONCURRENCY = 2;
const MIN_CONCURRENCY = 1;
const RATE_RETRY_DELAYS = [1500, 4000, 8000]; // backoff on 429 before giving up
const endpointGates = new Map(); // endpoint -> { active, limit, queue }

let _log = null;
function setLogger(cb) { _log = cb; }

function gateFor(endpoint) {
  let g = endpointGates.get(endpoint);
  if (!g) { g = { active: 0, limit: START_CONCURRENCY, queue: [] }; endpointGates.set(endpoint, g); }
  return g;
}
// Reset adaptive limits at the start of each run so a new report begins with
// full headroom (runs are sequential, so gates are idle between them).
function resetGates() {
  for (const g of endpointGates.values()) { g.limit = START_CONCURRENCY; }
}
function acquireGate(endpoint) {
  const g = gateFor(endpoint);
  if (g.active < g.limit) { g.active++; return Promise.resolve(); }
  return new Promise(res => g.queue.push(res));
}
function releaseGate(endpoint) {
  const g = gateFor(endpoint);
  g.active--;
  // Wake as many waiters as the (possibly reduced) limit now allows.
  while (g.active < g.limit && g.queue.length) { g.active++; g.queue.shift()(); }
}
// Agent-visible adaptation: a 429 means we're over the endpoint's ceiling, so
// permanently lower this endpoint's concurrency for the rest of the run.
function throttleDown(endpoint) {
  const g = gateFor(endpoint);
  if (g.limit > MIN_CONCURRENCY) {
    g.limit -= 1;
    _log?.(`  [APIdirect] concurrency limit hit on /${endpoint} → throttling to ${g.limit} concurrent for rest of run`, 'warn');
  }
}

async function apiFetch(endpoint, params, apiKey) {
  const url = `${BASE}/${endpoint}`;
  await acquireGate(endpoint);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await axios.get(url, {
          params,
          headers: { 'X-API-Key': apiKey },
          // Generous per-request ceiling: under adaptive serial throttling the
          // API can be slower to respond. Note this covers only the HTTP call —
          // gate-queue waiting happens before axios starts, so it isn't counted.
          timeout: 30000,
        });
        return data;
      } catch (e) {
        const status = e.response?.status;
        const msg = e.response?.data?.error || e.message;
        if (status === 429) {
          throttleDown(endpoint); // adapt globally, not just retry this one call
          if (attempt < RATE_RETRY_DELAYS.length) {
            await new Promise(r => setTimeout(r, RATE_RETRY_DELAYS[attempt]));
            continue;
          }
        }
        const err = new Error(`APIdirect /${endpoint}: ${msg}`);
        err.status = status;
        err.code = require('./sentinel').classifyError({ status, message: msg });
        throw err;
      }
    }
  } finally {
    releaseGate(endpoint);
  }
}

// Failure result — same metric shape as EMPTY but carries the failure so the
// report can render "unavailable" instead of a confident zero.
function failResult(EMPTY, e) {
  return {
    ...EMPTY,
    failed: true,
    failReason: e.code || require('./sentinel').classifyError(e),
    failMessage: e.message,
  };
}

// Per-post averaged Engagement Rate:
//   per-post ER = engagement_i × 100 / followers, averaged over all posts
//   = totalEngagement × 100 / (followers × postCount)
// (The old formula divided total engagement by followers once, inflating ER by ×postCount.)
function er(totalEngagement, followers, postCount) {
  if (followers > 0 && postCount > 0)
    return +((totalEngagement / postCount) / followers * 100).toFixed(3);
  if (postCount > 0) return +(totalEngagement / postCount).toFixed(2); // avg engagement/post (no followers)
  return 0;
}

// ── Date parsing + range filter ───────────────────────────────────────────────
function parseDate(s) {
  if (s == null) return null;
  if (typeof s === 'number') return new Date(s < 1e12 ? s * 1000 : s);
  const str = String(s).trim();
  if (!str) return null;
  if (/^\d{10,13}$/.test(str)) { const n = +str; return new Date(n < 1e12 ? n * 1000 : n); }
  // relative ("2 days ago", "3 hrs", "5 months ago")
  const rel = str.match(/(\d+)\s*(sec|min|hour|hr|day|week|wk|month|mon|year|yr)/i);
  if (rel) {
    const n = +rel[1], u = rel[2].toLowerCase(), d = new Date();
    if (u.startsWith('sec')) d.setSeconds(d.getSeconds() - n);
    else if (u.startsWith('min')) d.setMinutes(d.getMinutes() - n);
    else if (u.startsWith('h')) d.setHours(d.getHours() - n);
    else if (u.startsWith('d')) d.setDate(d.getDate() - n);
    else if (u.startsWith('w')) d.setDate(d.getDate() - n * 7);
    else if (u.startsWith('mon')) d.setMonth(d.getMonth() - n);
    else if (u.startsWith('year') || u.startsWith('yr')) d.setFullYear(d.getFullYear() - n);
    return d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

// Keep posts within [from, to]. Unparseable dates are kept (avoids dropping
// everything when the API date format is unexpected).
function inDateRange(dateVal, from, to) {
  if (!from && !to) return true;
  const d = parseDate(dateVal);
  if (!d) return true;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// Returns the oldest date found in a batch of posts, given one or more date field names.
function oldestInBatch(batch, ...fields) {
  let oldest = null;
  for (const p of batch) {
    for (const f of fields) {
      const d = parseDate(p[f]);
      if (d && (!oldest || d < oldest)) oldest = d;
    }
  }
  return oldest;
}

// ── LinkedIn ─────────────────────────────────────────────────────────────────
// New approach (2026-07): instead of paginating the org's full timeline via
// linkedin/company/posts (which cost ~$0.40+/org to reach a Feb start date),
// we:
//   1. Call linkedin/company once to resolve the numeric company_id
//   2. For each of the 21 hardcoded AQ keywords call linkedin/posts with
//      from_company=<id> + sort_by=most_recent, stopping per-keyword as soon
//      as the oldest post on a page predates dateFrom
//   3. Deduplicate by URL across keywords, merging keywords_found
// This keeps cost to ~$0.15–0.25/org regardless of posting frequency.
//
// Person profiles (/in/ URLs) are supported via the `author` param instead.
async function fetchLinkedIn(org, liHandle, apiKey, dateRange, aqKw, cb) {
  const EMPTY = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  const handle = liHandle ? liHandle.replace(/^@/, '').trim() : null;
  if (!handle) {
    cb?.(`  [APIdirect/LI] ${org}: no official handle — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }

  // ── Step 1: resolve filter param (company_id or author URL) ──
  const isPersonUrl = handle.includes('/in/') && !handle.includes('/company/');
  const isSchoolUrl = handle.includes('/school/');
  if (isSchoolUrl) {
    cb?.(`  [APIdirect/LI] ${org}: school page not supported by API — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }
  let filterParam;
  try {
    if (isPersonUrl) {
      const profileUrl = handle.startsWith('http') ? handle : `https://www.linkedin.com/in/${handle}`;
      filterParam = { author: profileUrl };
      cb?.(`  [APIdirect/LI] ${org}: person profile detected, using author filter`);
    } else {
      const companyUrl = handle.startsWith('http') ? handle : `https://www.linkedin.com/company/${handle}`;
      const { company_id, name } = await resolveCompanyId(companyUrl, apiKey,
        (msg) => cb?.(`  [APIdirect/LI] ${org}: ${msg.replace(/^\s+\[APIdirect\/LI\]\s*/, '')}`));
      filterParam = { from_company: String(company_id) };
      cb?.(`  [APIdirect/LI] ${org}: using company_id=${company_id} (${name})`);
    }
  } catch (e) {
    cb?.(`  [APIdirect/LI] ${org}: could not resolve profile — ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }

  // ── Step 2: search per keyword, deduplicate ──
  // seen: url → { post, keywords: Set<string> }
  const seen = new Map();
  const MAX_PAGES_PER_KW = 5;

  for (const keyword of AQ_KEYWORDS_SEARCH) {
    for (let page = 1; page <= MAX_PAGES_PER_KW; page++) {
      let data;
      try {
        data = await apiFetch('linkedin/posts', { query: keyword, sort_by: 'most_recent', page, ...filterParam }, apiKey);
      } catch (e) {
        cb?.(`  [APIdirect/LI] ${org} "${keyword}" p${page}: ${e.message}`, 'warn');
        break;
      }
      const batch = data.posts || [];
      if (!batch.length) break;

      for (const post of batch) {
        if (!inDateRange(post.date, dateRange?.from, dateRange?.to)) continue;
        const key = post.url || `${post.date}:${(post.snippet || '').slice(0, 80)}`;
        if (!seen.has(key)) seen.set(key, { post, keywords: new Set() });
        seen.get(key).keywords.add(keyword);
      }

      // Stop paginating this keyword once we've passed the date window start
      const oldest = oldestInBatch(batch, 'date');
      if (dateRange?.from && oldest && oldest < dateRange.from) break;
    }
  }

  // ── Step 3: aggregate ──
  const entries = [...seen.values()];
  const posts   = entries.map(e => e.post);

  const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
  const totalShares   = posts.reduce((s, p) => s + (p.shares   || 0), 0);
  const totalEngage   = totalLikes + totalComments + totalShares;

  const topPosts = [...entries]
    .sort((a, b) => {
      const ea = (a.post.likes || 0) + (a.post.comments || 0) + (a.post.shares || 0);
      const eb = (b.post.likes || 0) + (b.post.comments || 0) + (b.post.shares || 0);
      return eb - ea;
    })
    .map(({ post, keywords }) => ({
      url:            post.url || '',
      snippet:        (post.snippet || post.text || '').slice(0, 250),
      author:         post.author || '',
      likes:          post.likes    || 0,
      comments:       post.comments || 0,
      shares:         post.shares   || 0,
      date:           post.date     || '',
      keywords_found: [...keywords],
    }));

  const erVal = er(totalEngage, 0, posts.length);
  cb?.(`  [APIdirect/LI] ${org}: ${posts.length} AQ posts (${AQ_KEYWORDS_SEARCH.length} keyword searches), ${totalEngage} engagements`, posts.length > 0 ? 'ok' : 'warn');
  return { postCount: posts.length, totalLikes, totalComments, totalShares, totalViews: 0, followers: 0, er: erVal, topPosts, fetched: posts.length, inRangeCount: posts.length };
}

// ── Twitter / X ───────────────────────────────────────────────────────────────
// Smart pagination: fetch pages sequentially, stop as soon as the oldest tweet
// on a page predates dateFrom. Max 5 pages (~100 tweets).
async function fetchTwitter(org, twitterHandle, apiKey, dateRange, aqKw, cb) {
  const EMPTY = { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  if (!twitterHandle) {
    cb?.(`  [APIdirect/X] ${org}: no official handle — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }
  const MAX_PAGES = 5;
  try {
    const handle = twitterHandle.replace(/^@/, '');

    // Build a single search query: from:@handle + OR-chain of AQ keywords.
    // Multi-word keywords are quoted; single words are bare.
    // This costs 1–MAX_PAGES calls per org (pagination only), not 21 calls per keyword.
    const kwClause = aqKw
      .map(kw => kw.includes(' ') ? `"${kw}"` : kw)
      .join(' OR ');
    const query = `from:@${handle} (${kwClause}) -is:retweet`;

    // Fetch user followers in parallel with first search page
    const [userRes, firstPageRes] = await Promise.allSettled([
      apiFetch('twitter/user', { username: handle }, apiKey),
      apiFetch('twitter/posts', { query, page: 1 }, apiKey),
    ]);
    const followers = userRes.status === 'fulfilled' ? (userRes.value?.user?.followers_count || 0) : 0;

    if (firstPageRes.status === 'rejected') throw firstPageRes.reason;

    let allTweets = firstPageRes.value?.tweets || firstPageRes.value?.posts || [];

    // Paginate until we run out of results or cross dateFrom
    if (allTweets.length > 0) {
      const oldest = oldestInBatch(allTweets, 'date', 'created_at');
      if (!dateRange?.from || !oldest || oldest >= dateRange.from) {
        for (let page = 2; page <= MAX_PAGES; page++) {
          const r = await apiFetch('twitter/posts', { query, page }, apiKey);
          const batch = r.tweets || r.posts || [];
          if (!batch.length) break;
          allTweets = allTweets.concat(batch);
          const batchOldest = oldestInBatch(batch, 'date', 'created_at');
          if (dateRange?.from && batchOldest && batchOldest < dateRange.from) break;
        }
      }
    }

    // Date-range filter (search already AQ-filtered by query, so no keyword gate needed)
    const tweets = allTweets.filter(t => inDateRange(t.date || t.created_at, dateRange?.from, dateRange?.to));

    // Tag each tweet with which of the 21 keywords actually matched
    const tagged = tweets.map(t => {
      const text = `${t.text || t.snippet || t.title || ''}`.toLowerCase();
      return { ...t, keywords_found: aqKw.filter(kw => text.includes(kw)) };
    });

    const totalLikes    = tagged.reduce((s, t) => s + (t.likes    || 0), 0);
    const totalReplies  = tagged.reduce((s, t) => s + (t.replies  || 0), 0);
    const totalRetweets = tagged.reduce((s, t) => s + (t.retweets || 0), 0);
    const totalViews    = tagged.reduce((s, t) => s + (t.views    || 0), 0);
    const totalEngage   = totalLikes + totalReplies + totalRetweets;

    const topPosts = [...tagged]
      .sort((a, b) => ((b.likes || 0) + (b.replies || 0) + (b.retweets || 0)) - ((a.likes || 0) + (a.replies || 0) + (a.retweets || 0)))
      .slice(0, 5)
      .map(t => ({
        url:            t.url || '',
        snippet:        (t.text || t.snippet || t.title || '').slice(0, 250),
        author:         t.author || handle,
        likes:          t.likes    || 0,
        replies:        t.replies  || 0,
        retweets:       t.retweets || 0,
        views:          t.views    || 0,
        date:           t.date || t.created_at || '',
        keywords_found: t.keywords_found,
      }));

    const erVal = er(totalEngage, followers, tagged.length);
    cb?.(`  [APIdirect/X] ${org}: ${tagged.length} AQ tweets (search), ${followers.toLocaleString()} followers, ER=${erVal}%`, tagged.length > 0 ? 'ok' : 'warn');
    return { postCount: tagged.length, totalLikes, totalReplies, totalRetweets, totalViews, followers, er: erVal, topPosts, fetched: allTweets.length, inRangeCount: tagged.length };
  } catch (e) {
    cb?.(`  [APIdirect/X] ${org}: ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }
}

// ── Instagram ─────────────────────────────────────────────────────────────────
// Uses instagram/user/posts — the account's own feed by username, not a
// keyword search (same move as fetchLinkedIn(): fetch the account's own
// content directly instead of guessing authorship from search results, no
// author-substring matching needed since every post already belongs to this
// account). This endpoint has no incremental page cursor — `pages` (1-10)
// fetches that many pages (12 posts each, up to 120) in ONE call from the
// start, so there's no cheaper way to "paginate until old enough" than
// requesting the max in a single shot and checking how far back it reaches.
async function fetchInstagram(org, igHandle, apiKey, dateRange, aqKw, cb) {
  const EMPTY = { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  if (!igHandle) {
    cb?.(`  [APIdirect/IG] ${org}: no official handle — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }
  const handle = igHandle.replace(/^@/, '').trim();
  const MAX_PAGES = 10; // API ceiling — 120 posts, the most this endpoint can return in one call
  try {
    const [postsRes, userRes] = await Promise.allSettled([
      apiFetch('instagram/user/posts', { username: handle, pages: MAX_PAGES }, apiKey),
      apiFetch('instagram/user', { username: handle }, apiKey),
    ]);
    const followers = (userRes.status === 'fulfilled' && userRes.value) ? (userRes.value?.user?.follower_count || 0) : 0;

    // If posts call failed but profile succeeded, return partial data (followers known, posts unavailable)
    // rather than hard-failing the entire org — avoids ✗ for accounts where only the posts endpoint errors.
    if (postsRes.status === 'rejected') {
      const e = postsRes.reason;
      cb?.(`  [APIdirect/IG] ${org}: posts fetch failed (${e.message}) — recording 0 posts with ${followers.toLocaleString()} followers`, 'warn');
      return { ...EMPTY, followers, failed: true, failReason: e.code || require('./sentinel').classifyError(e), failMessage: e.message };
    }

    const allPosts = postsRes.value?.posts || [];
    const fetched = allPosts.length;
    const oldest = oldestInBatch(allPosts, 'date');
    // Only a coverage gap if we hit the full 120-post ceiling AND still
    // hadn't reached back before the report window — if the account has
    // fewer posts than the ceiling, we've genuinely seen its entire history.
    const hitCeiling = fetched >= MAX_PAGES * 12;
    const truncated = hitCeiling && !!dateRange?.from && (!oldest || oldest >= dateRange.from);
    if (truncated) {
      cb?.(`  [APIdirect/IG] ${org}: hit the ${MAX_PAGES}-page/${MAX_PAGES * 12}-post ceiling while still inside the date window — org posts frequently, older in-range posts may exist beyond this cap`, 'warn');
    }

    // 1) date range — no authorship filter needed, this is the account's own feed
    let posts = allPosts.filter(p => inDateRange(p.date, dateRange?.from, dateRange?.to));
    const inRange = posts.length;

    // 2) AQ relevance — use the same 21 hardcoded keywords as LinkedIn
    posts = posts.filter(p => isAQ(`${p.snippet || ''} ${p.title || ''}`, AQ_KEYWORDS_SEARCH));

    // 3) metrics + ER
    const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
    const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
    const totalViews    = posts.reduce((s, p) => s + (p.views    || 0), 0);
    const totalEngage   = totalLikes + totalComments;
    const topPosts = [...posts]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
      .slice(0, 5)
      .map(p => ({
        url:      p.url || '',
        snippet:  (p.snippet || '').slice(0, 250),
        author:   p.author || p.author_name || '',
        likes:    p.likes    || 0,
        comments: p.comments || 0,
        views:    p.views    || 0,
        date:     p.date     || '',
        isVideo:  !!p.is_video,
      }));
    const erVal = er(totalEngage, followers, posts.length);
    cb?.(`  [APIdirect/IG] ${org}: ${fetched} fetched → ${inRange} in range → ${posts.length} AQ posts, ${followers.toLocaleString()} followers, ER=${erVal}%`, posts.length > 0 ? 'ok' : 'warn');
    return { postCount: posts.length, totalLikes, totalComments, totalViews, followers, er: erVal, topPosts, fetched, inRangeCount: inRange, truncated };
  } catch (e) {
    cb?.(`  [APIdirect/IG] ${org}: ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }
}

// ── YouTube channel resolution + subscriber count ─────────────────────────────
// Used by this module's own run() (below) to show a subscriber count
// alongside LinkedIn/Twitter/Instagram in the Social Media summary table.
// youtube-er.js's own engagement-rate section resolves the channel itself via
// YouTube Data API v3 instead (channels.list?forHandle=...) — that section
// needs subscriber-hidden detection and video listing that only the official
// API exposes, so it doesn't reuse this APIdirect-based resolution.
async function fetchYouTubeChannel(org, ytHandle, apiKey, cb) {
  try {
    // Accept full YouTube URLs; Channel IDs (UC...) passed as-is; @handles have @ stripped
    const urlM = ytHandle && ytHandle.match(/youtube\.com\/(?:channel\/(UC[A-Za-z0-9_-]{22})|@([A-Za-z0-9_.-]+))/);
    const resolvedHandle = urlM ? (urlM[1] || `@${urlM[2]}`) : (ytHandle || null);
    const isChannelId = resolvedHandle && /^UC[A-Za-z0-9_-]{22}$/.test(resolvedHandle);
    const query = isChannelId ? resolvedHandle : resolvedHandle ? resolvedHandle.replace(/^@/, '') : org;
    const r = await apiFetch('youtube/channels', { query }, apiKey);
    let ch = (r.channels || [])[0];
    // When no handle/id is configured we search by org name — verify title matches.
    if (!resolvedHandle && ch) {
      const titleLower = (ch.title || '').toLowerCase();
      const orgWords = org.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matched = orgWords.filter(w => titleLower.includes(w)).length;
      if (matched === 0) {
        cb?.(`  [APIdirect/YT] ${org}: channel "${ch.title}" doesn't match org name — subscriber count skipped`, 'warn');
        ch = null;
      }
    }
    if (!ch) return { subscribers: 0, channelTitle: '', channelUrl: '', channelId: null };
    const subscribers = parseInt((ch.subscriber_count || '0').replace(/[^\d]/g, ''), 10) || 0;
    cb?.(`  [APIdirect/YT] ${org}: ${subscribers.toLocaleString()} subscribers`, 'ok');
    return { subscribers, channelTitle: ch.title || '', channelUrl: ch.url || '', channelId: ch.channel_id || null };
  } catch (e) {
    cb?.(`  [APIdirect/YT] ${org} channel: ${e.message}`, 'warn');
    return { subscribers: 0, channelTitle: '', channelUrl: '', channelId: null };
  }
}


// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {object} cfg  - must include APIDIRECT_KEY
 * @param {string[]} selectedOrgs
 * @param {object} orgHandles  - { "OrgName": { twitter?: "@handle", instagram?: "@handle", youtube?: "@handle" } }
 * @param {Function} cb
 * @returns {Promise<Array>} one entry per org
 */
async function run(cfg, selectedOrgs, orgHandles = {}, cb) {
  const apiKey = cfg.APIDIRECT_KEY;
  setLogger(cb);   // route adaptive-throttle notices into the run transcript
  resetGates();    // fresh concurrency headroom for this run
  if (!apiKey) {
    cb?.('  [APIdirect] No APIDIRECT_KEY — social collection skipped', 'warn');
    return selectedOrgs.map(org => ({
      org,
      li: { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      tw: { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      ig: { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] },
      yt: { subscribers: 0, channelTitle: '', channelUrl: '' },
    }));
  }

  const dateRange = { from: parseDate(cfg.DATE_FROM), to: parseDate(cfg.DATE_TO) };
  cb?.(`  APIdirect date window: ${dateRange.from ? dateRange.from.toISOString().slice(0,10) : '—'} → ${dateRange.to ? dateRange.to.toISOString().slice(0,10) : '—'} (smart pagination — stops when oldest post predates window start)`);
  cb?.(`  APIdirect social collection: ${selectedOrgs.length} orgs (LI + X + IG + YT channel)…`);

  // Merge base AQ keywords with user-supplied scope keywords so all filters
  // and API queries cover the full configured topic scope.
  const aqKw = buildAqKeywords(cfg.SCOPE_KEYWORDS);
  const scopeExtra = aqKw.length - AQ_KW_BASE.length;
  cb?.(`  APIdirect AQ keywords: ${aqKw.length} terms (${AQ_KW_BASE.length} base + ${scopeExtra} from scope)`);

  // Process 3 orgs at a time to stay within rate limits
  const results = [];
  for (let i = 0; i < selectedOrgs.length; i += 3) {
    const batch = selectedOrgs.slice(i, i + 3);
    const batchResults = await Promise.allSettled(batch.map(async org => {
      const handles = orgHandles[org] || {};
      const [li, tw, ig, yt] = await Promise.allSettled([
        fetchLinkedIn(org, handles.linkedin || null, apiKey, dateRange, aqKw, cb),
        fetchTwitter(org, handles.twitter || null, apiKey, dateRange, aqKw, cb),
        fetchInstagram(org, handles.instagram || null, apiKey, dateRange, aqKw, cb),
        fetchYouTubeChannel(org, handles.youtube || null, apiKey, cb),
      ]);
      // Rejected platform promises are failures, not zeros — keep the flag.
      const rejected = (res, EMPTY) =>
        res.status === 'fulfilled' ? res.value : failResult(EMPTY, res.reason || new Error('unknown'));
      return {
        org,
        li: rejected(li, { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] }),
        tw: rejected(tw, { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] }),
        ig: rejected(ig, { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] }),
        yt: yt.status === 'fulfilled' ? yt.value : { subscribers: 0, channelTitle: '', channelUrl: '' },
      };
    }));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') results.push(r.value);
    }
  }

  return results;
}

module.exports = {
  run,
  // Individual fetchers + helpers exported for the sentinel's targeted retries
  fetchLinkedIn, fetchTwitter, fetchInstagram, fetchYouTubeChannel,
  buildAqKeywords, parseDate, inDateRange, isAQ,
  AQ_KEYWORDS_SEARCH,
};

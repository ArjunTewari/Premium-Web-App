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

const BASE = 'https://apidirect.io/v1';
// Base AQ keywords. 'pollution' removed — bare substring matches water/noise/soil/light
// pollution and produces false positives; 'air pollution' in the list already covers the AQ case.
const AQ_KW_BASE = ['air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
                    'smog', 'clean air', 'particulate', 'emission'];

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

// Auto-generate a 3+ letter abbreviation from multi-word org names — same
// logic as pipeline.js's getAbbreviation(), duplicated here (small,
// self-contained, no external deps) rather than cross-required, since
// pipeline.js requires this module and a top-level require back would be
// circular. Used by the authorship filters below: LinkedIn/Instagram pages
// often use an org's acronym as their display name (e.g. "APAG"), which a
// handle-or-full-org-name-only substring check would never match.
const ABBR_STOP = new Set(['of','on','and','the','for','in','at','by','to','a','an','with','its','vs']);
function getAbbreviation(orgName) {
  const words = orgName.replace(/[^a-zA-Z\s]/g, ' ').trim().split(/\s+/)
    .filter(w => w.length > 1 && !ABBR_STOP.has(w.toLowerCase()));
  if (words.length < 2) return null;
  const abbr = words.map(w => w[0].toUpperCase()).join('');
  if (abbr.length < 3) return null;
  if (orgName.replace(/[^a-zA-Z]/g, '').length <= 6) return null; // already short/acronym
  return abbr;
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
// Smart pagination: fetch pages sequentially, stop as soon as the oldest post
// on a page predates dateFrom (we've gone far enough back in time).
// Max 3 pages — LinkedIn search ordering is less stable than a user timeline.
async function fetchLinkedIn(org, liHandle, apiKey, dateRange, aqKw, cb) {
  const EMPTY = { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  const handle = liHandle ? liHandle.replace(/^@/, '').trim() : null;
  if (!handle) {
    cb?.(`  [APIdirect/LI] ${org}: no official handle — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }
  // Was slice(0,8) — with the default 11-term AQ_KW_BASE plus user scope
  // keywords, that silently excluded up to 9 legitimate terms (e.g. "black
  // carbon", "nitrogen dioxide", "methane") from the search query ITSELF,
  // even though the AQ-relevance filter below checks the full list — a post
  // using an excluded term was never fetched in the first place, regardless
  // of how permissive that later filter is. Raised to 20 (verified: stays
  // well under a 500-char query length even with a long org name and a
  // heavier custom scope-keyword set — see test-tv-serper-query.js-style
  // verification during this fix).
  const kwClause = aqKw.slice(0, 20).map(k => `"${k}"`).join(' OR ');
  const q = `"${org}" (${kwClause})`;
  const MAX_PAGES = 3;
  try {
    // Paginate until we've seen a post older than dateFrom or hit MAX_PAGES
    let allPosts = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await apiFetch('linkedin/posts', { query: q, page, sort_by: 'most_recent' }, apiKey);
      const batch = r.posts || [];
      if (!batch.length) break;
      allPosts = allPosts.concat(batch);
      const oldest = oldestInBatch(batch, 'date');
      if (dateRange?.from && oldest && oldest < dateRange.from) break;
    }
    const fetched = allPosts.length;

    // 1) official channel only — fail closed if no author metadata. Checks
    // handle, full org name, AND the org's abbreviation (e.g. "APAG") —
    // LinkedIn pages often display as their acronym, which neither the
    // handle nor the full org name would substring-match.
    const handleLower = handle.toLowerCase();
    const orgLower = org.toLowerCase();
    const abbr = getAbbreviation(org);
    const abbrLower = abbr ? abbr.toLowerCase() : null;
    let posts = allPosts.filter(p => {
      const author = (p.author || p.author_name || p.company || '').toLowerCase();
      return author.includes(handleLower) || author.includes(orgLower) || (abbrLower && author.includes(abbrLower));
    });
    const afterAuthor = posts.length;
    if (posts.length === 0 && fetched > 0) {
      cb?.(`  [APIdirect/LI] ${org}: no posts with matching author field — ${fetched} dropped`, 'warn');
    }

    // 2) date range
    posts = posts.filter(p => inDateRange(p.date, dateRange?.from, dateRange?.to));
    const inRange = posts.length;

    // 3) AQ relevance
    posts = posts.filter(p => isAQ(
      `${p.title || ''} ${p.snippet || ''} ${p.text || ''} ${p.body || ''} ${p.content || ''}`,
      aqKw
    ));

    // 4) metrics + ER
    const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
    const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
    const totalShares   = posts.reduce((s, p) => s + (p.shares   || 0), 0);
    const totalEngage   = totalLikes + totalComments + totalShares;
    const topPosts = [...posts]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0) + (b.shares || 0)) - ((a.likes || 0) + (a.comments || 0) + (a.shares || 0)))
      .slice(0, 5)
      .map(p => ({
        url:      p.url || '',
        snippet:  (p.snippet || p.title || p.text || p.body || p.content || '').slice(0, 250),
        author:   p.author || '',
        likes:    p.likes    || 0,
        comments: p.comments || 0,
        shares:   p.shares   || 0,
        date:     p.date     || '',
      }));
    const erVal = er(totalEngage, 0, posts.length);
    cb?.(`  [APIdirect/LI] ${org}: ${fetched} fetched → ${inRange} in range → ${posts.length} AQ posts, ${totalEngage} engagements`, posts.length > 0 ? 'ok' : 'warn');
    return { postCount: posts.length, totalLikes, totalComments, totalShares, totalViews: 0, followers: 0, er: erVal, topPosts, fetched, afterAuthor, inRangeCount: inRange };
  } catch (e) {
    cb?.(`  [APIdirect/LI] ${org}: ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }
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
    // Fetch user profile and first page of tweets in parallel
    const [userRes, firstPageRes] = await Promise.allSettled([
      apiFetch('twitter/user', { username: handle }, apiKey),
      apiFetch('twitter/user/tweets', { username: handle, page: 1 }, apiKey),
    ]);
    const followers = userRes.status === 'fulfilled' ? (userRes.value?.user?.followers_count || 0) : 0;

    // A rejected first page is a FAILED fetch, not "0 tweets" — surface it so
    // the sentinel can retry and the report can render "unavailable".
    if (firstPageRes.status === 'rejected') throw firstPageRes.reason;

    // Collect all pages; page 1 already fetched above
    let allTweets = firstPageRes.value?.tweets || [];
    if (allTweets.length > 0) {
      const oldest = oldestInBatch(allTweets, 'date', 'created_at');
      if (!dateRange?.from || !oldest || oldest >= dateRange.from) {
        for (let page = 2; page <= MAX_PAGES; page++) {
          const r = await apiFetch('twitter/user/tweets', { username: handle, page }, apiKey);
          const batch = r.tweets || [];
          if (!batch.length) break;
          allTweets = allTweets.concat(batch);
          const batchOldest = oldestInBatch(batch, 'date', 'created_at');
          if (dateRange?.from && batchOldest && batchOldest < dateRange.from) break;
        }
      }
    }
    const fetched = allTweets.length;

    // 1) drop retweets
    allTweets = allTweets.filter(t => !(t.text || '').trim().startsWith('RT @') && !t.retweeted_status);

    // 2) date range
    let tweets = allTweets.filter(t => inDateRange(t.date || t.created_at, dateRange?.from, dateRange?.to));
    const inRange = tweets.length;

    // 3) AQ relevance
    tweets = tweets.filter(t => isAQ(`${t.title || ''} ${t.snippet || ''} ${t.text || ''}`, aqKw));

    // 4) metrics + ER
    const totalLikes    = tweets.reduce((s, t) => s + (t.likes    || 0), 0);
    const totalReplies  = tweets.reduce((s, t) => s + (t.replies  || 0), 0);
    const totalRetweets = tweets.reduce((s, t) => s + (t.retweets || 0), 0);
    const totalViews    = tweets.reduce((s, t) => s + (t.views    || 0), 0);
    const totalEngage   = totalLikes + totalReplies + totalRetweets;
    const topPosts = [...tweets]
      .sort((a, b) => ((b.likes || 0) + (b.replies || 0) + (b.retweets || 0)) - ((a.likes || 0) + (a.replies || 0) + (a.retweets || 0)))
      .slice(0, 5)
      .map(t => ({
        url:      t.url || '',
        snippet:  (t.snippet || t.title || t.text || '').slice(0, 250),
        author:   t.author || '',
        likes:    t.likes    || 0,
        replies:  t.replies  || 0,
        retweets: t.retweets || 0,
        views:    t.views    || 0,
        date:     t.date     || '',
      }));
    const erVal = er(totalEngage, followers, tweets.length);
    cb?.(`  [APIdirect/X] ${org}: ${fetched} fetched → ${inRange} in range → ${tweets.length} AQ tweets, ${followers.toLocaleString()} followers, ER=${erVal}%`, tweets.length > 0 ? 'ok' : 'warn');
    return { postCount: tweets.length, totalLikes, totalReplies, totalRetweets, totalViews, followers, er: erVal, topPosts, fetched, inRangeCount: inRange };
  } catch (e) {
    cb?.(`  [APIdirect/X] ${org}: ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }
}

// ── Instagram ─────────────────────────────────────────────────────────────────
// Smart pagination: fetch pages sequentially, stop as soon as the oldest post
// on a page predates dateFrom. Max 5 pages (~100 posts).
async function fetchInstagram(org, igHandle, apiKey, dateRange, aqKw, cb) {
  const EMPTY = { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
  if (!igHandle) {
    cb?.(`  [APIdirect/IG] ${org}: no official handle — skipped`, 'warn');
    return { ...EMPTY, noHandle: true };
  }
  const MAX_PAGES = 5;
  try {
    const handle = igHandle.replace(/^@/, '').toLowerCase();
    // Was slice(0,6) — same query-vs-filter keyword-coverage gap as
    // LinkedIn, just worse (up to 11 of 17 default terms excluded from the
    // query itself). Raised to 20; stays well under a safe query-length
    // margin even with a heavier custom scope-keyword set.
    const kwClause = aqKw.slice(0, 20).map(k => `"${k}"`).join(' OR ');
    const query = `${handle} (${kwClause})`;

    // Fetch user profile and first page in parallel
    const [firstPageRes, userRes] = await Promise.allSettled([
      apiFetch('instagram/posts', { query, page: 1 }, apiKey),
      apiFetch('instagram/user', { username: handle }, apiKey),
    ]);
    const followers = (userRes.status === 'fulfilled' && userRes.value) ? (userRes.value?.user?.follower_count || 0) : 0;

    // A rejected first page is a FAILED fetch, not "0 posts" — surface it.
    if (firstPageRes.status === 'rejected') throw firstPageRes.reason;

    let allPosts = firstPageRes.value?.posts || [];
    if (allPosts.length > 0) {
      const oldest = oldestInBatch(allPosts, 'date', 'taken_at');
      if (!dateRange?.from || !oldest || oldest >= dateRange.from) {
        for (let page = 2; page <= MAX_PAGES; page++) {
          const r = await apiFetch('instagram/posts', { query, page }, apiKey);
          const batch = r.posts || [];
          if (!batch.length) break;
          allPosts = allPosts.concat(batch);
          const batchOldest = oldestInBatch(batch, 'date', 'taken_at');
          if (dateRange?.from && batchOldest && batchOldest < dateRange.from) break;
        }
      }
    }
    const fetched = allPosts.length;

    // 1) official channel only — substring match against handle, org name,
    // OR the org's abbreviation (e.g. "APAG"), same pattern as
    // fetchLinkedIn(). instagram/posts is a free-text search (not scoped to
    // the account, same as linkedin/posts), so the author field can come
    // back formatted differently — display name, different case, extra
    // text — than the bare handle string used for the separate
    // instagram/user followers lookup. Exact equality was silently dropping
    // genuinely-authored posts even when the handle itself was correct
    // (proven by followers resolving fine from the same handle).
    const orgLower = org.toLowerCase();
    const abbr = getAbbreviation(org);
    const abbrLower = abbr ? abbr.toLowerCase() : null;
    let posts = allPosts.filter(p => {
      const author = (p.author || p.username || p.author_name || '').toLowerCase();
      return author.includes(handle) || author.includes(orgLower) || (abbrLower && author.includes(abbrLower));
    });
    const afterAuthor = posts.length;
    if (posts.length === 0 && fetched > 0) {
      cb?.(`  [APIdirect/IG] ${org}: no posts with matching author field — ${fetched} dropped`, 'warn');
    }

    // 2) date range
    posts = posts.filter(p => inDateRange(p.date || p.taken_at, dateRange?.from, dateRange?.to));
    const inRange = posts.length;

    // 3) AQ relevance
    posts = posts.filter(p => isAQ(
      `${p.title || ''} ${p.snippet || ''} ${p.caption || ''} ${p.description || ''} ${p.text || ''} ${p.body || ''}`,
      aqKw
    ));

    // 4) metrics + ER
    const totalLikes    = posts.reduce((s, p) => s + (p.likes    || 0), 0);
    const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
    const totalViews    = posts.reduce((s, p) => s + (p.views    || 0), 0);
    const totalEngage   = totalLikes + totalComments;
    const topPosts = [...posts]
      .sort((a, b) => ((b.likes || 0) + (b.comments || 0)) - ((a.likes || 0) + (a.comments || 0)))
      .slice(0, 5)
      .map(p => ({
        url:      p.url || '',
        snippet:  (p.snippet || p.title || p.caption || '').slice(0, 250),
        author:   p.author || p.author_name || '',
        likes:    p.likes    || 0,
        comments: p.comments || 0,
        views:    p.views    || 0,
        date:     p.date     || '',
        isVideo:  !!p.is_video,
      }));
    const erVal = er(totalEngage, followers, posts.length);
    cb?.(`  [APIdirect/IG] ${org}: ${fetched} fetched → ${inRange} in range → ${posts.length} AQ posts, ${followers.toLocaleString()} followers, ER=${erVal}%`, posts.length > 0 ? 'ok' : 'warn');
    return { postCount: posts.length, totalLikes, totalComments, totalViews, followers, er: erVal, topPosts, fetched, afterAuthor, inRangeCount: inRange };
  } catch (e) {
    cb?.(`  [APIdirect/IG] ${org}: ${e.message}`, 'warn');
    return failResult(EMPTY, e);
  }
}

// ── YouTube channel resolution + subscriber count ─────────────────────────────
// Also returns channelId now — youtube-er.js uses it to filter video-search
// results to the official channel, replacing the old Google-API forHandle
// lookup (which required YOUTUBE_KEY; this only needs APIDIRECT_KEY).
async function fetchYouTubeChannel(org, ytHandle, apiKey, cb) {
  try {
    const query = ytHandle ? ytHandle.replace(/^@/, '') : org;
    const r = await apiFetch('youtube/channels', { query }, apiKey);
    let ch = (r.channels || [])[0];
    // When no handle is configured we search by org name — verify the returned channel
    // title actually matches the org before trusting its subscriber count.
    if (!ytHandle && ch) {
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

// ── YouTube video discovery ─────────────────────────────────────────────────
// Free-text search (GET /v1/youtube/posts) — same shape as linkedin/posts and
// instagram/posts: not scoped to a channel, so results must be filtered to
// the official channel by the caller using each post's channel_id. Returns
// views but NOT likes/comments — youtube-er.js still uses YouTube Data API v3
// for those (APIdirect has no per-video engagement-stats endpoint).
async function searchYouTubeVideos(org, apiKey, aqKw, cb) {
  const kwClause = aqKw.slice(0, 8).map(k => `"${k}"`).join(' OR ');
  const query = `${org} (${kwClause})`.slice(0, 500); // APIdirect caps query at 500 chars
  try {
    const r = await apiFetch('youtube/posts', { query, pages: 1 }, apiKey);
    return { posts: r.posts || [], failed: false };
  } catch (e) {
    cb?.(`  [APIdirect/YT] ${org} video search: ${e.message}`, 'warn');
    return { posts: [], failed: true, failReason: e.code || require('./sentinel').classifyError(e), failMessage: e.message };
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
  fetchLinkedIn, fetchTwitter, fetchInstagram, fetchYouTubeChannel, searchYouTubeVideos,
  buildAqKeywords, parseDate, inDateRange,
};

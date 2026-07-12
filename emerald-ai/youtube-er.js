'use strict';
/**
 * youtube-er.js — YouTube Engagement Rate module
 *
 * Uses YouTube Data API v3 exclusively (no APIdirect dependency) — the same
 * "fetch the account's own content directly" move applied to LinkedIn
 * (company/posts) and Instagram (user/posts) this session, adapted to
 * YouTube's actual API: there's no single "channel timeline" endpoint, but
 * search.list scoped to channelId + type=video + order=date, with
 * publishedAfter/publishedBefore doing the date-range filtering SERVER-SIDE,
 * gets the same result — the channel's own videos, already date-bounded, no
 * keyword search and no post-hoc channel-matching needed.
 *
 * For each org:
 *   1. channels.list?forHandle=... resolves the channel_id, title, and
 *      subscriber count (incl. hidden-count detection) in one call.
 *   2. search.list?channelId=...&type=video&order=date&publishedAfter=...
 *      &publishedBefore=... lists this channel's videos already scoped to
 *      the report window, paginated via pageToken up to a page cap (each
 *      page costs 100 quota units — see MAX_SEARCH_PAGES below).
 *   3. AQ-relevance filter (client-side, on title+description) — search.list
 *      has no keyword param that stays channel+date scoped at the same time.
 *   4. videos.list for likes/comments/views (search.list returns snippet
 *      only, no statistics).
 *   5. ER = (likes + comments) / subscribers * 100
 *      Fallback to view-ER when subscriber count is hidden: (likes+comments)/views*100
 *
 * Quota cost note: search.list is expensive (100 units/page vs 1 unit for
 * channels.list/videos.list). MAX_SEARCH_PAGES=3 (150 videos/org) caps this
 * at 300 units/org for discovery; YouTube's default daily quota is 10,000
 * units, so budget roughly 30 orgs/day before hitting it.
 */

const axios = require('axios');
const APIdirect = require('./apidirect-collector'); // reused for parseDate() and isAQ() only — no API calls to APIdirect from this module

const YT_AQ_BASE = ['air quality', 'air pollution', 'AQI', 'PM2.5', 'NCAP'];

// Base AQ terms + user SCOPE_KEYWORDS, capped at 15 (matches apidirect-collector.js's
// convention of slicing keyword lists before building a query clause).
function buildYtAqTerms(scopeKeywords) {
  const extra = Array.isArray(scopeKeywords) ? scopeKeywords.slice(0, 10) : [];
  return [...new Set([...YT_AQ_BASE, ...extra])].slice(0, 15);
}

const YT_VIDEOS_URL   = 'https://www.googleapis.com/youtube/v3/videos';
const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';
const YT_SEARCH_URL   = 'https://www.googleapis.com/youtube/v3/search';
const MAX_SEARCH_PAGES = 3; // 150 videos — see quota-cost note above

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Extract video ID from any YouTube URL format ───────────────────────────
function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  // Standard: youtube.com/watch?v=ID
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:[&?#]|$)/);
  if (m) return m[1];
  // Short: youtu.be/ID
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?#]|$)/);
  if (m) return m[1];
  // Shorts: youtube.com/shorts/ID
  m = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/);
  if (m) return m[1];
  // Embed or /v/: youtube.com/embed/ID or youtube.com/v/ID
  m = url.match(/\/(?:embed|v)\/([a-zA-Z0-9_-]{11})(?:[?#/]|$)/);
  if (m) return m[1];
  return null;
}

// ─── Resolve a channel by handle or channel ID ──────────────────────────────
// Accepts either "@handle" / "handle" or a raw YouTube channel ID ("UC...").
async function resolveChannel(ytHandle, apiKey) {
  const isChannelId = /^UC[A-Za-z0-9_-]{22}$/.test(ytHandle);
  const params = isChannelId
    ? { part: 'snippet,statistics', id: ytHandle, key: apiKey }
    : { part: 'snippet,statistics', forHandle: `@${ytHandle.replace(/^@/, '')}`, key: apiKey };
  const { data } = await axios.get(YT_CHANNELS_URL, { params, timeout: 20000 });
  const item = (data.items || [])[0];
  if (!item) return null;
  const s = item.statistics || {};
  return {
    channelId: item.id,
    channelTitle: item.snippet?.title || '',
    subscribers: parseInt(s.subscriberCount || '0', 10),
    subscribersHidden: s.hiddenSubscriberCount === true,
  };
}

// ─── List a channel's videos already scoped to the date window ─────────────
async function discoverChannelVideos(channelId, dateRange, apiKey) {
  let videos = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    const { data } = await axios.get(YT_SEARCH_URL, {
      params: {
        part: 'snippet',
        channelId,
        type: 'video',
        order: 'date',
        publishedAfter: dateRange.from ? dateRange.from.toISOString() : undefined,
        publishedBefore: dateRange.to ? dateRange.to.toISOString() : undefined,
        maxResults: 50,
        pageToken,
        key: apiKey,
      },
      timeout: 20000,
    });
    const items = data.items || [];
    videos = videos.concat(items.map((it) => ({
      video_id: it.id?.videoId || '',
      title: it.snippet?.title || '',
      description: it.snippet?.description || '',
      date: it.snippet?.publishedAt || '',
      channel_id: it.snippet?.channelId || channelId,
      url: it.id?.videoId ? `https://www.youtube.com/watch?v=${it.id.videoId}` : '',
    })));
    pageToken = data.nextPageToken;
    pages++;
    if (pageToken && pages >= MAX_SEARCH_PAGES) { truncated = true; break; }
  } while (pageToken);
  return { videos, truncated };
}

// ─── Batch fetch video stats (max 50 IDs per call) ─────────────────────────
// search.list returns snippet only — no statistics — so this call is still
// required regardless of discovery method.
async function fetchVideoStats(videoIds, apiKey) {
  if (!videoIds.length) return {};
  const out = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const { data } = await axios.get(YT_VIDEOS_URL, {
      params: { part: 'statistics,snippet', id: batch.join(','), key: apiKey },
      timeout: 20000,
    });
    for (const item of data.items || []) {
      const s = item.statistics || {};
      out[item.id] = {
        title:       item.snippet?.title || '',
        publishedAt: item.snippet?.publishedAt || '',
        views:       parseInt(s.viewCount    || '0', 10),
        likes:       parseInt(s.likeCount    || '0', 10),
        comments:    parseInt(s.commentCount || '0', 10),
      };
    }
  }
  return out;
}

function classifyYtError(e, cb) {
  const status = e.response?.status;
  const reason = e.response?.data?.error?.errors?.[0]?.reason || '';
  const msg    = e.response?.data?.error?.message || e.message;
  cb?.(`  [YouTubeER] YouTube API error HTTP ${status || '?'} ${reason}: ${msg}`, 'warn');
  if (status === 403) {
    cb?.('  [YouTubeER] 403 Fix: enable "YouTube Data API v3" in Google Cloud Console for this API key, and remove any HTTP-referrer restrictions on the key.', 'warn');
  } else if (status === 400) {
    cb?.('  [YouTubeER] 400 Fix: check the API key value — it may be malformed or belong to the wrong project.', 'warn');
  }
  return { failReason: require('./sentinel').classifyError({ status, message: msg }), failMessage: msg };
}

const EMPTY_RESULT = { videos: [], videoCount: 0, avgER: 0, avgViewER: 0, totalViews: 0, totalLikes: 0, totalComments: 0, erMethod: 'none' };

// ─── Main run ───────────────────────────────────────────────────────────────
async function run(cfg, selectedOrgs, cb) {
  const YOUTUBE_KEY = cfg.YOUTUBE_KEY    || '';
  const ORG_HANDLES = cfg.ORG_YT_HANDLES || {};

  if (!YOUTUBE_KEY) {
    cb?.('[YouTubeER] No YOUTUBE_KEY — YouTube Data API v3 required for both discovery and stats, skipping entirely', 'warn');
    return selectedOrgs.map((org) => ({ org, ...EMPTY_RESULT, noKey: true }));
  }

  cb?.(`[YouTubeER] Searching YouTube (Data API v3) for ${selectedOrgs.length} orgs...`);

  const aqKw = buildYtAqTerms(cfg.SCOPE_KEYWORDS);
  const dateRange = { from: APIdirect.parseDate(cfg.DATE_FROM), to: APIdirect.parseDate(cfg.DATE_TO) };

  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [YouTubeER] "${orgName}"...`);
    const orgHandle = ORG_HANDLES[orgName] || null;

    if (!orgHandle) {
      cb?.(`  [YouTubeER] ${orgName}: no YT handle configured — skipping`, 'warn');
      orgResults.push({ org: orgName, ...EMPTY_RESULT, noHandle: true });
      continue;
    }

    // ── Step 1: resolve official channel + subscriber count ──────────────
    let channel;
    try {
      channel = await resolveChannel(orgHandle, YOUTUBE_KEY);
    } catch (e) {
      const { failReason, failMessage } = classifyYtError(e, cb);
      orgResults.push({ org: orgName, ...EMPTY_RESULT, failed: true, failReason, failMessage });
      continue;
    }
    if (!channel) {
      cb?.(`  [YouTubeER] ${orgName}: could not resolve channel for handle ${orgHandle}`, 'warn');
      orgResults.push({ org: orgName, ...EMPTY_RESULT, handleUnresolved: true });
      continue;
    }
    cb?.(`  [YouTubeER] ${orgName}: resolved channel "${channel.channelTitle}" (${channel.subscribers.toLocaleString()} subscribers)`, 'ok');

    // ── Step 2: this channel's videos in the date window (server-side date filter) ──
    let discoveredVideos, truncated;
    try {
      ({ videos: discoveredVideos, truncated } = await discoverChannelVideos(channel.channelId, dateRange, YOUTUBE_KEY));
    } catch (e) {
      const { failReason, failMessage } = classifyYtError(e, cb);
      orgResults.push({ org: orgName, ...EMPTY_RESULT, discovered: 0, failed: true, failReason, failMessage });
      continue;
    }
    if (truncated) {
      cb?.(`  [YouTubeER] ${orgName}: hit the ${MAX_SEARCH_PAGES}-page video-search cap while still inside the date window — org uploads frequently, older in-range videos may exist beyond this cap`, 'warn');
    }
    const discoveredCount = discoveredVideos.length;

    // ── Step 3: AQ-relevance filter ───────────────────────────────────────
    const candidates = discoveredVideos.filter((v) => APIdirect.isAQ(`${v.title} ${v.description}`, aqKw));

    if (!candidates.length) {
      const diag = discoveredCount === 0
        ? 'no videos found on this channel within the report date window'
        : `${discoveredCount} video(s) found in the date window but none matched the AQ keywords — zero is genuine`;
      cb?.(`  [YouTubeER] ${orgName}: 0 videos — ${diag}`, 'warn');
      orgResults.push({ org: orgName, ...EMPTY_RESULT, discovered: discoveredCount, truncated });
      continue;
    }

    // ── Step 4: per-video stats (views/likes/comments) ────────────────────
    let videoStats = {};
    let statsFailed = false, statsFailReason = null, statsFailMessage = null;
    try {
      videoStats = await fetchVideoStats(candidates.map((v) => v.video_id).filter(Boolean), YOUTUBE_KEY);
    } catch (e) {
      ({ failReason: statsFailReason, failMessage: statsFailMessage } = classifyYtError(e, cb));
      statsFailed = true;
    }

    // ── Step 5: assemble per-video data and calculate ER ─────────────────
    const videos = candidates.map((v) => {
      const vs = videoStats[v.video_id];
      const views = vs?.views ?? null;
      const likes = vs?.likes ?? null;
      const comments = vs?.comments ?? null;
      const subscribers = channel.subscribers;
      const subsHidden = channel.subscribersHidden;

      let subscriberER = null, viewER = null, erMethod = 'none';
      if (likes !== null && comments !== null) {
        const engagement = likes + comments;
        if (!subsHidden && subscribers > 0) {
          subscriberER = parseFloat(((engagement / subscribers) * 100).toFixed(3));
          erMethod = 'subscriber';
        }
        if (views && views > 0) {
          viewER = parseFloat(((engagement / views) * 100).toFixed(3));
          if (erMethod === 'none') erMethod = 'view';
        }
      }

      return {
        videoId: v.video_id,
        url: v.url,
        title: vs?.title || v.title || '',
        publishedAt: vs?.publishedAt || v.date || '',
        channelId: v.channel_id,
        channelName: channel.channelTitle,
        subscribers, subsHidden, views, likes, comments, subscriberER, viewER, erMethod,
      };
    });

    const subERVideos  = videos.filter((v) => v.subscriberER !== null);
    const viewERVideos = videos.filter((v) => v.viewER !== null);
    let avgER = 0, avgViewER = 0, erMethod = 'none';
    if (subERVideos.length)  { avgER = parseFloat((subERVideos.reduce((s, v) => s + v.subscriberER, 0) / subERVideos.length).toFixed(3)); erMethod = 'subscriber'; }
    if (viewERVideos.length) { avgViewER = parseFloat((viewERVideos.reduce((s, v) => s + v.viewER, 0) / viewERVideos.length).toFixed(3)); if (erMethod === 'none') erMethod = 'view'; }

    const totalViews    = videos.reduce((s, v) => s + (v.views    ?? 0), 0);
    const totalLikes    = videos.reduce((s, v) => s + (v.likes    ?? 0), 0);
    const totalComments = videos.reduce((s, v) => s + (v.comments ?? 0), 0);

    cb?.(`  [YouTubeER] ${orgName}: ${videos.length} AQ videos in window | avgER=${avgER}% (${erMethod}) | views=${totalViews.toLocaleString()}`, videos.length > 0 ? 'ok' : 'warn');

    orgResults.push({
      org: orgName,
      videos, videoCount: videos.length,
      avgER, avgViewER, erMethod,
      totalViews, totalLikes, totalComments,
      discovered: discoveredCount, truncated,
      failed: statsFailed, failReason: statsFailed ? statsFailReason : null, failMessage: statsFailed ? statsFailMessage : null,
    });
  }

  // Rank by avgER (subscriber-based), then avgViewER, then videoCount
  orgResults.sort((a, b) =>
    (b.avgER - a.avgER) || (b.avgViewER - a.avgViewER) || (b.videoCount - a.videoCount)
  );
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.('[YouTubeER] Complete', 'ok');
  return orgResults;
}

// ─── HTML section ───────────────────────────────────────────────────────────
function buildYoutubeERHtml(results, hasApiKey) {
  if (!results?.length) return '';

  const orgsWithVideos = results.filter(r => r.videoCount > 0).length;
  const orgsWithER     = results.filter(r => r.avgER > 0 || r.avgViewER > 0).length;
  const totalVideos    = results.reduce((s, r) => s + r.videoCount, 0);
  const totalViews     = results.reduce((s, r) => s + r.totalViews, 0);
  const topOrg         = results[0];
  const maxER          = Math.max(...results.map(r => r.avgER || r.avgViewER), 0.01);

  const methodNote = !hasApiKey
    ? `<div style="background:rgba(201,146,42,.08);border:1px solid rgba(201,146,42,.3);border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:12px;color:#d4a017;line-height:1.7">
        <strong>&#9432; YOUTUBE_KEY not configured</strong> — YouTube Data API v3 is required for both video discovery and engagement stats; without it this section is skipped entirely. Add <code style="background:#1e2638;padding:1px 5px;border-radius:3px">YOUTUBE_KEY</code> (Google API key with YouTube Data API v3 enabled) to unlock this section.
      </div>`
    : `<div style="background:rgba(76,175,116,.06);border:1px solid rgba(76,175,116,.2);border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:12px;color:#8fa3b8;line-height:1.7">
        <strong style="color:#4caf74">Methodology:</strong> YouTube Data API v3 resolves the official channel (<code style="background:#1e2638;padding:1px 5px;border-radius:3px">channels.list?forHandle</code>), lists its videos already scoped to the report window (<code style="background:#1e2638;padding:1px 5px;border-radius:3px">search.list?channelId&order=date&publishedAfter/Before</code>), then fetches live likes/comments/view stats per video. <strong>Subscriber ER</strong> = (likes + comments) / subscribers × 100. <strong>View ER</strong> used as fallback when subscriber count is hidden.
      </div>`;

  const statCards = [
    { label: 'Orgs with YT videos', value: orgsWithVideos, unit: `of ${results.length} tracked`, col: '#ff0000' },
    { label: 'Videos discovered',   value: totalVideos,    unit: 'via YouTube Data API v3',       col: '#e53935' },
    { label: 'Total views',         value: totalViews > 999999 ? `${(totalViews/1000000).toFixed(1)}M` : totalViews > 999 ? `${(totalViews/1000).toFixed(0)}K` : totalViews,
                                    unit: 'cumulative',                                             col: '#ef5350' },
    { label: 'Best ER',             value: topOrg?.avgER || topOrg?.avgViewER || '—',
                                    unit: `${topOrg?.org || ''} (${topOrg?.erMethod || 'n/a'}-based)`, col: '#c9922a' },
  ].map(c => `
    <div style="flex:1;min-width:150px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:14px 16px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:7px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:11px;color:#5e7494;margin-top:4px">${c.unit}</div>
    </div>`).join('');

  const orgRows = results.map(r => {
    const er     = r.avgER || r.avgViewER;
    const erPct  = maxER > 0 ? Math.round((er / maxER) * 100) : 0;
    const hasER  = er > 0;
    const col    = r.videoCount > 0 ? '#e53935' : '#252d40';
    const erLabel = r.avgER > 0 ? `${r.avgER}%` : r.avgViewER > 0 ? `${r.avgViewER}% (view)` : '—';

    const topVideos = [...r.videos]
      .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
      .slice(0, 3);

    const videoCards = topVideos.length
      ? topVideos.map(v => {
          const erDisplay = v.subscriberER !== null
            ? `<span style="color:#4caf74">${v.subscriberER}% ER</span>`
            : v.viewER !== null
              ? `<span style="color:#c9922a">${v.viewER}% view-ER</span>`
              : '<span style="color:#3a4a5e">no ER</span>';
          const statsRow = v.views !== null
            ? `<span style="color:#5e7494">${(v.views||0).toLocaleString()} views · ${(v.likes||0).toLocaleString()} likes · ${(v.comments||0).toLocaleString()} comments</span>`
            : '<span style="color:#3a4a5e">metrics not fetched</span>';
          return `
          <div style="margin-top:8px;padding:8px 10px;background:#0a0e17;border-left:2px solid #e53935;border-radius:0 4px 4px 0">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
              <div style="flex:1">
                <div style="font-size:11px;color:#d8e4f0;line-height:1.4;margin-bottom:4px">${esc(v.title).slice(0, 80)}</div>
                <div style="font-family:monospace;font-size:10px;margin-bottom:2px">${statsRow}</div>
                <div style="font-size:10px;color:#5e7494">${esc(v.channelName) || 'Channel unknown'}</div>
              </div>
              <div style="flex-shrink:0;text-align:right">
                <div style="font-family:monospace;font-size:12px;font-weight:700">${erDisplay}</div>
                ${v.url ? `<a href="${esc(v.url)}" target="_blank" style="font-size:10px;color:#e53935;text-decoration:none">↗ watch</a>` : ''}
              </div>
            </div>
          </div>`;
        }).join('')
      : `<div style="margin-top:8px;font-size:11px;color:#3a4a5e">No YouTube videos indexed in this period</div>`;

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 20px;border-left:3px solid ${col}">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex-shrink:0;width:28px;font-family:monospace;font-size:14px;font-weight:700;color:#5e7494;padding-top:2px">#${r.rank}</div>
        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
            <div style="font-family:monospace;font-size:12px;font-weight:700;color:#d8e4f0">${esc(r.org)}</div>
            <div style="font-size:11px;color:#5e7494">${r.videoCount} video${r.videoCount === 1 ? '' : 's'}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${erPct}%;background:${hasER ? '#e53935' : '#1e2638'};border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:13px;font-weight:700;color:${hasER ? '#e53935' : '#3a4a5e'};width:80px;text-align:right">${erLabel}</span>
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:#5e7494;margin-bottom:4px">
            <span><strong style="color:#d8e4f0">${r.totalViews.toLocaleString()}</strong> views</span>
            <span><strong style="color:#d8e4f0">${r.totalLikes.toLocaleString()}</strong> likes</span>
            <span><strong style="color:#d8e4f0">${r.totalComments.toLocaleString()}</strong> comments</span>
          </div>
          ${videoCards}
        </div>
      </div>
    </div>`;
  }).join('');

  return `
<section class="sec" id="youtube-er">
  <div class="sh">
    <div class="se">Section 08c</div>
    <h2 class="st">YouTube Engagement Rate</h2>
    <div class="sd">Real engagement metrics from YouTube Data API v3. Videos discovered, channel-matched, and stats fetched live per video — all via the official API.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">${statCards}</div>

  ${methodNote}

  <div style="display:flex;flex-direction:column;gap:10px">${orgRows}</div>
</section>`;
}

module.exports = { run, buildYoutubeERHtml, extractVideoId };

'use strict';
/**
 * youtube-er.js — YouTube Engagement Rate module
 *
 * For each org:
 *   1. APIdirect youtube/channels to resolve the org's official channel_id
 *      (needs only APIDIRECT_KEY — no dependency on YOUTUBE_KEY)
 *   2. APIdirect youtube/posts to discover AQ-related videos (free-text
 *      search, same shape as linkedin/posts and instagram/posts — not
 *      scoped to a channel, so results are filtered to the official
 *      channel using each post's channel_id)
 *   3. Client-side date-range filter — APIdirect's upload_date param only
 *      supports last_hour/today/this_week/this_month/this_year, not an
 *      arbitrary custom range, so DATE_FROM/DATE_TO filtering happens here
 *   4. YouTube Data API v3 /videos for views/likes/comments — APIdirect's
 *      video search returns views but not engagement counts
 *   5. YouTube Data API v3 /channels for subscriber-hidden detection
 *   6. ER = (likes + comments) / subscribers * 100
 *      Fallback to view-ER when subscriber count is hidden: (likes+comments)/views*100
 */

const axios = require('axios');
const APIdirect = require('./apidirect-collector');

const YT_AQ_BASE = ['air quality', 'air pollution', 'AQI', 'PM2.5', 'NCAP'];

// Base AQ terms + user SCOPE_KEYWORDS, capped at 15 (matches apidirect-collector.js's
// convention of slicing keyword lists before building a query clause).
function buildYtAqTerms(scopeKeywords) {
  const extra = Array.isArray(scopeKeywords) ? scopeKeywords.slice(0, 10) : [];
  return [...new Set([...YT_AQ_BASE, ...extra])].slice(0, 15);
}

const YT_VIDEOS_URL  = 'https://www.googleapis.com/youtube/v3/videos';
const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

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

// ─── Batch fetch video stats (max 50 IDs per call) ─────────────────────────
// Still YouTube Data API v3 — APIdirect's youtube/posts returns views but no
// likes/comments, and there's no APIdirect endpoint for per-video engagement
// stats at all.
async function fetchVideoStats(videoIds, apiKey) {
  if (!videoIds.length) return {};
  const out = {};
  // Chunk into batches of 50
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    try {
      const { data } = await axios.get(YT_VIDEOS_URL, {
        params: { part: 'statistics,snippet', id: batch.join(','), key: apiKey },
        timeout: 20000,
      });
      for (const item of data.items || []) {
        const s = item.statistics || {};
        out[item.id] = {
          channelId:    item.snippet?.channelId || '',
          channelTitle: item.snippet?.channelTitle || '',
          title:        item.snippet?.title || '',
          publishedAt:  item.snippet?.publishedAt || '',
          views:        parseInt(s.viewCount    || '0', 10),
          likes:        parseInt(s.likeCount    || '0', 10),
          comments:     parseInt(s.commentCount || '0', 10),
        };
      }
    } catch (e) {
      // quota exceeded or bad key — caller handles
      throw e;
    }
  }
  return out;
}

// ─── Batch fetch channel stats (max 50 IDs per call) ───────────────────────
// Still YouTube Data API v3 — APIdirect's channel search doesn't expose
// hiddenSubscriberCount, which the ER fallback logic depends on.
async function fetchChannelStats(channelIds, apiKey) {
  if (!channelIds.length) return {};
  const out = {};
  const unique = [...new Set(channelIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const { data } = await axios.get(YT_CHANNELS_URL, {
        params: { part: 'statistics,snippet', id: batch.join(','), key: apiKey },
        timeout: 20000,
      });
      for (const item of data.items || []) {
        const s = item.statistics || {};
        out[item.id] = {
          name:              item.snippet?.title || '',
          subscribers:       parseInt(s.subscriberCount || '0', 10),
          subscribersHidden: s.hiddenSubscriberCount === true,
          totalViews:        parseInt(s.viewCount || '0', 10),
          videoCount:        parseInt(s.videoCount || '0', 10),
        };
      }
    } catch (e) {
      throw e;
    }
  }
  return out;
}

// ─── Main run ───────────────────────────────────────────────────────────────
async function run(cfg, selectedOrgs, cb) {
  const YOUTUBE_KEY   = cfg.YOUTUBE_KEY    || '';
  const APIDIRECT_KEY = cfg.APIDIRECT_KEY  || '';
  const ORG_HANDLES   = cfg.ORG_YT_HANDLES || {};

  if (!APIDIRECT_KEY) {
    cb?.('[YouTubeER] No APIDIRECT_KEY — skipping', 'warn');
    return [];
  }
  if (!YOUTUBE_KEY) {
    cb?.('[YouTubeER] No YOUTUBE_KEY — engagement stats (likes/comments) unavailable, views only', 'warn');
  }

  cb?.(`[YouTubeER] Searching YouTube (APIdirect) for ${selectedOrgs.length} orgs...`);

  const aqKw = buildYtAqTerms(cfg.SCOPE_KEYWORDS);
  const dateRange = { from: APIdirect.parseDate(cfg.DATE_FROM), to: APIdirect.parseDate(cfg.DATE_TO) };

  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [YouTubeER] "${orgName}"...`);

    const orgHandle = ORG_HANDLES[orgName] || null;

    // If no handle configured at all, skip this org for YT
    if (!orgHandle) {
      cb?.(`  [YouTubeER] ${orgName}: no YT handle configured — skipping`, 'warn');
      orgResults.push({
        org: orgName, videos: [], videoCount: 0,
        avgER: 0, avgViewER: 0, totalViews: 0, totalLikes: 0, totalComments: 0,
        erMethod: 'none', noHandle: true,
      });
      continue;
    }

    // ── Step 1: resolve official channel via APIdirect (needs only APIDIRECT_KEY) ──
    const channelInfo = await APIdirect.fetchYouTubeChannel(orgName, orgHandle, APIDIRECT_KEY, cb);
    const officialChannelId = channelInfo.channelId;
    const handleUnresolved = !officialChannelId;
    if (handleUnresolved) {
      cb?.(`  [YouTubeER] ${orgName}: could not resolve channel for handle ${orgHandle}`, 'warn');
    }

    // ── Step 2: discover AQ-related videos via APIdirect ───────────────────
    const searchResult = await APIdirect.searchYouTubeVideos(orgName, APIDIRECT_KEY, aqKw, cb);
    if (searchResult.failed) {
      cb?.(`  [YouTubeER] ${orgName}: video discovery failed — ${searchResult.failMessage}`, 'warn');
      orgResults.push({
        org: orgName, videos: [], videoCount: 0,
        avgER: 0, avgViewER: 0, totalViews: 0, totalLikes: 0, totalComments: 0,
        erMethod: 'none', discovered: 0, handleUnresolved,
        failed: true, failReason: searchResult.failReason, failMessage: searchResult.failMessage,
      });
      continue;
    }
    const discovered = searchResult.posts;

    // ── Step 3: filter to official channel, then to the report date window ──
    let candidates = officialChannelId
      ? discovered.filter(p => p.channel_id === officialChannelId)
      : []; // can't verify official channel — don't show an unverified count as if genuine
    const afterChannel = candidates.length;

    candidates = candidates.filter(p => APIdirect.inDateRange(p.date, dateRange.from, dateRange.to));
    const inRangeCount = candidates.length;

    if (!candidates.length) {
      const diag = discovered.length === 0
        ? 'no videos discovered via APIdirect for this org/keyword combination'
        : handleUnresolved
          ? `APIdirect found ${discovered.length} video(s) but the channel handle couldn't be resolved to confirm they're from the official channel`
          : afterChannel === 0
            ? `APIdirect found ${discovered.length} video(s) but none matched the resolved official channel`
            : `${afterChannel} video(s) matched the official channel but none fall in the report date window`;
      cb?.(`  [YouTubeER] ${orgName}: 0 videos — ${diag}`, 'warn');
      orgResults.push({
        org: orgName, videos: [], videoCount: 0,
        avgER: 0, avgViewER: 0, totalViews: 0, totalLikes: 0, totalComments: 0,
        erMethod: 'none', discovered: discovered.length, afterChannel, inRangeCount, handleUnresolved,
      });
      continue;
    }

    // ── Step 4 & 5: YouTube Data API v3 for likes/comments/subscriber-hidden ──
    let videoStats = {};
    let channelStats = {};
    let statsFailed = false, statsFailReason = null, statsFailMessage = null;

    if (YOUTUBE_KEY) {
      try {
        const videoIds = candidates.map(p => p.video_id).filter(Boolean);
        videoStats = await fetchVideoStats(videoIds, YOUTUBE_KEY);
        channelStats = await fetchChannelStats([officialChannelId].filter(Boolean), YOUTUBE_KEY);
      } catch (e) {
        const status = e.response?.status;
        const reason = e.response?.data?.error?.errors?.[0]?.reason || '';
        const msg    = e.response?.data?.error?.message || e.message;
        cb?.(`  [YouTubeER] YouTube API error (${orgName}) HTTP ${status || '?'} ${reason}: ${msg}`, 'warn');
        if (status === 403) {
          cb?.('  [YouTubeER] 403 Fix: enable "YouTube Data API v3" in Google Cloud Console for this API key, and remove any HTTP-referrer restrictions on the key.', 'warn');
        } else if (status === 400) {
          cb?.('  [YouTubeER] 400 Fix: check the API key value — it may be malformed or belong to the wrong project.', 'warn');
        }
        statsFailed = true;
        statsFailReason = require('./sentinel').classifyError({ status, message: msg });
        statsFailMessage = msg;
      }
    }

    // ── Step 6: assemble per-video data and calculate ER ─────────────────
    const videos = candidates.map(p => {
      const vid = p.video_id;
      const vs  = videoStats[vid];
      const cs  = officialChannelId ? channelStats[officialChannelId] : null;

      const views       = vs?.views ?? (typeof p.views === 'number' ? p.views : null);
      const likes       = vs?.likes    ?? null;
      const comments    = vs?.comments ?? null;
      const subscribers = cs?.subscribers ?? null;
      const subsHidden  = cs?.subscribersHidden ?? false;

      let subscriberER = null;
      let viewER       = null;
      let erMethod     = 'none';

      if (likes !== null && comments !== null) {
        const engagement = likes + comments;
        if (!subsHidden && subscribers && subscribers > 0) {
          subscriberER = parseFloat(((engagement / subscribers) * 100).toFixed(3));
          erMethod = 'subscriber';
        }
        if (views && views > 0) {
          viewER = parseFloat(((engagement / views) * 100).toFixed(3));
          if (erMethod === 'none') erMethod = 'view';
        }
      }

      return {
        videoId:     vid,
        url:         p.url || (vid ? `https://www.youtube.com/watch?v=${vid}` : ''),
        title:       vs?.title || p.title || '',
        publishedAt: vs?.publishedAt || p.date || '',
        channelId:   p.channel_id || '',
        channelName: cs?.name || p.author || '',
        subscribers,
        subsHidden,
        views,
        likes,
        comments,
        subscriberER,
        viewER,
        erMethod,
      };
    });

    // Determine the org-level ER method (prefer subscriber-based)
    const subERVideos  = videos.filter(v => v.subscriberER !== null);
    const viewERVideos = videos.filter(v => v.viewER !== null);

    let avgER     = 0;
    let avgViewER = 0;
    let erMethod  = 'none';

    if (subERVideos.length) {
      avgER    = parseFloat((subERVideos.reduce((s, v) => s + v.subscriberER, 0) / subERVideos.length).toFixed(3));
      erMethod = 'subscriber';
    }
    if (viewERVideos.length) {
      avgViewER = parseFloat((viewERVideos.reduce((s, v) => s + v.viewER, 0) / viewERVideos.length).toFixed(3));
      if (erMethod === 'none') erMethod = 'view';
    }

    const totalViews    = videos.reduce((s, v) => s + (v.views    ?? 0), 0);
    const totalLikes    = videos.reduce((s, v) => s + (v.likes    ?? 0), 0);
    const totalComments = videos.reduce((s, v) => s + (v.comments ?? 0), 0);

    cb?.(`  [YouTubeER] ${orgName}: ${videos.length} official-channel videos in window | avgER=${avgER}% (${erMethod}) | views=${totalViews.toLocaleString()}`, videos.length > 0 ? 'ok' : 'warn');

    orgResults.push({
      org: orgName,
      videos:       videos,
      videoCount:   videos.length,
      avgER,
      avgViewER,
      erMethod,
      totalViews,
      totalLikes,
      totalComments,
      discovered: discovered.length,
      afterChannel,
      inRangeCount,
      handleUnresolved,
      failed: statsFailed,
      failReason: statsFailed ? statsFailReason : null,
      failMessage: statsFailed ? statsFailMessage : null,
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
        <strong>&#9432; YOUTUBE_KEY not configured</strong> — videos discovered and channel-matched via APIdirect.io, but engagement metrics (likes, comments) are unavailable since only YouTube Data API v3 exposes those. Add <code style="background:#1e2638;padding:1px 5px;border-radius:3px">YOUTUBE_KEY</code> (Google API key with YouTube Data API v3 enabled) to unlock likes, comments, and ER scores.
      </div>`
    : `<div style="background:rgba(76,175,116,.06);border:1px solid rgba(76,175,116,.2);border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:12px;color:#8fa3b8;line-height:1.7">
        <strong style="color:#4caf74">Methodology:</strong> APIdirect.io discovers AQ-related videos (<code style="background:#1e2638;padding:1px 5px;border-radius:3px">GET /youtube/posts</code>) and resolves the official channel (<code style="background:#1e2638;padding:1px 5px;border-radius:3px">GET /youtube/channels</code>); YouTube Data API v3 fetches live likes/comments/view stats per video. <strong>Subscriber ER</strong> = (likes + comments) / subscribers × 100. <strong>View ER</strong> used as fallback when subscriber count is hidden.
      </div>`;

  const statCards = [
    { label: 'Orgs with YT videos', value: orgsWithVideos, unit: `of ${results.length} tracked`, col: '#ff0000' },
    { label: 'Videos discovered',   value: totalVideos,    unit: 'via APIdirect.io',              col: '#e53935' },
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
    <div class="sd">Real engagement metrics from YouTube Data API v3. Videos discovered and channel-matched via APIdirect.io, stats fetched live per video.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">${statCards}</div>

  ${methodNote}

  <div style="display:flex;flex-direction:column;gap:10px">${orgRows}</div>
</section>`;
}

module.exports = { run, buildYoutubeERHtml, extractVideoId };

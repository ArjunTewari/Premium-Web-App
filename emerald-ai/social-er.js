'use strict';
/**
 * social-er.js — Social AQ Presence
 *
 * Data sources (in priority order):
 *   X/Twitter  → X API v2 Bearer Token (x-collector.js) when X_BEARER_TOKEN set
 *                Fallback: Serper Google index
 *   Instagram  → Meta Graph Business Discovery (instagram-collector.js) when
 *                META_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID set
 *                Fallback: Serper Google index
 *   LinkedIn   → Serper Google index (no public API without user OAuth)
 *   YouTube    → youtube-er.js (unchanged, called separately in pipeline.js)
 *
 * Presence scored 0–10:
 *   Volume   (0–4): total AQ posts across all platforms
 *   Breadth  (0–3): number of platforms with ≥1 AQ post
 *   Relevance(0–3): 3 if any platform is API-verified, else keyword density
 */

const axios = require('axios');

const AQ_TERMS = '("air quality" OR "air pollution" OR AQI OR PM2.5 OR NCAP)';
const AQ_KEYWORDS = [
  'air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
  'smog', 'clean air', 'pollution', 'black carbon', 'ozone', 'ammonia',
  'nitrogen dioxide', 'particulate', 'emission',
];

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Serper helper (LinkedIn fallback + X/IG fallback) ─────────────────────

async function serperSearch(query, serperKey, dateFrom, dateTo, cb) {
  try {
    const body = { q: query, num: 5 };
    if (dateFrom && dateTo) {
      const [fy, fm, fd] = dateFrom.split('-');
      const [ty, tm, td] = dateTo.split('-');
      body.tbs = `cdr:1,cd_min:${fm}/${fd}/${fy},cd_max:${tm}/${td}/${ty}`;
    }
    const res = await axios.post(
      'https://google.serper.dev/search',
      body,
      { headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return res.data.organic || [];
  } catch (e) {
    cb?.(`  [SocialPresence] Serper error: ${e.message}`, 'warn');
    return [];
  }
}

function countAQKeywords(text) {
  const lower = text.toLowerCase();
  return AQ_KEYWORDS.filter(kw => lower.includes(kw)).length;
}

// ── Transparent 0–10 score ─────────────────────────────────────────────────

function scorePresence(liCount, xCount, igCount, apiVerified, liItems = []) {
  const total = liCount + xCount + igCount;

  const volumePts =
    total === 0 ? 0 : total === 1 ? 1 : total <= 3 ? 2 : total <= 6 ? 3 : 4;

  const platforms = [liCount > 0, xCount > 0, igCount > 0].filter(Boolean).length;
  const breadthPts = platforms;

  let relevancePts = 0;
  if (total > 0) {
    if (apiVerified) {
      // API-filtered posts are AQ-verified by definition
      relevancePts = 3;
    } else {
      const avgKw = liItems.length > 0
        ? liItems.reduce((s, p) => s + countAQKeywords(`${p.title || ''} ${p.snippet || ''}`), 0) / liItems.length
        : 0;
      relevancePts = avgKw < 0.5 ? 0 : avgKw < 1.0 ? 1 : avgKw < 2.0 ? 2 : 3;
    }
  }

  return {
    presenceScore: volumePts + breadthPts + relevancePts,
    scoreBreakdown: {
      volume:    { pts: volumePts,    max: 4, detail: `${total} AQ posts across platforms` },
      breadth:   { pts: breadthPts,   max: 3, detail: `${platforms} of 3 platforms active` },
      relevance: { pts: relevancePts, max: 3, detail: apiVerified ? 'API-verified AQ posts' : 'avg AQ keyword hits per post' },
    },
  };
}

// ── Main run() ─────────────────────────────────────────────────────────────

async function run(cfg, selectedOrgs, cb) {
  const SERPER_KEY = cfg.SERPER_KEY;
  if (!SERPER_KEY) {
    cb?.('  [SocialPresence] No SERPER_KEY — skipping', 'warn');
    return [];
  }

  const useXApi = !!cfg.X_BEARER_TOKEN;
  const useIgApi = !!cfg.HIKER_API_KEY;

  cb?.(`  Social Presence: ${selectedOrgs.length} orgs` +
    ` | X:${useXApi ? 'API' : 'Serper'} | IG:${useIgApi ? 'API' : 'Serper'} | LI:Serper`);

  // ── Pre-fetch X data for all orgs (one pass) ───────────────────────────
  let xApiData = {};
  if (useXApi) {
    try {
      const XCollector = require('./x-collector');
      xApiData = await XCollector.run(selectedOrgs, cfg.DATE_FROM, cfg.DATE_TO, cfg.X_BEARER_TOKEN, cb);
    } catch (e) {
      cb?.(`  X API collection error: ${e.message}`, 'warn');
    }
  }

  // ── Pre-fetch IG data for all orgs (one pass) ──────────────────────────
  let igApiData = {};
  if (useIgApi) {
    try {
      const IgCollector = require('./instagram-collector');
      igApiData = await IgCollector.run(
        selectedOrgs, cfg.DATE_FROM, cfg.DATE_TO,
        cfg.HIKER_API_KEY, cfg.CLAUDE_KEY, cb
      );
    } catch (e) {
      cb?.(`  IG API collection error: ${e.message}`, 'warn');
    }
  }

  // ── Per-org assembly ───────────────────────────────────────────────────
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [SocialPresence] "${orgName}"…`);

    // LinkedIn: always Serper
    const liItems = await serperSearch(
      `"${orgName}" ${AQ_TERMS} site:linkedin.com/posts`,
      SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb
    );

    // X: API or Serper
    let xItems      = [];
    let xApiResult  = null;
    let xApiCount   = 0;
    if (useXApi && xApiData[orgName]) {
      xApiResult = xApiData[orgName];
      xApiCount  = xApiResult.aqPosts || 0;
    } else {
      xItems = await serperSearch(
        `"${orgName}" ${AQ_TERMS} (site:x.com OR site:twitter.com)`,
        SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb
      );
    }

    // Instagram: API or Serper
    let igItems     = [];
    let igApiResult = null;
    let igApiCount  = 0;
    if (useIgApi && igApiData[orgName]) {
      igApiResult = igApiData[orgName];
      igApiCount  = igApiResult.ig_not_available ? 0 : (igApiResult.aqPosts || 0);
    } else {
      igItems = await serperSearch(
        `"${orgName}" ${AQ_TERMS} site:instagram.com`,
        SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb
      );
    }

    // Effective counts for scoring
    const xCount  = useXApi  ? xApiCount  : xItems.length;
    const igCount = useIgApi ? igApiCount : igItems.length;
    const liCount = liItems.length;
    const apiVerified = useXApi || useIgApi;

    const { presenceScore, scoreBreakdown } = scorePresence(liCount, xCount, igCount, apiVerified, liItems);
    const totalFound = liCount + xCount + igCount;

    orgResults.push({
      org:            orgName,
      presenceScore,
      scoreBreakdown,
      avgER:          presenceScore, // pipeline.js compat
      twitterER:      0,
      linkedinER:     0,
      youtubeER:      0,
      twitterPosts:   xCount,
      linkedinPosts:  liCount,
      instagramPosts: igCount,
      youtubePosts:   0,
      totalPosts:     totalFound,
      insight: totalFound > 0
        ? `${liCount} LinkedIn · ${xCount} X${useXApi ? ' (API)' : ''} · ${igCount} Instagram${useIgApi ? ' (API)' : ''} · presence ${presenceScore}/10`
        : 'No indexed social posts found in this period',
      // Serper fallback data (used in HTML when API not available)
      liResults:  liItems,
      xResults:   xItems,
      igResults:  igItems,
      // API enrichment data (used in HTML when API available)
      xApiResult,
      igApiResult,
      useXApi,
      useIgApi,
    });

    cb?.(
      `  [SocialPresence] ${orgName}: LI=${liCount} X=${xCount}${useXApi ? '(api)' : ''} IG=${igCount}${useIgApi ? '(api)' : ''} score=${presenceScore}/10`,
      totalFound > 0 ? 'ok' : 'warn'
    );
  }

  orgResults.sort((a, b) => b.presenceScore - a.presenceScore);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.('  Social Presence complete', 'ok');
  return orgResults;
}

// ── HTML generation ────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s >= 8) return '#4caf74';
  if (s >= 5) return '#c9922a';
  return '#e05c5c';
}

function buildSocialERHtml(erResults, ytResults = [], hasYtKey = false) {
  if (!erResults?.length) return '';

  const orgsWithPresence = erResults.filter(r => r.totalPosts > 0).length;
  const totalLiIndexed   = erResults.reduce((s, r) => s + r.linkedinPosts, 0);
  const totalXIndexed    = erResults.reduce((s, r) => s + r.twitterPosts, 0);
  const totalIgIndexed   = erResults.reduce((s, r) => s + (r.instagramPosts || 0), 0);
  const totalYtVideos    = ytResults.reduce((s, r) => s + (r.videoCount || 0), 0);

  const useXApi  = erResults.some(r => r.useXApi);
  const useIgApi = erResults.some(r => r.useIgApi);

  const statCards = [
    { label: 'Orgs with social AQ posts', value: orgsWithPresence, unit: `of ${erResults.length} tracked`, col: '#4caf74' },
    { label: 'LinkedIn posts indexed',    value: totalLiIndexed,   unit: 'via Serper',                     col: '#4a7fd4' },
    { label: 'X/Twitter AQ posts',        value: totalXIndexed,    unit: useXApi  ? 'via X API v2'  : 'via Serper index', col: '#4a9fd4' },
    { label: 'Instagram AQ posts',        value: totalIgIndexed,   unit: useIgApi ? 'via Meta Graph' : 'via Serper index', col: '#e05c9c' },
    { label: 'YouTube videos',            value: totalYtVideos,    unit: 'official channel',               col: '#e53935' },
  ].map(c => `
    <div style="flex:1;min-width:140px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:14px 16px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:11px;color:#5e7494;margin-top:5px">${c.unit}</div>
    </div>`).join('');

  // Data source banner
  const sourceBanner = `
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
    <span style="font-family:monospace;font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494">Data sources:</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(74,127,212,.12);border:1px solid rgba(74,127,212,.3);color:#4a7fd4;border-radius:4px;padding:2px 8px">LinkedIn · Serper index</span>
    <span style="font-family:monospace;font-size:10px;background:${useXApi  ? 'rgba(74,159,212,.12)' : 'rgba(94,116,148,.08)'};border:1px solid ${useXApi  ? 'rgba(74,159,212,.3)' : 'rgba(94,116,148,.2)'};color:${useXApi  ? '#4a9fd4' : '#5e7494'};border-radius:4px;padding:2px 8px">X/Twitter · ${useXApi  ? '✓ X API v2' : 'Serper index'}</span>
    <span style="font-family:monospace;font-size:10px;background:${useIgApi ? 'rgba(224,92,156,.12)' : 'rgba(94,116,148,.08)'};border:1px solid ${useIgApi ? 'rgba(224,92,156,.3)' : 'rgba(94,116,148,.2)'};color:${useIgApi ? '#e05c9c' : '#5e7494'};border-radius:4px;padding:2px 8px">Instagram · ${useIgApi ? '✓ HikerAPI' : 'Serper index'}</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(229,57,53,.12);border:1px solid rgba(229,57,53,.3);color:#e53935;border-radius:4px;padding:2px 8px">YouTube · ✓ Data API v3</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(94,116,148,.08);border:1px solid rgba(94,116,148,.2);color:#5e7494;border-radius:4px;padding:2px 8px">LinkedIn API · pending</span>
  </div>`;

  const ytKeyNotice = !hasYtKey
    ? `<div style="background:rgba(201,146,42,.08);border:1px solid rgba(201,146,42,.3);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:11px;color:#d4a017;line-height:1.7">
        <strong>&#9432; YOUTUBE_KEY not configured</strong> — videos are discovered via Serper but views/likes/ER require a Google API key with YouTube Data API v3 enabled.
      </div>`
    : '';

  // ── Summary table ─────────────────────────────────────────────────────────
  const colTotals = erResults.reduce((s, r) => {
    const yt = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
    s.li += r.linkedinPosts; s.x += r.twitterPosts; s.ig += (r.instagramPosts || 0); s.yt += (yt.videoCount || 0);
    return s;
  }, { li: 0, x: 0, ig: 0, yt: 0 });
  const cohortTotal = colTotals.li + colTotals.x + colTotals.ig + colTotals.yt || 1;

  const unifiedRows = erResults
    .map(r => {
      const yt    = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
      const total = r.linkedinPosts + r.twitterPosts + (r.instagramPosts || 0) + (yt.videoCount || 0);
      return { r, yt, total };
    })
    .sort((a, b) => b.total - a.total);

  let _lastTotal = null, _lastRank = 0;
  unifiedRows.forEach(({ total }, idx) => {
    if (total === _lastTotal) { unifiedRows[idx].unifiedRank = _lastRank; }
    else { _lastRank = idx + 1; unifiedRows[idx].unifiedRank = _lastRank; _lastTotal = total; }
  });

  const summaryTable = `<div style="overflow-x:auto;border:1px solid #252d40;border-radius:8px;margin-bottom:16px;overflow:hidden">
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr style="background:#181e2e">
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5e7494;white-space:nowrap">Rank</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5e7494">Org</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a7fd4;white-space:nowrap">LinkedIn</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a9fd4;white-space:nowrap">X${useXApi ? ' ✓' : ''}</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e05c9c;white-space:nowrap">Instagram${useIgApi ? ' ✓' : ''}</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e53935;white-space:nowrap">YouTube</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;white-space:nowrap">Total</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4caf74;white-space:nowrap">SoV %</th>
      </tr>
      <tr style="background:#0f1422;border-top:1px solid #252d40">
        <td colspan="2" style="padding:5px 12px;font-family:monospace;font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#3a4a5e">COHORT TOTAL</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#4a7fd4">${colTotals.li}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#4a9fd4">${colTotals.x}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#e05c9c">${colTotals.ig}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#e53935">${colTotals.yt}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#c9922a">${cohortTotal}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#4caf74">100%</td>
      </tr>
    </thead>
    <tbody>
      ${unifiedRows.map(({ r, yt, total, unifiedRank }) => {
        const sov  = cohortTotal > 0 ? ((total / cohortTotal) * 100).toFixed(1) : '0.0';
        const barW = Math.round((total / (unifiedRows[0].total || 1)) * 100);
        const col  = total >= 10 ? '#4caf74' : total >= 5 ? '#c9922a' : total >= 1 ? '#4a9fd4' : '#5e7494';
        const xFol = r.xApiResult?.followers ? ` <span style="color:#3a4a5e">(${(r.xApiResult.followers/1000).toFixed(1)}K)</span>` : '';
        const igFol = r.igApiResult?.followers && !r.igApiResult.ig_not_available ? ` <span style="color:#3a4a5e">(${(r.igApiResult.followers/1000).toFixed(1)}K)</span>` : '';
        return `<tr style="border-top:1px solid #252d40">
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#2e3a52">#${unifiedRank}</td>
          <td style="padding:8px 12px"><span style="font-family:monospace;font-size:11px;font-weight:700;color:${col}">${escHtml(r.org)}</span></td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#4a7fd4">${r.linkedinPosts}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#4a9fd4">${r.twitterPosts}${xFol}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#e05c9c">${r.instagramPosts || 0}${igFol}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#e53935">${yt.videoCount || 0}</td>
          <td style="padding:8px 12px;text-align:center">
            <span style="font-family:monospace;font-size:15px;font-weight:700;color:${col}">${total}</span>
            <div style="margin:4px auto;width:70px;height:3px;background:#1e2638;border-radius:2px;overflow:hidden"><div style="height:100%;background:${col};width:${barW}%"></div></div>
          </td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:600;color:#4caf74">${sov}%</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>
<div style="font-family:monospace;font-size:9px;color:#3a4a5e;margin-bottom:16px">
  ${useXApi || useIgApi
    ? `✓ = live API data (AQ-filtered). Counts reflect posts about air quality only.${useXApi ? ' X: client-side keyword filter.' : ''}${useIgApi ? ' IG: HikerAPI + Claude Haiku AQ classification.' : ''} LI: Google-indexed posts (Serper). SoV % = org total ÷ cohort total.`
    : 'Counts = Google-indexed posts / official YouTube channel videos in the report period. LinkedIn · X/Twitter · Instagram via Serper index. SoV % = org total ÷ cohort total.'}
</div>`;

  // ── Per-org detail sections ───────────────────────────────────────────────
  const orgDetails = erResults.map(r => {
    const yt  = ytResults.find(y => y.org === r.org) || { videoCount: 0, videos: [], avgER: 0, avgViewER: 0, erMethod: 'none', totalViews: 0 };
    const col = scoreColor(r.presenceScore);

    // X detail block
    const xDetailHtml = (() => {
      if (r.useXApi && r.xApiResult && !r.xApiResult.error) {
        const xr = r.xApiResult;
        if (!xr.aqPosts) return '<div style="font-size:11px;color:#3a4a5e">No AQ tweets in this period</div>';
        const topPostsHtml = (xr.topPosts || []).map((p, i) => `
          <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid ${i === 0 ? '#4a9fd4' : '#1e2638'};border-radius:0 4px 4px 0;margin-bottom:4px">
            <a href="${escHtml(p.url)}" target="_blank" style="font-size:11px;color:#4a9fd4;text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((p.text || '').slice(0, 200))}${(p.text || '').length > 200 ? '…' : ''}</a>
            <div style="font-family:monospace;font-size:9px;color:#5e7494;margin-top:3px">♥ ${p.likes} &middot; ↩ ${p.replies} &middot; ↻ ${p.reposts}${p.views ? ` &middot; ${p.views.toLocaleString()} views` : ''} &middot; ${p.created_at ? new Date(p.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : ''}</div>
          </div>`).join('');
        return `<div style="margin-top:6px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">
            X/Twitter — <span style="color:#4a9fd4">${xr.aqPosts} AQ tweet${xr.aqPosts === 1 ? '' : 's'}</span> of ${xr.totalPosts} total
            ${xr.followers ? `&middot; ${xr.followers.toLocaleString()} followers` : ''}
            ${xr.totalLikes ? `&middot; ${xr.totalLikes.toLocaleString()} total ♥` : ''}
          </div>
          ${topPostsHtml || '<div style="font-size:10px;color:#5e7494">No top posts to display</div>'}
        </div>`;
      }
      // Serper fallback
      return (r.xResults || []).length === 0 ? '' : `
        <div style="margin-top:6px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">X/Twitter — ${r.xResults.length} post${r.xResults.length === 1 ? '' : 's'} (Serper index)</div>
          ${(r.xResults || []).map(s => `
          <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0;margin-bottom:3px">
            ${s.link ? `<a href="${escHtml(s.link)}" target="_blank" style="font-size:11px;color:#4a9fd4;text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((s.title || s.snippet || '').slice(0, 150))}${(s.title||s.snippet||'').length > 150 ? '…' : ''}</a>` : `<div style="font-size:11px;color:#8fa3b8">${escHtml((s.title || s.snippet || '').slice(0, 150))}</div>`}
          </div>`).join('')}
        </div>`;
    })();

    // Instagram detail block
    const igDetailHtml = (() => {
      if (r.useIgApi && r.igApiResult) {
        const ig = r.igApiResult;
        if (ig.ig_not_available) return '<div style="font-size:11px;color:#3a4a5e">Instagram: account not available via Business Discovery</div>';
        if (!ig.aqPosts) return '<div style="font-size:11px;color:#3a4a5e">No AQ Instagram posts in this period</div>';
        const topPostsHtml = (ig.topPosts || []).map((p, i) => `
          <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid ${i === 0 ? '#e05c9c' : '#1e2638'};border-radius:0 4px 4px 0;margin-bottom:4px">
            <a href="${escHtml(p.permalink)}" target="_blank" style="font-size:11px;color:#e05c9c;text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((p.caption || '').slice(0, 200))}${(p.caption || '').length > 200 ? '…' : ''}</a>
            <div style="font-family:monospace;font-size:9px;color:#5e7494;margin-top:3px">♥ ${p.likes} &middot; 💬 ${p.comments} &middot; ${p.timestamp ? new Date(p.timestamp).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : ''}</div>
          </div>`).join('');
        return `<div style="margin-top:6px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">
            Instagram — <span style="color:#e05c9c">${ig.aqPosts} AQ post${ig.aqPosts === 1 ? '' : 's'}</span> of ${ig.totalPosts} in period
            ${ig.followers ? `&middot; ${ig.followers.toLocaleString()} followers` : ''}
          </div>
          ${topPostsHtml || '<div style="font-size:10px;color:#5e7494">No top posts</div>'}
        </div>`;
      }
      // Serper fallback
      return (r.igResults || []).length === 0 ? '' : `
        <div style="margin-top:6px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">Instagram — ${r.igResults.length} post${r.igResults.length === 1 ? '' : 's'} (Serper index)</div>
          ${(r.igResults || []).map(s => `
          <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0;margin-bottom:3px">
            ${s.link ? `<a href="${escHtml(s.link)}" target="_blank" style="font-size:11px;color:#e05c9c;text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((s.title || s.snippet || '').slice(0, 150))}${(s.title||s.snippet||'').length > 150 ? '…' : ''}</a>` : `<div style="font-size:11px;color:#8fa3b8">${escHtml((s.title || s.snippet || '').slice(0, 150))}</div>`}
          </div>`).join('')}
        </div>`;
    })();

    // LinkedIn detail block (always Serper)
    const liDetailHtml = (r.liResults || []).length === 0 ? '' : `
      <div style="margin-top:6px">
        <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">LinkedIn — ${r.liResults.length} post${r.liResults.length === 1 ? '' : 's'}</div>
        ${r.liResults.map(s => `
        <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0;margin-bottom:3px">
          ${s.link ? `<a href="${escHtml(s.link)}" target="_blank" style="font-size:11px;color:#4a7fd4;text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((s.title || s.snippet || '').slice(0, 150))}${(s.title||s.snippet||'').length > 150 ? '…' : ''}</a>` : `<div style="font-size:11px;color:#8fa3b8">${escHtml((s.title || s.snippet || '').slice(0, 150))}</div>`}
          ${s.snippet && s.title && s.link ? `<div style="font-size:10px;color:#5e7494;margin-top:2px">${escHtml(s.snippet.slice(0, 120))}${s.snippet.length > 120 ? '…' : ''}</div>` : ''}
        </div>`).join('')}
      </div>`;

    // YouTube detail block
    const yt2 = yt;
    const sortedYtVideos = [...(yt2.videos || [])].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    const hasApiMetrics  = sortedYtVideos.some(v => v.views !== null);
    const avgER = yt2.avgER || yt2.avgViewER || 0;
    const erMethodLabel = yt2.erMethod === 'subscriber'
      ? 'ER = (likes+comments) ÷ subscribers × 100'
      : yt2.erMethod === 'view'
        ? 'ER = (likes+comments) ÷ views × 100 (subscriber count hidden)'
        : null;

    const ytVideosHtml = sortedYtVideos.map((v, idx) => {
      const metricsStr = v.views !== null
        ? `${(v.views||0).toLocaleString()} views &middot; ${(v.likes||0).toLocaleString()} likes &middot; ${(v.comments||0).toLocaleString()} comments`
        : '<span style="color:#5e7494">metrics unavailable</span>';
      const erStr = (v.subscriberER !== null)
        ? ` &middot; <span style="color:#e53935">ER ${v.subscriberER}% (sub)</span>`
        : (v.viewER !== null)
          ? ` &middot; <span style="color:#e05c5c">ER ${v.viewER}% (view)</span>`
          : '';
      return `<div style="padding:6px 10px;background:#0a0e17;border-left:2px solid ${idx === 0 ? '#e53935' : '#1e2638'};border-radius:0 4px 4px 0;margin-bottom:4px">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <span style="font-family:monospace;font-size:9px;color:#3a4a5e;flex-shrink:0;margin-top:2px">#${idx+1}</span>
          <div style="flex:1;min-width:0">
            ${v.url
              ? `<a href="${escHtml(v.url)}" target="_blank" style="font-size:11px;color:#e53935;text-decoration:none;line-height:1.4;display:block;font-weight:600;margin-bottom:2px">${escHtml((v.title || v.url || '').slice(0, 150))}${(v.title||v.url||'').length>150?'…':''}</a>`
              : `<div style="font-size:11px;color:#8fa3b8;line-height:1.4;margin-bottom:2px">${escHtml((v.title || '').slice(0, 150))}</div>`}
            <div style="font-family:monospace;font-size:9px;color:#5e7494">${metricsStr}${erStr}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    const hasAnyPost = r.totalPosts > 0 || yt2.videoCount > 0;

    return `<details style="border:1px solid #252d40;border-radius:6px;margin-bottom:6px">
      <summary style="padding:10px 14px;cursor:pointer;background:#181e2e;border-radius:6px;list-style:none;display:flex;align-items:center;gap:12px;user-select:none">
        <span style="font-family:monospace;font-size:10px;font-weight:700;color:#2e3a52">#${r.rank}</span>
        <span style="font-family:monospace;font-size:11px;font-weight:700;color:${col}">${escHtml(r.org)}</span>
        <span style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${r.presenceScore}/10</span>
        <span style="font-size:10px;color:#5e7494;margin-left:4px">
          <span style="color:#4a7fd4">${r.linkedinPosts} LI</span> &middot;
          <span style="color:#4a9fd4">${r.twitterPosts} X</span> &middot;
          <span style="color:#e05c9c">${r.instagramPosts||0} IG</span> &middot;
          <span style="color:#e53935">${yt2.videoCount||0} YT</span>
        </span>
        <span style="color:#c9922a;font-size:11px;margin-left:auto">▾</span>
      </summary>
      <div style="padding:12px 14px;background:#0e1420">
        ${!hasAnyPost ? '<div style="font-size:11px;color:#3a4a5e">No indexed posts found in this period</div>' : ''}
        ${liDetailHtml}
        ${xDetailHtml}
        ${igDetailHtml}
        ${yt2.videoCount > 0 ? `
        <div style="margin-top:10px">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:5px">
            <span style="font-size:10px;color:#5e7494;text-transform:uppercase;letter-spacing:.08em">YouTube — <span style="color:#e53935">${yt2.videoCount} video${yt2.videoCount===1?'':'s'}</span>${yt2.totalViews>0 ? ` &middot; ${yt2.totalViews.toLocaleString()} total views` : ''}</span>
            ${avgER > 0 ? `<span style="font-family:monospace;font-size:10px;color:#e53935;background:rgba(229,57,53,.08);border:1px solid rgba(229,57,53,.2);border-radius:4px;padding:1px 7px">avg ER ${avgER}%</span>` : ''}
          </div>
          ${erMethodLabel ? `<div style="font-size:9px;color:#3a4a5e;margin-bottom:5px;font-style:italic">${escHtml(erMethodLabel)}</div>` : ''}
          ${!hasApiMetrics ? `<div style="font-size:10px;color:#c9922a;margin-bottom:6px">&#9432; Enable YouTube Data API v3 for view/like metrics.</div>` : ''}
          ${ytVideosHtml}
        </div>` : `<div style="margin-top:8px;font-size:11px;color:#3a4a5e">No YouTube videos indexed in this period</div>`}
      </div>
    </details>`;
  }).join('');

  return `
<section class="sec" id="social">
  <div class="sh">
    <div class="se">Section 08</div>
    <h2 class="st">Social AQ Presence</h2>
    <div class="sd">AQ-relevant posts published by each organisation on LinkedIn, X/Twitter, Instagram, and YouTube (official channel only). ${useXApi || useIgApi ? 'X and/or Instagram data sourced from official APIs — counts reflect posts specifically about air quality.' : 'Ranked by total publishing volume across all platforms.'} SoV % = org's share of all tracked cohort posts.</div>
    <div class="sdiv"></div>
  </div>

  ${sourceBanner}

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  ${ytKeyNotice}

  ${summaryTable}

  <div style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;margin-bottom:8px">Per-Org Detail</div>
  ${orgDetails}
</section>`;
}

module.exports = { run, buildSocialERHtml };

'use strict';
/**
 * social-er.js — Social AQ Presence
 *
 * Data sources (in priority order):
 *   X/Twitter  → APIDirectio /v1/twitter/user/tweets (x-collector.js)
 *   Instagram  → APIDirectio /v1/instagram/user/posts (instagram-collector.js)
 *   LinkedIn   → APIDirectio /v1/linkedin/company/posts
 *   YouTube    → youtube-er.js (unchanged, called separately in pipeline.js)
 *
 * Presence scored 0–10:
 *   Volume   (0–4): total AQ posts across all platforms
 *   Breadth  (0–3): number of platforms with ≥1 AQ post
 *   Relevance(0–3): 3 if any platform is API-verified, else keyword density
 */

const axios      = require('axios');
const ORG_SOCIAL = require('./org-handles');

const APIDIR_BASE = 'https://apidirect.io';

const AQ_KEYWORDS = [
  'air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
  'smog', 'clean air', 'pollution', 'black carbon', 'ozone', 'ammonia',
  'nitrogen dioxide', 'particulate', 'emission',
];

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── APIDirectio LinkedIn company posts ─────────────────────────────────────

async function fetchLinkedIn(companyUrl, apidirKey, dateFrom, dateTo, cb) {
  if (!companyUrl) return [];
  const fromMs = dateFrom ? new Date(dateFrom).getTime() : 0;
  const toMs   = dateTo   ? new Date(dateTo  ).getTime() : Date.now();
  try {
    const res = await axios.get(`${APIDIR_BASE}/v1/linkedin/company/posts`, {
      params:  { url: companyUrl, page: 1 },
      headers: { 'X-API-Key': apidirKey },
      timeout: 20000,
    });
    const posts = res.data.posts || [];
    return posts.filter(p => {
      if (!p.date) return true;
      try {
        const d = new Date(p.date);
        if (isNaN(d.getTime())) return true;
        const ms = d.getTime();
        return ms >= fromMs && ms <= toMs;
      } catch { return true; }
    });
  } catch (e) {
    cb?.(`  [SocialPresence] LinkedIn fetch error: ${e.response?.data?.error || e.message}`, 'warn');
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
  const APIDIR_KEY = cfg.APIDIRECT_KEY;
  if (!APIDIR_KEY) {
    cb?.('  [SocialPresence] No APIDIRECT_KEY — skipping', 'warn');
    return [];
  }

  cb?.(`  Social Presence: ${selectedOrgs.length} orgs | X:APIDirectio | IG:APIDirectio | LI:APIDirectio`);

  const extraHandles = cfg.customOrgHandles || {};

  // ── Pre-fetch X data for all orgs ─────────────────────────────────────
  let xApiData = {};
  try {
    const XCollector = require('./x-collector');
    xApiData = await XCollector.run(selectedOrgs, cfg.DATE_FROM, cfg.DATE_TO, APIDIR_KEY, cb, extraHandles);
  } catch (e) {
    cb?.(`  X collection error: ${e.message}`, 'warn');
  }

  // ── Pre-fetch IG data for all orgs ────────────────────────────────────
  let igApiData = {};
  try {
    const IgCollector = require('./instagram-collector');
    igApiData = await IgCollector.run(selectedOrgs, cfg.DATE_FROM, cfg.DATE_TO, APIDIR_KEY, cfg.CLAUDE_KEY, cb, extraHandles);
  } catch (e) {
    cb?.(`  IG collection error: ${e.message}`, 'warn');
  }

  // ── Per-org assembly ───────────────────────────────────────────────────
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [SocialPresence] "${orgName}"…`);

    // LinkedIn: APIDirectio company posts (custom handle takes priority)
    const liUrl   = extraHandles[orgName]?.linkedin || ORG_SOCIAL[orgName]?.linkedin;
    const liPosts = await fetchLinkedIn(liUrl, APIDIR_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb);
    const liCount = liPosts.length;

    // X: APIDirectio user tweets
    const xApiResult = xApiData[orgName] || null;
    const xCount     = xApiResult?.aqPosts || 0;

    // Instagram: APIDirectio user posts
    const igApiResult = igApiData[orgName] || null;
    const igCount     = igApiResult?.ig_not_available ? 0 : (igApiResult?.aqPosts || 0);

    const { presenceScore, scoreBreakdown } = scorePresence(liCount, xCount, igCount, true, liPosts);
    const totalFound = liCount + xCount + igCount;

    orgResults.push({
      org:            orgName,
      presenceScore,
      scoreBreakdown,
      avgER:          presenceScore,
      twitterER:      0,
      linkedinER:     0,
      youtubeER:      0,
      twitterPosts:   xCount,
      linkedinPosts:  liCount,
      instagramPosts: igCount,
      youtubePosts:   0,
      totalPosts:     totalFound,
      insight: totalFound > 0
        ? `${liCount} LinkedIn · ${xCount} X · ${igCount} Instagram · presence ${presenceScore}/10 (all via APIDirectio)`
        : 'No AQ social posts found in this period',
      liResults:  liPosts,
      xResults:   [],
      igResults:  [],
      xApiResult,
      igApiResult,
      useXApi:  true,
      useIgApi: true,
    });

    cb?.(
      `  [SocialPresence] ${orgName}: LI=${liCount} X=${xCount}(api) IG=${igCount}(api) score=${presenceScore}/10`,
      totalFound > 0 ? 'ok' : 'warn'
    );

    await sleep(300);
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
    { label: 'LinkedIn AQ posts',          value: totalLiIndexed,   unit: 'total in period',  col: '#4a7fd4' },
    { label: 'X/Twitter AQ posts',        value: totalXIndexed,    unit: 'total in period',  col: '#4a9fd4' },
    { label: 'Instagram AQ posts',        value: totalIgIndexed,   unit: 'total in period',  col: '#e05c9c' },
    { label: 'YouTube videos',            value: totalYtVideos,    unit: 'official channel',              col: '#e53935' },
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
    <span style="font-family:monospace;font-size:10px;background:rgba(74,127,212,.12);border:1px solid rgba(74,127,212,.3);color:#4a7fd4;border-radius:4px;padding:2px 8px">LinkedIn · ✓ APIDirectio</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(74,159,212,.12);border:1px solid rgba(74,159,212,.3);color:#4a9fd4;border-radius:4px;padding:2px 8px">X/Twitter · ✓ APIDirectio</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(224,92,156,.12);border:1px solid rgba(224,92,156,.3);color:#e05c9c;border-radius:4px;padding:2px 8px">Instagram · ✓ APIDirectio</span>
    <span style="font-family:monospace;font-size:10px;background:rgba(229,57,53,.12);border:1px solid rgba(229,57,53,.3);color:#e53935;border-radius:4px;padding:2px 8px">YouTube · ✓ Data API v3</span>
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
  ✓ = live API data (AQ-filtered). All platforms via APIDirectio. X: client-side keyword filter. IG: Claude Haiku AQ classification. LI: fetched from company page. SoV % = org total ÷ cohort total.
</div>`;

  const metricCard = (label, value, col) =>
    `<div style="background:#181e2e;border:1px solid #252d40;border-radius:6px;padding:10px 12px;min-width:0">
      <div style="font-family:monospace;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#5e7494;margin-bottom:5px">${label}</div>
      <div style="font-family:monospace;font-size:18px;font-weight:700;color:${col};line-height:1">${value}</div>
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
        return `<div style="margin-top:10px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:6px">X Twitter</div>
          <div style="background:rgba(74,159,212,.08);border:1px solid rgba(74,159,212,.2);border-radius:4px;padding:3px 10px;margin-bottom:8px;font-size:9px;color:#4a9fd4;font-family:monospace">Native API keyword filter — AQ posts only</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
            ${metricCard('AQ Posts', xr.aqPosts, '#4a9fd4')}
            ${metricCard('Followers', xr.followers ? xr.followers.toLocaleString() : '—', '#4a9fd4')}
            ${metricCard('AQ Post Likes', (xr.totalLikes || 0).toLocaleString(), '#4a9fd4')}
            ${metricCard('Replies', (xr.totalReplies || 0).toLocaleString(), '#4a9fd4')}
          </div>
          <div style="font-size:9px;color:#3a4a5e;font-family:monospace;margin-bottom:4px">${xr.aqPosts} AQ tweets of ${xr.totalPosts} total in period</div>
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
        return `<div style="margin-top:10px">
          <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:6px">Instagram</div>
          <div style="background:rgba(224,92,156,.08);border:1px solid rgba(224,92,156,.2);border-radius:4px;padding:3px 10px;margin-bottom:8px;font-size:9px;color:#e05c9c;font-family:monospace">All posts fetched → AQ-classified by Claude Haiku</div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px">
            ${metricCard('AQ Posts', ig.aqPosts, '#e05c9c')}
            ${metricCard('Followers', ig.followers ? ig.followers.toLocaleString() : '—', '#e05c9c')}
            ${metricCard('AQ Post Likes', (ig.totalLikes || 0).toLocaleString(), '#e05c9c')}
            ${metricCard('Comments', (ig.totalComments || 0).toLocaleString(), '#e05c9c')}
          </div>
          <div style="font-size:9px;color:#3a4a5e;font-family:monospace;margin-bottom:4px">${ig.aqPosts} AQ posts of ${ig.totalPosts} in period</div>
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

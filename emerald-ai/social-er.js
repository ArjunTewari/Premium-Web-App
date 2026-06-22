'use strict';
/**
 * social-er.js — Social AQ Presence module (Serper-based)
 * Searches LinkedIn, X/Twitter and Instagram via Serper for AQ posts.
 *
 * Presence scored on a transparent 0–10 formula:
 *   Volume   (0–4): total Google-indexed posts across platforms
 *   Breadth  (0–3): number of platforms with ≥1 post
 *   Relevance(0–3): avg AQ keyword hits per post title+snippet
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

/**
 * Transparent 0–10 presence score.
 * Every point is explainable to a stakeholder.
 */
function scorePresence(liItems, xItems, igItems) {
  const allPosts = [
    ...liItems.map(p => ({ ...p, platform: 'linkedin' })),
    ...xItems.map(p => ({ ...p, platform: 'x' })),
    ...igItems.map(p => ({ ...p, platform: 'instagram' })),
  ];
  const total = allPosts.length;

  // Volume: 0 posts→0, 1→1, 2-3→2, 4-6→3, 7+→4
  const volumePts = total === 0 ? 0 : total === 1 ? 1 : total <= 3 ? 2 : total <= 6 ? 3 : 4;

  // Breadth: 1pt per platform with ≥1 post
  const platforms = [liItems.length > 0, xItems.length > 0, igItems.length > 0].filter(Boolean).length;
  const breadthPts = platforms;

  // Relevance: avg AQ keyword hits per post
  let relevancePts = 0;
  if (total > 0) {
    const avgKw = allPosts.reduce((s, p) =>
      s + countAQKeywords(`${p.title || ''} ${p.snippet || ''}`), 0) / total;
    relevancePts = avgKw < 0.5 ? 0 : avgKw < 1.0 ? 1 : avgKw < 2.0 ? 2 : 3;
  }

  return {
    presenceScore: volumePts + breadthPts + relevancePts,
    scoreBreakdown: {
      volume:    { pts: volumePts,    max: 4, detail: `${total} posts indexed` },
      breadth:   { pts: breadthPts,   max: 3, detail: `${platforms} of 3 platforms active` },
      relevance: { pts: relevancePts, max: 3, detail: `avg AQ keyword hits per post` },
    },
  };
}

async function run(cfg, selectedOrgs, cb) {
  const SERPER_KEY = cfg.SERPER_KEY;
  if (!SERPER_KEY) {
    cb?.('  [SocialPresence] No SERPER_KEY — skipping', 'warn');
    return [];
  }

  cb?.(`  Social Presence: searching ${selectedOrgs.length} orgs via Serper (LinkedIn + X + Instagram)…`);
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [SocialPresence] "${orgName}"…`);

    const [liItems, xItems, igItems] = await Promise.all([
      serperSearch(`"${orgName}" ${AQ_TERMS} site:linkedin.com/posts`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
      serperSearch(`"${orgName}" ${AQ_TERMS} (site:x.com OR site:twitter.com)`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
      serperSearch(`"${orgName}" ${AQ_TERMS} site:instagram.com`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
    ]);

    const { presenceScore, scoreBreakdown } = scorePresence(liItems, xItems, igItems);
    const totalFound = liItems.length + xItems.length + igItems.length;
    const topItem    = liItems[0] || xItems[0] || igItems[0] || null;

    orgResults.push({
      org:            orgName,
      presenceScore,
      scoreBreakdown,
      avgER:          presenceScore, // pipeline.js compat
      twitterER:      0,
      linkedinER:     0,
      youtubeER:      0,
      twitterPosts:   xItems.length,
      linkedinPosts:  liItems.length,
      instagramPosts: igItems.length,
      youtubePosts:   0,
      totalPosts:     totalFound,
      bestPost: topItem ? {
        platform: liItems[0] ? 'linkedin' : xItems[0] ? 'x' : 'instagram',
        url: topItem.link,
        text: topItem.snippet || topItem.title || '',
        date: topItem.date || '',
      } : null,
      insight: totalFound > 0
        ? `${liItems.length} LinkedIn · ${xItems.length} X · ${igItems.length} Instagram posts · presence ${presenceScore}/10`
        : 'No indexed social posts found in this period',
      liResults: liItems,
      xResults:  xItems,
      igResults: igItems,
    });

    cb?.(`  [SocialPresence] ${orgName}: LI=${liItems.length} X=${xItems.length} IG=${igItems.length} score=${presenceScore}/10`,
      totalFound > 0 ? 'ok' : 'warn');
  }

  orgResults.sort((a, b) => b.presenceScore - a.presenceScore);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.(`  Social Presence complete`, 'ok');
  return orgResults;
}

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
  const avgScore         = erResults.length
    ? Math.round(erResults.reduce((s, r) => s + r.presenceScore, 0) / erResults.length * 10) / 10
    : 0;
  const topOrg           = erResults[0];

  const statCards = [
    { label: 'Orgs with social AQ posts', value: orgsWithPresence, unit: `of ${erResults.length} tracked`, col: '#4caf74' },
    { label: 'LinkedIn posts indexed',    value: totalLiIndexed,   unit: '',               col: '#4a7fd4' },
    { label: 'X/Twitter posts indexed',   value: totalXIndexed,    unit: '',               col: '#4a9fd4' },
    { label: 'Instagram posts indexed',   value: totalIgIndexed,   unit: '',               col: '#e05c9c' },
    { label: 'YouTube videos indexed',    value: totalYtVideos,    unit: '',               col: '#e53935' },
    { label: 'Avg presence score',        value: `${avgScore}/10`, unit: topOrg ? `led by ${topOrg.org.split(' ').slice(-1)[0]}` : '', col: '#c9922a' },
  ].map(c => `
    <div style="flex:1;min-width:140px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:14px 16px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:11px;color:#5e7494;margin-top:5px">${c.unit}</div>
    </div>`).join('');

  const ytKeyNotice = !hasYtKey
    ? `<div style="background:rgba(201,146,42,.08);border:1px solid rgba(201,146,42,.3);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:11px;color:#d4a017;line-height:1.7">
        <strong>&#9432; YOUTUBE_KEY not configured</strong> — videos are discovered via Serper but views/likes/ER require a Google API key with YouTube Data API v3 enabled.
      </div>`
    : '';

  const maxPosts = Math.max(...erResults.map(r => r.totalPosts), 1);
  const maxYtVids = Math.max(...ytResults.map(r => r.videoCount || 0), 1);

  // ── Unified summary table ranked by total indexed posts ──────────────────
  const cohortTotal = erResults.reduce((s, r) => {
    const yt = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
    return s + r.linkedinPosts + r.twitterPosts + (r.instagramPosts || 0) + (yt.videoCount || 0);
  }, 0) || 1;

  const unifiedRows = erResults
    .map(r => {
      const yt    = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
      const total = r.linkedinPosts + r.twitterPosts + (r.instagramPosts || 0) + (yt.videoCount || 0);
      return { r, yt, total };
    })
    .sort((a, b) => b.total - a.total);

  // Assign unified ranks
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
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a9fd4;white-space:nowrap">X</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e05c9c;white-space:nowrap">Instagram</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e53935;white-space:nowrap">YouTube</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;white-space:nowrap">Total</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4caf74;white-space:nowrap">SoV %</th>
      </tr>
    </thead>
    <tbody>
      ${unifiedRows.map(({ r, yt, total, unifiedRank }) => {
        const sov = cohortTotal > 0 ? ((total / cohortTotal) * 100).toFixed(1) : '0.0';
        const maxTotal = unifiedRows[0].total || 1;
        const barW = Math.round((total / maxTotal) * 100);
        const col = total >= 10 ? '#4caf74' : total >= 5 ? '#c9922a' : total >= 1 ? '#4a9fd4' : '#5e7494';
        return `<tr style="border-top:1px solid #252d40">
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:12px;font-weight:700;color:#2e3a52">#${unifiedRank}</td>
          <td style="padding:8px 12px"><span style="font-family:monospace;font-size:11px;font-weight:700;color:${col}">${escHtml(r.org)}</span></td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#4a7fd4">${r.linkedinPosts}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#4a9fd4">${r.twitterPosts}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:13px;font-weight:700;color:#e05c9c">${r.instagramPosts || 0}</td>
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
  Counts = Google-indexed posts / official YouTube channel videos in the report period. LinkedIn · X/Twitter · Instagram via Serper index. YouTube = official channel videos only (filtered by configured @handle). SoV % = org total ÷ cohort total.
</div>`;

  // ── Per-org collapsible detail sections ───────────────────────────────────
  const orgDetails = erResults.map(r => {
    const yt  = ytResults.find(y => y.org === r.org) || { videoCount: 0, videos: [], avgER: 0, avgViewER: 0, erMethod: 'none', totalViews: 0 };
    const col = scoreColor(r.presenceScore);

    const postSnippets = (platform, items, linkCol) => items.length === 0 ? '' : `
      <div style="margin-top:6px">
        <div style="font-size:9px;color:#3a4a5e;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">${platform} — ${items.length} post${items.length===1?'':'s'}</div>
        ${items.map(s => `
        <div style="padding:6px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0;margin-bottom:3px">
          ${s.link
            ? `<a href="${escHtml(s.link)}" target="_blank" style="font-size:11px;color:${linkCol};text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((s.title || s.snippet || '').slice(0, 150))}${(s.title||s.snippet||'').length > 150 ? '…' : ''}</a>`
            : `<div style="font-size:11px;color:#8fa3b8;line-height:1.4">${escHtml((s.title || s.snippet || '').slice(0, 150))}</div>`
          }
          ${s.snippet && s.title && s.link ? `<div style="font-size:10px;color:#5e7494;margin-top:2px;line-height:1.4">${escHtml(s.snippet.slice(0, 120))}${s.snippet.length>120?'…':''}</div>` : ''}
        </div>`).join('')}
      </div>`;

    const sortedYtVideos = [...(yt.videos || [])].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    const hasApiMetrics  = sortedYtVideos.some(v => v.views !== null);
    const avgER = yt.avgER || yt.avgViewER || 0;
    const erMethodLabel = yt.erMethod === 'subscriber'
      ? 'ER = (likes+comments) ÷ subscribers × 100'
      : yt.erMethod === 'view'
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

    const hasAnyPost = r.totalPosts > 0 || yt.videoCount > 0;

    return `<details style="border:1px solid #252d40;border-radius:6px;margin-bottom:6px">
      <summary style="padding:10px 14px;cursor:pointer;background:#181e2e;border-radius:6px;list-style:none;display:flex;align-items:center;gap:12px;user-select:none">
        <span style="font-family:monospace;font-size:10px;font-weight:700;color:#2e3a52">#${r.rank}</span>
        <span style="font-family:monospace;font-size:11px;font-weight:700;color:${col}">${escHtml(r.org)}</span>
        <span style="font-family:monospace;font-size:12px;font-weight:700;color:${col}">${r.presenceScore}/10</span>
        <span style="font-size:10px;color:#5e7494;margin-left:4px">
          <span style="color:#4a7fd4">${r.linkedinPosts} LI</span> &middot;
          <span style="color:#4a9fd4">${r.twitterPosts} X</span> &middot;
          <span style="color:#e05c9c">${r.instagramPosts||0} IG</span> &middot;
          <span style="color:#e53935">${yt.videoCount||0} YT</span>
        </span>
        <span style="color:#c9922a;font-size:11px;margin-left:auto">▾</span>
      </summary>
      <div style="padding:12px 14px;background:#0e1420">
        ${!hasAnyPost ? '<div style="font-size:11px;color:#3a4a5e">No indexed posts found in this period</div>' : ''}
        ${postSnippets('linkedin',  r.liResults || [], '#4a7fd4')}
        ${postSnippets('x.com',     r.xResults  || [], '#4a9fd4')}
        ${postSnippets('instagram', r.igResults  || [], '#e05c9c')}
        ${yt.videoCount > 0 ? `
        <div style="margin-top:10px">
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:5px">
            <span style="font-size:10px;color:#5e7494;text-transform:uppercase;letter-spacing:.08em">YouTube — <span style="color:#e53935">${yt.videoCount} video${yt.videoCount===1?'':'s'}</span>${yt.totalViews>0 ? ` &middot; ${yt.totalViews.toLocaleString()} total views` : ''}</span>
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
    <div class="sd">Indexed AQ-related posts published by each organisation on LinkedIn, X/Twitter, Instagram, and YouTube (official channel only). Ranked by total publishing volume across all platforms. SoV % = org's share of all tracked cohort posts.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  ${ytKeyNotice}

  ${summaryTable}

  <div style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;margin-bottom:8px">Per-Org Detail</div>
  ${orgDetails}
</section>`;
}

module.exports = { run, buildSocialERHtml };

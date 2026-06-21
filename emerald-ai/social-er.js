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
    { label: 'LinkedIn posts indexed',    value: totalLiIndexed,   unit: 'via Google index',               col: '#4a7fd4' },
    { label: 'X/Twitter posts indexed',   value: totalXIndexed,    unit: 'via Google index',               col: '#4a9fd4' },
    { label: 'Instagram posts indexed',   value: totalIgIndexed,   unit: 'via Google index',               col: '#e05c9c' },
    { label: 'YouTube videos indexed',    value: totalYtVideos,    unit: 'via Google index',               col: '#e53935' },
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

  const orgRows = erResults.map(r => {
    const yt       = ytResults.find(y => y.org === r.org) || { videoCount: 0, videos: [], totalViews: 0, totalLikes: 0, totalComments: 0, avgER: 0, avgViewER: 0, erMethod: 'none' };
    const hasData  = r.totalPosts > 0;
    const col      = scoreColor(r.presenceScore);
    const liPct    = Math.round((r.linkedinPosts / maxPosts) * 100);
    const xPct     = Math.round((r.twitterPosts  / maxPosts) * 100);
    const igPct    = Math.round(((r.instagramPosts || 0) / maxPosts) * 100);
    const ytPct    = Math.round(((yt.videoCount || 0) / maxYtVids) * 100);
    const bd       = r.scoreBreakdown;

    const postSnippets = (platform, items, linkCol) => items.slice(0, 1).map(s => `
      <div style="margin-top:7px;padding:7px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0">
        <div style="font-size:11px;color:#8fa3b8;line-height:1.5">${escHtml((s.title || s.snippet || '').slice(0, 120))}</div>
        ${s.link ? `<a href="${escHtml(s.link)}" style="font-size:10px;color:${linkCol};text-decoration:none;display:inline-block;margin-top:3px" target="_blank">↗ ${platform}</a>` : ''}
      </div>`).join('');

    // Top YouTube video card
    const topYtVideo = [...(yt.videos || [])].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];
    const ytSection = yt.videoCount > 0
      ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #1e2638">
          <div style="font-size:10px;color:#5e7494;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em">YouTube <span style="color:#e53935">${yt.videoCount} video${yt.videoCount === 1 ? '' : 's'}</span>${yt.totalViews > 0 ? ` &middot; ${yt.totalViews.toLocaleString()} views` : ''}</div>
          ${topYtVideo ? `<div style="padding:7px 10px;background:#0a0e17;border-left:2px solid #e53935;border-radius:0 4px 4px 0">
            <div style="font-size:11px;color:#8fa3b8;line-height:1.5;margin-bottom:3px">${escHtml((topYtVideo.title || topYtVideo.url || '').slice(0, 100))}</div>
            <div style="font-family:monospace;font-size:10px;color:#5e7494">${topYtVideo.views !== null ? `${(topYtVideo.views||0).toLocaleString()} views · ${(topYtVideo.likes||0).toLocaleString()} likes` : '<span style="color:#c9922a">YouTube API key may need \'YouTube Data API v3\' enabled in Google Cloud Console</span>'}</div>
            ${topYtVideo.url ? `<a href="${escHtml(topYtVideo.url)}" target="_blank" style="font-size:10px;color:#e53935;text-decoration:none;display:inline-block;margin-top:3px">↗ watch</a>` : ''}
          </div>` : ''}
        </div>`
      : `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #1e2638;font-size:11px;color:#3a4a5e">No YouTube videos indexed in this period</div>`;

    const noData = !hasData
      ? `<div style="margin-top:8px;font-size:11px;color:#3a4a5e">No indexed posts found in this period</div>`
      : '';

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 20px;border-left:3px solid ${col}">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">

        <div style="flex-shrink:0;width:28px;font-family:monospace;font-size:14px;font-weight:700;color:#5e7494;padding-top:2px">#${r.rank}</div>

        <div style="flex:1;min-width:200px">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
            <span style="font-family:monospace;font-size:12px;font-weight:700;color:#d8e4f0">${escHtml(r.org)}</span>
            <span style="font-family:monospace;font-size:18px;font-weight:700;color:${col}">${r.presenceScore}<span style="font-size:11px;color:#5e7494">/10</span></span>
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:#5e7494">
            <span><span style="font-family:monospace;font-weight:700;color:#4a7fd4">${r.linkedinPosts}</span> LI</span>
            <span><span style="font-family:monospace;font-weight:700;color:#4a9fd4">${r.twitterPosts}</span> X</span>
            <span><span style="font-family:monospace;font-weight:700;color:#e05c9c">${r.instagramPosts || 0}</span> IG</span>
            <span><span style="font-family:monospace;font-weight:700;color:#e53935">${yt.videoCount}</span> YT</span>
          </div>

          <div style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px">
            ${[
              { label: 'Volume',    pts: bd.volume.pts,    max: 4, detail: bd.volume.detail,    col: '#4a9fd4' },
              { label: 'Breadth',   pts: bd.breadth.pts,   max: 3, detail: bd.breadth.detail,   col: '#c9922a' },
              { label: 'Relevance', pts: bd.relevance.pts, max: 3, detail: bd.relevance.detail, col: '#4caf74' },
            ].map(c => `
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:10px;color:#5e7494;width:62px;flex-shrink:0">${c.label}</span>
              <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
                <div style="height:100%;width:${Math.round(c.pts/c.max*100)}%;background:${c.col};border-radius:3px"></div>
              </div>
              <span style="font-family:monospace;font-size:10px;color:${c.col};width:28px;text-align:right">${c.pts}/${c.max}</span>
              <span style="font-size:10px;color:#3a4a5e;flex-shrink:0">${c.detail}</span>
            </div>`).join('')}
          </div>

          ${postSnippets('linkedin',  r.liResults || [], '#4a7fd4')}
          ${postSnippets('x.com',     r.xResults  || [], '#4a9fd4')}
          ${postSnippets('instagram', r.igResults  || [], '#e05c9c')}
          ${noData}
          ${ytSection}
        </div>

        <div style="flex-shrink:0;min-width:140px">
          <div style="font-size:10px;color:#5e7494;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em">Platform</div>
          ${[
            { label: 'LI', pct: liPct, count: r.linkedinPosts,         col: '#4a7fd4' },
            { label: 'X',  pct: xPct,  count: r.twitterPosts,          col: '#4a9fd4' },
            { label: 'IG', pct: igPct, count: r.instagramPosts || 0,    col: '#e05c9c' },
            { label: 'YT', pct: ytPct, count: yt.videoCount || 0,       col: '#e53935' },
          ].map(p => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
            <span style="font-family:monospace;font-size:10px;color:${p.col};width:20px">${p.label}</span>
            <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${p.pct}%;background:${p.col};border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:11px;font-weight:700;color:${p.col};width:16px;text-align:right">${p.count}</span>
          </div>`).join('')}
        </div>

      </div>
    </div>`;
  }).join('');

  return `
<section class="sec" id="social">
  <div class="sh">
    <div class="se">Section 08b</div>
    <h2 class="st">Social AQ Presence</h2>
    <div class="sd">Google-indexed posts mentioning each organisation in an air quality context on LinkedIn, X/Twitter, Instagram, and YouTube. Scored 0–10 on a transparent formula: Volume (0–4) + Platform Breadth (0–3) + AQ Keyword Relevance (0–3).</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  <div style="background:rgba(74,159,212,.06);border:1px solid rgba(74,159,212,.18);border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:12px;color:#8fa3b8;line-height:1.7">
    <strong style="color:#4a9fd4">Scoring formula:</strong>
    <strong>Volume</strong> (0–4): 0 posts=0, 1=1, 2–3=2, 4–6=3, 7+=4 &nbsp;·&nbsp;
    <strong>Breadth</strong> (0–3): 1pt per platform (LinkedIn / X / Instagram) with &ge;1 indexed post &nbsp;·&nbsp;
    <strong>Relevance</strong> (0–3): avg AQ keyword hits per post title+snippet (&lt;0.5=0, &lt;1=1, &lt;2=2, 2+=3)
  </div>

  ${ytKeyNotice}

  <div style="display:flex;flex-direction:column;gap:10px">${orgRows}</div>
</section>`;
}

module.exports = { run, buildSocialERHtml };

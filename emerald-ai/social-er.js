'use strict';
/**
 * social-er.js — Social AQ Presence (APIdirect.io)
 *
 * Data sources:
 *   LinkedIn  → APIdirect /v1/linkedin/posts (likes, comments, shares, links)
 *   Twitter/X → APIdirect /v1/twitter/posts + user/tweets + user (ER, followers)
 *   Instagram → APIdirect /v1/instagram/posts + user (ER, followers)
 *   YouTube   → youtube-er.js (YouTube Data API v3) — APIdirect has no video endpoint
 *
 * Presence score 0–10 (unchanged formula):
 *   Volume   (0–4): total AQ posts across platforms
 *   Breadth  (0–3): platforms with ≥1 post
 *   Relevance(0–3): API-verified AQ posts → always 3 when APIdirect returns data
 */

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Presence score (transparent formula) ───────────────────────────────────

function scorePresence(liCount, xCount, igCount) {
  const total = liCount + xCount + igCount;
  const volumePts = total === 0 ? 0 : total === 1 ? 1 : total <= 3 ? 2 : total <= 6 ? 3 : 4;
  const platforms = [liCount > 0, xCount > 0, igCount > 0].filter(Boolean).length;
  const breadthPts = platforms;
  // APIdirect always returns AQ-filtered posts → relevance = 3 when any posts found
  const relevancePts = total > 0 ? 3 : 0;
  return {
    presenceScore: volumePts + breadthPts + relevancePts,
    scoreBreakdown: {
      volume:    { pts: volumePts,    max: 4, detail: `${total} AQ posts across platforms` },
      breadth:   { pts: breadthPts,   max: 3, detail: `${platforms} of 3 platforms active` },
      relevance: { pts: relevancePts, max: 3, detail: 'APIdirect live data' },
    },
  };
}

// ── Main run() ──────────────────────────────────────────────────────────────

async function run(cfg, selectedOrgs, cb) {
  const APIdirect = require('./apidirect-collector');

  // Build orgHandles from all three platform handle maps (user-editable in UI)
  const orgHandles = {};
  for (const org of selectedOrgs) {
    orgHandles[org] = {
      youtube:   (cfg.ORG_YT_HANDLES || {})[org] || '',
      twitter:   (cfg.ORG_TW_HANDLES || {})[org] || '',
      instagram: (cfg.ORG_IG_HANDLES || {})[org] || '',
      linkedin:  (cfg.ORG_LI_HANDLES || {})[org] || '',
    };
  }

  cb?.(`\n  Social Presence (APIdirect.io): ${selectedOrgs.length} orgs → LI + X + IG + YT channel…`);

  let rawResults = [];
  try {
    rawResults = await APIdirect.run(cfg, selectedOrgs, orgHandles, cb);
  } catch (e) {
    cb?.(`  APIdirect collection error: ${e.message}`, 'err');
    return [];
  }

  // SENTINEL: validate every org × platform result, diagnose zeros, retry
  // transient failures, and log the data-health verdict for this run.
  try {
    const Sentinel = require('./sentinel');
    rawResults = await Sentinel.socialSentinel(rawResults, { cfg, orgHandles, cb });
  } catch (e) {
    cb?.(`  Sentinel error (non-fatal): ${e.message}`, 'warn');
  }

  // Map APIdirect results → pipeline.js-compatible format
  const orgResults = rawResults.map((d, idx) => {
    const liCount = d.li.postCount;
    const xCount  = d.tw.postCount;
    const igCount = d.ig.postCount;
    const { presenceScore, scoreBreakdown } = scorePresence(liCount, xCount, igCount);
    const totalPosts = liCount + xCount + igCount;

    return {
      org:            d.org,
      presenceScore,
      scoreBreakdown,
      avgER:          presenceScore, // pipeline compat
      twitterER:      d.tw.er || 0,
      linkedinER:     d.li.er || 0,
      instagramER:    d.ig.er || 0,
      youtubeER:      0,            // set by youtube-er.js
      twitterPosts:   xCount,
      linkedinPosts:  liCount,
      instagramPosts: igCount,
      youtubePosts:   0,
      totalPosts,
      insight: totalPosts > 0
        ? `${liCount} LinkedIn (${d.li.totalLikes}♥ ${d.li.totalComments}💬 ${d.li.totalShares}↗) · ${xCount} X (${d.tw.followers?.toLocaleString?.() || 0} followers, ER ${d.tw.er}%) · ${igCount} IG (${d.ig.followers?.toLocaleString?.() || 0} followers, ER ${d.ig.er}%)`
        : 'No AQ social posts found via APIdirect in this period',
      // Rich APIdirect data (used in HTML)
      liData:  d.li,
      twData:  d.tw,
      igData:  d.ig,
      ytChData: d.yt || { subscribers: 0, channelTitle: '', channelUrl: '' },
      // Legacy compat fields (unused but kept for safety)
      liResults:  [],
      xResults:   [],
      igResults:  [],
      xApiResult:  null,
      igApiResult: null,
      useXApi:    true,
      useIgApi:   true,
    };
  });

  orgResults.sort((a, b) => b.presenceScore - a.presenceScore);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.('  Social Presence (APIdirect) complete', 'ok');
  return orgResults;
}

// ── HTML helpers ────────────────────────────────────────────────────────────

function scoreColor(s) {
  if (s >= 8) return '#4caf74';
  if (s >= 5) return '#c9922a';
  return '#e05c5c';
}

function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function topPostsHtml(posts, color, fields) {
  if (!posts?.length) return '<div style="font-size:15px;color:#7d90aa">No posts found</div>';
  return posts.map((p, i) => {
    const metrics = fields.map(f => {
      const icons = { likes: '♥', comments: '💬', shares: '↗', retweets: '↻', replies: '↩', views: '👁' };
      return `${icons[f] || ''} ${fmtNum(p[f] || 0)}`;
    }).join(' · ');
    return `<div style="padding:6px 10px;background:#0a0e17;border-left:2px solid ${i === 0 ? color : '#1e2638'};border-radius:0 4px 4px 0;margin-bottom:4px">
      ${p.url
        ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener" style="font-size:16px;color:${color};text-decoration:none;line-height:1.4;display:block;font-weight:600">${escHtml((p.snippet || '').slice(0, 200))}${(p.snippet||'').length > 200 ? '…' : ''}</a>`
        : `<div style="font-size:16px;color:#8fa3b8;line-height:1.4">${escHtml((p.snippet || '').slice(0, 200))}</div>`}
      <div style="font-family:monospace;font-size:14px;color:#5e7494;margin-top:3px">${metrics}${p.date ? ' · ' + p.date.slice(0, 10) : ''}</div>
    </div>`;
  }).join('');
}

// ── buildSocialERHtml ───────────────────────────────────────────────────────

function buildSocialERHtml(erResults, ytResults = [], hasYtKey = false) {
  if (!erResults?.length) return '';

  // ── Sentinel data-health: collect per-platform fetch failures ─────────────
  const fetchFailures = [];
  for (const r of erResults) {
    for (const [pName, pd] of [['LinkedIn', r.liData], ['X/Twitter', r.twData], ['Instagram', r.igData]]) {
      if (pd?.failed) fetchFailures.push({ org: r.org, platform: pName, reason: pd.failReason || 'unknown' });
    }
  }
  const healthBanner = fetchFailures.length
    ? `<div class="sentinel-note" style="background:rgba(224,92,92,.08);border:1px solid rgba(224,92,92,.35);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:16px;color:#e05c5c;line-height:1.7">
        <strong>&#9888; SENTINEL · DATA COLLECTION INCOMPLETE</strong> — ${fetchFailures.length} platform fetch(es) failed (${[...new Set(fetchFailures.map(f => f.reason))].join(', ')}).
        Affected cells show <strong>✕</strong> and are excluded from totals — they are <strong>not</strong> zeros.
        <span style="color:#c9922a">${[...new Set(fetchFailures.map(f => f.platform))].map(p => `${p}: ${fetchFailures.filter(f => f.platform === p).length} org(s)`).join(' · ')}</span>
      </div>`
    : `<div class="sentinel-note" style="background:rgba(74,175,116,.08);border:1px solid rgba(74,175,116,.3);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:16px;color:#4caf74;line-height:1.7">
        <strong>&#9432; SENTINEL</strong> — All social fetches across ${erResults.length} orgs (LinkedIn · X · Instagram) completed; any zeros shown are verified absence, not collection failures.
      </div>`;

  // Post-count cell: failure ≠ zero ≠ no handle — each renders distinctly.
  const postCell = (count, pd, color) => {
    if (pd?.failed) return `<span style="color:#e05c5c;cursor:help" title="API request failed (${escHtml(pd.failReason || 'unknown')}) — data unavailable, not zero">✕</span>`;
    if (pd?.noHandle) return `<span style="color:#3d4a63;cursor:help" title="No handle configured for this platform">–</span>`;
    return `<span style="color:${color}">${count || 0}</span>`;
  };

  const orgsWithPresence = erResults.filter(r => r.totalPosts > 0).length;
  const totalLi = erResults.reduce((s, r) => s + (r.linkedinPosts || 0), 0);
  const totalX  = erResults.reduce((s, r) => s + (r.twitterPosts  || 0), 0);
  const totalIg = erResults.reduce((s, r) => s + (r.instagramPosts || 0), 0);
  const totalYt = ytResults.reduce((s, r) => s + (r.videoCount    || 0), 0);

  // Stat cards
  const statCards = [
    { label: 'Orgs with AQ social posts', value: orgsWithPresence,                  unit: `of ${erResults.length} tracked`,  col: '#4caf74' },
    { label: 'LinkedIn AQ posts',          value: totalLi,                            unit: 'LinkedIn API',                    col: '#4a7fd4' },
    { label: 'X/Twitter AQ tweets',        value: totalX,                             unit: 'X API v2',                        col: '#4a9fd4' },
    { label: 'Instagram AQ posts',         value: totalIg,                            unit: 'Instagram Graph API',             col: '#e05c9c' },
    { label: 'YouTube videos',             value: totalYt,                            unit: 'YouTube Data API v3',             col: '#e53935' },
  ].map(c => `
    <div style="flex:1;min-width:140px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:14px 16px">
      <div style="font-family:monospace;font-size:15px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:27px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:16px;color:#5e7494;margin-top:5px">${c.unit}</div>
    </div>`).join('');

  // Source banner
  const sourceBanner = `
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
    <span style="font-family:monospace;font-size:14px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#5e7494">Data sources:</span>
    <span style="font-family:monospace;font-size:15px;background:rgba(74,127,212,.14);border:1px solid rgba(74,127,212,.35);color:#4a7fd4;border-radius:4px;padding:2px 8px">LinkedIn · ✓ LinkedIn API</span>
    <span style="font-family:monospace;font-size:15px;background:rgba(74,159,212,.14);border:1px solid rgba(74,159,212,.35);color:#4a9fd4;border-radius:4px;padding:2px 8px">X/Twitter · ✓ X API v2</span>
    <span style="font-family:monospace;font-size:15px;background:rgba(224,92,156,.14);border:1px solid rgba(224,92,156,.35);color:#e05c9c;border-radius:4px;padding:2px 8px">Instagram · ✓ Graph API</span>
    <span style="font-family:monospace;font-size:15px;background:rgba(229,57,53,.12);border:1px solid rgba(229,57,53,.3);color:#e53935;border-radius:4px;padding:2px 8px">YouTube · ✓ Data API v3</span>
  </div>`;

  const ytKeyNotice = !hasYtKey
    ? `<div style="background:rgba(201,146,42,.08);border:1px solid rgba(201,146,42,.3);border-radius:8px;padding:10px 14px;margin-bottom:20px;font-size:16px;color:#d4a017;line-height:1.7">
        <strong>&#9432; YOUTUBE_KEY not configured</strong> — videos are discovered via Serper but views/likes/ER require a Google API key with YouTube Data API v3 enabled.
      </div>`
    : '';

  // ── Summary table ─────────────────────────────────────────────────────────
  const colTotals = erResults.reduce((s, r) => {
    const yt = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
    s.li += r.linkedinPosts || 0;
    s.x  += r.twitterPosts  || 0;
    s.ig += r.instagramPosts || 0;
    s.yt += yt.videoCount   || 0;
    return s;
  }, { li: 0, x: 0, ig: 0, yt: 0 });
  const cohortTotal = colTotals.li + colTotals.x + colTotals.ig + colTotals.yt || 1;

  const unifiedRows = erResults
    .map(r => {
      const yt    = ytResults.find(y => y.org === r.org) || { videoCount: 0 };
      const total = (r.linkedinPosts || 0) + (r.twitterPosts || 0) + (r.instagramPosts || 0) + (yt.videoCount || 0);
      return { r, yt, total };
    })
    .sort((a, b) => b.total - a.total);

  let _lastTotal = null, _lastRank = 0;
  unifiedRows.forEach(({ total }, idx) => {
    if (total === _lastTotal) { unifiedRows[idx].unifiedRank = _lastRank; }
    else { _lastRank = idx + 1; unifiedRows[idx].unifiedRank = _lastRank; _lastTotal = total; }
  });

  const summaryTable = `<div style="overflow:hidden;overflow-x:auto;border:1px solid #252d40;border-radius:8px;margin-bottom:16px">
  <table style="width:100%;border-collapse:collapse;font-size:17px">
    <thead>
      <tr style="background:#181e2e">
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fa3b8;white-space:nowrap">#</th>
        <th style="padding:8px 12px;text-align:left;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8fa3b8">Org</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a7fd4;white-space:nowrap">LI posts</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a9fd4;white-space:nowrap">X posts</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a9fd4;white-space:nowrap">X ER%</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4a9fd4;white-space:nowrap">X flw</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e05c9c;white-space:nowrap">IG posts</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e05c9c;white-space:nowrap">IG ER%</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e05c9c;white-space:nowrap">IG flw</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e53935;white-space:nowrap">YT</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e53935;white-space:nowrap">YT ER%</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#e53935;white-space:nowrap">YT subs</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#c9922a;white-space:nowrap">Total</th>
        <th style="padding:8px 12px;text-align:center;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4caf74;white-space:nowrap;cursor:help" title="Share of Voice — how much of the tracked group's total AQ social activity this org accounts for during the report period">SoV%</th>
      </tr>
      <tr style="background:#0f1422;border-top:1px solid #252d40">
        <td colspan="2" style="padding:5px 12px;font-family:monospace;font-size:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7e9a">COHORT</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#4a7fd4">${colTotals.li}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#4a9fd4">${colTotals.x}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#e05c9c">${colTotals.ig}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#e53935">${colTotals.yt}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;color:#6b7e9a">—</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#c9922a">${cohortTotal}</td>
        <td style="padding:5px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#4caf74">100%</td>
      </tr>
    </thead>
    <tbody>
      ${unifiedRows.map(({ r, yt, total, unifiedRank }) => {
        const sov  = cohortTotal > 0 ? ((total / cohortTotal) * 100).toFixed(1) : '0.0';
        const barW = Math.round((total / (unifiedRows[0].total || 1)) * 100);
        const col  = total >= 10 ? '#4caf74' : total >= 5 ? '#c9922a' : total >= 1 ? '#4a9fd4' : '#5e7494';
        const twFollowers = r.twData?.followers || 0;
        const igFollowers = r.igData?.followers || 0;
        const ytER   = yt.avgER || yt.avgViewER || 0;
        const ytSubs = yt.videos?.find(v => v.subscribers > 0)?.subscribers || 0;
        const twER  = r.twitterER  > 0 ? `<span style="color:#4a9fd4">${r.twitterER}%</span>` : '<span style="color:#6b7e9a">—</span>';
        // IG ER: show ~ when followers < 500 (unreliable denominator)
        const igER  = r.instagramER > 0
          ? (igFollowers >= 500
              ? `<span style="color:#e05c9c">${r.instagramER}%</span>`
              : `<span style="color:#6b7e9a" title="ER unreliable — follower count too low (${igFollowers}) for meaningful ER">~</span>`)
          : '<span style="color:#6b7e9a">—</span>';
        const ytERCell = ytER > 0 ? `<span style="color:#e53935">${ytER}%</span>` : '<span style="color:#6b7e9a">—</span>';
        const twFlwCell = twFollowers > 0 ? `<span style="color:#4a9fd4;font-size:18px">${fmtNum(twFollowers)}</span>` : '<span style="color:#6b7e9a">—</span>';
        const igFlwCell = igFollowers > 0 ? `<span style="color:#e05c9c;font-size:18px">${fmtNum(igFollowers)}</span>` : '<span style="color:#6b7e9a">—</span>';
        const ytSubsCell = ytSubs > 0 ? `<span style="color:#e53935;font-size:18px">${fmtNum(ytSubs)}</span>` : '<span style="color:#6b7e9a">—</span>';
        return `<tr style="border-top:1px solid #252d40">
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#8fa3b8">#${unifiedRank}</td>
          <td style="padding:8px 12px"><span style="font-family:monospace;font-size:18px;font-weight:700;color:${col}">${escHtml(r.org)}</span></td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700">${postCell(r.linkedinPosts, r.liData, '#4a7fd4')}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700">${postCell(r.twitterPosts, r.twData, '#4a9fd4')}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px">${twER}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace">${twFlwCell}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700">${postCell(r.instagramPosts, r.igData, '#e05c9c')}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px">${igER}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace">${igFlwCell}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:700;color:#e53935">${yt.videoCount || 0}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px">${ytERCell}</td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace">${ytSubsCell}</td>
          <td style="padding:8px 12px;text-align:center">
            <span style="font-family:monospace;font-size:20px;font-weight:700;color:${col}">${total}</span>
          </td>
          <td style="padding:8px 12px;text-align:center;font-family:monospace;font-size:18px;font-weight:600;color:#4caf74">${sov}%</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
</div>
<div style="background:#0d1120;border:1px solid #1e2638;border-radius:6px;padding:10px 14px;font-family:monospace;font-size:14px;color:#7d90aa;line-height:1.9;margin-bottom:16px">
  <strong style="color:#5e7494;letter-spacing:.06em">LEGEND</strong> &nbsp;·&nbsp;
  <strong style="color:#4a7fd4">LI</strong> = LinkedIn AQ posts &nbsp;·&nbsp;
  <strong style="color:#4a9fd4">X</strong> = X/Twitter AQ posts from official handle &nbsp;·&nbsp;
  <strong style="color:#e05c9c">IG</strong> = Instagram posts from official handle &nbsp;·&nbsp;
  <strong style="color:#e53935">YT</strong> = YouTube videos via Data API v3 &nbsp;·&nbsp;
  <span style="color:#5e7494">flw = follower count &nbsp;·&nbsp; subs = subscriber count</span><br>
  ER% = Engagement Rate — X: (likes+replies+retweets)÷followers×100 &nbsp;·&nbsp; IG: (likes+comments)÷followers×100 (shown as <strong>~</strong> when followers &lt; 500, unreliable) &nbsp;·&nbsp; YT: (likes+comments)÷subscribers×100, falls back to ÷views &nbsp;·&nbsp;
  SoV% = org total ÷ cohort total &nbsp;·&nbsp; Data: LinkedIn API · X API v2 · Instagram Graph API · YouTube Data API v3
</div>`;

  // ── Per-org expandable detail sections ───────────────────────────────────
  const orgDetails = erResults.map(r => {
    const yt  = ytResults.find(y => y.org === r.org) || { videoCount: 0, videos: [], avgER: 0, avgViewER: 0, erMethod: 'none', totalViews: 0 };
    const col = scoreColor(r.presenceScore);

    // LinkedIn block
    const li = r.liData || { postCount: 0, totalLikes: 0, totalComments: 0, totalShares: 0, topPosts: [] };
    const liHtml = li.postCount > 0 ? `
      <div style="margin-top:8px">
        <div style="font-size:14px;color:#7d90aa;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">
          LinkedIn — <span style="color:#4a7fd4">${li.postCount} AQ post${li.postCount === 1 ? '' : 's'}</span>
          &middot; ♥ ${li.totalLikes} &middot; 💬 ${li.totalComments} &middot; ↗ ${li.totalShares}
        </div>
        ${topPostsHtml(li.topPosts, '#4a7fd4', ['likes', 'comments', 'shares'])}
      </div>` : '';

    // Twitter block
    const tw = r.twData || { postCount: 0, totalLikes: 0, totalReplies: 0, totalRetweets: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
    const twHtml = tw.postCount > 0 ? `
      <div style="margin-top:8px">
        <div style="font-size:14px;color:#7d90aa;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">
          X/Twitter — <span style="color:#4a9fd4">${tw.postCount} tweet${tw.postCount === 1 ? '' : 's'}</span>
          ${tw.followers ? `&middot; ${fmtNum(tw.followers)} followers` : ''}
          ${tw.er > 0 ? `&middot; <span style="color:#4a9fd4;background:rgba(74,159,212,.1);border:1px solid rgba(74,159,212,.25);border-radius:3px;padding:1px 5px">ER ${tw.er}%</span>` : ''}
          &middot; ♥ ${tw.totalLikes} &middot; ↩ ${tw.totalReplies} &middot; ↻ ${tw.totalRetweets} ${tw.totalViews > 0 ? `&middot; 👁 ${fmtNum(tw.totalViews)}` : ''}
        </div>
        ${topPostsHtml(tw.topPosts, '#4a9fd4', ['likes', 'replies', 'retweets', 'views'])}
      </div>` : '';

    // Instagram block
    const ig = r.igData || { postCount: 0, totalLikes: 0, totalComments: 0, totalViews: 0, followers: 0, er: 0, topPosts: [] };
    const igHtml = ig.postCount > 0 ? `
      <div style="margin-top:8px">
        <div style="font-size:14px;color:#7d90aa;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700;margin-bottom:4px">
          Instagram — <span style="color:#e05c9c">${ig.postCount} post${ig.postCount === 1 ? '' : 's'}</span>
          ${ig.followers ? `&middot; ${fmtNum(ig.followers)} followers` : ''}
          ${ig.er > 0 ? `&middot; <span style="color:#e05c9c;background:rgba(224,92,156,.1);border:1px solid rgba(224,92,156,.25);border-radius:3px;padding:1px 5px">ER ${ig.er}%</span>` : ''}
          &middot; ♥ ${ig.totalLikes} &middot; 💬 ${ig.totalComments} ${ig.totalViews > 0 ? `&middot; 👁 ${fmtNum(ig.totalViews)}` : ''}
        </div>
        ${topPostsHtml(ig.topPosts, '#e05c9c', ['likes', 'comments', 'views'])}
      </div>` : '';

    // YouTube block (from youtube-er.js)
    const sortedYtVideos = [...(yt.videos || [])].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
    const avgER = yt.avgER || yt.avgViewER || 0;
    const erMethodLabel = yt.erMethod === 'subscriber'
      ? 'ER = (likes+comments) ÷ subscribers × 100'
      : yt.erMethod === 'view'
        ? 'ER = (likes+comments) ÷ views × 100'
        : null;
    const ytHtml = yt.videoCount > 0 ? `
      <div style="margin-top:10px">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:5px">
          <span style="font-size:14px;color:#7d90aa;text-transform:uppercase;letter-spacing:.08em;font-family:monospace;font-weight:700">YouTube — <span style="color:#e53935">${yt.videoCount} video${yt.videoCount === 1 ? '' : 's'}</span>${yt.totalViews > 0 ? ` &middot; ${yt.totalViews.toLocaleString()} total views` : ''}</span>
          ${avgER > 0 ? `<span style="font-family:monospace;font-size:15px;color:#e53935;background:rgba(229,57,53,.08);border:1px solid rgba(229,57,53,.2);border-radius:4px;padding:1px 7px">avg ER ${avgER}%</span>` : ''}
          ${erMethodLabel ? `<span style="font-family:monospace;font-size:14px;color:#7d90aa">${erMethodLabel}</span>` : ''}
        </div>
        ${sortedYtVideos.map((v, idx) => {
          const metricsStr = v.views !== null
            ? `${(v.views || 0).toLocaleString()} views &middot; ${(v.likes || 0).toLocaleString()} likes &middot; ${(v.comments || 0).toLocaleString()} comments`
            : '<span style="color:#5e7494">metrics unavailable</span>';
          const erStr = (v.subscriberER !== null)
            ? ` &middot; <span style="color:#e53935">ER ${v.subscriberER}% (sub)</span>`
            : (v.viewER !== null) ? ` &middot; <span style="color:#e05c5c">ER ${v.viewER}% (view)</span>` : '';
          return `<div style="padding:6px 10px;background:#0a0e17;border-left:2px solid ${idx === 0 ? '#e53935' : '#1e2638'};border-radius:0 4px 4px 0;margin-bottom:4px">
            <div style="display:flex;align-items:flex-start;gap:8px">
              <span style="font-family:monospace;font-size:14px;color:#7d90aa;flex-shrink:0;margin-top:2px">#${idx + 1}</span>
              <div style="flex:1;min-width:0">
                ${v.url
                  ? `<a href="${escHtml(v.url)}" target="_blank" style="font-size:16px;color:#e53935;text-decoration:none;line-height:1.4;display:block;font-weight:600;margin-bottom:2px">${escHtml((v.title || v.url || '').slice(0, 150))}${(v.title || v.url || '').length > 150 ? '…' : ''}</a>`
                  : `<div style="font-size:16px;color:#8fa3b8;line-height:1.4;margin-bottom:2px">${escHtml((v.title || '').slice(0, 150))}</div>`}
                <div style="font-family:monospace;font-size:14px;color:#5e7494">${metricsStr}${erStr}</div>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>` : '';

    const hasAnyPost = r.totalPosts > 0 || yt.videoCount > 0;

    return `<details style="border:1px solid #252d40;border-radius:6px;margin-bottom:6px">
      <summary style="padding:10px 14px;cursor:pointer;background:#181e2e;border-radius:6px;list-style:none;display:flex;align-items:center;gap:12px;user-select:none">
        <span style="font-family:monospace;font-size:15px;font-weight:700;color:#6b7e9a">#${r.rank}</span>
        <span style="font-family:monospace;font-size:16px;font-weight:700;color:${col}">${escHtml(r.org)}</span>
        <span style="font-family:monospace;font-size:17px;font-weight:700;color:${col}">${r.presenceScore}/10</span>
        <span style="font-size:15px;color:#5e7494;margin-left:4px">
          <span style="color:#4a7fd4">${r.linkedinPosts || 0} LI</span> &middot;
          <span style="color:#4a9fd4">${r.twitterPosts || 0} X</span> &middot;
          <span style="color:#e05c9c">${r.instagramPosts || 0} IG</span> &middot;
          <span style="color:#e53935">${yt.videoCount || 0} YT</span>
        </span>
        ${r.twitterER > 0 || r.instagramER > 0 ? `<span style="font-size:15px;color:#5e7494">
          ${r.twitterER > 0 ? `<span style="color:#4a9fd4">X ${r.twitterER}%</span>` : ''}
          ${r.twitterER > 0 && r.instagramER > 0 ? ' · ' : ''}
          ${r.instagramER > 0 ? `<span style="color:#e05c9c">IG ${r.instagramER}%</span>` : ''}
        </span>` : ''}
        <span style="color:#c9922a;font-size:16px;margin-left:auto">▾</span>
      </summary>
      <div style="padding:12px 14px;background:#0e1420">
        ${!hasAnyPost ? '<div style="font-size:16px;color:#7d90aa">No AQ social posts found via APIdirect in this period</div>' : ''}
        ${liHtml}
        ${twHtml}
        ${igHtml}
        ${ytHtml}
      </div>
    </details>`;
  });

  return `
<!-- SOCIAL PRESENCE SECTION -->
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">${statCards}</div>
${sourceBanner}
${healthBanner}
${ytKeyNotice}
${summaryTable}
${orgDetails.join('')}`;
}

module.exports = { run, buildSocialERHtml };

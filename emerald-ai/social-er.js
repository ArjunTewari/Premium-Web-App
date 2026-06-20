'use strict';
/**
 * social-er.js — Social AQ Presence module (Serper-based)
 * Searches LinkedIn and X/Twitter via Serper for AQ posts mentioning each org
 * in the report date range. No Apify required.
 */

const axios = require('axios');

const AQ_TERMS = '("air quality" OR "air pollution" OR AQI OR PM2.5 OR NCAP)';

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

async function run(cfg, selectedOrgs, cb) {
  const SERPER_KEY = cfg.SERPER_KEY;
  if (!SERPER_KEY) {
    cb?.('  [SocialPresence] No SERPER_KEY — skipping', 'warn');
    return [];
  }

  cb?.(`  Social Presence: searching ${selectedOrgs.length} orgs via Serper (LinkedIn + X)…`);
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [SocialPresence] "${orgName}"…`);

    const [liItems, xItems] = await Promise.all([
      serperSearch(
        `"${orgName}" ${AQ_TERMS} site:linkedin.com/posts`,
        SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb
      ),
      serperSearch(
        `"${orgName}" ${AQ_TERMS} (site:x.com OR site:twitter.com)`,
        SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb
      ),
    ]);

    const totalFound = liItems.length + xItems.length;
    const topItem = liItems[0] || xItems[0] || null;

    orgResults.push({
      org:           orgName,
      // ER fields kept at 0 for pipeline.js compatibility (scorecard, PPTX)
      twitterER:     0,
      linkedinER:    0,
      youtubeER:     0,
      avgER:         0,
      twitterPosts:  xItems.length,
      linkedinPosts: liItems.length,
      youtubePosts:  0,
      totalPosts:    totalFound,
      bestPost:      topItem ? { platform: liItems[0] ? 'linkedin' : 'x', url: topItem.link, text: topItem.snippet || topItem.title || '', date: topItem.date || '' } : null,
      insight:       totalFound > 0
        ? `${liItems.length} LinkedIn · ${xItems.length} X/Twitter posts indexed`
        : 'No indexed social posts found in this period',
      liResults:     liItems,
      xResults:      xItems,
    });

    cb?.(`  [SocialPresence] ${orgName}: LI=${liItems.length} X=${xItems.length}`, totalFound > 0 ? 'ok' : 'warn');
  }

  orgResults.sort((a, b) => b.totalPosts - a.totalPosts);
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.(`  Social Presence complete`, 'ok');
  return orgResults;
}

function buildSocialERHtml(erResults) {
  if (!erResults?.length) return '';

  const orgsWithPresence   = erResults.filter(r => r.totalPosts > 0).length;
  const totalIndexed       = erResults.reduce((s, r) => s + r.totalPosts, 0);
  const topOrg             = erResults[0];
  const totalLiIndexed     = erResults.reduce((s, r) => s + r.linkedinPosts, 0);
  const totalXIndexed      = erResults.reduce((s, r) => s + r.twitterPosts, 0);

  const statCards = [
    { label: 'Orgs with social AQ posts', value: orgsWithPresence, unit: `of ${erResults.length} tracked`,  col: '#4caf74' },
    { label: 'LinkedIn posts indexed',     value: totalLiIndexed,  unit: 'via Google index',                col: '#4a7fd4' },
    { label: 'X/Twitter posts indexed',    value: totalXIndexed,   unit: 'via Google index',                col: '#4a9fd4' },
    { label: 'Most visible org',           value: topOrg?.org?.split(' ').slice(-1)[0] || '—',
                                           unit: `${topOrg?.totalPosts || 0} posts`,                        col: '#c9922a' },
  ].map(c => `
    <div style="flex:1;min-width:160px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:11px;color:#5e7494;margin-top:5px">${c.unit}</div>
    </div>`).join('');

  const maxPosts = Math.max(...erResults.map(r => r.totalPosts), 1);

  const orgRows = erResults.map(r => {
    const barPct  = Math.round((r.totalPosts / maxPosts) * 100);
    const liPct   = Math.round((r.linkedinPosts / maxPosts) * 100);
    const xPct    = Math.round((r.twitterPosts / maxPosts) * 100);
    const hasData = r.totalPosts > 0;
    const col     = hasData ? '#4caf74' : '#252d40';

    const topSnippets = [...r.liResults.slice(0, 2), ...r.xResults.slice(0, 2)].slice(0, 3);
    const snippetHtml = topSnippets.length
      ? topSnippets.map(s => `
        <div style="margin-top:8px;padding:8px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0">
          <div style="font-size:10px;color:#5e7494;margin-bottom:3px">${escHtml(s.title || '').slice(0, 70)}</div>
          <div style="font-size:11px;color:#8fa3b8;line-height:1.55">${escHtml(s.snippet || '').slice(0, 140)}</div>
          ${s.link ? `<a href="${escHtml(s.link)}" style="font-size:10px;color:#4a9fd4;text-decoration:none" target="_blank">↗ view post</a>` : ''}
        </div>`).join('')
      : `<div style="margin-top:8px;font-size:11px;color:#3a4a5e">No indexed posts found in this period</div>`;

    return `
    <div style="background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 20px;border-left:3px solid ${col}">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap">
        <div style="flex-shrink:0;width:28px;font-family:monospace;font-size:14px;font-weight:700;color:#5e7494;padding-top:2px">#${r.rank}</div>
        <div style="flex:1;min-width:200px">
          <div style="font-family:monospace;font-size:12px;font-weight:700;color:#d8e4f0;margin-bottom:6px">${escHtml(r.org)}</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <div style="flex:1;height:6px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${barPct}%;background:${col};border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:14px;font-weight:700;color:${hasData ? '#4caf74' : '#3a4a5e'};width:40px;text-align:right">${r.totalPosts}</span>
          </div>
          <div style="display:flex;gap:10px;margin-bottom:4px">
            <span style="font-size:11px;color:#5e7494">
              <span style="font-family:monospace;font-weight:700;color:#4a7fd4">${r.linkedinPosts}</span>
              <span style="margin:0 3px">LI</span>
              <span style="font-family:monospace;font-weight:700;color:#4a9fd4">${r.twitterPosts}</span>
              <span>X</span>
            </span>
          </div>
          ${snippetHtml}
        </div>
        <div style="flex-shrink:0;min-width:160px">
          <div style="font-size:10px;color:#5e7494;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em">Platform</div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-family:monospace;font-size:10px;color:#4a7fd4;width:20px">LI</span>
            <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${liPct}%;background:#4a7fd4;border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:11px;font-weight:700;color:#4a7fd4;width:16px;text-align:right">${r.linkedinPosts}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:monospace;font-size:10px;color:#4a9fd4;width:20px">X</span>
            <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${xPct}%;background:#4a9fd4;border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:11px;font-weight:700;color:#4a9fd4;width:16px;text-align:right">${r.twitterPosts}</span>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
<section class="sec" id="social">
  <div class="sh">
    <div class="se">Section 08b</div>
    <h2 class="st">Social AQ Presence</h2>
    <div class="sd">Google-indexed posts mentioning each organisation in an air quality context on LinkedIn and X/Twitter during the report period. Sourced via Serper web search — counts reflect publicly indexed posts, not total platform activity.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  <div style="background:rgba(74,159,212,.06);border:1px solid rgba(74,159,212,.18);border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#8fa3b8;line-height:1.7">
    <strong style="color:#4a9fd4">Methodology:</strong> Serper web search queries <code style="background:#1e2638;padding:1px 5px;border-radius:3px;font-size:11px">"Org Name" ("air quality" OR PM2.5 OR AQI) site:linkedin.com/posts</code> and equivalent for X/Twitter. Date range filtered using Google's <code style="background:#1e2638;padding:1px 5px;border-radius:3px;font-size:11px">tbs=cdr</code> parameter. Results reflect posts indexed by Google at time of report generation.
  </div>

  <div style="display:flex;flex-direction:column;gap:10px">${orgRows}</div>
</section>`;
}

module.exports = { run, buildSocialERHtml };

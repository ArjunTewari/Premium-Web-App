'use strict';
/**
 * social-er.js — Social AQ Presence module (Serper-based)
 * Searches LinkedIn and X/Twitter via Serper for AQ posts mentioning each org.
 * For X posts: scrapes metrics (likes, reposts, replies, views) via text scrape
 * first, then falls back to ScreenshotOne + Claude vision.
 * ER = (likes + replies + reposts) / views × 100
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

// Parse shorthand numbers like "9.4K", "1.2M", "142"
function parseXNumber(s) {
  if (!s) return 0;
  s = String(s).replace(/,/g, '').trim();
  if (/k/i.test(s)) return Math.round(parseFloat(s) * 1000);
  if (/m/i.test(s)) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s) || 0;
}

// Try to extract metrics from raw page text (fast path)
function parseMetricsFromText(text) {
  const views   = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Vv]iews?/)?.[1]);
  const likes   = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Ll]ikes?/)?.[1]);
  const reposts = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*(?:[Rr]eposts?|[Rr]etweets?)/)?.[1]);
  const replies = parseXNumber(text.match(/(\d[\d,.]*[KkMm]?)\s*[Rr]eplies?/)?.[1]);
  if (!views && !likes && !reposts && !replies) return null;
  return { likes: likes || 0, replies: replies || 0, reposts: reposts || 0, views: views || 0 };
}

// Screenshot + Claude vision fallback
async function screenshotAndVision(tweetUrl, cfg, cb) {
  if (!cfg.SCREENSHOTONE_KEY || !cfg.CLAUDE_KEY) return null;
  try {
    cb?.(`    [XMetrics] Taking screenshot: ${tweetUrl}`);
    const shotUrl = `https://api.screenshotone.com/take?access_key=${cfg.SCREENSHOTONE_KEY}&url=${encodeURIComponent(tweetUrl)}&format=jpg&viewport_width=820&viewport_height=560&block_ads=true&block_cookie_banners=true&delay=2`;
    const imgRes = await axios.get(shotUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const base64 = Buffer.from(imgRes.data).toString('base64');

    cb?.(`    [XMetrics] Sending to Claude vision…`);
    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Look at this X/Twitter post screenshot. Extract the engagement counts. Return ONLY valid JSON: {"likes":0,"replies":0,"reposts":0,"views":0}. Use 0 for any metric not visible.' }
          ]
        }]
      },
      {
        headers: { 'x-api-key': cfg.CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const raw = claudeRes.data.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const m = JSON.parse(match[0]);
      cb?.(`    [XMetrics] Vision: likes=${m.likes} reposts=${m.reposts} replies=${m.replies} views=${m.views}`, 'ok');
      return { likes: m.likes || 0, replies: m.replies || 0, reposts: m.reposts || 0, views: m.views || 0 };
    }
  } catch (e) {
    cb?.(`    [XMetrics] Screenshot/vision failed: ${e.message}`, 'warn');
  }
  return null;
}

// Main metrics fetcher: text scrape first, then vision
async function getXMetrics(tweetUrl, cfg, cb) {
  // Step 1: text scrape via Serper
  if (cfg.SERPER_KEY) {
    try {
      const res = await axios.post(
        'https://scrape.serper.dev',
        { url: tweetUrl },
        { headers: { 'X-API-KEY': cfg.SERPER_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      const text = res.data.text || res.data.content || '';
      const metrics = parseMetricsFromText(text);
      if (metrics) {
        cb?.(`    [XMetrics] Text scrape: likes=${metrics.likes} reposts=${metrics.reposts} views=${metrics.views}`, 'ok');
        return { ...metrics, source: 'text' };
      }
    } catch (e) {
      cb?.(`    [XMetrics] Text scrape failed: ${e.message}`, 'warn');
    }
  }

  // Step 2: screenshot + Claude vision
  const metrics = await screenshotAndVision(tweetUrl, cfg, cb);
  return metrics ? { ...metrics, source: 'vision' } : null;
}

function calcER(metrics) {
  if (!metrics || metrics.views <= 0) return null;
  return Math.round(((metrics.likes + metrics.replies + metrics.reposts) / metrics.views) * 10000) / 100;
}

async function run(cfg, selectedOrgs, cb) {
  const SERPER_KEY = cfg.SERPER_KEY;
  if (!SERPER_KEY) {
    cb?.('  [SocialPresence] No SERPER_KEY — skipping', 'warn');
    return [];
  }

  const hasMetrics = cfg.SERPER_KEY && (cfg.SCREENSHOTONE_KEY || cfg.CLAUDE_KEY);
  cb?.(`  Social Presence: searching ${selectedOrgs.length} orgs via Serper (LinkedIn + X + Instagram)${hasMetrics ? ' + X metrics' : ''}…`);
  const orgResults = [];

  for (const orgName of selectedOrgs) {
    cb?.(`  [SocialPresence] "${orgName}"…`);

    const [liItems, xItems, igItems] = await Promise.all([
      serperSearch(`"${orgName}" ${AQ_TERMS} site:linkedin.com/posts`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
      serperSearch(`"${orgName}" ${AQ_TERMS} (site:x.com OR site:twitter.com)`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
      serperSearch(`"${orgName}" ${AQ_TERMS} site:instagram.com`, SERPER_KEY, cfg.DATE_FROM, cfg.DATE_TO, cb),
    ]);

    // Fetch metrics for up to 5 X posts
    const xWithMetrics = [];
    for (const item of xItems.slice(0, 5)) {
      if (!item.link) { xWithMetrics.push({ ...item, metrics: null }); continue; }
      const metrics = await getXMetrics(item.link, cfg, cb);
      xWithMetrics.push({ ...item, metrics });
    }

    // Calculate average ER across posts that have views
    const postsWithER = xWithMetrics.filter(p => p.metrics?.views > 0);
    const erValues = postsWithER.map(p => calcER(p.metrics)).filter(v => v !== null);
    const twitterER = erValues.length > 0
      ? Math.round((erValues.reduce((a, b) => a + b, 0) / erValues.length) * 100) / 100
      : 0;

    // Aggregate totals
    const totalLikes   = xWithMetrics.reduce((s, p) => s + (p.metrics?.likes   || 0), 0);
    const totalReposts = xWithMetrics.reduce((s, p) => s + (p.metrics?.reposts || 0), 0);
    const totalViews   = xWithMetrics.reduce((s, p) => s + (p.metrics?.views   || 0), 0);
    const totalReplies = xWithMetrics.reduce((s, p) => s + (p.metrics?.replies || 0), 0);

    const totalFound = liItems.length + xItems.length + igItems.length;
    const topItem    = liItems[0] || xItems[0] || igItems[0] || null;

    orgResults.push({
      org:              orgName,
      twitterER,
      linkedinER:       0,
      youtubeER:        0,
      avgER:            twitterER,
      twitterPosts:     xItems.length,
      linkedinPosts:    liItems.length,
      instagramPosts:   igItems.length,
      youtubePosts:     0,
      totalPosts:       totalFound,
      // X metric totals
      totalLikes,
      totalReposts,
      totalViews,
      totalReplies,
      xWithMetrics,
      bestPost: topItem ? { platform: liItems[0] ? 'linkedin' : xItems[0] ? 'x' : 'instagram', url: topItem.link, text: topItem.snippet || topItem.title || '', date: topItem.date || '' } : null,
      insight: totalFound > 0
        ? `${liItems.length} LinkedIn · ${xItems.length} X/Twitter · ${igItems.length} Instagram posts${twitterER > 0 ? ` · ${twitterER}% avg ER` : ''}`
        : 'No indexed social posts found in this period',
      liResults:  liItems,
      xResults:   xItems,
      igResults:  igItems,
    });

    cb?.(`  [SocialPresence] ${orgName}: LI=${liItems.length} X=${xItems.length} IG=${igItems.length} ER=${twitterER}%`, totalFound > 0 ? 'ok' : 'warn');
  }

  orgResults.sort((a, b) => (b.twitterER || b.totalPosts) - (a.twitterER || a.totalPosts));
  orgResults.forEach((r, i) => { r.rank = i + 1; });

  cb?.(`  Social Presence complete`, 'ok');
  return orgResults;
}

function fmtNum(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function buildSocialERHtml(erResults) {
  if (!erResults?.length) return '';

  const orgsWithPresence = erResults.filter(r => r.totalPosts > 0).length;
  const totalIndexed     = erResults.reduce((s, r) => s + r.totalPosts, 0);
  const topOrg           = erResults[0];
  const totalLiIndexed   = erResults.reduce((s, r) => s + r.linkedinPosts, 0);
  const totalXIndexed    = erResults.reduce((s, r) => s + r.twitterPosts, 0);
  const totalIgIndexed   = erResults.reduce((s, r) => s + (r.instagramPosts || 0), 0);
  const hasER            = erResults.some(r => r.twitterER > 0);

  const statCards = [
    { label: 'Orgs with social AQ posts', value: orgsWithPresence,  unit: `of ${erResults.length} tracked`, col: '#4caf74' },
    { label: 'LinkedIn posts indexed',    value: totalLiIndexed,    unit: 'via Google index',               col: '#4a7fd4' },
    { label: 'X/Twitter posts indexed',   value: totalXIndexed,     unit: 'via Google index',               col: '#4a9fd4' },
    { label: 'Instagram posts indexed',   value: totalIgIndexed,    unit: 'via Google index',               col: '#e05c9c' },
    hasER
      ? { label: 'Best X engagement rate', value: Math.max(...erResults.map(r => r.twitterER || 0)).toFixed(2) + '%', unit: erResults.find(r => r.twitterER === Math.max(...erResults.map(r => r.twitterER || 0)))?.org || '', col: '#c9922a' }
      : { label: 'Most visible org', value: topOrg?.org?.split(' ').slice(-1)[0] || '—', unit: `${topOrg?.totalPosts || 0} posts`, col: '#c9922a' },
  ].map(c => `
    <div style="flex:1;min-width:160px;background:#181e2e;border:1px solid #252d40;border-radius:8px;padding:16px 18px">
      <div style="font-family:monospace;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#5e7494;margin-bottom:8px">${c.label}</div>
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:${c.col};line-height:1">${c.value}</div>
      <div style="font-size:11px;color:#5e7494;margin-top:5px">${c.unit}</div>
    </div>`).join('');

  const maxPosts = Math.max(...erResults.map(r => r.totalPosts), 1);
  const maxER    = Math.max(...erResults.map(r => r.twitterER || 0), 1);

  const orgRows = erResults.map(r => {
    const barPct  = Math.round((r.totalPosts / maxPosts) * 100);
    const liPct   = Math.round((r.linkedinPosts / maxPosts) * 100);
    const xPct    = Math.round((r.twitterPosts / maxPosts) * 100);
    const igPct   = Math.round(((r.instagramPosts || 0) / maxPosts) * 100);
    const erPct   = Math.round(((r.twitterER || 0) / maxER) * 100);
    const hasData = r.totalPosts > 0;
    const col     = hasData ? '#4caf74' : '#252d40';

    // Post cards with metrics
    const xPostCards = r.xWithMetrics?.length
      ? r.xWithMetrics.map(p => {
          const m = p.metrics;
          const er = calcER(m);
          const metricsRow = m
            ? `<div style="display:flex;gap:14px;margin-top:6px;flex-wrap:wrap">
                <span style="font-family:monospace;font-size:10px;color:#e05c5c">♥ ${fmtNum(m.likes)}</span>
                <span style="font-family:monospace;font-size:10px;color:#4a9fd4">↺ ${fmtNum(m.reposts)}</span>
                <span style="font-family:monospace;font-size:10px;color:#8fa3b8">💬 ${fmtNum(m.replies)}</span>
                <span style="font-family:monospace;font-size:10px;color:#5e7494">👁 ${fmtNum(m.views)}</span>
                ${er !== null ? `<span style="font-family:monospace;font-size:10px;font-weight:700;color:#c9922a">ER ${er}%</span>` : ''}
                <span style="font-size:9px;color:#3a4a5e">[${escHtml(m.source || '?')}]</span>
              </div>`
            : `<div style="font-size:10px;color:#3a4a5e;margin-top:4px">metrics not available</div>`;
          return `
          <div style="margin-top:8px;padding:8px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0">
            <div style="font-size:10px;color:#5e7494;margin-bottom:3px">${escHtml((p.title || '').slice(0, 70))}</div>
            <div style="font-size:11px;color:#8fa3b8;line-height:1.55">${escHtml((p.snippet || '').slice(0, 140))}</div>
            ${metricsRow}
            ${p.link ? `<a href="${escHtml(p.link)}" style="font-size:10px;color:#4a9fd4;text-decoration:none;display:inline-block;margin-top:4px" target="_blank">↗ view post</a>` : ''}
          </div>`;
        }).join('')
      : '';

    const liSnippets = r.liResults?.slice(0, 2).map(s => `
      <div style="margin-top:8px;padding:8px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0">
        <div style="font-size:10px;color:#5e7494;margin-bottom:3px">${escHtml((s.title || '').slice(0, 70))}</div>
        <div style="font-size:11px;color:#8fa3b8;line-height:1.55">${escHtml((s.snippet || '').slice(0, 140))}</div>
        ${s.link ? `<a href="${escHtml(s.link)}" style="font-size:10px;color:#4a7fd4;text-decoration:none;display:inline-block;margin-top:4px" target="_blank">↗ view post</a>` : ''}
      </div>`).join('') || '';

    const igSnippets = r.igResults?.slice(0, 2).map(s => `
      <div style="margin-top:8px;padding:8px 10px;background:#0a0e17;border-left:2px solid #252d40;border-radius:0 4px 4px 0">
        <div style="font-size:10px;color:#5e7494;margin-bottom:3px">${escHtml((s.title || '').slice(0, 70))}</div>
        <div style="font-size:11px;color:#8fa3b8;line-height:1.55">${escHtml((s.snippet || '').slice(0, 140))}</div>
        ${s.link ? `<a href="${escHtml(s.link)}" style="font-size:10px;color:#e05c9c;text-decoration:none;display:inline-block;margin-top:4px" target="_blank">↗ view post</a>` : ''}
      </div>`).join('') || '';

    const noData = !hasData
      ? `<div style="margin-top:8px;font-size:11px;color:#3a4a5e">No indexed posts found in this period</div>`
      : '';

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
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:11px;color:#5e7494">
              <span style="font-family:monospace;font-weight:700;color:#4a7fd4">${r.linkedinPosts}</span> LI &nbsp;
              <span style="font-family:monospace;font-weight:700;color:#4a9fd4">${r.twitterPosts}</span> X &nbsp;
              <span style="font-family:monospace;font-weight:700;color:#e05c9c">${r.instagramPosts || 0}</span> IG
            </span>
            ${r.twitterER > 0 ? `<span style="font-family:monospace;font-size:11px;font-weight:700;color:#c9922a">${r.twitterER}% X ER</span>` : ''}
            ${r.totalViews > 0 ? `<span style="font-size:11px;color:#5e7494">👁 ${fmtNum(r.totalViews)} total views</span>` : ''}
          </div>
          ${r.twitterER > 0 ? `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:10px;color:#c9922a;width:40px;flex-shrink:0">X ER</span>
            <div style="flex:1;height:4px;background:#1e2638;border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${erPct}%;background:#c9922a;border-radius:2px"></div>
            </div>
            <span style="font-family:monospace;font-size:10px;color:#c9922a;width:40px;text-align:right">${r.twitterER}%</span>
          </div>` : ''}
          ${xPostCards}
          ${liSnippets}
          ${igSnippets}
          ${noData}
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
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-family:monospace;font-size:10px;color:#4a9fd4;width:20px">X</span>
            <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${xPct}%;background:#4a9fd4;border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:11px;font-weight:700;color:#4a9fd4;width:16px;text-align:right">${r.twitterPosts}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-family:monospace;font-size:10px;color:#e05c9c;width:20px">IG</span>
            <div style="flex:1;height:5px;background:#1e2638;border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${igPct}%;background:#e05c9c;border-radius:3px"></div>
            </div>
            <span style="font-family:monospace;font-size:11px;font-weight:700;color:#e05c9c;width:16px;text-align:right">${r.instagramPosts || 0}</span>
          </div>
          ${r.totalViews > 0 ? `
          <div style="margin-top:8px;padding:8px;background:#0a0e17;border:1px solid #252d40;border-radius:5px">
            <div style="font-size:9px;color:#5e7494;margin-bottom:4px;text-transform:uppercase;letter-spacing:.08em">X totals</div>
            <div style="font-family:monospace;font-size:10px;color:#e05c5c;margin-bottom:2px">♥ ${fmtNum(r.totalLikes)} likes</div>
            <div style="font-family:monospace;font-size:10px;color:#4a9fd4;margin-bottom:2px">↺ ${fmtNum(r.totalReposts)} reposts</div>
            <div style="font-family:monospace;font-size:10px;color:#8fa3b8;margin-bottom:2px">💬 ${fmtNum(r.totalReplies)} replies</div>
            <div style="font-family:monospace;font-size:10px;color:#5e7494">👁 ${fmtNum(r.totalViews)} views</div>
          </div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const erMethodNote = hasER
    ? `X/Twitter ER = (likes + replies + reposts) / views × 100. Metrics extracted via page text scrape, falling back to ScreenshotOne + Claude vision if text scrape returns no numbers.`
    : `Add <code style="background:#1e2638;padding:1px 5px;border-radius:3px;font-size:11px">SCREENSHOTONE_KEY</code> to enable X engagement metrics.`;

  return `
<section class="sec" id="social">
  <div class="sh">
    <div class="se">Section 08b</div>
    <h2 class="st">Social AQ Presence</h2>
    <div class="sd">Google-indexed posts mentioning each organisation in an air quality context on LinkedIn, X/Twitter, and Instagram during the report period. X posts include live engagement metrics (likes, reposts, replies, views) where available.</div>
    <div class="sdiv"></div>
  </div>

  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">${statCards}</div>

  <div style="background:rgba(74,159,212,.06);border:1px solid rgba(74,159,212,.18);border-radius:8px;padding:12px 16px;margin-bottom:24px;font-size:12px;color:#8fa3b8;line-height:1.7">
    <strong style="color:#4a9fd4">Methodology:</strong> Serper web search queries <code style="background:#1e2638;padding:1px 5px;border-radius:3px;font-size:11px">"Org Name" ("air quality" OR PM2.5 OR AQI) site:linkedin.com/posts</code> and equivalent for X/Twitter and Instagram. Date range filtered using Google's <code style="background:#1e2638;padding:1px 5px;border-radius:3px;font-size:11px">tbs=cdr</code> parameter. ${erMethodNote}
  </div>

  <div style="display:flex;flex-direction:column;gap:10px">${orgRows}</div>
</section>`;
}

module.exports = { run, buildSocialERHtml };

'use strict';
/**
 * run-social-window.js — standalone AQ social fetch + ER for one date window.
 *
 * Runs ONLY the social collectors (APIdirect LI/X/IG + YouTube Data API v3).
 * It deliberately does not invoke pipeline.js, so it spends nothing on Serper
 * news, TV/print scraping or Claude summarisation.
 *
 * Usage:
 *   APIDIRECT_KEY=... YOUTUBE_KEY=... \
 *   node run-social-window.js 2025-04-01 2025-06-30 [outfile.json]
 *
 * Handles are the live-validated set from emerald-web/src/pages/home.tsx
 * (verified 2026-07-29 — every value resolved and its account NAME matched
 * against the org).
 */

const path = require('path');
const fs = require('fs');
const APIdirect = require('./apidirect-collector');
const YouTubeER = require('./youtube-er');

const ORGS = [
  'WRI India',
  'Air Pollution Action Group',
  'Chintan Environmental Research and Action Group',
  'IIT Kanpur',
  'CSTEP',
  'IIT Delhi',
  'Health Effects Institute',
  'ICCT',
  'EPIC India',
  'Council on Energy, Environment and Water',
  'Centre for Science and Environment',
  'Climate Trends',
  'Sustainable Futures Collaborative',
];

const ORG_LI_HANDLES = {
  'Council on Energy, Environment and Water':        'council-on-energy-environment-and-water',
  'Centre for Science and Environment':              'centre-for-science-and-environment-new-delhi',
  'WRI India':                                       'wri-india',
  'CSTEP':                                           'cstep',
  'Air Pollution Action Group':                      'apag',
  'Chintan Environmental Research and Action Group': 'chintan-environmental-research-and-actiann-group-',
  'IIT Delhi':                                       'https://www.linkedin.com/school/iitdelhi',
  'IIT Kanpur':                                      'https://www.linkedin.com/school/indian-institute-of-technology-kanpur',
  'Health Effects Institute':                        'health-effects-institute',
  'ICCT':                                            'the-international-council-on-clean-transportation',
  'EPIC India':                                      'epic-india',
  'Climate Trends':                                  'climatetrends',
  'Sustainable Futures Collaborative':               'sustainable-futures-collaborative',
};

const ORG_TW_HANDLES = {
  'Council on Energy, Environment and Water':        'CEEWIndia',
  'Centre for Science and Environment':              'cseindia',
  'WRI India':                                       'wriindia',
  'CSTEP':                                           'CSTEP_India',
  'Air Pollution Action Group':                      'APAGIndia',
  'Chintan Environmental Research and Action Group': 'chintanindia',
  'IIT Delhi':                                       'iitdelhi',
  'IIT Kanpur':                                      'IITKanpur',
  'Health Effects Institute':                        '',
  'ICCT':                                            'theicct',
  'EPIC India':                                      'EPIC_India',
  'Climate Trends':                                  'ClimateTrendsIN',
  'Sustainable Futures Collaborative':               'SFC_India',
};

const ORG_IG_HANDLES = {
  'Council on Energy, Environment and Water':        'ceewindia',
  'Centre for Science and Environment':              'cseindia',
  'WRI India':                                       'wri_india',
  'CSTEP':                                           'cstep_ind',
  'Air Pollution Action Group':                      'apagindia',
  'Chintan Environmental Research and Action Group': 'chintan.india',
  'IIT Delhi':                                       'iitdelhi',
  'IIT Kanpur':                                      'iit.kanpur',
  'Health Effects Institute':                        '',
  'ICCT':                                            '',
  'EPIC India':                                      'epicindia.uchicago',
  'Climate Trends':                                  'climatetrendsin',
  'Sustainable Futures Collaborative':               'sustainablefuturescollab',
};

const ORG_YT_HANDLES = {
  'WRI India':                                       'https://www.youtube.com/channel/UCYoSZhQQR6Pc9lFJjR5e18g',
  'Air Pollution Action Group':                      'https://www.youtube.com/channel/UCj2uQfsw-u7yrp6WStsgZoQ',
  'Chintan Environmental Research and Action Group': 'https://www.youtube.com/channel/UCg-HN_sFTRBNDDOWxEt138g',
  'IIT Kanpur':                                      'https://www.youtube.com/channel/UCIdajcgyfqnD9PwDnv_xqmg',
  'CSTEP':                                           'https://www.youtube.com/channel/UCROj7dD9PqkZj4My5En829A',
  'IIT Delhi':                                       'https://www.youtube.com/channel/UCJX9RwRoVAEFLWlhrNF3Lqg',
  'Health Effects Institute':                        'https://www.youtube.com/channel/UCPli-nivc67QzWoW1nRumIw',
  'ICCT':                                            'https://www.youtube.com/channel/UCjbSjAMN6yiGhczNwSgTJ6Q',
  'EPIC India':                                      'https://www.youtube.com/channel/UCz-PtdD6pJSITzGt7q9gN8A',
  'Council on Energy, Environment and Water':        'https://www.youtube.com/channel/UCNF-vGnm1jdA_jhrIpk84Tg',
  'Centre for Science and Environment':              'https://www.youtube.com/channel/UCPUL9ZjjcobQ6XlgTo6Mr2g',
  'Climate Trends':                                  'https://www.youtube.com/channel/UCed9gfyM-3SAGIAYpvSz8ig',
  'Sustainable Futures Collaborative':               'https://www.youtube.com/channel/UCZcWNjwTwQK48D7z8oWAKCA',
};

const SCOPE_KEYWORDS = [
  'AQI', 'PM2.5', 'PM10', 'air pollution', 'air quality', 'smog',
  'clean air', 'NCAP', 'GRAP', 'Black Carbon', 'Ozone', 'Ammonia',
  'Carbon Monoxide', 'Nitrogen Dioxide', 'Methane',
];

const [, , dateFrom, dateTo, outArg] = process.argv;
if (!dateFrom || !dateTo) {
  console.error('usage: node run-social-window.js <YYYY-MM-DD from> <YYYY-MM-DD to> [out.json]');
  process.exit(1);
}
const outFile = outArg || path.join(__dirname, `social-${dateFrom}_${dateTo}.json`);

const cfg = {
  APIDIRECT_KEY: process.env.APIDIRECT_KEY || '',
  YOUTUBE_KEY:   process.env.YOUTUBE_KEY   || '',
  DATE_FROM:     dateFrom,
  DATE_TO:       dateTo,
  SCOPE_KEYWORDS,
  ORG_YT_HANDLES,
};

const log = (msg, level) => {
  const tag = level === 'err' ? 'ERR ' : level === 'warn' ? 'WARN' : level === 'ok' ? 'OK  ' : '    ';
  console.log(`${tag} ${msg}`);
};

const orgHandles = {};
for (const org of ORGS) {
  orgHandles[org] = {
    linkedin:  ORG_LI_HANDLES[org] || '',
    twitter:   ORG_TW_HANDLES[org] || '',
    instagram: ORG_IG_HANDLES[org] || '',
    youtube:   ORG_YT_HANDLES[org] || '',
  };
}

// Cell renderer that preserves the failure / no-handle / genuine-zero distinction
// instead of collapsing all three to "0".
function cell(pd, count) {
  if (!pd) return '  -  ';
  if (pd.noHandle) return '  –  ';
  if (pd.failed) return `  ✕(${pd.failReason || '?'})`;
  return String(count ?? 0).padStart(3, ' ') + '  ';
}

(async () => {
  if (!cfg.APIDIRECT_KEY) { console.error('FATAL: APIDIRECT_KEY not set'); process.exit(1); }
  console.log(`\nWindow: ${dateFrom} → ${dateTo}   Orgs: ${ORGS.length}\n${'='.repeat(78)}`);

  const social = await APIdirect.run(cfg, ORGS, orgHandles, log);

  let yt = [];
  if (cfg.YOUTUBE_KEY) {
    yt = await YouTubeER.run(cfg, ORGS, log);
  } else {
    console.log('WARN  YOUTUBE_KEY not set — YouTube section skipped (renders as "–", not zero)');
    yt = ORGS.map((org) => ({ org, videoCount: 0, videos: [], noKey: true }));
  }

  console.log(`\n${'='.repeat(110)}\nRESULTS  ${dateFrom} → ${dateTo}\n${'='.repeat(110)}`);
  console.log(
    'ORG'.padEnd(34) +
    'LI'.padEnd(9) + 'LI ER%'.padEnd(10) +
    'X'.padEnd(9)  + 'X ER%'.padEnd(9) +
    'IG'.padEnd(9) + 'IG ER%'.padEnd(9) +
    'YT'.padEnd(7) + 'YT ER%'
  );
  console.log('-'.repeat(110));

  const rows = [];
  for (const org of ORGS) {
    const d = social.find((s) => s.org === org) || {};
    const y = yt.find((v) => v.org === org) || {};
    const li = d.li, tw = d.tw, ig = d.ig;
    const ytER = y.avgER || y.avgViewER || 0;

    // LI ER is a true rate only when the company endpoint returned followers;
    // otherwise er() falls back to avg engagement/post, which is NOT a percent.
    const liIsRate = (li?.followers || 0) > 0;

    rows.push({
      org,
      linkedin:  li && { posts: li.postCount, followers: li.followers, er: li.er, erIsPercent: liIsRate,
                         likes: li.totalLikes, comments: li.totalComments, shares: li.totalShares,
                         failed: !!li.failed, failReason: li.failReason, noHandle: !!li.noHandle,
                         topPosts: li.topPosts },
      twitter:   tw && { posts: tw.postCount, followers: tw.followers, er: tw.er,
                         likes: tw.totalLikes, replies: tw.totalReplies, retweets: tw.totalRetweets,
                         failed: !!tw.failed, failReason: tw.failReason, noHandle: !!tw.noHandle,
                         topPosts: tw.topPosts },
      instagram: ig && { posts: ig.postCount, followers: ig.followers, er: ig.er,
                         likes: ig.totalLikes, comments: ig.totalComments, truncated: !!ig.truncated,
                         failed: !!ig.failed, failReason: ig.failReason, noHandle: !!ig.noHandle,
                         topPosts: ig.topPosts },
      youtube:   { videos: y.videoCount || 0, er: ytER, erMethod: y.erMethod,
                   truncated: !!y.truncated, discovered: y.discovered,
                   noHandle: !!y.noHandle, noKey: !!y.noKey, failed: !!y.failed,
                   videoList: y.videos },
    });

    console.log(
      org.slice(0, 33).padEnd(34) +
      cell(li, li?.postCount).padEnd(9) +
      (liIsRate ? `${li.er}%` : li?.postCount ? `${li.er}/post` : '—').padEnd(10) +
      cell(tw, tw?.postCount).padEnd(9) +
      (tw?.er > 0 ? `${tw.er}%` : '—').padEnd(9) +
      cell(ig, ig?.postCount).padEnd(9) +
      (ig?.er > 0 ? `${ig.er}%` : '—').padEnd(9) +
      (y.noHandle || y.noKey ? '  –  ' : String(y.videoCount || 0).padStart(3, ' ') + '  ').padEnd(7) +
      (ytER > 0 ? `${ytER}%` : '—')
    );
  }

  // Coverage warnings — a window far in the past can exceed what the endpoints reach.
  const igTrunc = rows.filter((r) => r.instagram?.truncated).map((r) => r.org);
  if (igTrunc.length) {
    console.log(`\nWARNING  Instagram hit its 120-post ceiling before reaching ${dateFrom} for: ${igTrunc.join(', ')}`);
    console.log('         Those IG counts are a LOWER BOUND, not a verified total.');
  }

  fs.writeFileSync(outFile, JSON.stringify({ window: { from: dateFrom, to: dateTo }, rows }, null, 2));
  console.log(`\nFull post-level data → ${outFile}`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });

'use strict';
/**
 * test-tv-serper-query.js — diagnostic script, NOT part of the pipeline.
 *
 * Runs the EXACT TV channel query the pipeline sends (site:<domain> "<org>"
 * <keywords>, Feb-May date range) against Serper's /news endpoint (what
 * pipeline.js STEP 1b currently uses) AND against /search (general web,
 * not news-only), for a well-covered org (Centre for Science and
 * Environment), so you can see directly whether the all-zero TV Channel
 * Coverage result is genuine absence or a too-narrow query/endpoint choice.
 *
 * Run on Replit where SERPER_KEY is set:
 *   node emerald-ai/test-tv-serper-query.js
 *
 * Or pass a key directly:
 *   SERPER_KEY=xxx node emerald-ai/test-tv-serper-query.js
 */

const axios = require('axios');

const SERPER_KEY = process.env.SERPER_KEY;
if (!SERPER_KEY) {
  console.error('SERPER_KEY not set. Run this on Replit (where it\'s already an env var) or: SERPER_KEY=xxx node test-tv-serper-query.js');
  process.exit(1);
}

// Same test knobs as the report — change ORG/DATE_FROM/DATE_TO to match a
// real report run if you want an apples-to-apples comparison.
const ORG = 'Centre for Science and Environment';
const DATE_FROM = '2026-02-01';
const DATE_TO = '2026-05-01';
const KEYWORDS = ['air quality', 'AQI', 'PM2.5', 'PM10', 'air pollution', 'clean air']; // matches SCOPE_KEYWORDS.slice(0,6) default
const DOMAINS = { NDTV: 'ndtv.com', News18: 'news18.com', 'India Today': 'indiatoday.in' };

function toSerperDate(s) {
  const [y, m, d] = s.split('-');
  return `${m}/${d}/${y}`;
}
const tbs = `cdr:1,cd_min:${toSerperDate(DATE_FROM)},cd_max:${toSerperDate(DATE_TO)}`;
const kwClause = `(${KEYWORDS.map((k) => `"${k}"`).join(' OR ')})`;

async function run(endpoint, query) {
  try {
    const { data } = await axios.post(`https://google.serper.dev/${endpoint}`, { q: query, num: 10, tbs }, {
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      timeout: 20000,
    });
    return endpoint === 'news' ? (data.news || []) : (data.organic || []);
  } catch (e) {
    return { error: e.response?.data?.message || e.message };
  }
}

(async () => {
  for (const [channel, domain] of Object.entries(DOMAINS)) {
    const query = `site:${domain} "${ORG}" ${kwClause}`;
    console.log(`\n=== ${channel} (${domain}) ===`);
    console.log('Query:', query);
    console.log('Date filter:', tbs);

    const newsResults = await run('news', query);
    console.log(`  /news  (current pipeline behavior): ${Array.isArray(newsResults) ? newsResults.length + ' results' : JSON.stringify(newsResults)}`);
    if (Array.isArray(newsResults)) newsResults.slice(0, 3).forEach((r) => console.log(`    - ${r.title} (${r.date})`));

    const searchResults = await run('search', query);
    console.log(`  /search (general web, not news-only): ${Array.isArray(searchResults) ? searchResults.length + ' results' : JSON.stringify(searchResults)}`);
    if (Array.isArray(searchResults)) searchResults.slice(0, 3).forEach((r) => console.log(`    - ${r.title} (${r.date || 'no date'})`));

    // Also try WITHOUT the site: restriction, to isolate whether site: itself is the problem
    const noSiteQuery = `"${ORG}" ${kwClause} ${channel}`;
    const noSiteResults = await run('news', noSiteQuery);
    console.log(`  /news, no site: restriction (just mentions "${channel}"): ${Array.isArray(noSiteResults) ? noSiteResults.length + ' results' : JSON.stringify(noSiteResults)}`);
  }
})();

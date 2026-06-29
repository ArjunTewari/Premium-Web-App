'use strict';
/**
 * test-articles.js — News coverage intelligence via APIDirectio
 *
 * Sources: Times of India · Hindustan Times · The Hindu · NDTV ·
 *          News18 · India Today · Aaj Tak · India TV · ABP News
 * Auth:    X-API-Key header to https://apidirect.io
 * Pricing: $0.008/request · 50 free/month
 *
 * Flow per org × source:
 *   1. GET /v1/news/articles?query={org AQ terms}&source={domain}&limit=50
 *   2. Client-side date filter to report window
 *   3. Haiku classifies using full title + snippet — rejects passing mentions
 *      where the org is cited for an unrelated reason
 *   4. Display confirmed articles grouped by source
 */

// Load .env
try {
  const fs = require('fs'), path = require('path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch {}

const axios = require('axios');

const ORGS      = ['IIT Delhi', 'CSE India', 'CEEW'];
const DATE_FROM = '2026-02-01';
const DATE_TO   = '2026-05-01';
const API_BASE  = 'https://apidirect.io';

// News sources — domain used as APIDirectio `source` filter
const SOURCES = [
  { name: 'Times of India',  domain: 'timesofindia.com'   },
  { name: 'Hindustan Times', domain: 'hindustantimes.com' },
  { name: 'The Hindu',       domain: 'thehindu.com'       },
  { name: 'NDTV',            domain: 'ndtv.com'           },
  { name: 'News18',          domain: 'news18.com'         },
  { name: 'India Today',     domain: 'indiatoday.in'      },
  { name: 'Aaj Tak',         domain: 'aajtak.in'          },
  { name: 'India TV',        domain: 'indiatvnews.com'    },
  { name: 'ABP News',        domain: 'abplive.com'        },
];

// Query per org — use names journalists write, plus AQ terms.
// Broader than the acronym alone to catch full-name references.
const ORG_QUERY = {
  'IIT Delhi':  'IIT Delhi air quality pollution AQI PM2.5',
  'CSE India':  'Centre for Science and Environment air quality pollution',
  'CEEW':       'CEEW "Council on Energy Environment" air quality',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function inPeriod(dateStr) {
  if (!dateStr) return true;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return true;
    return d >= new Date(DATE_FROM) && d <= new Date(DATE_TO);
  } catch { return true; }
}

// ── Fetcher ────────────────────────────────────────────────────────────────

async function fetchArticles(org, source, apiKey) {
  const query = ORG_QUERY[org] || `${org} air quality`;
  const url   = new URL(API_BASE + '/v1/news/articles');
  url.searchParams.set('query',          query);
  url.searchParams.set('source',         source.domain);
  url.searchParams.set('limit',          '50');
  url.searchParams.set('time_published', '1y');   // broad window — date filtered client-side

  const res = await axios.get(url.toString(), {
    headers: { 'X-API-Key': apiKey },
    timeout: 20000,
  });

  // APIDirectio key may vary across versions
  const raw = res.data.articles || res.data.posts || res.data.results || [];
  return raw
    .filter(a => inPeriod(a.date || a.published_date || a.publishedAt))
    .map(a => ({
      title:  a.title   || '',
      text:   a.snippet || a.description || a.summary || '',
      url:    a.url     || a.link  || '',
      date:   a.date    || a.published_date || a.publishedAt || '',
      author: a.author  || '',
      source: source.name,
    }));
}

// ── Haiku AQ + context classifier ─────────────────────────────────────────
// Full title + full snippet passed so Haiku has enough surrounding context
// to distinguish genuine AQ coverage from incidental org mentions.

async function isAQRelevant(article, org, claudeKey) {
  if (!claudeKey) return true;
  const context = `Title: "${article.title}"\n\nExcerpt: "${article.text.slice(0, 900)}"`;
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system:     'You classify news articles. Reply with only YES or NO.',
      messages: [{
        role:    'user',
        content: `Does this article cover air quality, air pollution, AQI, PM2.5, smog, vehicle emissions, or environmental air health — AND is "${org}" a meaningful actor (researcher, publisher, or primary subject) in that AQ context, not merely mentioned in passing for an unrelated reason?\n\n${context}\n\nYES or NO only.`,
      }],
    }, {
      headers: {
        'x-api-key':         claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      timeout: 15000,
    });
    return res.data.content?.[0]?.text?.trim().toUpperCase() === 'YES';
  } catch { return false; }
}

async function filterAQArticles(articles, org, claudeKey) {
  if (!claudeKey) {
    console.log('    ⚠ No CLAUDE_KEY — skipping Haiku, returning all raw articles');
    return articles;
  }
  if (!articles.length) return [];
  const aq = [];
  for (let i = 0; i < articles.length; i += 5) {
    const batch = articles.slice(i, i + 5);
    const flags = await Promise.all(batch.map(a => isAQRelevant(a, org, claudeKey)));
    flags.forEach((isAQ, j) => { if (isAQ) aq.push(batch[j]); });
    if (i + 5 < articles.length) await new Promise(r => setTimeout(r, 400));
  }
  return aq;
}

// ── Display ────────────────────────────────────────────────────────────────

function displayArticles(articles) {
  if (!articles.length) { console.log('    (none)\n'); return; }
  articles.forEach(a => {
    console.log(`    [${a.source}] ${a.title}`);
    if (a.text)   console.log(`    ${a.text.slice(0, 130).trim()}…`);
    if (a.url)    console.log(`    URL  : ${a.url}`);
    if (a.date)   console.log(`    Date : ${a.date}`);
    if (a.author) console.log(`    By   : ${a.author}`);
    console.log();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const API_KEY    = process.env.APIDIRECT_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;

  console.log('=== News Articles Intelligence — APIDirectio ===');
  console.log(`Orgs    : ${ORGS.join(', ')}`);
  console.log(`Period  : ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Sources : ${SOURCES.map(s => s.name).join(' · ')}`);
  console.log(`APIDir  : ${API_KEY ? '✓' : '✗ (set APIDIRECT_KEY in .env)'}  Haiku: ${CLAUDE_KEY ? '✓' : '✗'}\n`);

  if (!API_KEY) { console.error('APIDIRECT_KEY not set'); process.exit(1); }

  for (const org of ORGS) {
    console.log(`\n══ ${org} ${'═'.repeat(Math.max(0, 44 - org.length))}`);

    // Fetch sources sequentially to respect APIDirectio concurrency limits
    const sourceResults = [];
    for (const source of SOURCES) {
      const result = await fetchArticles(org, source, API_KEY).catch(e => {
        const msg = e.response?.data?.error || e.response?.data?.message || e.message;
        console.log(`  ⚠ ${source.name}: ${msg}`);
        return [];
      });
      sourceResults.push(result);
      await new Promise(r => setTimeout(r, 300));
    }

    // Per-source raw count
    const allArticles = sourceResults.flat();
    const counts = SOURCES.map((s, i) => `${s.name}:${sourceResults[i].length}`).join('  ');
    console.log(`  Raw (in period) : ${allArticles.length} total`);
    console.log(`    ${counts}`);

    if (!allArticles.length) {
      console.log('  No articles found for this period.\n');
      continue;
    }

    // Haiku AQ + context filter
    const aqArticles = await filterAQArticles(allArticles, org, CLAUDE_KEY);
    console.log(`  AQ confirmed    : ${aqArticles.length}\n`);

    if (aqArticles.length) {
      displayArticles(aqArticles);
    } else {
      console.log('  No AQ-relevant articles found after classification.\n');
    }
  }

  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

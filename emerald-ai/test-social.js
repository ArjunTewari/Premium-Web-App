'use strict';
/**
 * test-social.js — smoke test for Instagram: Serper discovery + HikerAPI metrics
 * Usage: node emerald-ai/test-social.js
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
const { ORG_IG_HANDLES } = require('./instagram-collector');

const ORGS     = ['CEEW', 'CSE India'];
const DATE_FROM = '2026-02-01';
const DATE_TO   = '2026-05-01';

const AQ_TERMS = '("air quality" OR "air pollution" OR AQI OR PM2.5 OR NCAP)';

// ── Serper: find posts from the org's own IG handle ────────────────────────
// Uses site:instagram.com/{handle} to restrict to that account's posts only

async function serperIGSearch(handle, serperKey) {
  const [fy, fm, fd] = DATE_FROM.split('-');
  const [ty, tm, td] = DATE_TO.split('-');
  const body = {
    q:   `${AQ_TERMS} site:instagram.com/${handle}`,
    num: 10,
    tbs: `cdr:1,cd_min:${fm}/${fd}/${fy},cd_max:${tm}/${td}/${ty}`,
  };
  const res = await axios.post('https://google.serper.dev/search', body, {
    headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return (res.data.organic || []).map(r => ({
    title:   r.title   || '',
    snippet: r.snippet || '',
    url:     r.link    || '',
  }));
}

// ── HikerAPI: enrich a post URL with metrics ───────────────────────────────

async function hikerEnrich(postUrl, hikerKey) {
  try {
    const res = await axios.get('https://api.hikerapi.com/v1/media/by/url', {
      params:  { url: postUrl },
      headers: { 'x-access-key': hikerKey },
      timeout: 15000,
    });
    const m = res.data;
    return {
      likes:    m.like_count    || 0,
      comments: m.comment_count || m.comments_count || 0,
      caption:  (m.caption_text || '').slice(0, 150),
      taken_at: m.taken_at || null,
    };
  } catch (e) {
    return { error: e.response?.data?.detail || e.message };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const SERPER_KEY = process.env.SERPER_KEY;
  const HIKER_KEY  = process.env.HIKER_API_KEY;

  console.log('=== Instagram: Serper + HikerAPI Test ===');
  console.log(`Orgs  : ${ORGS.join(', ')}`);
  console.log(`Period: ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Serper: ${SERPER_KEY ? '✓' : '✗ missing'}  |  HikerAPI: ${HIKER_KEY ? '✓' : '✗ missing (metrics skipped)'}\n`);

  if (!SERPER_KEY) { console.error('SERPER_KEY not set'); process.exit(1); }

  for (const org of ORGS) {
    const handle = ORG_IG_HANDLES[org];
    console.log(`\n── ${org} (@${handle || 'unknown'}) ──────────────────────────────`);

    if (!handle) { console.log('  ⚠ No IG handle configured — skipping'); continue; }

    // Step 1: discover via Serper (restricted to org's own handle)
    let posts = [];
    try {
      posts = await serperIGSearch(handle, SERPER_KEY);
      console.log(`  Serper found ${posts.length} post(s) from @${handle}`);
    } catch (e) {
      console.log(`  ⚠ Serper error: ${e.message}`);
    }

    if (!posts.length) { console.log('  No posts found'); continue; }

    // Step 2: enrich each post with HikerAPI metrics
    for (const post of posts) {
      console.log(`\n  📄 ${post.title.slice(0, 80)}`);
      console.log(`     URL    : ${post.url}`);

      if (HIKER_KEY) {
        const metrics = await hikerEnrich(post.url, HIKER_KEY);
        if (metrics.error) {
          console.log(`     Metrics: ⚠ ${metrics.error}`);
        } else {
          console.log(`     Likes   : ${metrics.likes}`);
          console.log(`     Comments: ${metrics.comments}`);
          if (metrics.taken_at) console.log(`     Date    : ${metrics.taken_at}`);
          if (metrics.caption)  console.log(`     Caption : ${metrics.caption}…`);
        }
      } else {
        console.log(`     Snippet: ${post.snippet.slice(0, 120)}`);
      }
    }
  }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

'use strict';
/**
 * test-social.js — Instagram: Serper discovery + HikerAPI direct fetch, merged & deduped
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

const ORGS      = ['CEEW', 'CSE India'];
const DATE_FROM = '2026-02-01';
const DATE_TO   = '2026-05-01';
const AQ_TERMS  = '("air quality" OR "air pollution" OR AQI OR PM2.5 OR NCAP)';

// Extract Instagram shortcode from any Instagram post URL
function shortcodeFromUrl(url) {
  const m = (url || '').match(/instagram\.com\/(?:[^/]+\/)?p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── Claude Haiku AQ classifier ─────────────────────────────────────────────

async function classifyPost(text, claudeKey) {
  if (!text || !claudeKey) return false;
  try {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system:     'You classify social media posts. Reply with only YES or NO.',
      messages: [{
        role:    'user',
        content: `Is this post about air quality, air pollution, AQI, PM2.5, smog, clean air, emissions, or environmental air health?\n\nPost: "${text.slice(0, 500)}"\n\nAnswer YES or NO only.`,
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
  } catch {
    return false;
  }
}

// Classify an array of posts in batches of 5, return only AQ ones
async function filterAQPosts(posts, claudeKey) {
  if (!claudeKey) { console.log('  ⚠ CLAUDE_KEY missing — skipping Haiku classification'); return posts; }
  const aq = [];
  for (let i = 0; i < posts.length; i += 5) {
    const batch = posts.slice(i, i + 5);
    const flags = await Promise.all(batch.map(p => classifyPost(p.caption || p.title || p.snippet, claudeKey)));
    flags.forEach((isAQ, j) => { if (isAQ) aq.push(batch[j]); });
    if (i + 5 < posts.length) await new Promise(r => setTimeout(r, 500));
  }
  return aq;
}

// ── Source 1: Serper ───────────────────────────────────────────────────────

async function serperIGSearch(handle, serperKey) {
  const [fy, fm, fd] = DATE_FROM.split('-');
  const [ty, tm, td] = DATE_TO.split('-');
  const res = await axios.post('https://google.serper.dev/search', {
    q:   `${AQ_TERMS} site:instagram.com/${handle}`,
    num: 10,
    tbs: `cdr:1,cd_min:${fm}/${fd}/${fy},cd_max:${tm}/${td}/${ty}`,
  }, {
    headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return (res.data.organic || []).map(r => ({
    shortcode: shortcodeFromUrl(r.link || ''),
    url:       r.link    || '',
    title:     r.title   || '',
    snippet:   r.snippet || '',
    source:    'serper',
  })).filter(p => p.shortcode);
}

// ── Source 2: HikerAPI direct media fetch ─────────────────────────────────

async function hikerFetchPosts(handle, hikerKey) {
  const fromTs = new Date(DATE_FROM).getTime();
  const toTs   = new Date(DATE_TO).getTime();
  const headers = { 'x-access-key': hikerKey };

  const userRes = await axios.get('https://api.hikerapi.com/v1/user/by/username', {
    params: { username: handle }, headers, timeout: 15000,
  });
  const userId = String(userRes.data?.pk || '');
  if (!userId) return [];

  const posts = [];
  let endCursor = null;
  let page = 0;

  do {
    const params = { user_id: userId };
    if (endCursor) params.end_cursor = endCursor;
    const res = await axios.get('https://api.hikerapi.com/v1/user/medias/chunk', {
      params, headers, timeout: 30000,
    });
    const [items, cursor] = Array.isArray(res.data) ? res.data : [[], null];
    if (!items?.length) break;

    for (const m of items) {
      const ts = m.taken_at_ts
        ? Number(m.taken_at_ts) * 1000
        : (typeof m.taken_at === 'string' ? new Date(m.taken_at).getTime() : Number(m.taken_at) * 1000);
      if (ts >= fromTs && ts <= toTs) {
        posts.push({
          shortcode: m.code || m.shortcode || '',
          url:       m.code ? `https://www.instagram.com/p/${m.code}/` : '',
          caption:   m.caption_text || '',
          title:     (m.caption_text || '').slice(0, 80),
          likes:     m.like_count    || 0,
          comments:  m.comment_count || 0,
          taken_at:  m.taken_at      || null,
          source:    'hiker',
        });
      }
      if (ts > 0 && ts < fromTs) { endCursor = null; break; }
    }

    endCursor = cursor || null;
    page++;
    if (endCursor) await new Promise(r => setTimeout(r, 400));
  } while (endCursor && page < 15);

  return posts.filter(p => p.shortcode);
}

// ── HikerAPI: enrich a Serper post URL with metrics + full caption ─────────

async function hikerEnrich(url, hikerKey) {
  try {
    const res = await axios.get('https://api.hikerapi.com/v1/media/by/url', {
      params: { url }, headers: { 'x-access-key': hikerKey }, timeout: 15000,
    });
    const m = res.data;
    return {
      likes:    m.like_count    || 0,
      comments: m.comment_count || 0,
      taken_at: m.taken_at      || null,
      caption:  m.caption_text  || '',
    };
  } catch (e) {
    return { error: e.response?.data?.detail || e.message };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const SERPER_KEY = process.env.SERPER_KEY;
  const HIKER_KEY  = process.env.HIKER_API_KEY;
  const CLAUDE_KEY = process.env.CLAUDE_KEY;

  console.log('=== Instagram: Serper + HikerAPI + Haiku ===');
  console.log(`Orgs  : ${ORGS.join(', ')}`);
  console.log(`Period: ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Serper: ${SERPER_KEY ? '✓' : '✗'}  HikerAPI: ${HIKER_KEY ? '✓' : '✗'}  Claude Haiku: ${CLAUDE_KEY ? '✓' : '✗'}\n`);

  if (!SERPER_KEY) { console.error('SERPER_KEY not set'); process.exit(1); }

  for (const org of ORGS) {
    const handle = ORG_IG_HANDLES[org];
    console.log(`\n── ${org} (@${handle || 'unknown'}) ────────────────────────`);
    if (!handle) { console.log('  ⚠ No handle configured'); continue; }

    // Step 1: fetch both sources in parallel
    const [serperPosts, hikerPosts] = await Promise.all([
      serperIGSearch(handle, SERPER_KEY).catch(e => { console.log(`  ⚠ Serper: ${e.message}`); return []; }),
      HIKER_KEY
        ? hikerFetchPosts(handle, HIKER_KEY).catch(e => { console.log(`  ⚠ HikerAPI: ${e.message}`); return []; })
        : Promise.resolve([]),
    ]);
    console.log(`  Serper: ${serperPosts.length}  HikerAPI: ${hikerPosts.length} in period`);

    // Step 2: merge, deduplicate by shortcode
    const seen = new Map();
    for (const p of hikerPosts) seen.set(p.shortcode, p);
    for (const p of serperPosts) {
      if (!seen.has(p.shortcode)) seen.set(p.shortcode, { ...p, needsEnrich: true });
      else seen.get(p.shortcode).title = seen.get(p.shortcode).title || p.title;
    }
    const merged = [...seen.values()];
    console.log(`  Merged: ${merged.length} unique (${merged.filter(p => p.needsEnrich).length} Serper-only need enrichment)`);

    // Step 3: enrich Serper-only posts to get full captions for classification
    if (HIKER_KEY) {
      for (const post of merged.filter(p => p.needsEnrich && p.url)) {
        const metrics = await hikerEnrich(post.url, HIKER_KEY);
        if (!metrics.error) Object.assign(post, metrics);
        else post.enrichError = metrics.error;
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Step 4: classify all merged posts with Claude Haiku
    console.log(`  Classifying ${merged.length} posts with Haiku…`);
    const aqPosts = await filterAQPosts(merged, CLAUDE_KEY);
    console.log(`  AQ posts: ${aqPosts.length} / ${merged.length}\n`);

    // Step 5: display
    for (const post of aqPosts) {
      const src = post.source === 'hiker' ? '[HikerAPI]' : '[Serper]  ';
      console.log(`  ${src} ${(post.caption || post.title || post.snippet || '').slice(0, 80)}`);
      console.log(`           URL      : ${post.url}`);
      if (post.likes    !== undefined) console.log(`           Likes    : ${post.likes}`);
      if (post.comments !== undefined) console.log(`           Comments : ${post.comments}`);
      if (post.taken_at)               console.log(`           Date     : ${post.taken_at}`);
      if (post.enrichError)            console.log(`           ⚠ Enrich : ${post.enrichError}`);
      console.log();
    }

    if (!aqPosts.length) console.log('  No AQ posts found in period');
  }

  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

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

const AQ_KEYWORDS = [
  'air quality', 'air pollution', 'aqi', 'pm2.5', 'pm10', 'ncap', 'grap',
  'smog', 'clean air', 'black carbon', 'ozone', 'ammonia', 'nitrogen dioxide',
  'particulate', 'emission', 'pollut', 'dust', 'haze', 'toxic air',
];

function isAQPost(caption) {
  const lower = (caption || '').toLowerCase();
  return AQ_KEYWORDS.some(kw => lower.includes(kw));
}

// Extract Instagram shortcode from any Instagram post URL
// Handles both /p/{code}/ and /{user}/p/{code}/
function shortcodeFromUrl(url) {
  const m = (url || '').match(/instagram\.com\/(?:[^/]+\/)?p\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
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
  })).filter(p => p.shortcode); // drop any non-post URLs (e.g. profile pages)
}

// ── Source 2: HikerAPI direct media fetch ─────────────────────────────────

async function hikerFetchPosts(handle, hikerKey) {
  const fromTs = new Date(DATE_FROM).getTime();
  const toTs   = new Date(DATE_TO).getTime();
  const headers = { 'x-access-key': hikerKey };

  // Get user pk
  const userRes = await axios.get('https://api.hikerapi.com/v1/user/by/username', {
    params: { username: handle }, headers, timeout: 15000,
  });
  const userId = String(userRes.data?.pk || '');
  if (!userId) return [];

  // Paginate media
  const posts = [];
  let endCursor = null;
  let page = 0;
  const MAX_PAGES = 15;

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
      if (ts >= fromTs && ts <= toTs && isAQPost(m.caption_text)) {
        posts.push({
          shortcode: m.code || m.shortcode || '',
          url:       m.code ? `https://www.instagram.com/p/${m.code}/` : '',
          title:     (m.caption_text || '').slice(0, 80),
          likes:     m.like_count    || 0,
          comments:  m.comment_count || 0,
          taken_at:  m.taken_at      || null,
          source:    'hiker',
        });
      }
      // Early stop: gone past window
      if (ts > 0 && ts < fromTs) { endCursor = null; break; }
    }

    endCursor = cursor || null;
    page++;
    if (endCursor) await new Promise(r => setTimeout(r, 400));
  } while (endCursor && page < MAX_PAGES);

  return posts.filter(p => p.shortcode);
}

// ── HikerAPI: enrich a Serper post URL with real metrics ──────────────────

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
      caption:  (m.caption_text || '').slice(0, 150),
    };
  } catch (e) {
    return { error: e.response?.data?.detail || e.message };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const SERPER_KEY = process.env.SERPER_KEY;
  const HIKER_KEY  = process.env.HIKER_API_KEY;

  console.log('=== Instagram: Serper + HikerAPI merged ===');
  console.log(`Orgs  : ${ORGS.join(', ')}`);
  console.log(`Period: ${DATE_FROM} → ${DATE_TO}`);
  console.log(`Serper: ${SERPER_KEY ? '✓' : '✗ missing'}  |  HikerAPI: ${HIKER_KEY ? '✓' : '✗ missing'}\n`);

  if (!SERPER_KEY) { console.error('SERPER_KEY not set'); process.exit(1); }

  for (const org of ORGS) {
    const handle = ORG_IG_HANDLES[org];
    console.log(`\n── ${org} (@${handle || 'unknown'}) ────────────────────────`);
    if (!handle) { console.log('  ⚠ No handle configured'); continue; }

    // ── Fetch from both sources in parallel ───────────────────────────────
    const [serperPosts, hikerPosts] = await Promise.all([
      serperIGSearch(handle, SERPER_KEY).catch(e => { console.log(`  ⚠ Serper: ${e.message}`); return []; }),
      HIKER_KEY
        ? hikerFetchPosts(handle, HIKER_KEY).catch(e => { console.log(`  ⚠ HikerAPI: ${e.message}`); return []; })
        : Promise.resolve([]),
    ]);

    console.log(`  Serper : ${serperPosts.length} post(s)`);
    console.log(`  HikerAPI: ${hikerPosts.length} post(s) in period`);

    // ── Merge, deduplicate by shortcode ───────────────────────────────────
    const seen = new Map(); // shortcode → merged post

    // HikerAPI posts go in first (already have metrics)
    for (const p of hikerPosts) seen.set(p.shortcode, p);

    // Serper posts: add if new, mark as needing enrichment if not already seen
    for (const p of serperPosts) {
      if (!seen.has(p.shortcode)) seen.set(p.shortcode, { ...p, needsEnrich: true });
      // If seen from HikerAPI already, just attach the title/snippet from Serper
      else seen.get(p.shortcode).title = seen.get(p.shortcode).title || p.title;
    }

    const merged = [...seen.values()];
    console.log(`  Merged  : ${merged.length} unique post(s) (${hikerPosts.length} from HikerAPI, ${merged.length - hikerPosts.length} Serper-only)\n`);

    // ── Enrich Serper-only posts with HikerAPI metrics ────────────────────
    if (HIKER_KEY) {
      for (const post of merged) {
        if (post.needsEnrich && post.url) {
          const metrics = await hikerEnrich(post.url, HIKER_KEY);
          if (!metrics.error) Object.assign(post, metrics);
          else post.enrichError = metrics.error;
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    // ── Display ───────────────────────────────────────────────────────────
    for (const post of merged) {
      const src = post.source === 'hiker' ? '[HikerAPI]' : '[Serper]  ';
      console.log(`  ${src} ${(post.title || post.caption || post.snippet || '').slice(0, 80)}`);
      console.log(`           URL      : ${post.url}`);
      if (post.likes    !== undefined) console.log(`           Likes    : ${post.likes}`);
      if (post.comments !== undefined) console.log(`           Comments : ${post.comments}`);
      if (post.taken_at)               console.log(`           Date     : ${post.taken_at}`);
      if (post.enrichError)            console.log(`           ⚠ Enrich : ${post.enrichError}`);
      console.log();
    }

    if (!merged.length) console.log('  No posts found in period');
  }

  console.log('=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

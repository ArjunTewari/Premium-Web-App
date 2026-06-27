'use strict';
/**
 * test-social.js — quick smoke test for X + Instagram collectors
 * Usage (in Replit shell):
 *   node test-social.js
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

const XCollector  = require('./x-collector');
const IgCollector = require('./instagram-collector');

const ORGS     = ['CEEW', 'CSE India'];
const DATE_FROM = '2026-03-27';
const DATE_TO   = '2026-06-27';

const cb = (msg, level) => {
  const prefix = level === 'warn' ? '⚠ ' : level === 'ok' ? '✓ ' : '  ';
  console.log(prefix + msg);
};

async function main() {
  console.log('=== Social API Smoke Test ===');
  console.log(`Orgs : ${ORGS.join(', ')}`);
  console.log(`Period: ${DATE_FROM} → ${DATE_TO}\n`);

  // ── Instagram API ──────────────────────────────────────────────────────
  console.log('\n── Instagram ──────────────────────────────');
  if (!process.env.META_ACCESS_TOKEN || !process.env.IG_BUSINESS_ACCOUNT_ID) {
    console.log('⚠  META_ACCESS_TOKEN or IG_BUSINESS_ACCOUNT_ID not set — skipping');
  } else {
    const igResults = await IgCollector.run(
      ORGS, DATE_FROM, DATE_TO,
      process.env.META_ACCESS_TOKEN,
      process.env.IG_BUSINESS_ACCOUNT_ID,
      process.env.CLAUDE_KEY,
      cb
    );
    for (const org of ORGS) {
      const r = igResults[org];
      if (!r) { console.log(`  ${org}: no result`); continue; }
      console.log(`\n  ${org} (@${r.handle})`);
      if (r.ig_not_available) {
        console.log(`    Not available (not a Business account)`);
      } else {
        console.log(`    Followers : ${(r.followers || 0).toLocaleString()}`);
        console.log(`    Posts in period : ${r.totalPosts}`);
        console.log(`    AQ posts (Haiku) : ${r.aqPosts}`);
        if (r.topPosts?.length) {
          console.log(`    Top post  : ${r.topPosts[0].caption?.slice(0, 100)}…`);
          console.log(`    Likes     : ${r.topPosts[0].likes}`);
        }
      }
      if (r.error) console.log(`    Error: ${r.error}`);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });

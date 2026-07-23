'use strict';
/**
 * Emerald AI — AQ Intelligence Web App
 * Runs on Replit at port 3000.
 * POST /run  → starts pipeline, streams logs via SSE
 * GET  /download/:file → serves generated HTML/PPTX
 */

// Load .env file without requiring the dotenv package
try {
  const _fs = require('fs'), _path = require('path');
  const _envPath = _path.join(__dirname, '.env');
  if (_fs.existsSync(_envPath)) {
    _fs.readFileSync(_envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*(?:#.*)?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch {}

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { run } = require('./pipeline');

const app = express();
const PORT = process.env.PORT || 3000;
const OUT_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

app.use(express.json());

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ── POST /run — start pipeline, stream SSE logs ───────────────────────────
app.post('/run', async (req, res) => {
  const body = req.body || {};

  // Build config from form inputs (fall back to env vars)
  const cfg = {
    ORGS:          Array.isArray(body.orgs) ? body.orgs.filter(Boolean) : (body.orgs || '').split(',').map(s => s.trim()).filter(Boolean),
    DATE_FROM:     body.dateFrom  || '2026-03-08',
    DATE_TO:       body.dateTo    || '2026-06-08',
    CLIENT_NAME:   body.clientName || 'Chetan Bhattacharji',
    SCOPE_KEYWORDS: Array.isArray(body.scopeKeywords) ? body.scopeKeywords : [],
    SERPER_KEY:    body.serperKey  || process.env.SERPER_KEY  || '',
    CLAUDE_KEY:    body.claudeKey  || process.env.CLAUDE_KEY  || '',
    // Model is hardcoded in pipeline.js to claude-haiku-4-5-20251001
    // Optional — AEO
    OPENAI_KEY:    body.openaiKey    || process.env.OPENAI_KEY    || '',
    PERPLEXITY_KEY:body.perplexityKey|| process.env.PERPLEXITY_KEY|| '',
    GEMINI_KEY:    body.geminiKey    || process.env.GEMINI_KEY    || '',
    // YouTube ER — optional, from form or server env
    YOUTUBE_KEY:    body.youtubeKey   || process.env.YOUTUBE_KEY  || '',
    // Official YT channel handles per org — map of { orgName: '@handle' }
    ORG_YT_HANDLES: (body.orgYtHandles && typeof body.orgYtHandles === 'object') ? body.orgYtHandles : {},
    // Social handles per org — sent from the React UI handle editor
    ORG_TW_HANDLES: (body.orgTwHandles && typeof body.orgTwHandles === 'object') ? body.orgTwHandles : {},
    ORG_IG_HANDLES: (body.orgIgHandles && typeof body.orgIgHandles === 'object') ? body.orgIgHandles : {},
    ORG_LI_HANDLES: (body.orgLiHandles && typeof body.orgLiHandles === 'object') ? body.orgLiHandles : {},
    // Social — always from server secrets (never from form body)
    X_BEARER_TOKEN:          process.env.X_BEARER_TOKEN          || '',
    META_ACCESS_TOKEN:       process.env.META_ACCESS_TOKEN       || '',
    IG_BUSINESS_ACCOUNT_ID:  process.env.IG_BUSINESS_ACCOUNT_ID  || '',
    outDir: OUT_DIR
  };

  // Validate required keys
  if (!cfg.ORGS.length) cfg.ORGS = ['CEEW', 'CSTEP'];
  if (cfg.ORGS.length > 13) cfg.ORGS = cfg.ORGS.slice(0, 13); // hard cap
  if (!cfg.SERPER_KEY)  return res.status(400).json({ error: 'Serper API key is required.' });
  if (!cfg.CLAUDE_KEY)  return res.status(400).json({ error: 'Claude API key is required.' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Log callback — maps to SSE events
  const cb = (msg, level='') => {
    send('log', { msg, level });
    process.stdout.write(msg + '\n');
  };

  try {
    const result = await run(cfg, cb);
    send('done', {
      htmlName: result.htmlName,
      pptxName: result.pptxName
    });
  } catch(e) {
    send('error', { msg: e.message });
    console.error('Pipeline error:', e);
  }

  res.end();
});

// ── GET /download/:file — serve generated report files ────────────────────
app.get('/download/:file', (req, res) => {
  const fname = path.basename(req.params.file); // prevent path traversal
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send('File not found');
  res.download(fpath, fname);
});

// ── GET /view/:file — serve HTML report inline (no attachment) ─────────────
app.get('/view/:file', (req, res) => {
  const fname = path.basename(req.params.file);
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send('File not found');
  if (!fname.endsWith('.html')) return res.status(400).send('Only HTML files can be previewed');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.sendFile(fpath);
});

// ── GET /outputs — list available reports ─────────────────────────────────
app.get('/outputs', (req, res) => {
  const files = fs.readdirSync(OUT_DIR)
    .filter(f => f.endsWith('.html') || f.endsWith('.pptx'))
    .map(f => ({
      name: f,
      size: Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024),
      mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.toISOString().slice(0,16)
    }))
    .sort((a,b) => b.mtime.localeCompare(a.mtime));
  res.json(files);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Emerald AI — AQ Intelligence Platform v7    ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`  Server running at http://0.0.0.0:${PORT}`);
  console.log(`  Open the Replit webview to access the UI\n`);
});

'use strict';
/**
 * Emerald AI — AQ Intelligence Web App
 * Runs on Replit at port 3000.
 * POST /run  → starts pipeline, streams logs via SSE
 * GET  /download/:file → serves generated HTML/PPTX
 */

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
    ORGS:          (body.orgs || '').split(',').map(s => s.trim()).filter(Boolean),
    DATE_FROM:     body.dateFrom  || '2026-03-08',
    DATE_TO:       body.dateTo    || '2026-06-08',
    CLIENT_NAME:   body.clientName || 'Chetan Bhattacharji',
    SERPER_KEY:    body.serperKey  || process.env.SERPER_KEY  || '',
    CLAUDE_KEY:    body.claudeKey  || process.env.CLAUDE_KEY  || '',
    // Model is hardcoded in pipeline.js to claude-haiku-4-5-20251001
    // Optional — AEO
    OPENAI_KEY:    body.openaiKey    || process.env.OPENAI_KEY    || '',
    PERPLEXITY_KEY:body.perplexityKey|| process.env.PERPLEXITY_KEY|| '',
    GEMINI_KEY:    body.geminiKey    || process.env.GEMINI_KEY    || '',
    // Social — always from server secrets
    TWITTER_KEY:           process.env.TWITTER_KEY           || '',
    YOUTUBE_CLIENT_ID:     process.env.YOUTUBE_CLIENT_ID     || '',
    YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || '',
    YOUTUBE_AUTHORIZED_URI:process.env.YOUTUBE_AUTHORIZED_URI|| '',
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

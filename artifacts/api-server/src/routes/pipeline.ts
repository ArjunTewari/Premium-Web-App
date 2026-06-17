import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { db, reportLogsTable } from "@workspace/db";
import { calculateReportCosts } from "../lib/auth.js";
import { requireAuth } from "../middleware/require-auth.js";

const require = createRequire(import.meta.url);

const router: IRouter = Router();

const OUT_DIR = path.join(process.cwd(), "outputs");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const YOUTUBE_TOKENS_FILE = path.join(process.cwd(), "youtube_tokens.json");

router.post("/run", requireAuth, async (req: Request, res: Response) => {
  const body = req.body || {};

  const cfg = {
    ORGS: Array.isArray(body.orgs)
      ? body.orgs.filter(Boolean)
      : (body.orgs || "").split(",").map((s: string) => s.trim()).filter(Boolean),
    DATE_FROM: body.dateFrom || "2026-03-08",
    DATE_TO: body.dateTo || "2026-06-08",
    CLIENT_NAME: body.clientName || "Chetan Bhattacharji",
    SCOPE_KEYWORDS: Array.isArray(body.scopeKeywords) ? body.scopeKeywords : [],
    SERPER_KEY: body.serperKey || process.env.SERPER_KEY || "",
    CLAUDE_KEY: body.claudeKey || process.env.CLAUDE_KEY || "",
    OPENAI_KEY: body.openaiKey || process.env.OPENAI_KEY || "",
    PERPLEXITY_KEY: body.perplexityKey || process.env.PERPLEXITY_KEY || "",
    GEMINI_KEY: body.geminiKey || process.env.GEMINI_KEY || "",
    TWITTER_KEY: process.env.TWITTER_KEY || "",
    YOUTUBE_KEY: process.env.YOUTUBE_KEY || "",
    YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || "",
    YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || "",
    YOUTUBE_AUTHORIZED_URI: process.env.YOUTUBE_AUTHORIZED_URI || "",
    outDir: OUT_DIR,
  };

  if (!cfg.ORGS.length) cfg.ORGS = ["CEEW", "CSTEP"];
  if (cfg.ORGS.length > 13) cfg.ORGS = cfg.ORGS.slice(0, 13);

  if (!cfg.SERPER_KEY)
    return res.status(400).json({ error: "Serper API key is required." });
  if (!cfg.CLAUDE_KEY)
    return res.status(400).json({ error: "Claude API key is required." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (type: string, data: unknown) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const cb = (msg: string, level = "") => {
    send("log", { msg, level });
    process.stdout.write(msg + "\n");
  };

  try {
    const pipelinePath = path.resolve(__dirname, "../pipeline.cjs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { run } = require(pipelinePath) as any;
    const result = await run(cfg, cb);
    send("done", { htmlName: result.htmlName, pptxName: result.pptxName });

    const costs = calculateReportCosts(cfg.ORGS, cfg.DATE_FROM, cfg.DATE_TO);
    db.insert(reportLogsTable).values({
      organizations: cfg.ORGS,
      dateFrom: cfg.DATE_FROM,
      dateTo: cfg.DATE_TO,
      htmlName: result.htmlName ?? null,
      pptxName: result.pptxName ?? null,
      clientName: cfg.CLIENT_NAME,
      costInr: costs.costInr.toFixed(2),
      costSerperInr: costs.costSerperInr.toFixed(2),
      costLlmAeoInr: costs.costLlmAeoInr.toFixed(2),
      costClaudeInr: costs.costClaudeInr.toFixed(2),
      costYoutubeInr: costs.costYoutubeInr.toFixed(2),
      costStorageInr: costs.costStorageInr.toFixed(2),
      costDeploymentInr: costs.costDeploymentInr.toFixed(2),
    }).catch((e: unknown) => console.error("Failed to log report:", e));
  } catch (e: unknown) {
    send("error", { msg: (e as Error).message });
    console.error("Pipeline error:", e);
  }

  res.end();
});

router.get("/outputs", requireAuth, (_req: Request, res: Response) => {
  try {
    const files = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".html") || f.endsWith(".pptx"))
      .map((f) => ({
        name: f,
        size: Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024),
        mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.toISOString().slice(0, 16),
      }))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    res.json(files);
  } catch {
    res.json([]);
  }
});

router.get("/download/:file", requireAuth, (req: Request, res: Response) => {
  const fname = path.basename(req.params.file);
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send("File not found");
  res.download(fpath, fname);
});

router.get("/auth/youtube", (req: Request, res: Response) => {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_AUTHORIZED_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).send("YOUTUBE_CLIENT_ID or YOUTUBE_AUTHORIZED_URI not set.");
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    access_type: "offline",
    prompt: "consent",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get("/auth/youtube/callback", async (req: Request, res: Response) => {
  const { code, error } = req.query as { code?: string; error?: string };
  if (error) return res.status(400).send(`OAuth error: ${error}`);
  if (!code) return res.status(400).send("Missing authorization code.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axios = require("axios") as any;
  try {
    const tok = await axios.post("https://oauth2.googleapis.com/token", null, {
      params: {
        code,
        client_id: process.env.YOUTUBE_CLIENT_ID,
        client_secret: process.env.YOUTUBE_CLIENT_SECRET,
        redirect_uri: process.env.YOUTUBE_AUTHORIZED_URI,
        grant_type: "authorization_code",
      },
    });
    const tokens = {
      access_token: tok.data.access_token,
      refresh_token: tok.data.refresh_token,
      expiry_date: Date.now() + (tok.data.expires_in || 3600) * 1000,
    };
    fs.writeFileSync(YOUTUBE_TOKENS_FILE, JSON.stringify(tokens, null, 2));
    res.send(`
      <h2 style="font-family:sans-serif;color:#1a7a4a">✓ YouTube authorised</h2>
      <p style="font-family:sans-serif">Tokens saved. YouTube data will be included in future reports.</p>
      <p style="font-family:sans-serif"><a href="/">← Back to Emerald AI</a></p>
    `);
  } catch (e: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.status(500).send(`Token exchange failed: ${(e as any).response?.data?.error_description || (e as Error).message}`);
  }
});

router.get("/auth/youtube/status", (_req: Request, res: Response) => {
  const connected = fs.existsSync(YOUTUBE_TOKENS_FILE);
  res.json({ connected, setupUrl: "/api/auth/youtube" });
});

export default router;

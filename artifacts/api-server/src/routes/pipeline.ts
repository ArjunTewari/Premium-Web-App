import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { db, reportLogsTable } from "@workspace/db";
import { calculateReportCosts } from "../lib/auth.js";
import { requireAuth, requireAdmin } from "../middleware/require-auth.js";

const require = createRequire(import.meta.url);

const router: IRouter = Router();

const OUT_DIR = path.join(process.cwd(), "outputs");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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
    AEO_QUERIES: Array.isArray(body.aeoQueries) && body.aeoQueries.length > 0 ? body.aeoQueries.filter(Boolean) : [],
    SERPER_KEY: body.serperKey || process.env.SERPER_KEY || "",
    CLAUDE_KEY: body.claudeKey || process.env.CLAUDE_KEY || "",
    OPENAI_KEY: body.openaiKey || process.env.OPENAI_KEY || "",
    PERPLEXITY_KEY: body.perplexityKey || process.env.PERPLEXITY_KEY || "",
    GEMINI_KEY: body.geminiKey || process.env.GEMINI_KEY || "",
    YOUTUBE_KEY: process.env.YOUTUBE_KEY || "",
    TWITTER_KEY: process.env.TWITTER_KEY || "",
    ORG_YT_HANDLES: (body.orgYtHandles && typeof body.orgYtHandles === "object" && !Array.isArray(body.orgYtHandles))
      ? body.orgYtHandles
      : {},
    outDir: OUT_DIR,
  };

  if (!cfg.ORGS.length) cfg.ORGS = ["Council on Energy, Environment and Water", "CSTEP"];
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
    const pipelinePath = path.resolve(__dirname, "../../../emerald-ai/pipeline.js");
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

export default router;

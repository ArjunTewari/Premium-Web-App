import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { run, type RunConfig } from "../pipeline/index.js";

const router: IRouter = Router();

// Output directory for generated reports
const OUT_DIR = path.resolve(process.cwd(), "data", "outputs");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── POST /run — start pipeline, stream SSE logs ───────────────────────────
router.post("/run", async (req, res) => {
  const body = req.body || {};

  const orgs: string[] = Array.isArray(body.orgs)
    ? body.orgs.filter(Boolean)
    : (body.orgs || "").split(",").map((s: string) => s.trim()).filter(Boolean);

  if (!orgs.length) {
    res.status(400).json({ error: "No organisations provided." });
    return;
  }
  if (orgs.length > 13) orgs.splice(13);

  const serperKey: string = body.serperKey || process.env["SERPER_KEY"] || "";
  const claudeKey: string = body.claudeKey || process.env["CLAUDE_KEY"] || "";

  if (!serperKey) {
    res.status(400).json({ error: "Serper API key is required." });
    return;
  }
  if (!claudeKey) {
    res.status(400).json({ error: "Claude API key is required." });
    return;
  }

  const cfg: RunConfig = {
    ORGS: orgs,
    DATE_FROM: body.dateFrom || "2026-03-08",
    DATE_TO: body.dateTo || "2026-06-08",
    CLIENT_NAME: body.clientName || "Client",
    SCOPE_KEYWORDS: Array.isArray(body.scopeKeywords) ? body.scopeKeywords : [],
    SERPER_KEY: serperKey,
    CLAUDE_KEY: claudeKey,
    OPENAI_KEY: body.openaiKey || process.env["OPENAI_KEY"] || "",
    PERPLEXITY_KEY: body.perplexityKey || process.env["PERPLEXITY_KEY"] || "",
    GEMINI_KEY: body.geminiKey || process.env["GEMINI_KEY"] || "",
    YOUTUBE_KEY: body.youtubeKey || process.env["YOUTUBE_KEY"] || "",
    FIRECRAWL_KEY: process.env["FIRECRAWL_KEY"] || "",
    APIDIRECT_KEY: process.env["APIDIRECT_KEY"] || "",
    ORG_YT_HANDLES:
      body.orgYtHandles && typeof body.orgYtHandles === "object"
        ? body.orgYtHandles
        : {},
    ORG_TW_HANDLES:
      body.orgTwHandles && typeof body.orgTwHandles === "object"
        ? body.orgTwHandles
        : {},
    ORG_IG_HANDLES:
      body.orgIgHandles && typeof body.orgIgHandles === "object"
        ? body.orgIgHandles
        : {},
    ORG_LI_HANDLES:
      body.orgLiHandles && typeof body.orgLiHandles === "object"
        ? body.orgLiHandles
        : {},
    // Social secrets — server only, never from form body
    X_BEARER_TOKEN: process.env["X_BEARER_TOKEN"] || "",
    META_ACCESS_TOKEN: process.env["META_ACCESS_TOKEN"] || "",
    IG_BUSINESS_ACCOUNT_ID: process.env["IG_BUSINESS_ACCOUNT_ID"] || "",
    outDir: OUT_DIR,
  };

  // SSE headers
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
    const result = await run(cfg, cb);
    send("done", { htmlName: result.htmlName, pptxName: result.pptxName });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    send("error", { msg });
    req.log.error({ err: e }, "Pipeline error");
  }

  res.end();
});

// ── GET /download/:file — serve generated report files ────────────────────
router.get("/download/:file", (req, res) => {
  const fname = path.basename(req.params["file"] || "");
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) {
    res.status(404).send("File not found");
    return;
  }
  res.download(fpath, fname);
});

// ── GET /view/:file — serve HTML report inline ─────────────────────────────
router.get("/view/:file", (req, res) => {
  const fname = path.basename(req.params["file"] || "");
  const fpath = path.join(OUT_DIR, fname);
  if (!fs.existsSync(fpath)) {
    res.status(404).send("File not found");
    return;
  }
  if (!fname.endsWith(".html")) {
    res.status(400).send("Only HTML files can be previewed");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.sendFile(fpath);
});

// ── GET /outputs — list available reports ─────────────────────────────────
router.get("/outputs", (_req, res) => {
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".html") || f.endsWith(".pptx"))
    .map((f) => {
      const stat = fs.statSync(path.join(OUT_DIR, f));
      return {
        name: f,
        size: Math.round(stat.size / 1024),
        mtime: stat.mtime.toISOString().slice(0, 16),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  res.json(files);
});

export default router;

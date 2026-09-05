import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { db, reportLogsTable } from "@workspace/db";
import { calculateReportCosts } from "../lib/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { run } from "../pipeline/index.js";

const ALERT_TO = "+918588098882";

async function sendReportSms(costInr: number, orgs: string[], htmlName: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { ReplitConnectors } = await import("@replit/connectors-sdk") as any;
    const connectors = new ReplitConnectors();

    const accountsRes = await connectors.proxy("twilio", "/2010-04-01/Accounts.json", { method: "GET" });
    const accountsData = await accountsRes.json() as { accounts?: { sid: string }[] };
    const sid = accountsData.accounts?.[0]?.sid;
    if (!sid) { console.warn("[SMS] Could not resolve Twilio account SID"); return; }

    const numsRes = await connectors.proxy("twilio", `/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, { method: "GET" });
    const numsData = await numsRes.json() as { incoming_phone_numbers?: { phone_number: string }[] };
    const from = numsData.incoming_phone_numbers?.[0]?.phone_number;
    if (!from) { console.warn("[SMS] No From number on Twilio account"); return; }

    const body = new URLSearchParams({
      To:   ALERT_TO,
      From: from,
      Body: `Emerald AI ✓ Report ready\nOrgs: ${orgs.slice(0, 3).join(", ")}${orgs.length > 3 ? ` +${orgs.length - 3} more` : ""}\nFile: ${htmlName}\nCost: ₹${costInr.toFixed(2)}`,
    });

    const smsRes = await connectors.proxy("twilio", `/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const smsData = await smsRes.json() as { sid?: string; error_message?: string };
    if (smsData.sid) {
      console.log(`[SMS] Sent — SID ${smsData.sid}`);
    } else {
      console.warn("[SMS] Send failed:", smsData.error_message);
    }
  } catch (e) {
    console.warn("[SMS] Skipped (connector not configured):", (e as Error).message);
  }
}

const router: IRouter = Router();

const OUT_DIR = path.join(process.cwd(), "outputs");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── In-memory run result store ────────────────────────────────────────────────
// Survives the SSE connection being killed by the 5-min proxy timeout.
// The pipeline keeps running after the client disconnects; when it finishes
// it writes the result here so the frontend can poll and retrieve it.
type RunStatus =
  | { status: "running" }
  | { status: "done"; htmlName: string; costInr: number }
  | { status: "error"; msg: string };

const runStore = new Map<string, RunStatus>();

// Evict entries older than 2 hours to prevent unbounded memory growth.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id] of runStore) {
    const ts = parseInt(id.split("-")[0] ?? "0", 16);
    if (ts < cutoff / 1000) runStore.delete(id);
  }
}, 30 * 60 * 1000);

// ── GET /run/status/:runId — poll for result after SSE drop ──────────────────
router.get("/run/status/:runId", requireAuth, (req: Request, res: Response) => {
  const entry = runStore.get(req.params.runId);
  if (!entry) return res.status(404).json({ status: "not_found" });
  res.json(entry);
});

// ── POST /run ─────────────────────────────────────────────────────────────────
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
    FIRECRAWL_KEY: process.env.FIRECRAWL_KEY || "",
    YOUTUBE_KEY: process.env.YOUTUBE_KEY || "",
    TWITTER_KEY: process.env.X_BEARER_TOKEN || "",
    APIDIRECT_KEY: process.env.APIDIRECT_KEY || "",
    ORG_YT_HANDLES: (body.orgYtHandles && typeof body.orgYtHandles === "object" && !Array.isArray(body.orgYtHandles))
      ? body.orgYtHandles : {},
    ORG_TW_HANDLES: (body.orgTwHandles && typeof body.orgTwHandles === "object" && !Array.isArray(body.orgTwHandles))
      ? body.orgTwHandles : {},
    ORG_IG_HANDLES: (body.orgIgHandles && typeof body.orgIgHandles === "object" && !Array.isArray(body.orgIgHandles))
      ? body.orgIgHandles : {},
    ORG_LI_HANDLES: (body.orgLiHandles && typeof body.orgLiHandles === "object" && !Array.isArray(body.orgLiHandles))
      ? body.orgLiHandles : {},
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || "",
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
    IG_BUSINESS_ACCOUNT_ID: process.env.IG_BUSINESS_ACCOUNT_ID || "",
    outDir: OUT_DIR,
  };

  if (!cfg.ORGS.length) cfg.ORGS = ["Council on Energy, Environment and Water", "CSTEP"];
  if (cfg.ORGS.length > 20) cfg.ORGS = cfg.ORGS.slice(0, 20);

  // Firecrawl is the primary source for print + TV coverage. Serper is now only
  // a best-effort article-text scraper (STEP 1c) and the white-space gap search
  // (STEP 5a); both degrade gracefully to Firecrawl summaries / an empty gap
  // section when SERPER_KEY is absent, so it is optional.
  if (!cfg.FIRECRAWL_KEY)
    return res.status(400).json({ error: "Firecrawl API key is required." });
  if (!cfg.CLAUDE_KEY)
    return res.status(400).json({ error: "Claude API key is required." });

  // Generate a stable run ID: hex-encoded seconds + random suffix.
  const runId = Math.floor(Date.now() / 1000).toString(16) + "-" + crypto.randomBytes(8).toString("hex");
  runStore.set(runId, { status: "running" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  req.setTimeout(0);
  req.socket?.setTimeout(0);

  let clientDisconnected = false;
  res.on("error", () => { clientDisconnected = true; });
  req.on("error", () => { clientDisconnected = true; });
  res.on("close", () => { clientDisconnected = true; });

  const send = (type: string, data: unknown) => {
    if (clientDisconnected || res.writableEnded) return;
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clientDisconnected = true;
    }
  };

  // Send runId immediately so the frontend can start polling if the SSE
  // connection gets killed by the 5-min infrastructure proxy timeout.
  send("runId", { runId });

  // Heartbeat every 15s to keep intermediate proxies from dropping idle connections.
  const heartbeat = setInterval(() => {
    if (clientDisconnected || res.writableEnded) { clearInterval(heartbeat); return; }
    try { res.write(`: ping\n\n`); } catch { clientDisconnected = true; }
  }, 15000);

  const cb = (msg: string, level = "") => {
    send("log", { msg, level });
    process.stdout.write(msg + "\n");
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await run(cfg as any, cb);
    const costs = calculateReportCosts(cfg.ORGS, cfg.DATE_FROM, cfg.DATE_TO);

    // Always persist result — the client may already be disconnected.
    runStore.set(runId, { status: "done", htmlName: result.htmlName, costInr: costs.costInr });

    send("done", { runId, htmlName: result.htmlName, costInr: costs.costInr });
    sendReportSms(costs.costInr, cfg.ORGS, result.htmlName ?? "").catch(() => {});
    db.insert(reportLogsTable).values({
      organizations: cfg.ORGS,
      dateFrom: cfg.DATE_FROM,
      dateTo: cfg.DATE_TO,
      htmlName: result.htmlName ?? null,
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
    const msg = (e as Error).message;
    runStore.set(runId, { status: "error", msg });
    send("error", { msg });
    console.error("Pipeline error:", e);
  } finally {
    clearInterval(heartbeat);
  }

  if (!clientDisconnected && !res.writableEnded) res.end();
});

router.get("/outputs", requireAuth, async (_req: Request, res: Response) => {
  try {
    const files = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => ({
        name: f,
        size: Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024),
        mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.toISOString().slice(0, 16),
      }))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));

    const logs = await db.select({ htmlName: reportLogsTable.htmlName, costInr: reportLogsTable.costInr }).from(reportLogsTable);
    const costMap: Record<string, string> = {};
    for (const log of logs) {
      if (log.htmlName && log.costInr) costMap[log.htmlName] = log.costInr;
    }

    res.json(files.map((f) => ({ ...f, costInr: costMap[f.name] ?? null })));
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

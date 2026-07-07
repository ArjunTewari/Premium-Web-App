import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { db, reportLogsTable } from "@workspace/db";
import { calculateReportCosts } from "../lib/auth.js";
import { requireAuth, requireAdmin } from "../middleware/require-auth.js";
import { ReplitConnectors } from "@replit/connectors-sdk";

const ALERT_TO = "+918588098882";

async function sendReportSms(costInr: number, orgs: string[], htmlName: string) {
  try {
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
    console.error("[SMS] Error:", e);
  }
}

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
    APIDIRECT_KEY: process.env.APIDIRECT_KEY || "",
    ORG_YT_HANDLES: (body.orgYtHandles && typeof body.orgYtHandles === "object" && !Array.isArray(body.orgYtHandles))
      ? body.orgYtHandles
      : {},
    ORG_TW_HANDLES: (body.orgTwHandles && typeof body.orgTwHandles === "object" && !Array.isArray(body.orgTwHandles))
      ? body.orgTwHandles
      : {},
    ORG_IG_HANDLES: (body.orgIgHandles && typeof body.orgIgHandles === "object" && !Array.isArray(body.orgIgHandles))
      ? body.orgIgHandles
      : {},
    ORG_LI_HANDLES: (body.orgLiHandles && typeof body.orgLiHandles === "object" && !Array.isArray(body.orgLiHandles))
      ? body.orgLiHandles
      : {},
    outDir: OUT_DIR,
  };

  if (!cfg.ORGS.length) cfg.ORGS = ["Council on Energy, Environment and Water", "CSTEP"];
  if (cfg.ORGS.length > 20) cfg.ORGS = cfg.ORGS.slice(0, 20);

  if (!cfg.SERPER_KEY)
    return res.status(400).json({ error: "Serper API key is required." });
  if (!cfg.CLAUDE_KEY)
    return res.status(400).json({ error: "Claude API key is required." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  req.setTimeout(0);
  req.socket?.setTimeout(0);

  // Prevent an unhandled 'error' event on the response/request sockets from
  // crashing the whole Node process (this happens if the client disconnects
  // or an intermediate proxy closes an idle connection while the pipeline is
  // still writing to it). Without these listeners, one dropped client during
  // a long-running report kills the server for every other in-flight/future
  // request — which looked like the report "getting stuck" after a few orgs.
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

  // Heartbeat comment every 15s so intermediate proxies don't treat long
  // silent stretches (e.g. Claude/Serper batches with no cb() calls) as an
  // idle connection and terminate it mid-report.
  const heartbeat = setInterval(() => {
    if (clientDisconnected || res.writableEnded) { clearInterval(heartbeat); return; }
    try { res.write(`: ping\n\n`); } catch { clientDisconnected = true; }
  }, 15000);

  const cb = (msg: string, level = "") => {
    send("log", { msg, level });
    process.stdout.write(msg + "\n");
  };

  try {
    const pipelinePath = path.resolve(__dirname, "../../../emerald-ai/pipeline.js");
    // Bust require cache so pipeline changes are picked up without server restart
    delete require.cache[require.resolve(pipelinePath)];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { run } = require(pipelinePath) as any;
    const result = await run(cfg, cb);
    const costs = calculateReportCosts(cfg.ORGS, cfg.DATE_FROM, cfg.DATE_TO);
    send("done", { htmlName: result.htmlName, costInr: costs.costInr });
    sendReportSms(costs.costInr, cfg.ORGS, result.htmlName ?? "").catch(() => {});
    db.insert(reportLogsTable).values({
      organizations: cfg.ORGS,
      dateFrom: cfg.DATE_FROM,
      dateTo: cfg.DATE_TO,
      htmlName: result.htmlName ?? null,
      clientName: cfg.CLIENT_NAME,
      generatedBy: req.user?.username ?? null,
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

import { Router, type IRouter, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db, usersTable, orgHandlesTable, reportLogsTable } from "@workspace/db";
import { requireAuth } from "../middleware/require-auth.js";
import { type ReportTrendSummary } from "../pipeline/index.js";
import { generateAndDeliverReport, loadReportHtml, persistReportToGithub, OUT_DIR } from "../lib/generate-report.js";
import { deriveReport, listReportOrgs, parseReportType, priceForType, reportTypeOfName, reportTypeOfHtml } from "../lib/report-types.js";
import { toClientView } from "../lib/client-view.js";
import { sendReportFileEmail } from "../lib/mailer.js";
import {
  listReports,
  listReportDataFiles,
  getReportContent,
} from "../lib/report-storage.js";

// Fallback report period when the client doesn't send one — a rolling month
// ending today, computed fresh on every request instead of a fixed date. The
// web app always sends real dates now; this only guards direct API calls.
function defaultDateRange(): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 1);
  return { from: iso(from), to: iso(to) };
}

const router: IRouter = Router();

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── In-memory run result store ────────────────────────────────────────────────
// Survives the SSE connection being killed by the 5-min proxy timeout.
// The pipeline keeps running after the client disconnects; when it finishes
// it writes the result here so the frontend can poll and retrieve it.
type RunStatus =
  | { status: "running" }
  | { status: "done"; htmlName: string; costInr: number }
  | { status: "error"; msg: string }
  | { status: "cancelled" };

const runStore = new Map<string, RunStatus>();

// One AbortController per in-flight run, keyed by runId — lets the /run/cancel
// route signal the pipeline to stop. Removed as soon as the run ends (success,
// error, or cancellation), so this never holds more entries than runStore's
// "running" rows.
const runControllers = new Map<string, AbortController>();

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

// ── POST /run/cancel/:runId — stop an in-flight report generation ────────────
router.post("/run/cancel/:runId", requireAuth, (req: Request, res: Response) => {
  const runId = String(req.params.runId || "").trim();
  const controller = runControllers.get(runId);
  if (!controller) return res.status(404).json({ error: "Run not found or already finished" });
  controller.abort();
  return res.json({ status: "ok" });
});

// ── POST /run ─────────────────────────────────────────────────────────────────
router.post("/run", requireAuth, async (req: Request, res: Response) => {
  const body = req.body || {};

  const cfg = {
    ORGS: Array.isArray(body.orgs)
      ? body.orgs.filter(Boolean)
      : (body.orgs || "").split(",").map((s: string) => s.trim()).filter(Boolean),
    DATE_FROM: body.dateFrom || defaultDateRange().from,
    DATE_TO: body.dateTo || defaultDateRange().to,
    CLIENT_NAME: body.clientName || "Chetan Bhattacharji",
    SCOPE_KEYWORDS: Array.isArray(body.scopeKeywords) ? body.scopeKeywords : [],
    AEO_QUERIES: Array.isArray(body.aeoQueries) && body.aeoQueries.length > 0 ? body.aeoQueries.filter(Boolean) : [],
    SERPER_KEY: body.serperKey || process.env.SERPER_KEY || "",
    CLAUDE_KEY: body.claudeKey || process.env.CLAUDE_KEY || "",
    OPENAI_KEY: body.openaiKey || process.env.OPENAI_KEY || "",
    PERPLEXITY_KEY: body.perplexityKey || process.env.PERPLEXITY_KEY || "",
    GEMINI_KEY: body.geminiKey || process.env.GEMINI_KEY || "",
    EXA_API_KEY: process.env.EXA_API_KEY || "",
    YOUTUBE_KEY: process.env.YOUTUBE_KEY || "",
    TWITTER_KEY: process.env.X_BEARER_TOKEN || "",
    APIDIRECT_KEY: process.env.APIDIRECT_KEY || "",
    // Social handles come from the shared org_handles table below (the single
    // source of truth every account edits). Any handle maps in the request body
    // are treated as a per-run override, merged on top.
    ORG_YT_HANDLES: {} as Record<string, string>,
    ORG_TW_HANDLES: {} as Record<string, string>,
    ORG_IG_HANDLES: {} as Record<string, string>,
    ORG_LI_HANDLES: {} as Record<string, string>,
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN || "",
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
    IG_BUSINESS_ACCOUNT_ID: process.env.IG_BUSINESS_ACCOUNT_ID || "",
    outDir: OUT_DIR,
  };

  if (!cfg.ORGS.length) cfg.ORGS = ["Council on Energy, Environment and Water", "CSTEP"];
  if (cfg.ORGS.length > 20) cfg.ORGS = cfg.ORGS.slice(0, 20);

  // Report type: "full" (default) or a one-org "benchmark" / "snapshot" view of
  // `subjectOrg`, which must be one of the orgs in this run. Checked before any
  // paid work starts.
  const reportType = parseReportType(body.reportType);
  if (!reportType) return res.status(400).json({ error: "reportType must be full, benchmark or snapshot." });
  let subjectOrg: string | null = null;
  if (reportType !== "full") {
    const want = String(body.subjectOrg || "").trim().toLowerCase();
    subjectOrg = cfg.ORGS.find((o: string) => o.toLowerCase() === want) ?? null;
    if (!subjectOrg) return res.status(400).json({ error: "Choose a subject organisation from the organisations in this run." });
    if (cfg.ORGS.length < 2) return res.status(400).json({ error: "A benchmark needs at least one other organisation to compare against." });
  }

  // Load the shared handle list (latest for every account), then layer any
  // per-run overrides from the request body on top.
  try {
    const rows = await db.select().from(orgHandlesTable);
    for (const r of rows) {
      if (r.youtube) cfg.ORG_YT_HANDLES[r.org] = r.youtube;
      if (r.twitter) cfg.ORG_TW_HANDLES[r.org] = r.twitter;
      if (r.instagram) cfg.ORG_IG_HANDLES[r.org] = r.instagram;
      if (r.linkedin) cfg.ORG_LI_HANDLES[r.org] = r.linkedin;
    }
  } catch (e) {
    console.error("Failed to load org_handles — proceeding with body handles only:", e);
  }
  const mergeOverride = (target: Record<string, string>, src: unknown) => {
    if (src && typeof src === "object" && !Array.isArray(src)) {
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) target[k] = v.trim();
      }
    }
  };
  mergeOverride(cfg.ORG_YT_HANDLES, body.orgYtHandles);
  mergeOverride(cfg.ORG_TW_HANDLES, body.orgTwHandles);
  mergeOverride(cfg.ORG_IG_HANDLES, body.orgIgHandles);
  mergeOverride(cfg.ORG_LI_HANDLES, body.orgLiHandles);

  // Article discovery is Exa-only (corpus-first). The legacy per-org
  // Firecrawl/Serper search path has been removed.
  if (!cfg.EXA_API_KEY)
    return res.status(400).json({ error: "EXA_API_KEY is required for article discovery." });
  if (!cfg.CLAUDE_KEY)
    return res.status(400).json({ error: "Claude API key is required." });

  // Generate a stable run ID: hex-encoded seconds + random suffix.
  const runId = Math.floor(Date.now() / 1000).toString(16) + "-" + crypto.randomBytes(8).toString("hex");
  runStore.set(runId, { status: "running" });

  const controller = new AbortController();
  runControllers.set(runId, controller);
  (cfg as { signal?: AbortSignal }).signal = controller.signal;

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
    // The generating account is "the client" for a manual run — look up its
    // email (captured at signup) so it receives the client-cost email.
    let clientEmail: string | null = null;
    const uid = (req.user as { userId?: number } | undefined)?.userId;
    if (uid != null) {
      try {
        const [u] = await db
          .select({ email: usersTable.email })
          .from(usersTable)
          .where(eq(usersTable.id, uid))
          .limit(1);
        clientEmail = u?.email ?? null;
      } catch (e) {
        console.error("client email lookup failed:", e);
      }
    }

    const { htmlName, costInr } = await generateAndDeliverReport({
      cfg,
      cb,
      generatedByUsername: (req.user as { username?: string } | undefined)?.username ?? null,
      recipientEmail: clientEmail,
      reportType,
      subjectOrg,
    });

    // Always persist result — the client may already be disconnected.
    runStore.set(runId, { status: "done", htmlName, costInr });
    send("done", { runId, htmlName, costInr });
  } catch (e: unknown) {
    if ((e as { code?: string } | undefined)?.code === "CANCELLED") {
      runStore.set(runId, { status: "cancelled" });
      send("cancelled", { runId });
    } else {
      const msg = (e as Error).message;
      runStore.set(runId, { status: "error", msg });
      send("error", { msg });
      console.error("Pipeline error:", e);
    }
  } finally {
    clearInterval(heartbeat);
    runControllers.delete(runId);
  }

  if (!clientDisconnected && !res.writableEnded) res.end();
});

router.get("/outputs", requireAuth, async (_req: Request, res: Response) => {
  try {
    const localFiles = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => ({
        name: f,
        size: Math.round(fs.statSync(path.join(OUT_DIR, f)).size / 1024),
        mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.toISOString().slice(0, 16),
      }));

    // Most reports now live in GitHub storage (see persistReportToGithub) —
    // local disk only ever holds the sample reports plus anything mid-upload
    // or that failed to migrate. Merge both, local taking priority on a name
    // clash (shouldn't happen — a report is removed locally only once the
    // GitHub upload has already succeeded).
    const githubFiles = await listReports();
    const localNames = new Set(localFiles.map((f) => f.name));
    const files = [...localFiles, ...githubFiles.filter((f) => !localNames.has(f.name))].sort((a, b) =>
      b.mtime.localeCompare(a.mtime),
    );

    const logs = await db.select({ htmlName: reportLogsTable.htmlName, costInr: reportLogsTable.costInr }).from(reportLogsTable);
    const costMap: Record<string, string> = {};
    for (const log of logs) {
      if (log.htmlName && log.costInr) costMap[log.htmlName] = log.costInr;
    }

    // Run-log cost first; benchmark / snapshot reports fall back to the price stored in the manifest.
    res.json(
      files.map((f) => {
        const price = (f as { priceInr?: number }).priceInr;
        return { ...f, costInr: costMap[f.name] ?? (price != null ? price.toFixed(2) : null) };
      }),
    );
  } catch {
    res.json([]);
  }
});

router.get("/download/:file", requireAuth, async (req: Request, res: Response) => {
  const fname = path.basename(String(req.params.file || "").trim());
  const fpath = path.join(OUT_DIR, fname);
  if (fs.existsSync(fpath)) return res.download(fpath, fname);

  // Not on local disk — most reports live in GitHub storage now.
  const content = await getReportContent(fname);
  if (content == null) return res.status(404).send("File not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  return res.send(content);
});

// ── POST /outputs/email — email an existing report as an attachment ─────────
// Admins may send to any address; other accounts only to their own signup
// email, so this can't be used to relay reports (or spam) to arbitrary people.
router.post("/outputs/email", requireAuth, async (req: Request, res: Response) => {
  const body = req.body || {};
  const fname = path.basename(String(body.file || "").trim());
  if (!/^[\w. \-]+\.html$/i.test(fname)) return res.status(400).json({ error: "Invalid report file" });
  const view = body.view === "restricted" ? "restricted" : "client";
  const to = String(body.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Enter a valid email address" });

  try {
    const isAdmin = req.user?.role === "admin";
    if (view === "restricted" && !isAdmin) return res.status(403).json({ error: "Only admins can email the full report" });
    if (!isAdmin) {
      const [me] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.username, req.user?.username ?? ""));
      if (!me?.email || me.email.toLowerCase() !== to.toLowerCase())
        return res.status(403).json({ error: "You can only email a report to your own account address" });
    }

    const html = await loadReportHtml(fname);
    if (html == null) return res.status(404).json({ error: "Report not found" });
    // Benchmark / snapshot dashboards are already client-facing: one file for both views.
    const attachment =
      view === "client" && reportTypeOfHtml(html) === "full"
        ? { filename: fname.replace(/\.html$/i, "-client.html"), content: toClientView(html) }
        : { filename: fname, content: html };
    const ok = await sendReportFileEmail(to, { htmlName: fname, view, attachment, sentBy: req.user?.username });
    if (!ok) return res.status(502).json({ error: "Email could not be sent — check RESEND_API_KEY / EMAIL_FROM on the server" });
    return res.json({ status: "ok", to, file: attachment.filename });
  } catch (e) {
    console.error("Email report failed:", e);
    return res.status(500).json({ error: "Email failed" });
  }
});

// ── GET /outputs/orgs?file= — organisations in a stored full report ────────
router.get("/outputs/orgs", requireAuth, async (req: Request, res: Response) => {
  const fname = path.basename(String(req.query.file || "").trim());
  if (!/^[\w. \-]+\.html$/i.test(fname)) return res.status(400).json({ error: "Invalid report file" });
  try {
    if (reportTypeOfName(fname) !== "full") return res.status(400).json({ error: "Only a full report has a cohort to choose from." });
    const html = await loadReportHtml(fname);
    if (html == null) return res.status(404).json({ error: "Report not found" });
    if (reportTypeOfHtml(html) !== "full") return res.status(400).json({ error: "Only a full report has a cohort to choose from." });
    return res.json({ orgs: listReportOrgs(html) });
  } catch (e) {
    console.error("List report orgs failed:", e);
    return res.status(422).json({ error: "This report's format could not be read." });
  }
});

// ── POST /outputs/derive — benchmark / snapshot from a stored full report ───
// Free: reads the report already on file, makes no API calls. The new file is
// stored next to the full report and appears in the list like any other.
router.post("/outputs/derive", requireAuth, async (req: Request, res: Response) => {
  const body = req.body || {};
  const fname = path.basename(String(body.file || "").trim());
  if (!/^[\w. \-]+\.html$/i.test(fname)) return res.status(400).json({ error: "Invalid report file" });
  const type = parseReportType(body.type);
  if (!type || type === "full") return res.status(400).json({ error: "type must be benchmark or snapshot." });
  const org = String(body.org || "").trim();
  if (!org) return res.status(400).json({ error: "Choose an organisation." });

  try {
    const html = await loadReportHtml(fname);
    if (html == null) return res.status(404).json({ error: "Report not found" });
    const derived = deriveReport(html, type, org);
    fs.writeFileSync(path.join(OUT_DIR, derived.htmlName), derived.html);
    const priceInr = priceForType(type);
    await persistReportToGithub(derived.htmlName, undefined, () => {}, priceInr);
    return res.json({ status: "ok", htmlName: derived.htmlName, type, org: derived.org, priceInr });
  } catch (e) {
    return res.status(422).json({ error: (e as Error).message || "Could not build the report" });
  }
});

// ── GET /trends — per-org SoV history for the Trends tab ─────────────────────
// One JSON file per report, uploaded alongside its HTML (see
// persistReportToGithub). Listing the directory + fetching each file is a
// GitHub API call per report — fine at today's volume, so it's kept simple
// with a short cache rather than a second manifest to keep in sync.
let trendsCache: { at: number; reports: ReportTrendSummary[] } | null = null;
const TRENDS_CACHE_MS = 60_000;

router.get("/trends", requireAuth, async (_req: Request, res: Response) => {
  try {
    if (trendsCache && Date.now() - trendsCache.at < TRENDS_CACHE_MS) {
      return res.json({ reports: trendsCache.reports });
    }

    const names = await listReportDataFiles();
    const parsed = await Promise.all(
      names.map(async (name) => {
        const raw = await getReportContent(name);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as ReportTrendSummary;
        } catch {
          return null;
        }
      }),
    );
    const reports = parsed
      .filter((r): r is ReportTrendSummary => r != null)
      .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));

    trendsCache = { at: Date.now(), reports };
    return res.json({ reports });
  } catch {
    return res.json({ reports: [] });
  }
});

export default router;

import path from "node:path";
import fs from "node:fs";
import { db, reportLogsTable } from "@workspace/db";
import { calculateClientBilling } from "./auth.js";
import { run, type RunConfig, type ReportTrendSummary } from "../pipeline/index.js";
import { sendAdminReportEmail, sendClientReportEmail } from "./mailer.js";
import { uploadReport, uploadReportData, getReportContent, isConfigured as isGithubStorageConfigured } from "./report-storage.js";
import { toClientView } from "./client-view.js";
import { deriveReport, priceForType, reportTypeOfName, type ReportType } from "./report-types.js";

// Shared by both trigger paths: a manual POST /run (routes/pipeline.ts,
// streams progress over SSE) and the weekly scheduler (report-scheduler.ts,
// runs unattended). Everything from "the pipeline finished" onward — moving
// the file to GitHub storage, emailing the admin + client, logging the run —
// used to live only in the SSE route and would otherwise have to be
// duplicated for scheduled runs.

const ALERT_TO = "+918588098882";
const OUT_DIR = path.join(process.cwd(), "outputs");

async function sendReportSms(costInr: number, orgs: string[], htmlName: string) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { ReplitConnectors } = (await import("@replit/connectors-sdk")) as any;
    const connectors = new ReplitConnectors();

    const accountsRes = await connectors.proxy("twilio", "/2010-04-01/Accounts.json", { method: "GET" });
    const accountsData = (await accountsRes.json()) as { accounts?: { sid: string }[] };
    const sid = accountsData.accounts?.[0]?.sid;
    if (!sid) { console.warn("[SMS] Could not resolve Twilio account SID"); return; }

    const numsRes = await connectors.proxy("twilio", `/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, { method: "GET" });
    const numsData = (await numsRes.json()) as { incoming_phone_numbers?: { phone_number: string }[] };
    const from = numsData.incoming_phone_numbers?.[0]?.phone_number;
    if (!from) { console.warn("[SMS] No From number on Twilio account"); return; }

    const body = new URLSearchParams({
      To: ALERT_TO,
      From: from,
      Body: `Emerald AI ✓ Report ready\nOrgs: ${orgs.slice(0, 3).join(", ")}${orgs.length > 3 ? ` +${orgs.length - 3} more` : ""}\nFile: ${htmlName}\nCost: ₹${costInr.toFixed(2)}`,
    });

    const smsRes = await connectors.proxy("twilio", `/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      body: body.toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const smsData = (await smsRes.json()) as { sid?: string; error_message?: string };
    if (smsData.sid) {
      console.log(`[SMS] Sent — SID ${smsData.sid}`);
    } else {
      console.warn("[SMS] Send failed:", smsData.error_message);
    }
  } catch (e) {
    console.warn("[SMS] Skipped (connector not configured):", (e as Error).message);
  }
}

// Move a just-generated report off local disk and into GitHub storage. Local
// disk is a write-through cache here: run() already wrote the file, this
// uploads it and only deletes the local copy once the upload actually
// succeeded — an upload hiccup leaves the report on disk (still servable,
// still listed) rather than losing a report that real API money paid for.
// Also uploads the report's small trend-data JSON (same base name) if run()
// produced one — that's what the Trends tab reads. No-op if
// GITHUB_REPORTS_TOKEN isn't set.
export async function persistReportToGithub(
  htmlName: string,
  trendSummary: ReportTrendSummary | undefined,
  cb: (msg: string, level?: string) => void,
  priceInr?: number,
): Promise<void> {
  if (!isGithubStorageConfigured()) return;
  const fpath = path.join(OUT_DIR, htmlName);
  let content: string;
  try {
    content = fs.readFileSync(fpath, "utf8");
  } catch {
    return;
  }
  const ok = await uploadReport(htmlName, content, priceInr);
  if (!ok) {
    cb(`  GitHub upload failed — report stays on local disk for now`, "warn");
    return;
  }
  fs.rmSync(fpath, { force: true });
  cb(`  Moved to GitHub storage — freed ${Math.round(content.length / 1024)}KB of local disk`, "ok");

  if (trendSummary) {
    const dataName = htmlName.replace(/\.html$/i, ".json");
    const dataOk = await uploadReportData(dataName, trendSummary);
    cb(
      dataOk ? `  Trend data saved (${dataName})` : `  Trend data upload failed for ${dataName}`,
      dataOk ? "ok" : "warn",
    );
  }
}

export interface GenerateReportParams {
  cfg: RunConfig;
  cb: (msg: string, level?: string) => void;
  /** Username to record as reportLogsTable.generatedBy. */
  generatedByUsername?: string | null;
  /** Client-facing recipient for sendClientReportEmail — resolved by the caller. */
  recipientEmail?: string | null;
  /** "full" (default) keeps the pipeline's multi-org report; "benchmark" / "snapshot" replace it with that view for `subjectOrg`. */
  reportType?: ReportType;
  subjectOrg?: string | null;
}

// A report's HTML from local disk (samples / mid-upload) or GitHub storage.
export async function loadReportHtml(htmlName: string): Promise<string | null> {
  const name = path.basename(htmlName);
  const fpath = path.join(OUT_DIR, name);
  if (fs.existsSync(fpath)) return fs.readFileSync(fpath, "utf8");
  return getReportContent(name);
}

export interface GenerateReportResult {
  htmlName: string;
  costInr: number;
}

export async function generateAndDeliverReport(params: GenerateReportParams): Promise<GenerateReportResult> {
  const { cfg, cb, generatedByUsername = null, recipientEmail = null, reportType = "full", subjectOrg = null } = params;

  const result = await run(cfg, cb);

  // Benchmark / snapshot: the pipeline always analyses the whole cohort (the
  // field averages need it), then only the chosen view is kept. Derivation is
  // free. If it fails after the paid run, keep the full report rather than
  // lose it.
  if (reportType !== "full" && subjectOrg && result.htmlName) {
    const fullPath = path.join(OUT_DIR, result.htmlName);
    try {
      const derived = deriveReport(fs.readFileSync(fullPath, "utf8"), reportType, subjectOrg);
      fs.writeFileSync(path.join(OUT_DIR, derived.htmlName), derived.html);
      fs.rmSync(fullPath, { force: true });
      cb(`  ${reportType === "snapshot" ? "Snapshot" : "Benchmark report"} for ${derived.org} → ${derived.htmlName}`, "ok");
      result.htmlName = derived.htmlName;
    } catch (e) {
      cb(`  Could not build the ${reportType} for ${subjectOrg} (${(e as Error).message}) — keeping the full report`, "warn");
    }
  }

  // Client billing: random ₹52–53 per org per month, this report.
  // A benchmark / snapshot is priced per report; a full report per org-month.
  const producedType = reportTypeOfName(result.htmlName ?? "");
  const priceInr = producedType === "full" ? undefined : priceForType(producedType);
  const billing =
    priceInr !== undefined
      ? { costInr: priceInr, perOrgMonthInr: priceInr, numOrgs: 1, months: 1 }
      : calculateClientBilling(cfg.ORGS, cfg.DATE_FROM, cfg.DATE_TO);
  // Real API cost of producing the report (from the pipeline's usage counters).
  const apiCost = result.cost;
  const apiCostInr = apiCost?.totalINR ?? 0;

  await persistReportToGithub(result.htmlName, result.trendSummary, cb, priceInr);

  // ── Cost emails ────────────────────────────────────────────────────────
  // The admin always receives the real-API-cost + client-cost email; the
  // resolved recipient (if any) gets the client-facing cost email.
  (async () => {
    // Admin gets the full report, the client gets the Client View. A failed
    // fetch just means the emails go out without the attachment.
    const fullHtml = result.htmlName ? await loadReportHtml(result.htmlName).catch(() => null) : null;
    const derivedType = reportTypeOfName(result.htmlName ?? "");
    const attachmentFor = (view: "client" | "restricted") =>
      fullHtml && result.htmlName
        ? {
            // A benchmark / snapshot is the same file for both audiences.
            filename: view === "client" && derivedType === "full" ? result.htmlName.replace(/\.html$/i, "-client.html") : result.htmlName,
            content: view === "client" ? toClientView(fullHtml) : fullHtml,
          }
        : undefined;
    const emailCtx = {
      orgs: cfg.ORGS,
      dateFrom: cfg.DATE_FROM,
      dateTo: cfg.DATE_TO,
      htmlName: result.htmlName ?? "",
      clientName: cfg.CLIENT_NAME,
      billing,
    };
    await sendAdminReportEmail({ ...emailCtx, attachment: attachmentFor("restricted"), apiCost, generatedByEmail: recipientEmail });
    if (recipientEmail) await sendClientReportEmail(recipientEmail, { ...emailCtx, attachment: attachmentFor("client") });
  })().catch((e: unknown) => console.error("Report email dispatch failed:", e));

  sendReportSms(billing.costInr, cfg.ORGS, result.htmlName ?? "").catch(() => {});

  db.insert(reportLogsTable).values({
    organizations: cfg.ORGS,
    dateFrom: cfg.DATE_FROM,
    dateTo: cfg.DATE_TO,
    htmlName: result.htmlName ?? null,
    clientName: cfg.CLIENT_NAME,
    generatedBy: generatedByUsername,
    costInr: billing.costInr.toFixed(2),
    perOrgMonthInr: billing.perOrgMonthInr.toFixed(2),
    apiCostInr: apiCostInr.toFixed(2),
    // Per-service real cost (INR) mapped onto the existing columns for the
    // admin dashboard. usdToInr defaults to 84 when the pipeline didn't
    // return a breakdown (older run path).
    costClaudeInr: (((apiCost?.linesUSD.claude ?? 0) + (apiCost?.linesUSD.claudeAeo ?? 0)) * (apiCost?.usdToInr ?? 84)).toFixed(2),
    costSerperInr: ((apiCost?.linesUSD.serper ?? 0) * (apiCost?.usdToInr ?? 84)).toFixed(2),
    costLlmAeoInr: (((apiCost?.linesUSD.perplexity ?? 0) + (apiCost?.linesUSD.openai ?? 0) + (apiCost?.linesUSD.gemini ?? 0)) * (apiCost?.usdToInr ?? 84)).toFixed(2),
    costYoutubeInr: ((apiCost?.linesUSD.youtube ?? 0) * (apiCost?.usdToInr ?? 84)).toFixed(2),
    costStorageInr: ((apiCost?.linesUSD.firecrawl ?? 0) * (apiCost?.usdToInr ?? 84)).toFixed(2),
    costDeploymentInr: ((apiCost?.linesUSD.apidirect ?? 0) * (apiCost?.usdToInr ?? 84)).toFixed(2),
  }).catch((e: unknown) => console.error("Failed to log report:", e));

  return { htmlName: result.htmlName, costInr: billing.costInr };
}

export { OUT_DIR };

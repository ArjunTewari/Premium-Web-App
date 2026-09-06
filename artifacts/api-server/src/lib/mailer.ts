import nodemailer from "nodemailer";
import { logger } from "./logger.js";
import type { ClientBilling } from "./auth.js";
import type { ReportApiCost } from "../pipeline/index.js";

// Admin recipient for the internal cost email (hardcoded per product owner).
const ADMIN_EMAIL = "arjuntewari0505@gmail.com";

const rupee = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let transport: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter | null {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!user || !pass) {
    logger.warn("EMAIL_USER / EMAIL_PASS not set — report emails are disabled");
    return null;
  }
  if (!transport) {
    transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user, pass },
    });
  }
  return transport;
}

async function send(opts: { to: string; subject: string; text: string; html: string }) {
  const t = getTransport();
  if (!t) return;
  const from = `"Emerald AI" <${process.env.EMAIL_USER}>`;
  try {
    const info = await t.sendMail({ from, ...opts });
    logger.info({ to: opts.to, messageId: info.messageId }, "Report email sent");
  } catch (err) {
    logger.warn({ err, to: opts.to }, "Report email failed");
  }
}

export interface ReportEmailContext {
  orgs: string[];
  dateFrom: string;
  dateTo: string;
  htmlName: string;
  clientName?: string;
  billing: ClientBilling;
}

// ── Client email — what the client is billed ────────────────────────────────
export async function sendClientReportEmail(to: string, ctx: ReportEmailContext): Promise<void> {
  const { orgs, dateFrom, dateTo, billing } = ctx;
  const period = `${dateFrom} to ${dateTo}`;
  const orgList = orgs.join(", ");

  const text = [
    `Emerald AI — your report is ready`,
    ``,
    `Organisations : ${orgList}`,
    `Report period : ${period}  (${billing.months} month${billing.months !== 1 ? "s" : ""})`,
    `File          : ${ctx.htmlName}`,
    ``,
    `── Billing ─────────────────────────────────────────`,
    `  ${billing.numOrgs} org${billing.numOrgs !== 1 ? "s" : ""} × ${billing.months} month${billing.months !== 1 ? "s" : ""} × ${rupee(billing.perOrgMonthInr)} per org / month`,
    `  Amount due : ${rupee(billing.costInr)}`,
  ].join("\n");

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#1a2232">
  <div style="background:#0f1923;padding:18px 22px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;color:#c9922a;font-size:17px">Emerald AI — Report Ready</h2>
  </div>
  <div style="border:1px solid #dde3ef;border-top:none;padding:22px;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:14px">
      <tr><td style="padding:5px 0;color:#5a6a80;width:130px">Organisations</td><td style="padding:5px 0;font-weight:600">${esc(orgList)}</td></tr>
      <tr><td style="padding:5px 0;color:#5a6a80">Report period</td><td style="padding:5px 0">${esc(period)} (${billing.months} month${billing.months !== 1 ? "s" : ""})</td></tr>
      <tr><td style="padding:5px 0;color:#5a6a80">File</td><td style="padding:5px 0">${esc(ctx.htmlName)}</td></tr>
    </table>
    <div style="background:#f0f7f2;border:1px solid #b6d9c4;border-radius:6px;padding:14px 16px">
      <div style="font-size:12px;font-weight:700;color:#1a5c30;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Billing Summary</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 0;color:#3a6a50">Organisations</td><td style="padding:4px 0;text-align:right;font-weight:600">${billing.numOrgs}</td></tr>
        <tr><td style="padding:4px 0;color:#3a6a50">Months</td><td style="padding:4px 0;text-align:right;font-weight:600">${billing.months}</td></tr>
        <tr><td style="padding:4px 0;color:#3a6a50">Rate</td><td style="padding:4px 0;text-align:right">${rupee(billing.perOrgMonthInr)} / org / month</td></tr>
        <tr style="border-top:1px solid #b6d9c4">
          <td style="padding:7px 0;font-weight:700">Amount due</td>
          <td style="padding:7px 0;text-align:right;font-weight:700;font-size:16px;color:#1a5c30">${rupee(billing.costInr)}</td>
        </tr>
      </table>
    </div>
  </div>
</div>`;

  await send({
    to,
    subject: `Emerald AI — report ready (${orgs.length} org${orgs.length !== 1 ? "s" : ""}, ${rupee(billing.costInr)})`,
    text,
    html,
  });
}

// ── Admin email — real API cost + client billing ────────────────────────────
export async function sendAdminReportEmail(
  ctx: ReportEmailContext & { apiCost?: ReportApiCost; generatedByEmail?: string | null },
): Promise<void> {
  const { orgs, dateFrom, dateTo, billing, apiCost } = ctx;
  const period = `${dateFrom} to ${dateTo}`;
  const orgList = orgs.join(", ");

  const svc: Array<[string, number, number]> = apiCost
    ? [
        ["Claude (classify/summary)", apiCost.counts.claudeInputTokens + apiCost.counts.claudeOutputTokens, apiCost.linesUSD.claude],
        ["Claude (AEO probes)", apiCost.counts.claudeAeoCalls, apiCost.linesUSD.claudeAeo],
        ["Firecrawl searches", apiCost.counts.firecrawlSearches, apiCost.linesUSD.firecrawl],
        ["Serper queries", apiCost.counts.serperQueries, apiCost.linesUSD.serper],
        ["APIdirect calls", apiCost.counts.apidirectCalls, apiCost.linesUSD.apidirect],
        ["Perplexity queries", apiCost.counts.perplexityCalls, apiCost.linesUSD.perplexity],
        ["OpenAI queries", apiCost.counts.openaiCalls, apiCost.linesUSD.openai],
        ["Gemini queries", apiCost.counts.geminiCalls, apiCost.linesUSD.gemini],
        ["YouTube API calls", apiCost.counts.youtubeApiCalls, apiCost.linesUSD.youtube],
      ]
    : [];

  const apiTotalUsd = apiCost?.totalUSD ?? 0;
  const apiTotalInr = apiCost?.totalINR ?? 0;
  const marginInr = Math.round((billing.costInr - apiTotalInr) * 100) / 100;

  const textRows = svc
    .map(([label, calls, usd]) => `  ${label.padEnd(28)} ${String(calls).padStart(7)}   $${usd.toFixed(4)}`)
    .join("\n");

  const text = [
    `Emerald AI — report generated`,
    ``,
    `Organisations : ${orgList}`,
    `Report period : ${period}  (${billing.months} month${billing.months !== 1 ? "s" : ""})`,
    `File          : ${ctx.htmlName}`,
    `Generated by  : ${ctx.generatedByEmail || "—"}`,
    ``,
    `── Real API cost ───────────────────────────────────`,
    `  Service                        Calls        Cost`,
    textRows || "  (no usage recorded)",
    `  ─────────────────────────────────────────────────`,
    `  Total API cost               $${apiTotalUsd.toFixed(4)}  ≈ ${rupee(apiTotalInr)}   (@ ${apiCost?.usdToInr ?? 84} INR/USD)`,
    ``,
    `── Client billing ─────────────────────────────────`,
    `  ${billing.numOrgs} org${billing.numOrgs !== 1 ? "s" : ""} × ${billing.months} month${billing.months !== 1 ? "s" : ""} × ${rupee(billing.perOrgMonthInr)}`,
    `  Client charged : ${rupee(billing.costInr)}`,
    `  Gross margin   : ${rupee(marginInr)}`,
  ].join("\n");

  const rows = svc
    .map(
      ([label, calls, usd]) =>
        `<tr><td style="padding:4px 8px;color:#5a6a80">${esc(label)}</td><td style="padding:4px 8px;text-align:center">${calls}</td><td style="padding:4px 8px;text-align:right;font-weight:600">$${usd.toFixed(4)}</td></tr>`,
    )
    .join("");

  const html = `
<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;color:#1a2232">
  <div style="background:#0f1923;padding:18px 22px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;color:#7ecfb3;font-size:17px">Emerald AI — Report Generated</h2>
  </div>
  <div style="border:1px solid #dde3ef;border-top:none;padding:22px;border-radius:0 0 8px 8px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:14px">
      <tr><td style="padding:5px 0;color:#5a6a80;width:130px">Organisations</td><td style="padding:5px 0;font-weight:600">${esc(orgList)}</td></tr>
      <tr><td style="padding:5px 0;color:#5a6a80">Period</td><td style="padding:5px 0">${esc(period)} (${billing.months} month${billing.months !== 1 ? "s" : ""})</td></tr>
      <tr><td style="padding:5px 0;color:#5a6a80">File</td><td style="padding:5px 0">${esc(ctx.htmlName)}</td></tr>
      <tr><td style="padding:5px 0;color:#5a6a80">Generated by</td><td style="padding:5px 0">${esc(ctx.generatedByEmail || "—")}</td></tr>
    </table>

    <div style="background:#f4f7fb;border-radius:6px;padding:14px 16px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;color:#3a4a60;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Real API Cost</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid #dde3ef">
          <th style="padding:4px 8px;text-align:left;color:#5a6a80">Service</th>
          <th style="padding:4px 8px;text-align:center;color:#5a6a80">Calls / tokens</th>
          <th style="padding:4px 8px;text-align:right;color:#5a6a80">Cost (USD)</th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="3" style="padding:6px 8px;color:#8a9aaa">No usage recorded</td></tr>`}</tbody>
        <tfoot><tr style="border-top:2px solid #dde3ef">
          <td colspan="2" style="padding:6px 8px;font-weight:700">Total API cost</td>
          <td style="padding:6px 8px;text-align:right;font-weight:700;color:#2a6a3a">$${apiTotalUsd.toFixed(4)} ≈ ${rupee(apiTotalInr)}</td>
        </tr></tfoot>
      </table>
      <div style="margin-top:8px;font-size:11px;color:#8a9aaa">Claude &amp; Serper are metered exactly; other services are counted per call at published unit rates. @ ${apiCost?.usdToInr ?? 84} INR/USD.</div>
    </div>

    <div style="background:#f0f7f2;border:1px solid #b6d9c4;border-radius:6px;padding:14px 16px">
      <div style="font-size:12px;font-weight:700;color:#1a5c30;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Client Billing</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 0;color:#3a6a50">${billing.numOrgs} org${billing.numOrgs !== 1 ? "s" : ""} × ${billing.months} month${billing.months !== 1 ? "s" : ""} × ${rupee(billing.perOrgMonthInr)}</td><td style="padding:4px 0;text-align:right;font-weight:600">${rupee(billing.costInr)}</td></tr>
        <tr style="border-top:1px solid #b6d9c4"><td style="padding:7px 0;font-weight:700">Gross margin (client − API)</td><td style="padding:7px 0;text-align:right;font-weight:700;font-size:16px;color:${marginInr >= 0 ? "#1a5c30" : "#b23a3a"}">${rupee(marginInr)}</td></tr>
      </table>
    </div>
  </div>
</div>`;

  await send({
    to: ADMIN_EMAIL,
    subject: `Emerald AI — report generated · API ${rupee(apiTotalInr)} · client ${rupee(billing.costInr)}`,
    text,
    html,
  });
}

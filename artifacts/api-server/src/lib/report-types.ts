// @ts-ignore — CommonJS module, same interop as ../pipeline/index.ts
import _dashboard from "../pipeline/single-org-dashboard.js";
import raahgiriProfile from "../pipeline/single-org-profiles/raahgiri.json";

// Report types. "full" is the multi-organisation report the pipeline writes.
// "benchmark" and "snapshot" are one-organisation views derived from a full
// report: the subject is named, every other organisation is shown only as a
// field average + low–high range. A snapshot is the benchmark's first
// scorecard section on its own.
//
// Deriving is deterministic string/number work on a report that already exists
// — no API calls, no fetches, no cost — so it is safe to offer on any stored
// full report.

export type ReportType = "full" | "benchmark" | "snapshot";
export type DerivedReportType = Exclude<ReportType, "full">;

export const REPORT_TYPES: readonly ReportType[] = ["full", "benchmark", "snapshot"];

// What the client is shown for a derived report: a value drawn from these
// ranges (rupees) when the report is created, in the same spirit as the
// per-org monthly rate in auth.ts. Full reports keep the existing billing.
export const DERIVED_PRICE_RANGE_INR: Record<DerivedReportType, [number, number]> = {
  snapshot: [40, 45],
  benchmark: [90, 100],
};

export function priceForType(type: DerivedReportType): number {
  const [lo, hi] = DERIVED_PRICE_RANGE_INR[type];
  return Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
}

export function parseReportType(v: unknown): ReportType | null {
  if (v == null || v === "") return "full";
  const s = String(v).toLowerCase();
  return (REPORT_TYPES as readonly string[]).includes(s) ? (s as ReportType) : null;
}

// Derived reports are stored as aq-benchmark-<org>-<from>-to-<to>.html /
// aq-snapshot-…; full reports keep the pipeline's aq-report-… name.
const DERIVED_NAME = /^aq-(benchmark|snapshot)-/i;

export function reportTypeOfName(htmlName: string): ReportType {
  const m = DERIVED_NAME.exec(htmlName);
  return m ? (m[1].toLowerCase() as DerivedReportType) : "full";
}

// A derived report carries <meta name="emerald-report-type"> — the check the
// Client View / email paths use so they never re-strip a one-org dashboard.
export function reportTypeOfHtml(html: string): ReportType {
  const m = /<meta name="emerald-report-type" content="(benchmark|snapshot)">/i.exec(html.slice(0, 4000));
  return m ? (m[1].toLowerCase() as DerivedReportType) : "full";
}

// Optional per-organisation profiles: subject-area suggestions that the
// generator renders as flagged INFERENCE blocks. Keyed by lower-cased name as
// it appears in the source report. Orgs without a profile get none.
const PROFILES: Record<string, Record<string, unknown>> = {
  raahgiri: raahgiriProfile as Record<string, unknown>,
};

interface Dashboard {
  buildSingleOrgDashboard(
    baseHtml: string,
    opts: { org: string; view?: DerivedReportType; profile?: Record<string, unknown> },
  ): string;
  listOrgs(baseHtml: string): string[];
  parseBaseReport(baseHtml: string): { meta: { from: string; to: string }; orgs: string[] };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dash = ((_dashboard as any).buildSingleOrgDashboard ? _dashboard : (_dashboard as any).default) as Dashboard;

/** Organisations in a full report, in the report's own order. */
export function listReportOrgs(fullHtml: string): string[] {
  return dash.listOrgs(fullHtml);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export interface DerivedReport {
  html: string;
  htmlName: string;
  org: string;
}

/**
 * Build a benchmark / snapshot for `org` from a full report's HTML.
 * Throws (with a message safe to show the user) when the org isn't in the
 * report or the input isn't a full multi-org report.
 */
export function deriveReport(fullHtml: string, type: DerivedReportType, org: string): DerivedReport {
  if (reportTypeOfHtml(fullHtml) !== "full") {
    throw new Error("A benchmark or snapshot can only be made from a full report.");
  }
  const base = dash.parseBaseReport(fullHtml);
  const want = org.trim().toLowerCase();
  const subject = base.orgs.find((o) => o.toLowerCase() === want);
  if (!subject) throw new Error(`"${org}" is not one of the organisations in this report.`);

  const html = dash.buildSingleOrgDashboard(fullHtml, {
    org: subject,
    view: type,
    profile: PROFILES[subject.toLowerCase()],
  });
  const htmlName = `aq-${type}-${slug(subject)}-${base.meta.from}-to-${base.meta.to}.html`;
  return { html, htmlName, org: subject };
}

// Report types and the Reports-tab filters (type, month generated, sort order).
// Pure functions, no React — kept out of home.tsx so they can be tested alone.

export type ReportType = "full" | "benchmark" | "snapshot";

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  full: "Full report",
  benchmark: "Benchmark report",
  snapshot: "Snapshot",
};

export const REPORT_TYPE_HINTS: Record<ReportType, string> = {
  full: "Every organisation, all sections.",
  benchmark: "One organisation measured against the field — all sections.",
  snapshot: "One organisation's scorecard only (the benchmark's first section).",
};

// Benchmark / snapshot files are stored as aq-benchmark-… / aq-snapshot-…;
// full reports keep the pipeline's aq-report-… name.
export function reportTypeOfName(name: string): ReportType {
  const m = /^aq-(benchmark|snapshot)-/i.exec(name);
  return m ? (m[1].toLowerCase() as ReportType) : "full";
}

export type ReportsSort = "newest" | "oldest";

export interface FilterableReport {
  name: string;
  /** "YYYY-MM-DDTHH:mm", UTC — the format /api/outputs returns. */
  mtime: string;
}

export interface ReportFilters {
  type: "all" | ReportType;
  /** "all" or a "YYYY-MM" month key. */
  month: string;
  sort: ReportsSort;
}

export const DEFAULT_REPORT_FILTERS: ReportFilters = { type: "all", month: "all", sort: "newest" };

export function isDefaultFilters(f: ReportFilters): boolean {
  return f.type === DEFAULT_REPORT_FILTERS.type && f.month === DEFAULT_REPORT_FILTERS.month && f.sort === DEFAULT_REPORT_FILTERS.sort;
}

function generatedAt(mtime: string): Date | null {
  const d = new Date(`${mtime.length === 16 ? `${mtime}:00` : mtime}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM" of the month a report was generated, in the viewer's local time; "" if unknown. */
export function reportMonth(mtime: string): string {
  const d = generatedAt(mtime);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(key: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}` : key;
}

/** Filter, then order by generation time (newest or oldest first; name breaks ties). */
export function applyReportFilters<T extends FilterableReport>(files: T[], f: ReportFilters): T[] {
  const out = files.filter(
    (r) => (f.type === "all" || reportTypeOfName(r.name) === f.type) && (f.month === "all" || reportMonth(r.mtime) === f.month),
  );
  const t = (r: T) => generatedAt(r.mtime)?.getTime() ?? 0;
  const dir = f.sort === "oldest" ? 1 : -1;
  return out.sort((a, b) => dir * (t(a) - t(b)) || a.name.localeCompare(b.name));
}

/** Chip counts per type, for the reports in the selected month. */
export function typeCounts(files: FilterableReport[], month: string): Record<"all" | ReportType, number> {
  const counts = { all: 0, full: 0, benchmark: 0, snapshot: 0 };
  for (const r of files) {
    if (month !== "all" && reportMonth(r.mtime) !== month) continue;
    counts.all += 1;
    counts[reportTypeOfName(r.name)] += 1;
  }
  return counts;
}

/** Months that have reports (newest month first), with counts for the selected type. */
export function monthOptions(files: FilterableReport[], type: "all" | ReportType): { key: string; label: string; count: number }[] {
  const byMonth = new Map<string, number>();
  for (const r of files) {
    const k = reportMonth(r.mtime);
    if (!k) continue;
    if (!byMonth.has(k)) byMonth.set(k, 0);
    if (type === "all" || reportTypeOfName(r.name) === type) byMonth.set(k, (byMonth.get(k) ?? 0) + 1);
  }
  return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([key, count]) => ({ key, label: monthLabel(key), count }));
}

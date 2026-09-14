import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Curated sample reports live in the repo at
 * `artifacts/api-server/sample-reports/` and are copied into `<cwd>/outputs`
 * on every boot. The `/api/outputs` list is not user-scoped, so anything in
 * `outputs/` shows up in the Reports tab for every account — including a
 * freshly created one. Overwriting on each boot means an updated sample
 * propagates on redeploy.
 */
const SRC_DIR = path.join(process.cwd(), "artifacts", "api-server", "sample-reports");
const OUT_DIR = path.join(process.cwd(), "outputs");
// A fixed, old mtime so real generated reports always sort above the sample(s).
const SAMPLE_MTIME = new Date("2026-01-01T00:00:00Z");

// One-time cleanup: filenames the samples used before adopting the
// TMP-<period>-<orgs>orgs scheme (see pipeline.js). On a Railway deploy with
// a persistent volume at outputs/, a copy under the old name would otherwise
// survive this rename forever as a stale duplicate. Harmless no-op once
// removed — safe to delete this list later.
const LEGACY_SAMPLE_NAMES = [
  "emerald-sample-report.html",
  "emerald-sample-report-feb-may-2026.html",
];

export function seedSampleReports(): void {
  try {
    if (!fs.existsSync(SRC_DIR)) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const current = new Set(fs.readdirSync(SRC_DIR).map((f) => f.toLowerCase()));

    let n = 0;
    for (const f of fs.readdirSync(SRC_DIR)) {
      if (!f.toLowerCase().endsWith(".html")) continue;
      const dest = path.join(OUT_DIR, f);
      fs.copyFileSync(path.join(SRC_DIR, f), dest);
      try {
        fs.utimesSync(dest, SAMPLE_MTIME, SAMPLE_MTIME);
      } catch {
        /* mtime is cosmetic (controls list sort order) */
      }
      n++;
    }

    for (const legacy of LEGACY_SAMPLE_NAMES) {
      if (current.has(legacy.toLowerCase())) continue; // still a real sample name — leave it
      const stale = path.join(OUT_DIR, legacy);
      if (fs.existsSync(stale)) {
        fs.rmSync(stale, { force: true });
        logger.info({ file: legacy }, "Removed stale pre-rename sample report from outputs");
      }
    }

    if (n) logger.info({ count: n, OUT_DIR }, "Seeded sample report(s) into outputs");
  } catch (err) {
    logger.warn({ err }, "seedSampleReports failed (non-fatal)");
  }
}

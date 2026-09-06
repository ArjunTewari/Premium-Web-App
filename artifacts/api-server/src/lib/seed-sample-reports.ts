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

export function seedSampleReports(): void {
  try {
    if (!fs.existsSync(SRC_DIR)) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
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
    if (n) logger.info({ count: n, OUT_DIR }, "Seeded sample report(s) into outputs");
  } catch (err) {
    logger.warn({ err }, "seedSampleReports failed (non-fatal)");
  }
}

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { isConfigured, uploadReport } from "./report-storage.js";

// One-time-per-boot backfill: anything already sitting in outputs/ from
// before GitHub-backed storage existed (or left behind by a failed upload
// on a previous boot) gets pushed to the reports repo and removed locally,
// same as a normal successful generation does going forward. The curated
// sample reports (re-copied into outputs/ on every boot by
// seedSampleReports) are excluded — they're a fixed demo fixture, not
// user-generated data, and are meant to stay local.
const SRC_DIR = path.join(process.cwd(), "artifacts", "api-server", "sample-reports");
const OUT_DIR = path.join(process.cwd(), "outputs");

export async function migrateLocalReportsToGithub(): Promise<void> {
  if (!isConfigured()) return; // no GITHUB_REPORTS_TOKEN set — leave everything local
  try {
    if (!fs.existsSync(OUT_DIR)) return;

    const sampleNames = new Set(
      fs.existsSync(SRC_DIR) ? fs.readdirSync(SRC_DIR).map((f) => f.toLowerCase()) : [],
    );

    const candidates = fs
      .readdirSync(OUT_DIR)
      .filter((f) => f.toLowerCase().endsWith(".html") && !sampleNames.has(f.toLowerCase()));

    let migrated = 0;
    for (const name of candidates) {
      const fpath = path.join(OUT_DIR, name);
      let content: string;
      try {
        content = fs.readFileSync(fpath, "utf8");
      } catch {
        continue;
      }
      const ok = await uploadReport(name, content);
      if (ok) {
        fs.rmSync(fpath, { force: true });
        migrated++;
      } else {
        logger.warn({ name }, "Migrate-to-GitHub upload failed — left local, will retry next boot");
      }
    }

    if (migrated) logger.info({ count: migrated }, "Migrated existing local report(s) to GitHub storage");
  } catch (err) {
    logger.warn({ err }, "migrateLocalReportsToGithub failed (non-fatal)");
  }
}

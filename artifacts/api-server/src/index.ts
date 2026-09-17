import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/ensure-schema.js";
import { seedAdminIfNeeded } from "./lib/seed.js";
import { seedSampleReports } from "./lib/seed-sample-reports.js";
import { migrateLocalReportsToGithub } from "./lib/migrate-reports-to-github.js";
import { startReportScheduler } from "./lib/report-scheduler.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Bootstrap the database before accepting traffic: create tables on a fresh
// Postgres, then seed the admin user if configured. A failure here is fatal —
// the app cannot work without its schema.
try {
  await ensureSchema();
  await seedAdminIfNeeded();
} catch (err) {
  logger.error({ err }, "Startup database bootstrap failed");
  process.exit(1);
}

// Copy the curated sample report(s) into outputs/ so every account's Reports
// tab has one to open. Non-fatal — the app runs fine without it.
seedSampleReports();

// Push any previously-generated reports still sitting on local disk to
// GitHub storage and free the space. No-op if GITHUB_REPORTS_TOKEN isn't
// set. Runs in the background — doesn't delay accepting traffic.
migrateLocalReportsToGithub().catch((err) => logger.warn({ err }, "Report migration failed"));

// Weekly scheduled reports (Scheduler tab) — checks every few minutes and
// fires any due schedule. No-op if none exist.
startReportScheduler();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

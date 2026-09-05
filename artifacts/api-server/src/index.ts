import app from "./app";
import { logger } from "./lib/logger";
import { ensureSchema } from "./lib/ensure-schema.js";
import { seedAdminIfNeeded } from "./lib/seed.js";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

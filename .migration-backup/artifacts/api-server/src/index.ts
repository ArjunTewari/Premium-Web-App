import app from "./app";
import { logger } from "./lib/logger";

// Safety net: a stray unhandled rejection or an 'error' event on a dropped
// client socket (e.g. during a long-running SSE report generation) must not
// take down the whole server — that previously looked like report
// generation "getting stuck" for every subsequent request until a manual
// restart. Log and keep the process alive instead of crashing.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception (process kept alive)");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection (process kept alive)");
});

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Node 18+ defaults: requestTimeout=300000ms, headersTimeout=60000ms.
// Report generation for large org sets (13+ orgs) takes longer than 5 min —
// the request was being killed at exactly the 300s mark. Set both to 0
// (no timeout) since the SSE pipeline route already manages its own
// per-request and per-socket timeouts.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

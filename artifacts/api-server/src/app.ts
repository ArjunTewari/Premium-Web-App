import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { seedAdminIfNeeded } from "./lib/seed.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: IncomingMessage & { id?: unknown }) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── Static frontend (single-service deploy) ─────────────────────────────────
// When the built emerald-web bundle is present next to the repo (Railway builds
// it in the same step), this server also serves the SPA so the frontend and API
// share one origin — relative `/api/...` calls and `sameSite: "lax"` auth
// cookies keep working with zero frontend changes. If the bundle isn't there
// (api-only local dev), this block is skipped entirely.
const WEB_DIST =
  process.env.WEB_DIST ||
  path.join(process.cwd(), "artifacts", "emerald-web", "dist", "public");
const WEB_INDEX = path.join(WEB_DIST, "index.html");

if (fs.existsSync(WEB_INDEX)) {
  logger.info({ WEB_DIST }, "Serving static frontend");
  app.use(
    express.static(WEB_DIST, {
      // Hashed asset filenames — safe to cache hard. index.html stays uncached.
      setHeaders: (res, filePath) => {
        if (filePath === WEB_INDEX) res.setHeader("Cache-Control", "no-cache");
        else if (/[.-][0-9a-f]{8,}\.\w+$/i.test(filePath))
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );

  // SPA fallback: any non-/api GET that didn't match a static file returns the
  // app shell so client-side routing (wouter) can take over on deep links.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(WEB_INDEX);
  });
} else {
  logger.warn({ WEB_INDEX }, "No static frontend bundle found — serving API only");
}

seedAdminIfNeeded();

export default app;

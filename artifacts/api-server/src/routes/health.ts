import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // Which build is running — Railway sets the commit it deployed. Lets anyone check
  // at /api/healthz that a merge is actually live.
  const commit = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || undefined;
  res.json({ ...data, commit });
});

export default router;

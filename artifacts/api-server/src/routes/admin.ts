import { Router, type Request, type Response } from "express";
import { desc, sql } from "drizzle-orm";
import { db, reportLogsTable } from "@workspace/db";
import { requireAdmin } from "../middleware/require-auth.js";

const router = Router();

router.get("/admin/reports", requireAdmin, async (req: Request, res: Response) => {
  const page = Math.max(1, parseInt(String(req.query.page || "1")));
  const limit = Math.min(100, parseInt(String(req.query.limit || "50")));
  const offset = (page - 1) * limit;

  const [rows, countRow] = await Promise.all([
    db
      .select()
      .from(reportLogsTable)
      .orderBy(desc(reportLogsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(reportLogsTable),
  ]);

  return res.json({
    reports: rows,
    total: countRow[0]?.count ?? 0,
    page,
    limit,
  });
});

router.get("/admin/costs", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      month: sql<string>`to_char(created_at, 'YYYY-MM')`,
      count: sql<number>`count(*)::int`,
      totalCostInr: sql<number>`sum(cost_inr::numeric)::float`,
      totalSerper: sql<number>`sum(cost_serper_inr::numeric)::float`,
      totalLlmAeo: sql<number>`sum(cost_llm_aeo_inr::numeric)::float`,
      totalClaude: sql<number>`sum(cost_claude_inr::numeric)::float`,
      totalYoutube: sql<number>`sum(cost_youtube_inr::numeric)::float`,
      totalStorage: sql<number>`sum(cost_storage_inr::numeric)::float`,
      totalDeployment: sql<number>`sum(cost_deployment_inr::numeric)::float`,
    })
    .from(reportLogsTable)
    .groupBy(sql`to_char(created_at, 'YYYY-MM')`)
    .orderBy(sql`to_char(created_at, 'YYYY-MM') desc`);

  return res.json({ months: rows });
});

export default router;

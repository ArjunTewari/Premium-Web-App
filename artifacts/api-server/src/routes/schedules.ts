import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, reportSchedulesTable } from "@workspace/db";
import { requireAuth } from "../middleware/require-auth.js";

const router: IRouter = Router();

router.get("/schedules", requireAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await db.select().from(reportSchedulesTable).orderBy(reportSchedulesTable.id);
    res.json({ schedules: rows });
  } catch (e) {
    console.error("Failed to load schedules:", e);
    res.status(500).json({ error: "Failed to load schedules" });
  }
});

router.post("/schedules", requireAuth, async (req: Request, res: Response) => {
  const body = req.body || {};
  const orgs: string[] = Array.isArray(body.orgs) ? body.orgs.filter(Boolean) : [];
  if (!orgs.length) return res.status(400).json({ error: "Select at least one organisation" });

  const clientName = String(body.clientName || "").trim();
  if (!clientName) return res.status(400).json({ error: "Client name is required" });
  const label = String(body.label || clientName).trim();
  const scopeKeywords: string[] | null = Array.isArray(body.scopeKeywords)
    ? body.scopeKeywords.filter(Boolean)
    : null;
  const recipientEmail = typeof body.recipientEmail === "string" && body.recipientEmail.trim()
    ? body.recipientEmail.trim()
    : null;
  const runHourIst = Number.isInteger(body.runHourIst) && body.runHourIst >= 0 && body.runHourIst <= 23
    ? body.runHourIst
    : 5;
  const runMinuteIst = Number.isInteger(body.runMinuteIst) && body.runMinuteIst >= 0 && body.runMinuteIst <= 59
    ? body.runMinuteIst
    : 0;

  try {
    const [row] = await db
      .insert(reportSchedulesTable)
      .values({
        label,
        orgs,
        clientName,
        scopeKeywords,
        recipientEmail,
        runHourIst,
        runMinuteIst,
        active: true,
        createdBy: (req.user as { username?: string } | undefined)?.username ?? null,
      })
      .returning();
    return res.json({ schedule: row });
  } catch (e) {
    console.error("Failed to create schedule:", e);
    return res.status(500).json({ error: "Failed to create schedule" });
  }
});

router.put("/schedules/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id || ""), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid schedule id" });

  const body = req.body || {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {};
  if (Array.isArray(body.orgs) && body.orgs.length) patch.orgs = body.orgs.filter(Boolean);
  if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
  if (typeof body.clientName === "string" && body.clientName.trim()) patch.clientName = body.clientName.trim();
  if (Array.isArray(body.scopeKeywords)) patch.scopeKeywords = body.scopeKeywords.filter(Boolean);
  if (typeof body.recipientEmail === "string") patch.recipientEmail = body.recipientEmail.trim() || null;
  if (Number.isInteger(body.runHourIst) && body.runHourIst >= 0 && body.runHourIst <= 23) patch.runHourIst = body.runHourIst;
  if (Number.isInteger(body.runMinuteIst) && body.runMinuteIst >= 0 && body.runMinuteIst <= 59) patch.runMinuteIst = body.runMinuteIst;
  if (typeof body.active === "boolean") patch.active = body.active;

  if (!Object.keys(patch).length) return res.status(400).json({ error: "No valid fields to update" });

  try {
    const [row] = await db
      .update(reportSchedulesTable)
      .set(patch)
      .where(eq(reportSchedulesTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Schedule not found" });
    return res.json({ schedule: row });
  } catch (e) {
    console.error("Failed to update schedule:", e);
    return res.status(500).json({ error: "Failed to update schedule" });
  }
});

router.delete("/schedules/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id || ""), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid schedule id" });
  try {
    await db.delete(reportSchedulesTable).where(eq(reportSchedulesTable.id, id));
    return res.json({ status: "ok" });
  } catch (e) {
    console.error("Failed to delete schedule:", e);
    return res.status(500).json({ error: "Failed to delete schedule" });
  }
});

export default router;

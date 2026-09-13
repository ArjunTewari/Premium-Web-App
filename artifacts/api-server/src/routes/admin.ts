import { Router, type Request, type Response } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { desc, eq, sql } from "drizzle-orm";
import { db, reportLogsTable, usersTable } from "@workspace/db";
import { requireAdmin } from "../middleware/require-auth.js";
import { sendPasswordResetEmail } from "../lib/mailer.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Unambiguous charset (no 0/O, 1/I/l) — this gets read aloud or copy-pasted.
const TEMP_PW_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
function generateTempPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += TEMP_PW_ALPHABET[bytes[i] % TEMP_PW_ALPHABET.length];
  return out;
}

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

// ── User accounts ─────────────────────────────────────────────────────────

router.get("/admin/users", requireAdmin, async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      email: usersTable.email,
      role: usersTable.role,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.username);

  return res.json({ users: rows });
});

// Reset a user's password. There is no self-service "forgot password" flow —
// bcrypt hashes can't be reversed, so a lost password can only be replaced,
// never recovered — this route is that replacement path. It always returns
// the new password in the response (the admin's fallback if the account has
// no email on file, or the email send silently fails — mailer.ts logs but
// doesn't surface transport failures) and best-effort emails it too.
router.post("/admin/users/:username/reset-password", requireAdmin, async (req: Request, res: Response) => {
  const username = String(req.params.username || "").trim();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (!user) return res.status(404).json({ error: "User not found" });

  const newPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, user.id));

  let emailed = false;
  if (user.email) {
    try {
      await sendPasswordResetEmail(user.email, { username: user.username, newPassword });
      emailed = true;
    } catch (err) {
      logger.warn({ err, username }, "Password reset email failed to send");
    }
  }

  return res.json({ status: "ok", newPassword, email: user.email, emailed });
});

export default router;

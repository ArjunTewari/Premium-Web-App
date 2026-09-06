import { Router, type IRouter, type Request, type Response } from "express";
import { asc, eq } from "drizzle-orm";
import { db, orgHandlesTable } from "@workspace/db";
import { requireAuth } from "../middleware/require-auth.js";

const router: IRouter = Router();

const PLATFORMS = ["linkedin", "twitter", "instagram", "youtube"] as const;
type Platform = (typeof PLATFORMS)[number];

function cleanHandles(src: unknown): Partial<Record<Platform, string>> {
  const out: Partial<Record<Platform, string>> = {};
  if (src && typeof src === "object") {
    for (const p of PLATFORMS) {
      const v = (src as Record<string, unknown>)[p];
      if (typeof v === "string") out[p] = v.trim();
    }
  }
  return out;
}

// ── GET /api/handles — the whole shared list, newest source of truth ─────────
router.get("/handles", requireAuth, async (_req: Request, res: Response) => {
  const rows = await db.select().from(orgHandlesTable).orderBy(asc(orgHandlesTable.org));
  return void res.json(rows);
});

// ── PUT /api/handles/:org — upsert one org's handles (any signed-in user) ────
router.put("/handles/:org", requireAuth, async (req: Request, res: Response) => {
  const org = String(req.params.org || "").trim();
  if (!org) return res.status(400).json({ error: "Org name required" });

  const h = cleanHandles(req.body);
  const by = (req.user as { username?: string } | undefined)?.username ?? null;
  const now = new Date();

  const [row] = await db
    .insert(orgHandlesTable)
    .values({
      org,
      linkedin: h.linkedin ?? "",
      twitter: h.twitter ?? "",
      instagram: h.instagram ?? "",
      youtube: h.youtube ?? "",
      updatedAt: now,
      updatedBy: by,
    })
    .onConflictDoUpdate({
      target: orgHandlesTable.org,
      // Only overwrite the platforms the caller actually sent.
      set: {
        ...(h.linkedin !== undefined ? { linkedin: h.linkedin } : {}),
        ...(h.twitter !== undefined ? { twitter: h.twitter } : {}),
        ...(h.instagram !== undefined ? { instagram: h.instagram } : {}),
        ...(h.youtube !== undefined ? { youtube: h.youtube } : {}),
        updatedAt: now,
        updatedBy: by,
      },
    })
    .returning();

  return void res.json(row);
});

// ── PUT /api/handles — bulk upsert from a { org: {handles} } map ─────────────
router.put("/handles", requireAuth, async (req: Request, res: Response) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return res.status(400).json({ error: "Expected an object mapping org name → handles" });

  const by = (req.user as { username?: string } | undefined)?.username ?? null;
  const now = new Date();
  const entries = Object.entries(body as Record<string, unknown>)
    .map(([org, h]) => [org.trim(), cleanHandles(h)] as const)
    .filter(([org]) => org.length > 0);

  for (const [org, h] of entries) {
    await db
      .insert(orgHandlesTable)
      .values({
        org,
        linkedin: h.linkedin ?? "",
        twitter: h.twitter ?? "",
        instagram: h.instagram ?? "",
        youtube: h.youtube ?? "",
        updatedAt: now,
        updatedBy: by,
      })
      .onConflictDoUpdate({
        target: orgHandlesTable.org,
        set: {
          ...(h.linkedin !== undefined ? { linkedin: h.linkedin } : {}),
          ...(h.twitter !== undefined ? { twitter: h.twitter } : {}),
          ...(h.instagram !== undefined ? { instagram: h.instagram } : {}),
          ...(h.youtube !== undefined ? { youtube: h.youtube } : {}),
          updatedAt: now,
          updatedBy: by,
        },
      });
  }

  const rows = await db.select().from(orgHandlesTable).orderBy(asc(orgHandlesTable.org));
  return void res.json(rows);
});

// ── DELETE /api/handles/:org ────────────────────────────────────────────────
router.delete("/handles/:org", requireAuth, async (req: Request, res: Response) => {
  const org = String(req.params.org || "").trim();
  if (!org) return res.status(400).json({ error: "Org name required" });
  await db.delete(orgHandlesTable).where(eq(orgHandlesTable.org, org));
  return void res.json({ status: "ok" });
});

export default router;

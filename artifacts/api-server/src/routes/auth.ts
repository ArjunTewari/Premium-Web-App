import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  signFullToken,
  COOKIE_NAME,
  COOKIE_PENDING,
  COOKIE_OPTS,
} from "../lib/auth.js";
import { requireAuth } from "../middleware/require-auth.js";

const router = Router();

router.post("/auth/login", async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const fullToken = signFullToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  res.clearCookie(COOKIE_PENDING);
  res.cookie(COOKIE_NAME, fullToken, COOKIE_OPTS);
  return res.json({ status: "ok", user: { username: user.username, role: user.role } });
});

router.post("/auth/signup", async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3)
    return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  // Email is captured so the account (the client) receives its cost email per
  // report. Optional at the API level, but validate the format when present.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Enter a valid email address" });

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing) return res.status(409).json({ error: "Username already taken" });

  const hash = await bcrypt.hash(password, 10);
  const [newUser] = await db
    .insert(usersTable)
    .values({ username, email: email || null, passwordHash: hash, role: "user", totpEnabled: false })
    .returning();

  const fullToken = signFullToken({
    userId: newUser.id,
    username: newUser.username,
    role: newUser.role,
  });
  res.clearCookie(COOKIE_PENDING);
  res.cookie(COOKIE_NAME, fullToken, COOKIE_OPTS);
  return res.json({ status: "ok", user: { username: newUser.username, role: newUser.role } });
});

router.post("/auth/logout", (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME);
  res.clearCookie(COOKIE_PENDING);
  return res.json({ status: "ok" });
});

router.get("/auth/me", requireAuth, (req: Request, res: Response) => {
  return res.json({ user: req.user });
});

export default router;

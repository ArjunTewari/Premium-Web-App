import { Router, type Request, type Response } from "express";
import { createRequire } from "node:module";
import bcrypt from "bcryptjs";
import qrcode from "qrcode";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  signFullToken,
  signPendingToken,
  verifyToken,
  COOKIE_NAME,
  COOKIE_PENDING,
  COOKIE_OPTS,
  PENDING_COOKIE_OPTS,
} from "../lib/auth.js";
import { requireAuth } from "../middleware/require-auth.js";

const _require = createRequire(import.meta.url);
const otplib = _require("otplib") as {
  generateSecret: () => string;
  generateURI: (opts: { strategy: string; issuer: string; label: string; secret: string }) => string;
  verify: (opts: { strategy: string; secret: string; token: string }) => Promise<boolean>;
};

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

  const pendingPayload = {
    userId: user.id,
    username: user.username,
    role: user.role,
  };

  if (!user.totpEnabled) {
    const pending = signPendingToken(pendingPayload);
    res.cookie(COOKIE_PENDING, pending, PENDING_COOKIE_OPTS);
    return res.json({ status: "2fa_setup_required" });
  }

  const pending = signPendingToken(pendingPayload);
  res.cookie(COOKIE_PENDING, pending, PENDING_COOKIE_OPTS);
  return res.json({ status: "2fa_required" });
});

router.post("/auth/signup", async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password required" });
  if (username.length < 3)
    return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username))
    .limit(1);

  if (existing) return res.status(409).json({ error: "Username already taken" });

  const hash = await bcrypt.hash(password, 10);
  const [newUser] = await db
    .insert(usersTable)
    .values({ username, passwordHash: hash, role: "user", totpEnabled: false })
    .returning();

  const pendingPayload = { userId: newUser.id, username: newUser.username, role: newUser.role };
  const pending = signPendingToken(pendingPayload);
  res.cookie(COOKIE_PENDING, pending, PENDING_COOKIE_OPTS);
  return res.json({ status: "2fa_setup_required" });
});

router.post("/auth/verify-totp", async (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "TOTP token required" });

  const pendingToken = req.cookies?.[COOKIE_PENDING];
  if (!pendingToken) return res.status(401).json({ error: "No pending auth" });

  const payload = verifyToken(pendingToken);
  if (!payload || payload.stage !== "pending")
    return res.status(401).json({ error: "Invalid or expired session" });

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, payload.userId))
    .limit(1);

  if (!user || !user.totpSecret)
    return res.status(401).json({ error: "2FA not configured" });

  const isValid = await otplib.verify({
    strategy: "totp",
    token: String(token),
    secret: user.totpSecret,
  });

  if (!isValid) return res.status(401).json({ error: "Invalid TOTP code" });

  const fullToken = signFullToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  res.clearCookie(COOKIE_PENDING);
  res.cookie(COOKIE_NAME, fullToken, COOKIE_OPTS);
  return res.json({ status: "ok", user: { username: user.username, role: user.role } });
});

router.get("/auth/totp-setup", async (req: Request, res: Response) => {
  const pendingToken = req.cookies?.[COOKIE_PENDING];
  if (!pendingToken) return res.status(401).json({ error: "No pending auth" });

  const payload = verifyToken(pendingToken);
  if (!payload || payload.stage !== "pending")
    return res.status(401).json({ error: "Invalid or expired session" });

  const secret = otplib.generateSecret();
  const otpauth = otplib.generateURI({
    strategy: "totp",
    issuer: "Emerald AI",
    label: payload.username,
    secret,
  });
  const qrDataUrl = await qrcode.toDataURL(otpauth);

  await db
    .update(usersTable)
    .set({ totpSecret: secret })
    .where(eq(usersTable.id, payload.userId));

  return res.json({ secret, qrDataUrl });
});

router.post("/auth/totp-confirm", async (req: Request, res: Response) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "TOTP token required" });

  const pendingToken = req.cookies?.[COOKIE_PENDING];
  if (!pendingToken) return res.status(401).json({ error: "No pending auth" });

  const payload = verifyToken(pendingToken);
  if (!payload || payload.stage !== "pending")
    return res.status(401).json({ error: "Invalid or expired session" });

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, payload.userId))
    .limit(1);

  if (!user || !user.totpSecret)
    return res.status(400).json({ error: "TOTP secret not generated yet" });

  const isValid = await otplib.verify({
    strategy: "totp",
    token: String(token),
    secret: user.totpSecret,
  });
  if (!isValid) return res.status(401).json({ error: "Invalid TOTP code" });

  await db
    .update(usersTable)
    .set({ totpEnabled: true })
    .where(eq(usersTable.id, payload.userId));

  const fullToken = signFullToken({
    userId: user.id,
    username: user.username,
    role: user.role,
  });
  res.clearCookie(COOKIE_PENDING);
  res.cookie(COOKIE_NAME, fullToken, COOKIE_OPTS);
  return res.json({ status: "ok", user: { username: user.username, role: user.role } });
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

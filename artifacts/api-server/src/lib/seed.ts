import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";

export async function seedAdminIfNeeded() {
  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN) return;
  try {
    const existing = await db.select().from(usersTable).limit(1);
    if (existing.length > 0) return;
    const password = process.env.ADMIN_INITIAL_PASSWORD ?? "admin2026";
    const hash = await bcrypt.hash(password, 10);
    await db.insert(usersTable).values({
      username: "admin",
      passwordHash: hash,
      role: "admin",
      totpEnabled: false,
    });
    console.log("Seeded default admin user (development only).");
  } catch (err) {
    console.error("Seed error (non-fatal):", err);
  }
}

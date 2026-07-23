import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

export async function seedAdminIfNeeded() {
  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN) return;
  try {
    const existing = await db.select().from(usersTable).where(eq(usersTable.username, "admin")).limit(1);
    if (existing.length > 0) return;
    const password = process.env.ADMIN_INITIAL_PASSWORD;
    if (!password) {
      console.warn("Skipping admin seed: ADMIN_INITIAL_PASSWORD env var is not set.");
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await db.insert(usersTable).values({
      username: "admin",
      passwordHash: hash,
      role: "admin",
      totpEnabled: false,
    });
    console.log("Seeded default admin user.");
  } catch (err) {
    console.error("Seed error (non-fatal):", err);
  }
}

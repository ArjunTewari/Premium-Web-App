import { pool } from "@workspace/db";
import { logger } from "./logger.js";
import { ORG_HANDLE_SEEDS } from "./org-handles-defaults.js";

/**
 * Create the app's tables if they don't already exist.
 *
 * Runs once on boot so a brand-new Postgres (e.g. a fresh Railway database)
 * comes up ready without a separate `drizzle-kit push` step in the deploy
 * pipeline. It is plain `CREATE TABLE IF NOT EXISTS`, so on an existing
 * database every statement is a no-op.
 *
 * The column definitions mirror `lib/db/src/schema/index.ts` — keep them in
 * sync. Drizzle remains the source of truth; any real schema *change* (altering
 * a column, adding an index) still goes through `pnpm --filter @workspace/db
 * run push` against the database. This function only bootstraps first use.
 */
export async function ensureSchema(): Promise<void> {
  const ddl = `
    CREATE TABLE IF NOT EXISTS "users" (
      "id" serial PRIMARY KEY,
      "username" text NOT NULL UNIQUE,
      "email" text,
      "password_hash" text NOT NULL,
      "totp_secret" text,
      "totp_enabled" boolean NOT NULL DEFAULT false,
      "role" text NOT NULL DEFAULT 'admin',
      "created_at" timestamp NOT NULL DEFAULT now()
    );
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;

    CREATE TABLE IF NOT EXISTS "report_logs" (
      "id" serial PRIMARY KEY,
      "organizations" text[] NOT NULL,
      "date_from" text NOT NULL,
      "date_to" text NOT NULL,
      "html_name" text,
      "pptx_name" text,
      "client_name" text,
      "generated_by" text,
      "cost_inr" numeric(10, 2) NOT NULL,
      "cost_serper_inr" numeric(10, 2) NOT NULL,
      "cost_llm_aeo_inr" numeric(10, 2) NOT NULL,
      "cost_claude_inr" numeric(10, 2) NOT NULL,
      "cost_youtube_inr" numeric(10, 2) NOT NULL DEFAULT '0',
      "cost_storage_inr" numeric(10, 2) NOT NULL,
      "cost_deployment_inr" numeric(10, 2) NOT NULL,
      "api_cost_inr" numeric(10, 2) NOT NULL DEFAULT '0',
      "per_org_month_inr" numeric(10, 2) NOT NULL DEFAULT '0',
      "created_at" timestamp NOT NULL DEFAULT now()
    );
    ALTER TABLE "report_logs" ADD COLUMN IF NOT EXISTS "api_cost_inr" numeric(10, 2) NOT NULL DEFAULT '0';
    ALTER TABLE "report_logs" ADD COLUMN IF NOT EXISTS "per_org_month_inr" numeric(10, 2) NOT NULL DEFAULT '0';

    CREATE TABLE IF NOT EXISTS "org_handles" (
      "org" text PRIMARY KEY,
      "linkedin" text NOT NULL DEFAULT '',
      "twitter" text NOT NULL DEFAULT '',
      "instagram" text NOT NULL DEFAULT '',
      "youtube" text NOT NULL DEFAULT '',
      "updated_at" timestamp NOT NULL DEFAULT now(),
      "updated_by" text
    );
  `;
  try {
    await pool.query(ddl);
    // Seed the shared handle list once — only rows that don't exist yet, so
    // later edits are never overwritten and re-runs are no-ops.
    if (ORG_HANDLE_SEEDS.length) {
      const values = ORG_HANDLE_SEEDS.map((_, i) => {
        const b = i * 5;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, 'seed')`;
      }).join(", ");
      const params = ORG_HANDLE_SEEDS.flatMap((s) => [
        s.org, s.linkedin, s.twitter, s.instagram, s.youtube,
      ]);
      const res = await pool.query(
        `INSERT INTO "org_handles" ("org","linkedin","twitter","instagram","youtube","updated_by")
         VALUES ${values}
         ON CONFLICT ("org") DO NOTHING`,
        params,
      );
      if (res.rowCount) logger.info({ seeded: res.rowCount }, "Seeded org_handles defaults");
    }
    logger.info("Schema check complete (tables present)");
  } catch (err) {
    logger.error({ err }, "ensureSchema failed — the database may be unreachable");
    throw err;
  }
}

import { pool } from "@workspace/db";
import { logger } from "./logger.js";

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
  `;
  try {
    await pool.query(ddl);
    logger.info("Schema check complete (tables present)");
  } catch (err) {
    logger.error({ err }, "ensureSchema failed — the database may be unreachable");
    throw err;
  }
}

import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  numeric,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  // Client's email, captured at signup. Nullable — the seeded admin account
  // and any API-created user may not have one. When set, the account receives
  // the client-cost email each time it generates a report.
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  role: text("role").notNull().default("admin"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

export const reportLogsTable = pgTable("report_logs", {
  id: serial("id").primaryKey(),
  organizations: text("organizations").array().notNull(),
  dateFrom: text("date_from").notNull(),
  dateTo: text("date_to").notNull(),
  htmlName: text("html_name"),
  pptxName: text("pptx_name"),
  clientName: text("client_name"),
  generatedBy: text("generated_by"),
  costInr: numeric("cost_inr", { precision: 10, scale: 2 }).notNull(),
  costSerperInr: numeric("cost_serper_inr", { precision: 10, scale: 2 }).notNull(),
  costLlmAeoInr: numeric("cost_llm_aeo_inr", { precision: 10, scale: 2 }).notNull(),
  costClaudeInr: numeric("cost_claude_inr", { precision: 10, scale: 2 }).notNull(),
  costYoutubeInr: numeric("cost_youtube_inr", { precision: 10, scale: 2 }).notNull().default("0"),
  costStorageInr: numeric("cost_storage_inr", { precision: 10, scale: 2 }).notNull(),
  costDeploymentInr: numeric("cost_deployment_inr", { precision: 10, scale: 2 }).notNull(),
  // Real total API cost to produce this report (INR) — sum of the metered
  // Claude/Serper spend plus per-call Firecrawl/APIdirect/YouTube/AEO costs.
  apiCostInr: numeric("api_cost_inr", { precision: 10, scale: 2 }).notNull().default("0"),
  // The per-org-per-month rate this report was billed to the client at (INR).
  perOrgMonthInr: numeric("per_org_month_inr", { precision: 10, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ReportLog = typeof reportLogsTable.$inferSelect;

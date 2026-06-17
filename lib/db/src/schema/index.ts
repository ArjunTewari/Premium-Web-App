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
  costInr: numeric("cost_inr", { precision: 10, scale: 2 }).notNull(),
  costSerperInr: numeric("cost_serper_inr", { precision: 10, scale: 2 }).notNull(),
  costLlmAeoInr: numeric("cost_llm_aeo_inr", { precision: 10, scale: 2 }).notNull(),
  costClaudeInr: numeric("cost_claude_inr", { precision: 10, scale: 2 }).notNull(),
  costYoutubeInr: numeric("cost_youtube_inr", { precision: 10, scale: 2 }).notNull().default("0"),
  costStorageInr: numeric("cost_storage_inr", { precision: 10, scale: 2 }).notNull(),
  costDeploymentInr: numeric("cost_deployment_inr", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ReportLog = typeof reportLogsTable.$inferSelect;

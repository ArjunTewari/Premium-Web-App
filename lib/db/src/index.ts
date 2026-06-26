import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Supabase Vercel integration sets POSTGRES_URL; fall back to DATABASE_URL for local dev
const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL or POSTGRES_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString,
  // Supabase (and most hosted Postgres) requires SSL in production
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});
export const db = drizzle(pool, { schema });

export * from "./schema";

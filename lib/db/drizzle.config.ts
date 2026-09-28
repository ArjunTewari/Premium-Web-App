import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Plain relative path (drizzle-kit resolves it against this config file's
  // own directory). Do NOT build this with path.join(__dirname, ...) — on
  // Windows that produces backslashes, and drizzle-kit runs this value
  // through a glob matcher internally where backslash is an escape
  // character, so it silently matches nothing ("No schema files found")
  // even though the file exists.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});

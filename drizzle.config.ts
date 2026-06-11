import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load .env.local explicitly — dotenv's default is .env, but Next.js
// convention (and where our DATABASE_URL lives) is .env.local.
config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — check .env.local");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL },
  casing: "snake_case",
  verbose: true,
  strict: true,
});

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

export const isPostgresConfigured = Boolean(process.env.DATABASE_URL);

let pool: pg.Pool | null = null;
let dbInstance: any = null;

if (isPostgresConfigured) {
  try {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
    });
    dbInstance = drizzle(pool, { schema });
  } catch (err) {
    console.warn("[Database] PostgreSQL connection failed, using local storage fallback:", err);
  }
}

export const db = dbInstance;

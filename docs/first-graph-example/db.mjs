// db.mjs: one connection pool and the three Postgres stores.
import pg from "pg";
import { createPostgresStores } from "@scshafe/switchyard-postgres";

export function openStores() {
  // APP_DATABASE_URL logs in as a member of switchyard_runtime: it can call
  // the store routines and nothing else.
  const pool = new pg.Pool({ connectionString: process.env.APP_DATABASE_URL });
  pool.on("error", (error) => console.error("idle PostgreSQL client failed", error));
  return { pool, ...createPostgresStores({ pool }) };
}

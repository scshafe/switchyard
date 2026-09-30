// db.mjs: the three Postgres stores, over one connection pool.
import { createPostgresStores } from "@scshafe/switchyard-postgres";

export function openStores() {
  // APP_DATABASE_URL logs in as a member of switchyard_runtime: it can call
  // the store routines and nothing else. The stores open their own pool, and
  // close() ends it.
  return createPostgresStores({
    connectionString: process.env.APP_DATABASE_URL,
    onPoolError: (error) => console.error("idle PostgreSQL client failed", error)
  });
}

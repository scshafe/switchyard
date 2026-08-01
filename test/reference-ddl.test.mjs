import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sql = await readFile(
  new URL("../sql/reference/pipeline-store.sql", import.meta.url),
  "utf8"
);

test("reference DDL statically carries the append-only identity/fence constraints", () => {
  const tables = [...sql.matchAll(/CREATE TABLE\s+([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables, [
    "pipeline_definitions",
    "runs",
    "run_items",
    "shards",
    "shard_members",
    "shard_outcomes",
    "bound_execution_identities",
    "executions",
    "attempts",
    "results",
    "dead_letters",
    "outbox_events",
    "artifacts",
    "work_leases"
  ]);
  assert.match(sql, /idempotency_key text\s+NOT NULL UNIQUE CHECK \(idempotency_key ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(sql, /input\s+jsonb\s+NOT NULL,/);
  assert.match(sql, /CHECK \(finished_at >= started_at\)/);
  assert.match(sql, /UNIQUE \(execution_id, attempt_number, event_index\)/);
  assert.match(sql, /CHECK \(heartbeat_at >= acquired_at\)/);
  assert.match(sql, /CHECK \(expires_at > heartbeat_at\)/);
  assert.match(
    sql,
    /--   - heartbeat: UPDATE heartbeat_at\/expires_at WHERE lease_token matches,\n--     expires_at > requested_at, requested_at >= acquired_at, AND\n--     requested_at >= heartbeat_at\./
  );
  const executableSql = sql.replace(/^--.*$/gm, "");
  assert.doesNotMatch(executableSql, /\bUPDATE\b|\bDELETE\s+FROM\b/);
});

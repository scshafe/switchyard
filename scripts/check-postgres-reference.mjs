import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const pgBin = process.env.MISSION_PIPELINE_PG_BIN
  ?? "/opt/homebrew/opt/postgresql@18/bin";
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-pg18-"));
const data = join(scratch, "data");
const socket = join(scratch, "socket");
let started = false;
let report;

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`
    );
  }
  return { code, stdout, stderr };
}

const executable = (name) => join(pgBin, name);

try {
  const version = await run(executable("postgres"), ["--version"]);
  if (!/PostgreSQL\) 18\.4(?:\s|\(|$)/.test(version.stdout.trim())) {
    throw new Error(
      `reference DDL release gate requires PostgreSQL 18.4, got ${version.stdout.trim()}`
    );
  }
  await mkdir(socket);
  await chmod(socket, 0o700);
  await run(executable("initdb"), [
    "-D",
    data,
    "-A",
    "trust",
    "-U",
    "mission_test",
    "--no-locale",
    "--encoding=UTF8"
  ]);
  await run(executable("pg_ctl"), [
    "-D",
    data,
    "-l",
    join(scratch, "postgres.log"),
    "-o",
    `-c listen_addresses= -k ${socket}`,
    "-w",
    "start"
  ]);
  started = true;
  await run(executable("createdb"), [
    "-h",
    socket,
    "-U",
    "mission_test",
    "mission_pipeline_test"
  ]);
  await run(executable("psql"), [
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    socket,
    "-U",
    "mission_test",
    "-d",
    "mission_pipeline_test",
    "-f",
    resolve(root, "sql/reference/pipeline-store.sql")
  ]);
  const count = await run(executable("psql"), [
    "-X",
    "-q",
    "-At",
    "-h",
    socket,
    "-U",
    "mission_test",
    "-d",
    "mission_pipeline_test",
    "-c",
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"
  ]);
  if (count.stdout.trim() !== "14") {
    throw new Error(`reference DDL created ${count.stdout.trim()} tables, expected 14`);
  }
  const heartbeatFence = await run(executable("psql"), [
    "-X",
    "-q",
    "-At",
    "-F",
    "|",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    socket,
    "-U",
    "mission_test",
    "-d",
    "mission_pipeline_test",
    "-c",
    `DO $gate$
DECLARE
  before_probe jsonb;
  after_probe jsonb;
  affected bigint;
BEGIN
  INSERT INTO work_leases (
    lease_key,
    lease_owner,
    lease_token,
    acquired_at,
    heartbeat_at,
    expires_at
  ) VALUES (
    'gate:heartbeat-monotonicity',
    'reference-gate',
    '11111111-1111-4111-8111-111111111111',
    '2026-08-01T00:00:00Z',
    '2026-08-01T00:00:00Z',
    '2026-08-01T01:00:00Z'
  );

  SELECT to_jsonb(work_leases) INTO before_probe
  FROM work_leases WHERE lease_key = 'gate:heartbeat-monotonicity';
  UPDATE work_leases
  SET heartbeat_at = '2026-07-31T23:59:00Z',
      expires_at = '2026-08-01T01:01:00Z'
  WHERE lease_key = 'gate:heartbeat-monotonicity'
    AND lease_token = '11111111-1111-4111-8111-111111111111'
    AND expires_at > '2026-07-31T23:59:00Z'
    AND '2026-07-31T23:59:00Z' >= acquired_at
    AND '2026-07-31T23:59:00Z' >= heartbeat_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  SELECT to_jsonb(work_leases) INTO after_probe
  FROM work_leases WHERE lease_key = 'gate:heartbeat-monotonicity';
  IF affected <> 0 OR before_probe IS DISTINCT FROM after_probe THEN
    RAISE EXCEPTION 'pre-acquisition heartbeat changed the lease';
  END IF;

  UPDATE work_leases
  SET heartbeat_at = '2026-08-01T00:10:00Z',
      expires_at = '2026-08-01T01:10:00Z'
  WHERE lease_key = 'gate:heartbeat-monotonicity'
    AND lease_token = '11111111-1111-4111-8111-111111111111'
    AND expires_at > '2026-08-01T00:10:00Z'
    AND '2026-08-01T00:10:00Z' >= acquired_at
    AND '2026-08-01T00:10:00Z' >= heartbeat_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'valid heartbeat did not advance exactly one lease';
  END IF;

  SELECT to_jsonb(work_leases) INTO before_probe
  FROM work_leases WHERE lease_key = 'gate:heartbeat-monotonicity';
  UPDATE work_leases
  SET heartbeat_at = '2026-08-01T00:05:00Z',
      expires_at = '2026-08-01T01:15:00Z'
  WHERE lease_key = 'gate:heartbeat-monotonicity'
    AND lease_token = '11111111-1111-4111-8111-111111111111'
    AND expires_at > '2026-08-01T00:05:00Z'
    AND '2026-08-01T00:05:00Z' >= acquired_at
    AND '2026-08-01T00:05:00Z' >= heartbeat_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  SELECT to_jsonb(work_leases) INTO after_probe
  FROM work_leases WHERE lease_key = 'gate:heartbeat-monotonicity';
  IF affected <> 0 OR before_probe IS DISTINCT FROM after_probe THEN
    RAISE EXCEPTION 'post-advance rewind changed the lease';
  END IF;
END $gate$;
SELECT
  to_char(heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
FROM work_leases
WHERE lease_key = 'gate:heartbeat-monotonicity';`
  ]);
  const [heartbeatAt, expiresAt] = heartbeatFence.stdout.trim().split("|");
  if (
    heartbeatAt !== "2026-08-01T00:10:00Z"
    || expiresAt !== "2026-08-01T01:10:00Z"
  ) {
    throw new Error(
      `disposable heartbeat fence proof ended in unexpected state: ${heartbeatFence.stdout.trim()}`
    );
  }
  const isolation = await run(executable("psql"), [
    "-X",
    "-At",
    "-F",
    "|",
    "-h",
    socket,
    "-U",
    "mission_test",
    "-d",
    "mission_pipeline_test",
    "-c",
    "SELECT current_setting('data_directory'), current_setting('listen_addresses'), inet_server_addr() IS NULL, current_database(), current_user;"
  ]);
  const [actualData, listenAddresses, unixSocketOnly, database, user] =
    isolation.stdout.trim().split("|");
  if (
    actualData !== data
    || listenAddresses !== ""
    || unixSocketOnly !== "t"
    || database !== "mission_pipeline_test"
    || user !== "mission_test"
  ) {
    throw new Error(`disposable PostgreSQL isolation proof failed: ${isolation.stdout.trim()}`);
  }
  report = {
    result: "pass",
    postgres: version.stdout.trim(),
    tableCount: 14,
    heartbeatFence: {
      preAcquisitionRejectedUnchanged: true,
      validAdvanceAccepted: true,
      postAdvanceRewindRejectedUnchanged: true,
      heartbeatAt,
      expiresAt
    },
    temporaryRoot: scratch,
    dataDirectory: data,
    socket,
    listenAddresses,
    unixSocketOnly: true,
    database,
    user
  };
} finally {
  if (started) {
    await run(
      executable("pg_ctl"),
      ["-D", data, "-m", "immediate", "-w", "stop"],
      { allowFailure: true }
    );
  }
  await rm(scratch, { force: true, recursive: true });
}
console.log(JSON.stringify({ ...report, cleanup: "removed" }));

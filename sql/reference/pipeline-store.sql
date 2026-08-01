-- ============================================================================
-- mission-pipeline REFERENCE DDL — PipelineStore port, relational template
-- ============================================================================
-- THIS FILE IS NEVER AUTO-APPLIED. It is documentation: a reviewed, dialect-
-- portable (PostgreSQL-flavored) template mirroring src/store.ts one-to-one so
-- host adapters have an unambiguous relational shape to bind. HOSTS OWN THEIR
-- MIGRATIONS: inbox-pipeline binds its existing pipeline/decision schemas
-- (append-only triggers, least-authority grants, RLS) through its own numbered
-- sql/postgres series; other hosts bind equivalent reviewed schemas through
-- their own migration ledgers. Copy, adapt, review, and migrate under the host's
-- own ledger — never execute this file directly.
--
-- Lease/fencing semantics are promoted from inbox sql/postgres/009
-- (integration.delivery_claims: "Claims are mutable, short-lived coordination
-- state; immutable attempts and acknowledgements are retained" — lease_owner,
-- UNIQUE lease_token, acquired_at/heartbeat_at/expires_at with the two CHECKs)
-- and 012 (mail.content_hydration_retry_leases: "Mutable coordination only.
-- Append-only outcomes remain …; a lease may expire or be replaced without
-- changing the audit record. The … token fence[s] ambiguous/stale completion
-- attempts after process crashes.").
--
-- THE APPEND-ONLY INVARIANT (src/store.ts): every table below EXCEPT
-- work_leases is append-only evidence — no UPDATE, no DELETE (hosts should
-- enforce with triggers and grants, as inbox does). work_leases is the ONLY
-- mutable table: a lease may be heartbeated (UPDATE), replaced after expiry
-- (UPDATE), or released (DELETE) without touching any audit record.
--
-- THE FENCING INVARIANT: claimNextShard mints a fresh lease_token per claim;
-- heartbeat/complete/fail/prepare/persist/record-dead-letter all match on the
-- token AND expires_at > now — a stale token or an expired lease is the typed
-- ShardLeaseLostError / WorkLeaseLostError, and the fenced-out worker appends
-- nothing.
-- ============================================================================

-- ── Definitions (publishDefinition / loadDefinition) ────────────────────────
-- Append-only. Republishing the identical digest is an idempotent no-op at the
-- adapter layer; a different digest under the same (pipeline_id, version) must
-- be rejected loudly (the PRIMARY KEY makes the overwrite impossible).
CREATE TABLE pipeline_definitions (
  pipeline_id        text        NOT NULL,             -- identifier grammar
  version            integer     NOT NULL CHECK (version >= 1),
  definition         jsonb       NOT NULL,             -- the sealed PipelineDefinition
  definition_digest  text        NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  published_at       timestamptz NOT NULL,
  PRIMARY KEY (pipeline_id, version)
);

-- ── Runs (createRun) ────────────────────────────────────────────────────────
-- Append-only. `compiled` is the digest-sealed CompiledPipeline the run
-- executes; readers re-verify the seal (validateCompiledPipeline) on claim.
CREATE TABLE runs (
  run_id           text        NOT NULL PRIMARY KEY,
  pipeline_id      text        NOT NULL,
  pipeline_version integer     NOT NULL CHECK (pipeline_version >= 1),
  pipeline_digest  text        NOT NULL CHECK (pipeline_digest ~ '^[a-f0-9]{64}$'),
  compiled         jsonb       NOT NULL,
  compiled_digest  text        NOT NULL CHECK (compiled_digest ~ '^[a-f0-9]{64}$'),
  configuration    jsonb,                              -- host-owned, opaque
  created_at       timestamptz NOT NULL,
  UNIQUE (run_id, pipeline_digest, compiled_digest),
  UNIQUE (
    run_id,
    pipeline_id,
    pipeline_version,
    pipeline_digest,
    compiled_digest
  )
);

-- Append-only. input_digest = canonical-JSON digest of input (verified on write).
CREATE TABLE run_items (
  run_id       text    NOT NULL REFERENCES runs(run_id),
  item_id      text    NOT NULL,
  ordinal      integer NOT NULL CHECK (ordinal >= 1),  -- exactly 1..n per run
  input        jsonb   NOT NULL,
  input_digest text    NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (run_id, item_id),
  UNIQUE (run_id, ordinal)
);

-- ── Shards (identity + membership: immutable; claims live in work_leases) ───
-- Append-only. shard_ids are globally unique (the lease key is derived from
-- the shard_id alone: 'shard:' || shard_id).
CREATE TABLE shards (
  shard_id   text        NOT NULL PRIMARY KEY,
  run_id     text        NOT NULL REFERENCES runs(run_id),
  created_at timestamptz NOT NULL,
  UNIQUE (shard_id, run_id)
);

-- Append-only. Shards PARTITION the run's items exactly (each item in exactly
-- one shard); position preserves the execution order inside the shard.
CREATE TABLE shard_members (
  shard_id text    NOT NULL REFERENCES shards(shard_id),
  run_id   text    NOT NULL,
  item_id  text    NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  PRIMARY KEY (shard_id, item_id),
  UNIQUE (shard_id, run_id, item_id),
  UNIQUE (shard_id, position),
  UNIQUE (run_id, item_id),                            -- the partition rule
  FOREIGN KEY (shard_id, run_id) REFERENCES shards(shard_id, run_id),
  FOREIGN KEY (run_id, item_id) REFERENCES run_items(run_id, item_id)
);

-- Append-only OUTCOME EVENT LOG
-- (completeShard / failShard / deferShard / cancelShard). A shard is
-- claimable while it has no CONCLUSIVE outcome: 'completed', 'partial', or a
-- 'failed' row with retryable = false, or 'cancelled'. Retryable failures and
-- deferred outcomes append an audit row and return the shard to the pool.
-- Deferral/cancellation are explicitly NOT stage/shard failures and therefore
-- carry a reason_code instead of error/retry evidence. Counts must cover the shard exactly
-- (completed_item_count + terminal_item_count = item_count) and
-- status 'completed' iff terminal_item_count = 0.
CREATE TABLE shard_outcomes (
  shard_outcome_id     uuid        NOT NULL PRIMARY KEY,
  shard_id             text        NOT NULL REFERENCES shards(shard_id),
  status               text        NOT NULL CHECK (status IN ('completed', 'partial', 'failed', 'deferred', 'cancelled')),
  retryable            boolean,                        -- failed rows only
  error_code           text,                           -- failed rows only
  reason_code          text,                           -- deferred/cancelled rows only
  item_count           integer,                        -- completed/partial rows only
  completed_item_count integer,
  terminal_item_count  integer,
  recorded_at          timestamptz NOT NULL,
  CHECK ((status = 'failed') = (retryable IS NOT NULL AND error_code IS NOT NULL)),
  CHECK ((status IN ('deferred', 'cancelled')) = (reason_code IS NOT NULL)),
  CHECK (reason_code IS NULL OR reason_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  CHECK (
    (
      status IN ('completed', 'partial')
      AND item_count IS NOT NULL AND item_count >= 0
      AND completed_item_count IS NOT NULL AND completed_item_count >= 0
      AND terminal_item_count IS NOT NULL AND terminal_item_count >= 0
    )
    OR
    (
      status NOT IN ('completed', 'partial')
      AND item_count IS NULL
      AND completed_item_count IS NULL
      AND terminal_item_count IS NULL
    )
  ),
  CHECK (item_count IS NULL OR completed_item_count + terminal_item_count = item_count),
  CHECK (status <> 'completed' OR terminal_item_count = 0),
  CHECK (status <> 'partial' OR terminal_item_count >= 1)
);

-- ── Stage executions (prepareStageExecution) ────────────────────────────────
-- Externally fenced hosts persist the sealed generic identity before any
-- evidence append. This is an illustrative host-owned table: its lease/fence
-- token belongs in the host's mutable claim table, never in immutable
-- evidence. Every bound evidence row references identity_digest and the host
-- validates the live fence plus all identity columns in the same transaction.
CREATE TABLE bound_execution_identities (
  identity_digest   text    NOT NULL PRIMARY KEY CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
  host_action_id    text    NOT NULL UNIQUE,
  run_id            text    NOT NULL,
  shard_id          text    NOT NULL,
  pipeline_id       text    NOT NULL,
  pipeline_version  integer NOT NULL CHECK (pipeline_version >= 1),
  definition_digest text    NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  compiled_digest   text    NOT NULL CHECK (compiled_digest ~ '^[a-f0-9]{64}$'),
  item_count        integer NOT NULL CHECK (item_count >= 1),
  item_set_digest   text    NOT NULL CHECK (item_set_digest ~ '^[a-f0-9]{64}$'),
  UNIQUE (
    identity_digest,
    run_id,
    shard_id,
    definition_digest,
    compiled_digest
  ),
  FOREIGN KEY (
    run_id,
    pipeline_id,
    pipeline_version,
    definition_digest,
    compiled_digest
  ) REFERENCES runs(
    run_id,
    pipeline_id,
    pipeline_version,
    pipeline_digest,
    compiled_digest
  ),
  FOREIGN KEY (shard_id, run_id) REFERENCES shards(shard_id, run_id)
);

-- Append-only reservation: ONE row per idempotency key
-- (digest({runId,itemId,nodeId,stageId,version,fingerprint,inputDigest,
-- [executionIdentityDigest]}) — computed by execute/durable-stage.ts).
-- Attempt numbering derives from the attempts
-- table, so the retry budget survives crashes and reclaims.
CREATE TABLE executions (
  execution_id    uuid    NOT NULL PRIMARY KEY,
  idempotency_key text    NOT NULL UNIQUE CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
  run_id          text    NOT NULL,
  shard_id        text    NOT NULL,
  item_id         text    NOT NULL,
  node_id         text    NOT NULL,
  stage_id        text    NOT NULL,
  stage_version   integer NOT NULL CHECK (stage_version >= 1),
  definition_digest text  NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  compiled_digest text    NOT NULL CHECK (compiled_digest ~ '^[a-f0-9]{64}$'),
  bound_identity_digest text REFERENCES bound_execution_identities(identity_digest),
  input_contract  text    NOT NULL,                    -- slot contract or 'pipeline-node-input.v1'
  input           jsonb   NOT NULL,
  input_digest    text    NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  UNIQUE (
    execution_id,
    idempotency_key,
    run_id,
    shard_id,
    item_id,
    node_id,
    stage_id,
    stage_version
  ),
  FOREIGN KEY (run_id, item_id) REFERENCES run_items(run_id, item_id),
  FOREIGN KEY (shard_id, run_id, item_id)
    REFERENCES shard_members(shard_id, run_id, item_id),
  FOREIGN KEY (run_id, definition_digest, compiled_digest)
    REFERENCES runs(run_id, pipeline_digest, compiled_digest),
  FOREIGN KEY (
    bound_identity_digest,
    run_id,
    shard_id,
    definition_digest,
    compiled_digest
  ) REFERENCES bound_execution_identities(
    identity_digest,
    run_id,
    shard_id,
    definition_digest,
    compiled_digest
  )
);

-- In the same fenced prepare transaction, the adapter MUST additionally
-- resolve `compiled.nodes[node_id]` from runs.compiled and require its exact
-- (stage_id, stage_version) AND derive the exact expected input_contract
-- (the single slot contract, or 'pipeline-node-input.v1' for multiple slots).
-- Every persist operation MUST compare its supplied
-- run/shard/item/node identity to this execution row before cached/duplicate
-- no-op handling; persistStageSuccess additionally requires output_contract
-- to equal the compiled node's outputContract. This closes cross-node and
-- cross-contract idempotency collisions and prevents a stale caller from
-- borrowing evidence belonging to another compiled DAG.

-- Append-only. One row per persisted attempt (persistStageSuccess appends a
-- 'succeeded' row atomically with the result; persistStageFailure appends a
-- 'failed' row). Either append may carry transactional-outbox rows produced by
-- that exact attempt. failure_scope preserves whether the failure belongs to
-- the item or the shard. terminal = true means terminal WITHIN that scope: an
-- item terminal requires its dead letter in the same transaction, while a
-- shard terminal is surfaced back to failShard and never creates an item dead
-- letter.
CREATE TABLE attempts (
  execution_id   uuid        NOT NULL REFERENCES executions(execution_id),
  attempt_number integer     NOT NULL CHECK (attempt_number >= 1),
  status         text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL,
  error_code     text,
  error_message  text,
  retryable      boolean,
  failure_scope  text        CHECK (failure_scope IN ('item', 'shard')),
  terminal       boolean,
  PRIMARY KEY (execution_id, attempt_number),
  UNIQUE (execution_id, attempt_number, status),
  UNIQUE (execution_id, attempt_number, status, failure_scope, terminal),
  CHECK (
    (
      status = 'succeeded'
      AND error_code IS NULL
      AND error_message IS NULL
      AND retryable IS NULL
      AND failure_scope IS NULL
      AND terminal IS NULL
    )
    OR
    (
      status = 'failed'
      AND error_code IS NOT NULL
      AND retryable IS NOT NULL
      AND failure_scope IS NOT NULL
      AND terminal IS NOT NULL
    )
  ),
  CHECK (finished_at >= started_at)
);

-- Append-ONCE per idempotency key: the cached-success record
-- (prepareStageExecution's 'cached' arm; persistStageSuccess returns
-- created = false and appends NOTHING when a row already exists —
-- outbox events ride exactly-once with the FIRST-created result).
CREATE TABLE results (
  result_id       uuid        NOT NULL PRIMARY KEY,
  execution_id    uuid        NOT NULL UNIQUE,
  attempt_number  integer     NOT NULL CHECK (attempt_number >= 1),
  attempt_status  text        NOT NULL DEFAULT 'succeeded' CHECK (attempt_status = 'succeeded'),
  idempotency_key text        NOT NULL UNIQUE,
  run_id          text        NOT NULL,
  shard_id        text        NOT NULL,
  item_id         text        NOT NULL,
  node_id         text        NOT NULL,
  stage_id        text        NOT NULL,
  stage_version   integer     NOT NULL CHECK (stage_version >= 1),
  output_contract text        NOT NULL,
  output          jsonb       NOT NULL,
  output_digest   text        NOT NULL CHECK (output_digest ~ '^[a-f0-9]{64}$'),
  recorded_at     timestamptz NOT NULL,
  FOREIGN KEY (
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ) REFERENCES executions(
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ),
  FOREIGN KEY (execution_id, attempt_number, attempt_status)
    REFERENCES attempts(execution_id, attempt_number, status)
);

-- Append-ONCE per idempotency key (recordDeadLetter / the deadLetter riding
-- persistStageFailure): the exactly-once dead-letter guarantee is the UNIQUE
-- constraint — replays observe created = false and append nothing.
-- Standalone recordDeadLetter additionally requires attempts to equal the
-- exact latest stage_attempts.attempt_number for this execution, with
-- failure_scope='item' and terminal=false; hosts enforce that predicate in
-- the fenced transaction.
CREATE TABLE dead_letters (
  dead_letter_id  uuid        NOT NULL PRIMARY KEY,
  execution_id    uuid        NOT NULL UNIQUE,
  idempotency_key text        NOT NULL UNIQUE,
  run_id          text        NOT NULL,
  shard_id        text        NOT NULL,
  item_id         text        NOT NULL,
  node_id         text        NOT NULL,
  stage_id        text        NOT NULL,
  stage_version   integer     NOT NULL CHECK (stage_version >= 1),
  input           jsonb       NOT NULL,
  error_code      text        NOT NULL,
  error_message   text        NOT NULL,
  attempts        integer     NOT NULL CHECK (attempts >= 1),
  attempt_status  text        NOT NULL DEFAULT 'failed' CHECK (attempt_status = 'failed'),
  failure_scope   text        NOT NULL DEFAULT 'item' CHECK (failure_scope = 'item'),
  attempt_terminal boolean    NOT NULL,
  created_at      timestamptz NOT NULL,
  FOREIGN KEY (
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ) REFERENCES executions(
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ),
  FOREIGN KEY (
    execution_id, attempts, attempt_status, failure_scope, attempt_terminal
  ) REFERENCES attempts(
    execution_id, attempt_number, status, failure_scope, terminal
  )
);

-- ── Transactional outbox (both stage-persist methods' outboxEvents) ──────────
-- Append-only. Rows are inserted IN THE SAME TRANSACTION as the success result
-- OR failed attempt (+ item-terminal dead letter when applicable) — the
-- atomicity the port guarantees. Host relays consume and acknowledge elsewhere
-- (consumption state is the host's, never a mutation of this table).
CREATE TABLE outbox_events (
  outbox_event_id uuid        NOT NULL PRIMARY KEY,
  execution_id    uuid        NOT NULL,
  attempt_number  integer     NOT NULL CHECK (attempt_number >= 1),
  event_index     integer     NOT NULL CHECK (event_index >= 0),
  run_id          text        NOT NULL,
  shard_id        text        NOT NULL,
  item_id         text        NOT NULL,
  node_id         text        NOT NULL,
  stage_id        text        NOT NULL,
  stage_version   integer     NOT NULL CHECK (stage_version >= 1),
  idempotency_key text        NOT NULL,
  event_type      text        NOT NULL,                -- identifier grammar
  payload         jsonb       NOT NULL,
  dedupe_key      text        UNIQUE,                  -- optional host dedupe
  recorded_at     timestamptz NOT NULL,
  UNIQUE (execution_id, attempt_number, event_index),
  FOREIGN KEY (
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ) REFERENCES executions(
    execution_id, idempotency_key, run_id, shard_id, item_id, node_id,
    stage_id, stage_version
  ),
  FOREIGN KEY (execution_id, attempt_number)
    REFERENCES attempts(execution_id, attempt_number)
);

-- created:false proof reads the winning attempt's exact batch ordered by
-- event_index ASC, canonicalizes each (event_type,payload,dedupe_key), and
-- returns those ordered digests as committedOutboxEventDigests.

-- ── Artifacts (putArtifact / getArtifact) ───────────────────────────────────
-- Append-only, content-addressed: digest = canonical-JSON sha256 of payload
-- (verified before insert); re-putting an existing digest is an idempotent
-- no-op. Large payloads may live in object storage with payload NULL and an
-- object_key column — host's choice; the port only promises ref round-trips.
CREATE TABLE artifacts (
  contract_id text  NOT NULL,
  digest      text  NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  byte_count  bigint CHECK (byte_count >= 0),
  payload     jsonb NOT NULL,
  PRIMARY KEY (contract_id, digest)
);

-- ── Work leases — THE ONLY MUTABLE TABLE ────────────────────────────────────
-- Shard claims use lease_key = 'shard:' || shard_id (claimNextShard /
-- heartbeatShard / completeShard / failShard); auxiliary leases (acquireLease
-- — e.g. B4 inference-concurrency fences) use host-chosen keys, which MUST NOT
-- use the reserved 'shard:' prefix. Semantics promoted from inbox 009/012:
--   - claim: INSERT, or UPDATE-replace when expires_at <= now (crash reclaim);
--   - heartbeat: UPDATE heartbeat_at/expires_at WHERE lease_token matches,
--     expires_at > requested_at, requested_at >= acquired_at, AND
--     requested_at >= heartbeat_at. The last predicate prevents a stale clock
--     from rewinding coordination state; zero rows updated = the typed
--     LeaseLost/invalid-clock rejection;
--   - release/finalize: DELETE WHERE lease_token matches (a foreign token is
--     LeaseLost; an absent row is a no-op for releaseLease).
-- Every fenced evidence append (prepare/persist/record-dead-letter/
-- complete/fail) re-checks this row's token + expiry in the same transaction
-- as its insert.
CREATE TABLE work_leases (
  lease_key    text        NOT NULL PRIMARY KEY,
  lease_owner  text        NOT NULL,
  lease_token  uuid        NOT NULL UNIQUE,
  acquired_at  timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  CHECK (heartbeat_at >= acquired_at),                 -- promoted 009 CHECK
  CHECK (expires_at > heartbeat_at)                    -- promoted 009 CHECK
);

CREATE INDEX work_leases_expiry ON work_leases (expires_at, lease_key);  -- promoted expiry index

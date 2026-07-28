// store.ts — the PipelineStore PORT: the host-neutral persistence seam the
// durable executor (execute/durable-stage.ts) and shard runner
// (execute/shard-runner.ts) speak. The package ships an in-memory
// implementation (memory-store.ts) for hermetic tests plus documented
// reference DDL (sql/reference/pipeline-store.sql); HOSTS own their real
// migrations and adapters (inbox-pipeline binds its existing pipeline/decision
// PG schemas via its PipelineWorkerRepository surface; MC would bind mc-store).
//
// SHAPED FROM inbox-pipeline/src/worker/ports.ts (PipelineWorkerRepository:
// claimNextShard / heartbeatShard / prepareStageExecution /
// persistStageSuccess / persistStageFailure / completeShard / failShard and
// the acquire/heartbeat/release inference-lease trio) and the lease/fencing
// semantics of inbox sql/postgres/009 (delivery_claims: lease_owner +
// UNIQUE lease_token + acquired_at/heartbeat_at/expires_at with
// heartbeat_at >= acquired_at, expires_at > heartbeat_at; "Claims are mutable,
// short-lived coordination state; immutable attempts … are retained" ) and
// 012 (content_hydration_retry_leases: "Mutable coordination only. Append-only
// outcomes remain …; a lease may expire or be replaced without changing the
// audit record. The … token fence[s] ambiguous/stale completion attempts after
// process crashes.").
//
// ── THE APPEND-ONLY INVARIANT ─────────────────────────────────────────────
// Every EVIDENCE record is immutable once written: definitions, runs,
// run items, shard identities/membership, shard finalizations, stage
// executions, attempts, results, dead letters, outbox events, and artifacts
// are append-only — an implementation must never UPDATE or DELETE them.
// The ONLY mutable state is the LEASE: a lease row (shard claim or auxiliary
// work lease) may be heartbeated, expired, replaced by a new claimant, or
// released without changing any audit record. Corrections are new appended
// records, never edits.
//
// ── THE FENCING INVARIANT ─────────────────────────────────────────────────
// claimNextShard mints a fresh, unguessable leaseToken per claim. EVERY
// subsequent operation under that claim — heartbeatShard, completeShard,
// failShard, prepareStageExecution, persistStageSuccess, persistStageFailure,
// recordDeadLetter — carries the token and MUST be rejected with the typed
// ShardLeaseLostError when the lease is missing, expired (at the operation's
// effective time), or held under a DIFFERENT token (a newer claimant fenced
// this worker out).
// Auxiliary leases fence identically via WorkLeaseLostError. A fenced-out
// worker can therefore never append conflicting evidence: the reclaim path is
// safe because cached successes are reused by idempotency key and everything
// else is re-executed under the new token.
//
// Externally owned scheduling fences use the separate
// BoundPipelineEvidenceStore<TFence>: Pipeline sees an opaque fence only on
// evidence methods and has no claim/heartbeat/settlement capability. The host
// adapter verifies that fence in the same transaction as each append and
// reports staleness with ExternalFenceRejectedError.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).
// ── Typed fencing rejections ──────────────────────────────────────────────
/**
 * The LOUD, typed rejection for every stale-token / expired / reclaimed shard
 * lease (name and message promoted from inbox
 * worker/postgres-runtime-repository.ts PipelineShardLeaseLostError).
 * `retryable` by taxonomy: another worker owns (or will own) the shard; this
 * worker must stop appending under the dead claim.
 */
export class ShardLeaseLostError extends Error {
    code = "shard_lease_lost";
    constructor(shardId) {
        super(`Pipeline shard lease is missing, expired, or fenced: ${shardId}`);
        this.name = "ShardLeaseLostError";
    }
}
/**
 * The typed rejection for auxiliary work leases (acquire/heartbeat/release —
 * promoted from PipelineInferenceLeaseLostError, generalized: B4's inference
 * concurrency fences are one user of these leases).
 */
export class WorkLeaseLostError extends Error {
    code = "work_lease_lost";
    constructor(leaseKey) {
        super(`Work lease is missing, expired, or fenced: ${leaseKey}`);
        this.name = "WorkLeaseLostError";
    }
}
/**
 * A host adapter throws this when an externally owned execution fence is no
 * longer authoritative. Mission Pipeline cannot inspect a host's opaque
 * fence, so the adapter is the sole validator and this typed rejection crosses
 * the engine unchanged. In particular, the bound runner never translates it
 * into a stage failure or attempts any lease settlement.
 */
export class ExternalFenceRejectedError extends Error {
    code = "external_fence_rejected";
    constructor(message = "The externally owned pipeline execution fence was rejected", cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "ExternalFenceRejectedError";
    }
}

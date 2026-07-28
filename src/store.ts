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

import type { ArtifactEnvelope, ArtifactRef, ContractId } from "./contracts/artifact.js";
import type { CompiledPipeline } from "./compile.js";
import type { PipelineDefinition } from "./definition.js";

// ── Typed fencing rejections ──────────────────────────────────────────────

/**
 * The LOUD, typed rejection for every stale-token / expired / reclaimed shard
 * lease (name and message promoted from inbox
 * worker/postgres-runtime-repository.ts PipelineShardLeaseLostError).
 * `retryable` by taxonomy: another worker owns (or will own) the shard; this
 * worker must stop appending under the dead claim.
 */
export class ShardLeaseLostError extends Error {
  readonly code = "shard_lease_lost";
  constructor(shardId: string) {
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
  readonly code = "work_lease_lost";
  constructor(leaseKey: string) {
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
  readonly code = "external_fence_rejected";

  constructor(message = "The externally owned pipeline execution fence was rejected", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExternalFenceRejectedError";
  }
}

// ── Definitions & runs ────────────────────────────────────────────────────

/** One pipeline input item of a run. `inputDigest` MUST equal digest(input). */
export interface PipelineRunItem {
  itemId: string;
  /** 1-based position inside the run (unique per run). */
  ordinal: number;
  /** The pipeline input payload (must satisfy the definition's inputContract). */
  input: unknown;
  /** Object-canonical digest of `input` (contracts/digest.ts digest rule). */
  inputDigest: string;
}

/** Shard identity + membership. Immutable once created (append-only). */
export interface PipelineShardSpec {
  shardId: string;
  /** Ordered member itemIds. Shards PARTITION the run's items exactly. */
  itemIds: string[];
}

/**
 * createRun input: the run header, its items, and its shards, persisted
 * together (one atomic append). The store validates: compiled pipeline is
 * sealed and matches the run's pipeline ref; item ids/ordinals unique with
 * inputDigest === digest(input); shards partition the items exactly.
 */
export interface CreateRunInput {
  run: {
    runId: string;
    /** The compiled, digest-sealed DAG this run executes (validated on write AND on claim read-back). */
    compiled: CompiledPipeline;
    createdAt: string;
    /** Host-owned, opaque run configuration (stored as evidence, never interpreted). */
    configuration?: unknown;
  };
  items: readonly PipelineRunItem[];
  shards: readonly PipelineShardSpec[];
}

// ── Shard claim / lease lifecycle ─────────────────────────────────────────

export interface ClaimNextShardInput {
  leaseOwner: string;
  leaseDurationMs: number;
  /** Exact-claim narrowing (both or neither — promoted pairing rule). */
  runId?: string;
  shardId?: string;
  /** Effective time (ISO). Defaults to the store clock. Injectable for tests. */
  at?: string;
}

export interface ShardClaimItem {
  itemId: string;
  ordinal: number;
  input: unknown;
  inputDigest: string;
}

/**
 * A fenced claim on ONE shard. Carries everything the runner needs: the sealed
 * compiled pipeline (verify with validateCompiledPipeline — store round-trip
 * proof) and the member items in ordinal order.
 */
export interface ShardClaim {
  runId: string;
  shardId: string;
  leaseOwner: string;
  /** The fencing token; every subsequent call under this claim carries it. */
  leaseToken: string;
  acquiredAt: string;
  expiresAt: string;
  compiled: CompiledPipeline;
  items: ShardClaimItem[];
}

/**
 * Immutable work supplied to {@link import("./execute/shard-runner.js").runBoundShard}
 * after a host has acquired its own execution fence. Unlike {@link ShardClaim},
 * this value contains no Pipeline-owned lease owner, token, or expiry.
 */
export interface BoundPipelineShard {
  runId: string;
  shardId: string;
  compiled: CompiledPipeline;
  items: readonly ShardClaimItem[];
}

export interface HeartbeatShardInput {
  shardId: string;
  leaseToken: string;
  extendByMs: number;
  at?: string;
}

export interface CompleteShardInput {
  shardId: string;
  leaseToken: string;
  at?: string;
}

export interface FailShardInput {
  shardId: string;
  leaseToken: string;
  /** true ⇒ the shard returns to the claimable pool; false ⇒ conclusively failed. */
  retryable: boolean;
  errorCode: string;
  at?: string;
}

export interface DeferShardInput {
  shardId: string;
  leaseToken: string;
  /**
   * Stable host reason for yielding the claim. Deferral appends coordination
   * evidence and returns the shard to the claimable pool; it is NOT a failed
   * stage attempt and consumes no stage retry budget. Must match
   * `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`.
   */
  reasonCode: string;
  at?: string;
}

export interface CancelShardInput {
  shardId: string;
  leaseToken: string;
  /**
   * Stable host reason why the claimed work became obsolete. Cancellation is
   * conclusive, but it is NOT a stage/shard failure (source supersession is
   * the canonical use). Must match
   * `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`.
   */
  reasonCode: string;
  at?: string;
}

/**
 * The append-only finalization record (promoted from inbox
 * pipeline-shard-finalization.v1): counts must cover the whole shard, and
 * status is "completed" iff terminalItemCount === 0 ("partial" = at least one
 * member item terminalized while the others completed).
 */
export interface ShardFinalization {
  status: "completed" | "partial";
  itemCount: number;
  completedItemCount: number;
  terminalItemCount: number;
}

// ── Stage execution: idempotent reservation + fenced persistence ──────────

export interface PrepareStageExecutionInput {
  /** Fencing pair — rejected with ShardLeaseLostError when stale. */
  shardId: string;
  leaseToken: string;
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  /**
   * The executor-computed idempotency key (execute/durable-stage.ts:
   * digest({runId,itemId,stageId,version,fingerprint,inputDigest})). The store
   * keys executions, results, and dead letters on it.
   */
  idempotencyKey: string;
  /** Single-slot: the slot contract; multi-slot: "pipeline-node-input.v1" (promoted). */
  inputContract: ContractId;
  input: unknown;
  inputDigest: string;
}

/**
 * The three-armed reservation result:
 * - "cached"   — a success already exists for the key: reuse it, execute nothing.
 * - "terminal" — a previous FENCED attempt exhausted its item or shard scope.
 *                Item scope replays stop at this node; shard scope is surfaced
 *                back to failShard without another invocation.
 * - "reserved" — an attempt slot is reserved; `attempt` is the 1-based attempt
 *                number (prior attempts + 1) surviving crashes, so the retry
 *                budget is enforced across reclaims. `previousFailure`, when
 *                present, lets a lowered-budget replay preserve item-vs-shard
 *                routing without inventing an item dead letter.
 */
export type StageFailureScope = "item" | "shard";

export type StagePreparation =
  | { disposition: "cached"; output: unknown; outputDigest: string }
  | {
      disposition: "terminal";
      errorCode: string;
      scope: StageFailureScope;
    }
  | {
      disposition: "reserved";
      executionId: string;
      attempt: number;
      previousFailure?: {
        errorCode: string;
        scope: StageFailureScope;
      };
    };

export interface PersistStageSuccessInput {
  shardId: string;
  leaseToken: string;
  executionId: string;
  idempotencyKey: string;
  runId: string;
  itemId: string;
  nodeId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  outputContract: ContractId;
  output: unknown;
  /** MUST equal digest(output) — the store re-verifies before appending. */
  outputDigest: string;
}

/**
 * `created` false ⇔ a success for the key was already persisted (this call
 * appended NOTHING — no result row, no attempt row, and NO outbox events;
 * outbox events ride exactly-once with the first-created result). The returned
 * output is always the persisted (first) one.
 */
export interface PersistedStageResult {
  output: unknown;
  outputDigest: string;
  created: boolean;
}

/**
 * One transactional-outbox event, appended ATOMICALLY with the stage attempt
 * that produced it (success or failure).
 */
export interface OutboxEventInput {
  eventType: string;
  payload: unknown;
  /** Optional uniqueness key; a duplicate dedupeKey is a LOUD rejection. */
  dedupeKey?: string;
}

export interface DeadLetterInput {
  runId: string;
  itemId: string;
  nodeId: string;
  stage: { id: string; version: number };
  idempotencyKey: string;
  input?: unknown;
  error: { code: string; message: string };
  attempts: number;
  createdAt: string;
}

/**
 * The standalone crash-replay dead-letter append carries the current shard
 * fence and refers to the exact latest nonterminal item-scoped failed attempt
 * for an existing stage execution. Keep coordination credentials outside
 * {@link DeadLetterInput}: that payload also rides inside persistStageFailure,
 * whose outer input is already fenced, and lease tokens are never durable
 * dead-letter evidence.
 */
export interface RecordDeadLetterInput extends DeadLetterInput {
  shardId: string;
  leaseToken: string;
}

// ── Externally fenced stage evidence ──────────────────────────────────────

/**
 * Remove Pipeline's legacy shard-lease pair from a stage-evidence operation
 * and replace it with a host-owned, opaque fence. The engine passes `fence`
 * through by identity and never reads, mutates, renews, or releases it.
 */
type ExternalizeStageFence<TInput, TFence> =
  TInput extends unknown
    ? Omit<TInput, "shardId" | "leaseToken"> & { fence: TFence }
    : never;

export type PrepareBoundStageExecutionInput<TFence> =
  ExternalizeStageFence<PrepareStageExecutionInput, TFence>;
export type PersistBoundStageSuccessInput<TFence> =
  ExternalizeStageFence<PersistStageSuccessInput, TFence>;
export type PersistBoundStageFailureInput<TFence> =
  ExternalizeStageFence<PersistStageFailureInput, TFence>;
export type RecordBoundDeadLetterInput<TFence> =
  ExternalizeStageFence<RecordDeadLetterInput, TFence>;

/**
 * Evidence-only persistence seam for externally fenced execution.
 *
 * This port intentionally contains no claim, heartbeat, release, completion,
 * failure-settlement, defer, or cancellation operation. A host adapter MUST
 * validate its live fence in the same transaction as every append. Rejection
 * should use {@link ExternalFenceRejectedError}; successful completion,
 * parking, cancellation, and lease release remain a separate host
 * transaction after the runner returns.
 */
export interface BoundPipelineEvidenceStore<TFence> {
  prepareStageExecution(
    input: PrepareBoundStageExecutionInput<TFence>
  ): Promise<StagePreparation>;
  persistStageSuccess(
    input: PersistBoundStageSuccessInput<TFence>,
    outboxEvents?: readonly OutboxEventInput[]
  ): Promise<PersistedStageResult>;
  persistStageFailure(
    input: PersistBoundStageFailureInput<TFence>,
    outboxEvents?: readonly OutboxEventInput[]
  ): Promise<void>;
  recordDeadLetter(
    input: RecordBoundDeadLetterInput<TFence>
  ): Promise<{ created: boolean }>;
}

/**
 * The legacy shard-token form of the same evidence-only seam. Kept as a
 * named narrow port so the durable stage executor does not depend on claim,
 * heartbeat, or settlement authority even when called by `runOneShard`.
 */
export type PipelineStageEvidenceStore = Pick<
  PipelineStore,
  | "prepareStageExecution"
  | "persistStageSuccess"
  | "persistStageFailure"
  | "recordDeadLetter"
>;

interface PersistStageFailureBase {
  shardId: string;
  leaseToken: string;
  executionId: string;
  idempotencyKey: string;
  runId: string;
  itemId: string;
  nodeId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  errorCode: string;
  errorMessage?: string;
  retryable: boolean;
  scope: StageFailureScope;
}

/**
 * Item terminalization is inseparable from its dead letter: both append in one
 * fenced transaction. A shard-terminal attempt never creates an item dead
 * letter; it is surfaced back to failShard after a crash/reclaim.
 */
export type PersistStageFailureInput = PersistStageFailureBase & (
  | { scope: "item"; terminal: false; deadLetter?: never }
  | { scope: "item"; terminal: true; deadLetter: DeadLetterInput }
  | { scope: "shard"; terminal: boolean; deadLetter?: never }
);

// ── Auxiliary work leases (inference fences and friends) ──────────────────

export interface AcquireLeaseInput {
  /** Host-chosen lease identity, e.g. "inference:<profileId>:<slot>". */
  leaseKey: string;
  leaseOwner: string;
  leaseDurationMs: number;
  at?: string;
}

export interface WorkLease {
  leaseKey: string;
  leaseOwner: string;
  leaseToken: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface HeartbeatLeaseInput {
  leaseKey: string;
  leaseToken: string;
  extendByMs: number;
  at?: string;
}

export interface ReleaseLeaseInput {
  leaseKey: string;
  leaseToken: string;
}

// ── The port ──────────────────────────────────────────────────────────────

/**
 * The host-neutral pipeline persistence port. See the module header for the
 * two load-bearing invariants (append-only evidence; token-fenced leases).
 *
 * Method-level contracts:
 * - publishDefinition: validates the seal; idempotent when the identical
 *   digest is republished; a DIFFERENT definition under the same
 *   (pipelineId, version) is a LOUD rejection (append-only — no overwrites).
 * - loadDefinition: returns the sealed definition or undefined (never a
 *   partially-validated object).
 * - createRun: one atomic append of run + items + shards (see CreateRunInput);
 *   a duplicate runId is a LOUD rejection.
 * - claimNextShard: returns undefined when nothing is claimable. A shard is
 *   claimable while it has NO conclusive finalization (completed | partial |
 *   failed non-retryable) and no live lease; an EXPIRED lease is silently
 *   replaced (crash reclaim) — the fence, not the claim, protects evidence.
 * - heartbeatShard/completeShard/failShard/deferShard/cancelShard: fenced
 *   (ShardLeaseLostError).
 *   completeShard derives the finalization from persisted evidence
 *   (terminal items vs completed items), appends it once, and releases the
 *   lease; it REQUIRES every member item resolved (all nodes succeeded, or
 *   item terminalized) and rejects premature finalization loudly.
 *   deferShard appends a non-failure yield/requeue outcome and releases the
 *   lease without consuming a stage attempt. cancelShard appends a conclusive
 *   non-failure cancellation and releases the lease.
 * - prepareStageExecution: fenced idempotency-key reservation + cached-result
 *   lookup (see StagePreparation).
 * - persistStageSuccess: fenced; verifies outputDigest; appends attempt +
 *   result + outboxEvents ATOMICALLY (all or nothing — a fencing rejection
 *   appends no event), or returns created:false appending nothing.
 * - persistStageFailure: fenced; appends the failed attempt + outboxEvents
 *   ATOMICALLY. An item-terminal failure requires its dead letter in the same
 *   atomic append; shard-scoped failures are non-terminal at the item and
 *   finalize through failShard.
 * - recordDeadLetter: fenced; requires an existing execution whose exact
 *   latest attempt is a nonterminal item-scoped failure; append-once per
 *   idempotencyKey; created:false when the key is already dead-lettered (the
 *   exactly-once guarantee under replays). The fence is checked before the
 *   idempotent no-op.
 * - putArtifact: verifies the envelope seal; content-addressed and idempotent
 *   (same digest twice is a no-op returning the same ref).
 * - acquireLease: undefined when contended (live lease under another token);
 *   expired leases are replaced. heartbeatLease is fenced
 *   (WorkLeaseLostError). releaseLease: a no-op when the lease is already
 *   gone, but a LOUD WorkLeaseLostError when the lease exists under a
 *   DIFFERENT token (never release someone else's fence).
 */
export interface PipelineStore {
  publishDefinition(definition: PipelineDefinition): Promise<void>;
  loadDefinition(pipelineId: string, version: number): Promise<PipelineDefinition | undefined>;

  createRun(input: CreateRunInput): Promise<void>;

  claimNextShard(input: ClaimNextShardInput): Promise<ShardClaim | undefined>;
  heartbeatShard(input: HeartbeatShardInput): Promise<void>;
  completeShard(input: CompleteShardInput): Promise<ShardFinalization>;
  failShard(input: FailShardInput): Promise<void>;
  deferShard(input: DeferShardInput): Promise<void>;
  cancelShard(input: CancelShardInput): Promise<void>;

  prepareStageExecution(input: PrepareStageExecutionInput): Promise<StagePreparation>;
  persistStageSuccess(input: PersistStageSuccessInput, outboxEvents?: readonly OutboxEventInput[]): Promise<PersistedStageResult>;
  persistStageFailure(input: PersistStageFailureInput, outboxEvents?: readonly OutboxEventInput[]): Promise<void>;
  recordDeadLetter(input: RecordDeadLetterInput): Promise<{ created: boolean }>;

  putArtifact(envelope: ArtifactEnvelope): Promise<ArtifactRef>;
  getArtifact(ref: ArtifactRef): Promise<ArtifactEnvelope | undefined>;

  acquireLease(input: AcquireLeaseInput): Promise<WorkLease | undefined>;
  heartbeatLease(input: HeartbeatLeaseInput): Promise<void>;
  releaseLease(input: ReleaseLeaseInput): Promise<void>;
}

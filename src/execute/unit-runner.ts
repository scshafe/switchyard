// execute/unit-runner.ts — v2 per-node queue runner and its narrow N2 store seam.
//
// N3's UnitStore implements this structural capability. The sole successful
// position-changing mutation is settleTurn: journey append, output artifact,
// edge evaluation, join progress, successor enqueue, outbox append, and lease
// release are one store-owned transaction. The runner never computes or accepts
// successors and never exposes store/admission authority to a node body.

import { types as nodeTypes } from "node:util";

import {
  validateArtifactEnvelope,
  type ArtifactEnvelope
} from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import { compileGraph } from "../graph/compile.js";
import {
  validateGraphDefinition,
  type GraphDefinition,
  type MissionPipelineNode,
  type MissionPipelineNodeRef
} from "../graph/definition.js";
import {
  assertIdentifier,
  assertSafePositiveInt,
  assertSha256Hex,
  typeName
} from "../internal/guards.js";
import {
  captureCapabilityMethod,
  captureCapabilityRecord,
  captureDenseArrayItems
} from "../internal/capability.js";
import {
  assertEvidenceString,
  deepFrozenClone
} from "../internal/evidence.js";
import { snapshotGraphValidationData } from "../graph/limits.js";
import { classifyExecutionFailure } from "./failure.js";
import {
  ENGINE_JOIN_UNSATISFIABLE_OUTCOME,
  snapshotNodeTurnCompletion,
  validateNodeTurnCompletion,
  type CallbackNodeEvent,
  type HumanNodeDecision,
  type NodeTurnCompletion,
  type WorkerNodeTurnContext
} from "./ports.js";
import {
  executeNodeTurnAttempt,
  isNodeTurnInvocationUncertainError,
  nodeExecutionFingerprint,
  nodeTurnCompletionDigest,
  nodeTurnIdempotencyKey,
  nodeTurnResultErrorUsage,
  WorkerNodeKindError,
  type WorkerNodePorts
} from "./turn.js";

const DateConstructor = Date;
const dateParse = Date.parse;
const datePrototype = Date.prototype;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;

export const NODE_TURN_USAGE_EVENT_TYPE = "node_turn_usage_receipt" as const;
export const NODE_TURN_USAGE_EVENT_SCHEMA_VERSION =
  "node-turn-usage-receipt-event.v1" as const;
export const MAX_TURN_BATCH_SIZE = 256;
export const MAX_TURN_OUTBOX_EVENTS = 1_024;

export interface ClaimedUnitTurn {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly graph: GraphDefinition;
  readonly inputArtifact: ArtifactEnvelope;
  /** Short-lived opaque fence. It is never exposed to a node body. */
  readonly leaseToken: string;
  readonly executionIdentityDigest?: string;
}

export interface ClaimUnitTurnsInput {
  readonly principalId: string;
  readonly leaseOwner: string;
  readonly batch: number;
  readonly nodeId?: string;
}

export interface ClaimExternalUnitTurnInput {
  readonly principalId: string;
  readonly kind: "human" | "callback";
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  /** Exact caller evidence the lease (or settled recovery) is authorized for. */
  readonly actorId: string;
  readonly completionDigest: string;
  readonly outboxEventDigests: readonly string[];
}

export type ExternalUnitTurnInspection = Omit<ClaimedUnitTurn, "leaseToken">;

export interface InspectExternalUnitTurnInput {
  readonly principalId: string;
  readonly kind: "human" | "callback";
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
}

export interface SettledExternalUnitTurn {
  readonly disposition: "settled";
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly actorId: string;
  readonly completionDigest: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly settlementDigest: string;
  readonly committedOutboxEventDigests: readonly string[];
}

export type ExternalUnitTurnClaimResult =
  | {
      readonly disposition: "claimed";
      readonly claim: ClaimedUnitTurn;
    }
  | SettledExternalUnitTurn;

export interface HeartbeatTurnInput {
  readonly queueId: string;
  readonly leaseToken: string;
  readonly extendByMs: number;
  readonly at: string;
}

export interface PrepareTurnAttemptInput {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly leaseToken: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly fingerprint: string;
  readonly inputDigest: string;
  readonly maxAttempts: number;
  readonly executionIdentityDigest?: string;
}

interface PreparedAttemptIdentity {
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
}

export type TurnAttemptPreparation =
  | ({
      readonly disposition: "reserved";
    } & PreparedAttemptIdentity)
  | ({
      readonly disposition: "cached";
      readonly completion: NodeTurnCompletion;
      readonly completionDigest: string;
      readonly startedAt: string;
      readonly settledAt: string;
    } & PreparedAttemptIdentity)
  | {
      readonly disposition: "terminal";
      readonly errorCode: string;
      readonly attempts: number;
    };

export interface CacheTurnCompletionInput extends PreparedAttemptIdentity {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly leaseToken: string;
  readonly completion: NodeTurnCompletion;
  readonly completionDigest: string;
  readonly startedAt: string;
  readonly settledAt: string;
}

export interface CacheTurnCompletionResult {
  readonly created: boolean;
  /** Authoritative cache row, including timestamps, on both result arms. */
  readonly completion: NodeTurnCompletion;
  readonly completionDigest: string;
  readonly startedAt: string;
  readonly settledAt: string;
}

export interface TurnOutboxEventInput {
  readonly eventType: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
}

export interface RetrySafeTurnOutboxEvents
  extends ReadonlyArray<TurnOutboxEventInput> {
  acknowledge(): void;
}

export type TurnOutboxEvents =
  | readonly TurnOutboxEventInput[]
  | RetrySafeTurnOutboxEvents;

export interface RecordTurnFailureInput extends PreparedAttemptIdentity {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly leaseToken: string;
  readonly startedAt: string;
  readonly failedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  /**
   * True means this queued occurrence atomically appends failed-attempt and
   * dead-letter evidence, releases its lease, marks only its outbound offers
   * impossible, and updates affected join progress. Other queues for the same
   * unit remain live.
   */
  readonly terminal: boolean;
  readonly usage: readonly UsageReceipt[];
  readonly failureDigest: string;
}

export interface RecordTurnFailureResult {
  readonly created: boolean;
  readonly failureDigest: string;
  /** Required on `created: false`, including an exact empty `[]` batch. */
  readonly committedOutboxEventDigests?: readonly string[];
}

export interface SettleTurnInput extends PreparedAttemptIdentity {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly leaseToken: string;
  readonly principalId: string;
  readonly actorId?: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly completion: NodeTurnCompletion;
  readonly completionDigest: string;
  /** Exact conflict seal for completion + attribution + journey timestamps. */
  readonly settlementDigest: string;
}

export interface SettleTurnResult {
  readonly created: boolean;
  readonly completionDigest: string;
  readonly settlementDigest: string;
  /** Required on `created: false`, including an exact empty `[]` batch. */
  readonly committedOutboxEventDigests?: readonly string[];
}

/**
 * N2's deliberately narrow execution-side seam. Queue semantics and all
 * implementations arrive in N3; bodies never receive this capability.
 *
 * Durable attempt state machine:
 *
 * - a new queue occurrence reserves its current `(attemptNumber,
 *   attemptIndex)`; reclaim before failure/cache MUST return that exact
 *   unresolved reservation and key;
 * - `cacheTurnCompletion` and `recordTurnFailure` are mutually exclusive for
 *   one reservation and conflicting repeats fail loudly;
 * - only a committed nonterminal failure advances to another reservation:
 *   queue-local attemptIndex increments exactly once, while the newly
 *   allocated global per-unit/node attemptNumber is strictly greater and may
 *   skip values allocated concurrently to another queued occurrence;
 * - terminal failure appends the dead letter and releases the lease in that
 *   same transaction;
 * - cached worker completion changes no journey/queue position and cannot
 *   publish artifacts, journey, joins, queues, or outbox. Worker `settleTurn`
 *   MUST require that exact cached completion;
 * - external turns validate before claiming and settle a reserved attempt
 *   directly, because their submitted decision/event is already the body
 *   result. `settleTurn` remains the sole successful position change.
 */
export interface TurnExecutionStore {
  /**
   * Coordination only: extends an active worker lease under the exact fence.
   * It never appends a journey entry, consumes an attempt, or creates routing.
   */
  heartbeatTurn(input: HeartbeatTurnInput): Promise<void>;
  prepareTurnAttempt(input: PrepareTurnAttemptInput): Promise<TurnAttemptPreparation>;
  cacheTurnCompletion(input: CacheTurnCompletionInput): Promise<CacheTurnCompletionResult>;
  recordTurnFailure(
    input: RecordTurnFailureInput,
    outboxEvents?: TurnOutboxEvents
  ): Promise<RecordTurnFailureResult>;
  settleTurn(
    input: SettleTurnInput,
    outboxEvents?: TurnOutboxEvents
  ): Promise<SettleTurnResult>;
}

export interface WorkerTurnRunnerStore extends TurnExecutionStore {
  claimUnitTurns(input: ClaimUnitTurnsInput): Promise<readonly ClaimedUnitTurn[]>;
}

export interface ExternalTurnRunnerStore
  extends Pick<TurnExecutionStore, "prepareTurnAttempt" | "settleTurn"> {
  /**
   * Read-only validation snapshot; it must not acquire or extend a lease. It
   * MUST retain and return the sealed graph/input metadata for both a queued
   * occurrence and an already-settled occurrence so exact response-loss
   * retries can reach `claimExternalUnitTurn.disposition = "settled"`.
   */
  inspectExternalUnitTurn(
    input: InspectExternalUnitTurnInput
  ): Promise<ExternalUnitTurnInspection | undefined>;
  /**
   * Acquire an exact-request lease, or recover an already-settled exact
   * completion. A differing actor/completion/outbox batch is a conflict.
   */
  claimExternalUnitTurn(
    input: ClaimExternalUnitTurnInput
  ): Promise<ExternalUnitTurnClaimResult | undefined>;
}

export interface TurnRunnerStore
  extends WorkerTurnRunnerStore, ExternalTurnRunnerStore {}

const leaseLostErrors = new WeakSet<object>();
const conflictErrors = new WeakSet<object>();
const heartbeatErrors = new WeakSet<object>();
const bodyInvocationErrors = new WeakSet<object>();
const bodyInvocationCauses = new WeakMap<object, unknown>();

class BodyInvocationRejected extends Error {
  constructor(cause: unknown) {
    super("Node body invocation rejected");
    this.name = "BodyInvocationRejected";
    bodyInvocationErrors.add(this);
    bodyInvocationCauses.set(this, cause);
    Object.freeze(this);
  }
}

/** Store adapters throw this exact type for an expired/reclaimed queue fence. */
export class TurnLeaseLostError extends Error {
  readonly code = "turn_lease_lost";
  readonly queueId: string;

  constructor(queueId: string) {
    super(`Unit turn lease is missing, expired, or fenced: ${queueId}`);
    this.name = "TurnLeaseLostError";
    this.queueId = queueId;
    leaseLostErrors.add(this);
  }
}

/** Same attempt identity produced contradictory completion/failure evidence. */
export class TurnEvidenceConflictError extends Error {
  readonly code = "turn_evidence_conflict";

  constructor(message: string) {
    super(message);
    this.name = "TurnEvidenceConflictError";
    conflictErrors.add(this);
  }
}

/** A heartbeat failed without a typed stale-fence proof; never a node failure. */
export class TurnLeaseHeartbeatError extends Error {
  readonly code = "turn_lease_heartbeat_failed";

  constructor(cause: unknown) {
    super("Unit turn lease heartbeat failed", { cause });
    this.name = "TurnLeaseHeartbeatError";
    heartbeatErrors.add(this);
    Object.freeze(this);
  }
}

export type TurnAttemptEvidenceOperation =
  | "assemble_completion"
  | "assemble_failure"
  | "assemble_settlement"
  | "claim_worker"
  | "claim_external"
  | "prepare"
  | "cache_completion"
  | "record_failure";

/** An evidence operation may have committed; only durable recovery may decide. */
export class TurnAttemptPersistenceUncertainError extends Error {
  readonly code = "turn_attempt_persistence_uncertain";
  readonly operation: TurnAttemptEvidenceOperation;

  constructor(operation: TurnAttemptEvidenceOperation, cause: unknown) {
    super(`Node-turn attempt evidence response is unavailable or untrustworthy: ${operation}`, {
      cause
    });
    this.name = "TurnAttemptPersistenceUncertainError";
    this.operation = operation;
    Object.freeze(this);
  }
}

/** settleTurn may have committed. Never translate this into a failed attempt. */
export class TurnSettlementUncertainError extends Error {
  readonly code = "turn_settlement_uncertain";

  constructor(cause: unknown) {
    super("Node-turn settlement response is unavailable or untrustworthy", { cause });
    this.name = "TurnSettlementUncertainError";
    Object.freeze(this);
  }
}

export class TurnAuthorityError extends Error {
  readonly code = "turn_principal_rejected";

  constructor(nodeId: string, expected: string, actual: string) {
    super(
      `node ${nodeId} requires authenticated principal ${expected}; received ${actual}`
    );
    this.name = "TurnAuthorityError";
    Object.freeze(this);
  }
}

export class TurnOutboxEvidenceNotCommittedError extends Error {
  readonly code = "turn_outbox_evidence_not_committed";

  constructor() {
    super(
      "a prior turn writer did not prove the exact submitted outbox batch committed"
    );
    this.name = "TurnOutboxEvidenceNotCommittedError";
    Object.freeze(this);
  }
}

function isBrandedError(value: unknown, brand: WeakSet<object>): boolean {
  return value !== null && typeof value === "object" && brand.has(value);
}

function isCoordinationRejection(value: unknown): boolean {
  return isBrandedError(value, leaseLostErrors)
    || isBrandedError(value, conflictErrors)
    || isBrandedError(value, heartbeatErrors);
}

function capturedBodyInvocationCause(
  value: unknown
): { readonly captured: false } | { readonly captured: true; readonly cause: unknown } {
  if (
    value !== null
    && (typeof value === "object" || typeof value === "function")
    && bodyInvocationErrors.has(value)
  ) {
    return Object.freeze({ captured: true as const, cause: bodyInvocationCauses.get(value) });
  }
  return Object.freeze({ captured: false as const });
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean (got ${typeName(value)})`);
  }
  return value;
}

function frozenNullRecord<T extends object>(value: T): T {
  return Object.freeze(
    Object.assign(Object.create(null) as object, value)
  ) as T;
}

function assertIsoTimestamp(value: unknown, label: string): string {
  const epochMs = typeof value === "string"
    ? Reflect.apply(dateParse, DateConstructor, [value])
    : Number.NaN;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(epochMs)
    || Reflect.apply(dateToISOString, new DateConstructor(epochMs), []) !== value
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function assertTimestampOrder(
  startedAtRaw: unknown,
  endedAtRaw: unknown,
  startedLabel: string,
  endedLabel: string
): { readonly startedAt: string; readonly endedAt: string } {
  const startedAt = assertIsoTimestamp(startedAtRaw, startedLabel);
  const endedAt = assertIsoTimestamp(endedAtRaw, endedLabel);
  if (
    Reflect.apply(dateParse, DateConstructor, [endedAt])
    < Reflect.apply(dateParse, DateConstructor, [startedAt])
  ) {
    throw new Error(`${endedLabel} must be at or after ${startedLabel}`);
  }
  return Object.freeze({ startedAt, endedAt });
}

function nowIso(now: () => Date): string {
  const value = now();
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== datePrototype
  ) {
    throw new Error("node turn clock must return a valid non-Proxy Date");
  }
  let epochMs: number;
  try {
    epochMs = Reflect.apply(dateGetTime, value, []);
  } catch {
    throw new Error("node turn clock must return a valid non-Proxy Date");
  }
  if (!Number.isFinite(epochMs)) {
    throw new Error("node turn clock must return a valid non-Proxy Date");
  }
  return Reflect.apply(dateToISOString, value, []);
}

function captureClaim(value: unknown, label = "claimed unit turn"): ClaimedUnitTurn {
  const raw = captureCapabilityRecord(
    value,
    [
      "queueId",
      "unitId",
      "nodeId",
      "graph",
      "inputArtifact",
      "leaseToken",
      "executionIdentityDigest"
    ],
    ["queueId", "unitId", "nodeId", "graph", "inputArtifact", "leaseToken"],
    label
  );
  const graph = validateGraphDefinition(raw.graph);
  const nodeId = assertIdentifier(raw.nodeId, `${label}.nodeId`);
  if (compileGraph(graph).nodesById[nodeId] === undefined) {
    throw new Error(`${label}: graph does not contain claimed node ${nodeId}`);
  }
  return Object.freeze({
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId,
    graph,
    inputArtifact: validateArtifactEnvelope(raw.inputArtifact),
    leaseToken: assertEvidenceString(raw.leaseToken, `${label}.leaseToken`),
    ...(raw.executionIdentityDigest === undefined
      ? {}
      : {
          executionIdentityDigest: assertSha256Hex(
            raw.executionIdentityDigest,
            `${label}.executionIdentityDigest`
          )
        })
  });
}

function captureExternalInspection(
  value: unknown,
  label = "external unit turn inspection"
): ExternalUnitTurnInspection {
  const raw = captureCapabilityRecord(
    value,
    [
      "queueId",
      "unitId",
      "nodeId",
      "graph",
      "inputArtifact",
      "executionIdentityDigest"
    ],
    ["queueId", "unitId", "nodeId", "graph", "inputArtifact"],
    label
  );
  const graph = validateGraphDefinition(raw.graph);
  const nodeId = assertIdentifier(raw.nodeId, `${label}.nodeId`);
  if (compileGraph(graph).nodesById[nodeId] === undefined) {
    throw new Error(`${label}: graph does not contain node ${nodeId}`);
  }
  return Object.freeze({
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId,
    graph,
    inputArtifact: validateArtifactEnvelope(raw.inputArtifact),
    ...(raw.executionIdentityDigest === undefined
      ? {}
      : {
          executionIdentityDigest: assertSha256Hex(
            raw.executionIdentityDigest,
            `${label}.executionIdentityDigest`
          )
        })
  });
}

function claimExecutionIdentityDigest(
  claim: ClaimedUnitTurn | ExternalUnitTurnInspection
): string | undefined {
  return Object.hasOwn(claim, "executionIdentityDigest")
    ? claim.executionIdentityDigest
    : undefined;
}

function artifactBytes(artifact: ArtifactEnvelope): number | undefined {
  return Object.hasOwn(artifact, "bytes") ? artifact.bytes : undefined;
}

function completionUsage(completion: NodeTurnCompletion): readonly UsageReceipt[] {
  return Object.hasOwn(completion, "usage") && completion.usage !== undefined
    ? completion.usage
    : Object.freeze([]);
}

function completionForStore(completion: NodeTurnCompletion): NodeTurnCompletion {
  return frozenNullRecord({
    outcome: completion.outcome,
    ...(Object.hasOwn(completion, "outputArtifact")
      ? { outputArtifact: completion.outputArtifact }
      : {}),
    ...(Object.hasOwn(completion, "usage") ? { usage: completion.usage } : {})
  });
}

function captureWorkerStore(store: unknown): WorkerTurnRunnerStore {
  return Object.freeze({
    claimUnitTurns: captureCapabilityMethod(
      store,
      "claimUnitTurns",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["claimUnitTurns"],
    heartbeatTurn: captureCapabilityMethod(
      store,
      "heartbeatTurn",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["heartbeatTurn"],
    prepareTurnAttempt: captureCapabilityMethod(
      store,
      "prepareTurnAttempt",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["prepareTurnAttempt"],
    cacheTurnCompletion: captureCapabilityMethod(
      store,
      "cacheTurnCompletion",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["cacheTurnCompletion"],
    recordTurnFailure: captureCapabilityMethod(
      store,
      "recordTurnFailure",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["recordTurnFailure"],
    settleTurn: captureCapabilityMethod(
      store,
      "settleTurn",
      "worker turn runner store"
    ) as WorkerTurnRunnerStore["settleTurn"]
  });
}

function captureExternalStore(store: unknown): ExternalTurnRunnerStore {
  return Object.freeze({
    inspectExternalUnitTurn: captureCapabilityMethod(
      store,
      "inspectExternalUnitTurn",
      "external turn runner store"
    ) as ExternalTurnRunnerStore["inspectExternalUnitTurn"],
    claimExternalUnitTurn: captureCapabilityMethod(
      store,
      "claimExternalUnitTurn",
      "external turn runner store"
    ) as ExternalTurnRunnerStore["claimExternalUnitTurn"],
    prepareTurnAttempt: captureCapabilityMethod(
      store,
      "prepareTurnAttempt",
      "external turn runner store"
    ) as ExternalTurnRunnerStore["prepareTurnAttempt"],
    settleTurn: captureCapabilityMethod(
      store,
      "settleTurn",
      "external turn runner store"
    ) as ExternalTurnRunnerStore["settleTurn"]
  });
}

function captureExecutionStore(store: unknown): TurnExecutionStore {
  return Object.freeze({
    heartbeatTurn: captureCapabilityMethod(
      store,
      "heartbeatTurn",
      "turn execution store"
    ) as TurnExecutionStore["heartbeatTurn"],
    prepareTurnAttempt: captureCapabilityMethod(
      store,
      "prepareTurnAttempt",
      "turn execution store"
    ) as TurnExecutionStore["prepareTurnAttempt"],
    cacheTurnCompletion: captureCapabilityMethod(
      store,
      "cacheTurnCompletion",
      "turn execution store"
    ) as TurnExecutionStore["cacheTurnCompletion"],
    recordTurnFailure: captureCapabilityMethod(
      store,
      "recordTurnFailure",
      "turn execution store"
    ) as TurnExecutionStore["recordTurnFailure"],
    settleTurn: captureCapabilityMethod(
      store,
      "settleTurn",
      "turn execution store"
    ) as TurnExecutionStore["settleTurn"]
  });
}

function attemptKey(
  claim: ClaimedUnitTurn | ExternalUnitTurnInspection,
  node: MissionPipelineNode,
  attemptNumber: number
): string {
  const executionIdentityDigest = claimExecutionIdentityDigest(claim);
  return nodeTurnIdempotencyKey({
    unitId: claim.unitId,
    nodeId: node.nodeId,
    attemptNumber,
    nodeRef: node.ref,
    fingerprint: nodeExecutionFingerprint(node),
    inputDigest: claim.inputArtifact.digest,
    ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
  });
}

function captureAttemptIdentity(
  raw: Readonly<Record<string, unknown>>,
  claim: ClaimedUnitTurn | ExternalUnitTurnInspection,
  node: MissionPipelineNode
): PreparedAttemptIdentity {
  const attemptNumber = assertSafePositiveInt(
    raw.attemptNumber,
    "turn preparation.attemptNumber"
  );
  const attemptIndex = assertSafePositiveInt(
    raw.attemptIndex,
    "turn preparation.attemptIndex"
  );
  if (attemptIndex > node.turn.maxAttempts) {
    throw new Error(
      `turn preparation.attemptIndex ${attemptIndex} exceeds node ${node.nodeId} maxAttempts ${node.turn.maxAttempts}`
    );
  }
  const idempotencyKey = assertSha256Hex(
    raw.idempotencyKey,
    "turn preparation.idempotencyKey"
  );
  const expected = attemptKey(claim, node, attemptNumber);
  if (idempotencyKey !== expected) {
    throw new Error(
      `turn preparation idempotency key mismatch for node ${node.nodeId}: supplied ${idempotencyKey} != computed ${expected}`
    );
  }
  return Object.freeze({ attemptNumber, attemptIndex, idempotencyKey });
}

function capturePreparation(
  value: unknown,
  claim: ClaimedUnitTurn,
  node: MissionPipelineNode
): TurnAttemptPreparation {
  const raw = captureCapabilityRecord(
    value,
    [
      "disposition",
      "attemptNumber",
      "attemptIndex",
      "idempotencyKey",
      "completion",
      "completionDigest",
      "startedAt",
      "settledAt",
      "errorCode",
      "attempts"
    ],
    ["disposition"],
    "turn preparation"
  );
  const assertArmKeys = (allowed: readonly string[]): void => {
    const permitted = new Set(allowed);
    const extras = Object.keys(raw).filter((key) => !permitted.has(key));
    if (extras.length > 0) {
      throw new Error(
        `turn preparation ${String(raw.disposition)} disposition has unsupported key(s) ${extras.map((key) => JSON.stringify(key)).join(", ")}`
      );
    }
  };
  if (raw.disposition === "terminal") {
    assertArmKeys(["disposition", "errorCode", "attempts"]);
    for (const key of ["errorCode", "attempts"] as const) {
      if (!Object.hasOwn(raw, key)) {
        throw new Error(`turn preparation.${key} is required for terminal disposition`);
      }
    }
    const attempts = assertSafePositiveInt(
      raw.attempts,
      "turn preparation.attempts"
    );
    if (attempts > node.turn.maxAttempts) {
      throw new Error(
        `turn preparation.attempts ${attempts} exceeds node ${node.nodeId} maxAttempts ${node.turn.maxAttempts}`
      );
    }
    return Object.freeze({
      disposition: "terminal" as const,
      errorCode: assertIdentifier(raw.errorCode, "turn preparation.errorCode"),
      attempts
    });
  }
  if (raw.disposition !== "reserved" && raw.disposition !== "cached") {
    throw new Error(
      `turn preparation.disposition must be "reserved" | "cached" | "terminal"`
    );
  }
  for (const key of ["attemptNumber", "attemptIndex", "idempotencyKey"] as const) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`turn preparation.${key} is required for ${raw.disposition}`);
    }
  }
  const identity = captureAttemptIdentity(raw, claim, node);
  if (raw.disposition === "reserved") {
    assertArmKeys(["disposition", "attemptNumber", "attemptIndex", "idempotencyKey"]);
    return Object.freeze({ disposition: "reserved" as const, ...identity });
  }
  assertArmKeys([
    "disposition",
    "attemptNumber",
    "attemptIndex",
    "idempotencyKey",
    "completion",
    "completionDigest",
    "startedAt",
    "settledAt"
  ]);
  for (const key of ["completion", "completionDigest", "startedAt", "settledAt"] as const) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`turn preparation.${key} is required for cached disposition`);
    }
  }
  const completion = validateNodeTurnCompletion(
    node,
    snapshotNodeTurnCompletion(raw.completion, "cached node turn completion"),
    "cached node turn completion"
  );
  const completionDigest = assertSha256Hex(
    raw.completionDigest,
    "turn preparation.completionDigest"
  );
  const computed = nodeTurnCompletionDigest(completion);
  if (completionDigest !== computed) {
    throw new TurnEvidenceConflictError(
      `cached completion digest conflicts for node ${node.nodeId}: stored ${completionDigest} != computed ${computed}`
    );
  }
  const timestamps = assertTimestampOrder(
    raw.startedAt,
    raw.settledAt,
    "turn preparation.startedAt",
    "turn preparation.settledAt"
  );
  return Object.freeze({
    disposition: "cached" as const,
    ...identity,
    completion,
    completionDigest,
    startedAt: timestamps.startedAt,
    settledAt: timestamps.endedAt
  });
}

async function prepareAttempt(
  store: Pick<TurnExecutionStore, "prepareTurnAttempt">,
  claim: ClaimedUnitTurn,
  node: MissionPipelineNode,
  priorNonterminalAttempt?: PreparedAttemptIdentity
): Promise<TurnAttemptPreparation> {
  const executionIdentityDigest = claimExecutionIdentityDigest(claim);
  let result: unknown;
  try {
    result = await store.prepareTurnAttempt(frozenNullRecord({
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: node.nodeId,
      leaseToken: claim.leaseToken,
      nodeRef: node.ref,
      fingerprint: nodeExecutionFingerprint(node),
      inputDigest: claim.inputArtifact.digest,
      maxAttempts: node.turn.maxAttempts,
      ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
    }));
  } catch (error) {
    if (isCoordinationRejection(error)) throw error;
    throw new TurnAttemptPersistenceUncertainError("prepare", error);
  }
  try {
    const prepared = capturePreparation(result, claim, node);
    if (priorNonterminalAttempt !== undefined) {
      if (prepared.disposition === "terminal") {
        throw new Error(
          `turn preparation became terminal after a committed nonterminal failure for queue ${claim.queueId}`
        );
      }
      if (
        prepared.attemptIndex !== priorNonterminalAttempt.attemptIndex + 1
        || prepared.attemptNumber <= priorNonterminalAttempt.attemptNumber
      ) {
        throw new Error(
          `turn preparation did not advance after a committed nonterminal failure for queue ${claim.queueId}: `
          + `previous (${priorNonterminalAttempt.attemptNumber}, ${priorNonterminalAttempt.attemptIndex}), `
          + `next (${prepared.attemptNumber}, ${prepared.attemptIndex})`
        );
      }
    }
    return prepared;
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("prepare", error);
  }
}

function captureCacheResult(
  value: unknown,
  node: MissionPipelineNode,
  expectedDigest: string
): CacheTurnCompletionResult {
  const raw = captureCapabilityRecord(
    value,
    ["created", "completion", "completionDigest", "startedAt", "settledAt"],
    ["created", "completion", "completionDigest", "startedAt", "settledAt"],
    "cache turn completion result"
  );
  const completion = validateNodeTurnCompletion(
    node,
    snapshotNodeTurnCompletion(
      raw.completion,
      "cache turn completion result.completion"
    ),
    "cache turn completion result.completion"
  );
  const completionDigest = assertSha256Hex(
    raw.completionDigest,
    "cache turn completion result.completionDigest"
  );
  const computedDigest = nodeTurnCompletionDigest(completion);
  if (completionDigest !== computedDigest || completionDigest !== expectedDigest) {
    throw new TurnEvidenceConflictError(
      `cached turn completion conflicts: submitted ${expectedDigest}, stored ${completionDigest}, computed ${computedDigest}`
    );
  }
  const timestamps = assertTimestampOrder(
    raw.startedAt,
    raw.settledAt,
    "cache turn completion result.startedAt",
    "cache turn completion result.settledAt"
  );
  return Object.freeze({
    created: assertBoolean(raw.created, "cache turn completion result.created"),
    completion,
    completionDigest,
    startedAt: timestamps.startedAt,
    settledAt: timestamps.endedAt
  });
}

async function cacheCompletion(
  store: TurnExecutionStore,
  claim: ClaimedUnitTurn,
  node: MissionPipelineNode,
  attempt: PreparedAttemptIdentity,
  completion: NodeTurnCompletion,
  completionDigest: string,
  startedAt: string,
  settledAt: string
): Promise<CacheTurnCompletionResult> {
  let rawResult: unknown;
  try {
    rawResult = await store.cacheTurnCompletion(frozenNullRecord({
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: node.nodeId,
      leaseToken: claim.leaseToken,
      ...attempt,
      completion: completionForStore(completion),
      completionDigest,
      startedAt,
      settledAt
    }));
  } catch (error) {
    if (isCoordinationRejection(error)) throw error;
    throw new TurnAttemptPersistenceUncertainError("cache_completion", error);
  }
  try {
    return captureCacheResult(rawResult, node, completionDigest);
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("cache_completion", error);
  }
}

interface CapturedTurnOutboxEvents {
  readonly events: readonly TurnOutboxEventInput[];
  readonly acknowledge?: () => void;
}

function captureTurnOutboxEvents(
  value: TurnOutboxEvents,
  label: string
): CapturedTurnOutboxEvents {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} must be a plain non-Proxy array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new Error(`${label}.length must be a data property`);
  }
  const length = lengthDescriptor.value;
  if (length > MAX_TURN_OUTBOX_EVENTS) {
    throw new Error(
      `${label} must contain at most ${MAX_TURN_OUTBOX_EVENTS} events (got ${length})`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const acknowledgeDescriptor = Object.hasOwn(descriptors, "acknowledge")
    ? descriptors.acknowledge
    : undefined;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string"
      || (
        key !== "length"
        && key !== "acknowledge"
        && !/^(0|[1-9][0-9]*)$/.test(key)
      )
    )
    || keys.length !== length + 1 + (acknowledgeDescriptor === undefined ? 0 : 1)
  ) {
    throw new Error(`${label} must be dense and have no unsupported extra keys`);
  }
  let acknowledge: (() => void) | undefined;
  if (acknowledgeDescriptor !== undefined) {
    if (
      !("value" in acknowledgeDescriptor)
      || typeof acknowledgeDescriptor.value !== "function"
      || nodeTypes.isProxy(acknowledgeDescriptor.value)
      || acknowledgeDescriptor.enumerable !== false
      || acknowledgeDescriptor.configurable !== false
      || acknowledgeDescriptor.writable !== false
    ) {
      throw new Error(
        `${label}.acknowledge must be a hardened non-enumerable data-property function`
      );
    }
    const method = acknowledgeDescriptor.value as () => void;
    acknowledge = () => Reflect.apply(method, value, []);
  }
  const events = Object.freeze(
    Array.from({ length }, (_, index) => {
      const descriptor = Object.hasOwn(descriptors, String(index))
        ? descriptors[String(index)]
        : undefined;
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) {
        throw new Error(`${label}[${index}] must be an enumerable data property`);
      }
      const event = captureCapabilityRecord(
        snapshotGraphValidationData(descriptor.value, `${label}[${index}]`),
        ["eventType", "payload", "dedupeKey"],
        ["eventType", "payload"],
        `${label}[${index}]`
      );
      return frozenNullRecord({
        eventType: assertEvidenceString(
          event.eventType,
          `${label}[${index}].eventType`
        ),
        payload: deepFrozenClone(event.payload, `${label}[${index}].payload`),
        ...(Object.hasOwn(event, "dedupeKey")
          ? {
              dedupeKey: assertEvidenceString(
                event.dedupeKey,
                `${label}[${index}].dedupeKey`
              )
            }
          : {})
      });
    })
  );
  return Object.freeze({
    events,
    ...(acknowledge === undefined ? {} : { acknowledge })
  });
}

export function turnOutboxEventDigest(eventRaw: unknown): string {
  const captured = captureTurnOutboxEvents(
    [eventRaw] as readonly TurnOutboxEventInput[],
    "turn outbox event batch"
  ).events[0]!;
  return digest({
    eventType: captured.eventType,
    payload: captured.payload,
    ...(Object.hasOwn(captured, "dedupeKey")
      ? { dedupeKey: captured.dedupeKey }
      : {})
  });
}

function receiptEvents(
  claim: ClaimedUnitTurn,
  attempt: PreparedAttemptIdentity,
  usage: readonly UsageReceipt[],
  disposition: "succeeded" | "failed"
): readonly TurnOutboxEventInput[] {
  return Object.freeze(
    usage.map((receipt, receiptIndex) => Object.freeze({
      eventType: NODE_TURN_USAGE_EVENT_TYPE,
      payload: Object.freeze({
        schemaVersion: NODE_TURN_USAGE_EVENT_SCHEMA_VERSION,
        unitId: claim.unitId,
        nodeId: claim.nodeId,
        attemptNumber: attempt.attemptNumber,
        attemptIndex: attempt.attemptIndex,
        idempotencyKey: attempt.idempotencyKey,
        receiptIndex,
        disposition,
        receipt
      }),
      dedupeKey: digest({
        eventType: NODE_TURN_USAGE_EVENT_TYPE,
        idempotencyKey: attempt.idempotencyKey,
        receiptIndex
      })
    }))
  );
}

function combineOutbox(
  automatic: readonly TurnOutboxEventInput[],
  supplied: TurnOutboxEvents | undefined,
  label: string
): CapturedTurnOutboxEvents {
  const automaticBatch = captureTurnOutboxEvents(automatic, `${label} automatic`);
  const suppliedBatch: CapturedTurnOutboxEvents = supplied === undefined
    ? Object.freeze({ events: Object.freeze([]) })
    : captureTurnOutboxEvents(supplied, `${label} supplied`);
  if (automaticBatch.events.length + suppliedBatch.events.length > MAX_TURN_OUTBOX_EVENTS) {
    throw new Error(
      `${label} must contain at most ${MAX_TURN_OUTBOX_EVENTS} total events`
    );
  }
  return Object.freeze({
    events: Object.freeze([...automaticBatch.events, ...suppliedBatch.events]),
    ...(Object.hasOwn(suppliedBatch, "acknowledge")
      ? { acknowledge: suppliedBatch.acknowledge }
      : {})
  });
}

function capturedOutboxAcknowledge(
  outbox: CapturedTurnOutboxEvents
): (() => void) | undefined {
  return Object.hasOwn(outbox, "acknowledge") ? outbox.acknowledge : undefined;
}

function acknowledgeOutbox(acknowledge: (() => void) | undefined): void {
  try {
    acknowledge?.();
  } catch {
    // Durable evidence already committed. An in-memory cursor failure cannot
    // undo it and must not make the engine append contradictory evidence.
  }
}

function assertExactOutboxProof(
  created: boolean,
  committed: readonly string[] | undefined,
  submitted: readonly string[]
): void {
  if (created) return;
  if (
    committed === undefined
    || committed.length !== submitted.length
    || committed.some((value, index) => value !== submitted[index])
  ) {
    throw new TurnOutboxEvidenceNotCommittedError();
  }
}

function captureDigestList(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return Object.freeze(
    captureDenseArrayItems(value, label, MAX_TURN_OUTBOX_EVENTS).map((entry, index) =>
      assertSha256Hex(entry, `${label}[${index}]`)
    )
  );
}

function failureUsage(
  error: unknown,
  node: MissionPipelineNode,
  attempt: PreparedAttemptIdentity
): readonly UsageReceipt[] {
  if (node.kind !== "model" && node.kind !== "agent") return Object.freeze([]);
  return nodeTurnResultErrorUsage(
    error,
    node.nodeId,
    attempt.idempotencyKey
  ) ?? Object.freeze([]);
}

function safeFailureMessage(error: unknown, fallback: string): string {
  if (
    error === null
    || typeof error !== "object"
    || nodeTypes.isProxy(error)
  ) return fallback;
  const descriptor = Object.getOwnPropertyDescriptor(error, "message");
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
  ) return fallback;
  const message = descriptor.value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000);
  return message.length === 0 ? fallback : message;
}

function failureDigest(input: Omit<RecordTurnFailureInput, "failureDigest">): string {
  // A reclaim presents a different coordination fence for the same durable
  // attempt. Lease tokens therefore never enter immutable evidence identity.
  return digest({
    queueId: input.queueId,
    unitId: input.unitId,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
    attemptIndex: input.attemptIndex,
    idempotencyKey: input.idempotencyKey,
    startedAt: input.startedAt,
    failedAt: input.failedAt,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    retryable: input.retryable,
    terminal: input.terminal,
    usage: input.usage
  });
}

interface CapturedTurnFailure {
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly usage: readonly UsageReceipt[];
}

function captureTurnFailure(
  error: unknown,
  attempt: PreparedAttemptIdentity,
  maxAttempts: number,
  node: MissionPipelineNode
): CapturedTurnFailure {
  const classified = classifyExecutionFailure(error);
  return Object.freeze({
    errorCode: classified.code,
    errorMessage: safeFailureMessage(error, classified.code),
    retryable: classified.retryable,
    terminal: !classified.retryable || attempt.attemptIndex >= maxAttempts,
    usage: failureUsage(error, node, attempt)
  });
}

function captureFailureResult(
  value: unknown,
  expectedDigest: string
): RecordTurnFailureResult {
  const raw = captureCapabilityRecord(
    value,
    ["created", "failureDigest", "committedOutboxEventDigests"],
    ["created", "failureDigest"],
    "record turn failure result"
  );
  const stored = assertSha256Hex(
    raw.failureDigest,
    "record turn failure result.failureDigest"
  );
  if (stored !== expectedDigest) {
    throw new TurnEvidenceConflictError(
      `failed turn attempt conflicts: submitted ${expectedDigest} != stored ${stored}`
    );
  }
  return Object.freeze({
    created: assertBoolean(raw.created, "record turn failure result.created"),
    failureDigest: stored,
    ...(raw.committedOutboxEventDigests === undefined
      ? {}
      : {
          committedOutboxEventDigests: captureDigestList(
            raw.committedOutboxEventDigests,
            "record turn failure result.committedOutboxEventDigests"
          )!
        })
  });
}

async function recordFailure(
  store: TurnExecutionStore,
  claim: ClaimedUnitTurn,
  attempt: PreparedAttemptIdentity,
  startedAt: string,
  failedAt: string,
  failure: CapturedTurnFailure,
  suppliedOutbox: TurnOutboxEvents | undefined
): Promise<{ readonly terminal: boolean; readonly errorCode: string }> {
  let input: RecordTurnFailureInput;
  let outbox: CapturedTurnOutboxEvents;
  let submittedDigests: readonly string[];
  try {
    assertTimestampOrder(
      startedAt,
      failedAt,
      "failed turn.startedAt",
      "failed turn.failedAt"
    );
    const failureBase = Object.freeze({
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      leaseToken: claim.leaseToken,
      ...attempt,
      startedAt,
      failedAt,
      ...failure
    });
    const sealedFailureDigest = failureDigest(failureBase);
    input = frozenNullRecord({
      ...failureBase,
      failureDigest: sealedFailureDigest
    });
    outbox = combineOutbox(
      receiptEvents(claim, attempt, failure.usage, "failed"),
      suppliedOutbox,
      "failed turn outbox"
    );
    submittedDigests = Object.freeze(outbox.events.map(turnOutboxEventDigest));
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("assemble_failure", error);
  }
  let rawResult: unknown;
  try {
    rawResult = await store.recordTurnFailure(input, outbox.events);
  } catch (recordError) {
    if (isCoordinationRejection(recordError)) throw recordError;
    throw new TurnAttemptPersistenceUncertainError("record_failure", recordError);
  }
  try {
    const result = captureFailureResult(rawResult, input.failureDigest);
    assertExactOutboxProof(
      result.created,
      result.committedOutboxEventDigests,
      submittedDigests
    );
    acknowledgeOutbox(capturedOutboxAcknowledge(outbox));
  } catch (recordError) {
    throw new TurnAttemptPersistenceUncertainError("record_failure", recordError);
  }
  return Object.freeze({
    terminal: failure.terminal,
    errorCode: failure.errorCode
  });
}

function captureSettleResult(
  value: unknown,
  expectedCompletionDigest: string,
  expectedSettlementDigest: string
): SettleTurnResult {
  const raw = captureCapabilityRecord(
    value,
    ["created", "completionDigest", "settlementDigest", "committedOutboxEventDigests"],
    ["created", "completionDigest", "settlementDigest"],
    "settle turn result"
  );
  const stored = assertSha256Hex(raw.completionDigest, "settle turn result.completionDigest");
  if (stored !== expectedCompletionDigest) {
    throw new TurnEvidenceConflictError(
      `settled turn completion conflicts: submitted ${expectedCompletionDigest} != stored ${stored}`
    );
  }
  const storedSettlement = assertSha256Hex(
    raw.settlementDigest,
    "settle turn result.settlementDigest"
  );
  if (storedSettlement !== expectedSettlementDigest) {
    throw new TurnEvidenceConflictError(
      `settled turn evidence conflicts: submitted ${expectedSettlementDigest} != stored ${storedSettlement}`
    );
  }
  return Object.freeze({
    created: assertBoolean(raw.created, "settle turn result.created"),
    completionDigest: stored,
    settlementDigest: storedSettlement,
    ...(raw.committedOutboxEventDigests === undefined
      ? {}
      : {
          committedOutboxEventDigests: captureDigestList(
            raw.committedOutboxEventDigests,
            "settle turn result.committedOutboxEventDigests"
          )!
        })
  });
}

function computeSettlementDigest(input: {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly actorId?: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly completionDigest: string;
}): string {
  return digest({
    queueId: input.queueId,
    unitId: input.unitId,
    nodeId: input.nodeId,
    attemptNumber: input.attemptNumber,
    attemptIndex: input.attemptIndex,
    idempotencyKey: input.idempotencyKey,
    principalId: input.principalId,
    ...(Object.hasOwn(input, "actorId") ? { actorId: input.actorId } : {}),
    startedAt: input.startedAt,
    settledAt: input.settledAt,
    completionDigest: input.completionDigest
  });
}

async function settleCompletion(
  store: Pick<TurnExecutionStore, "settleTurn">,
  claim: ClaimedUnitTurn,
  attempt: PreparedAttemptIdentity,
  principalId: string,
  actorId: string | undefined,
  completion: NodeTurnCompletion,
  completionDigest: string,
  startedAt: string,
  settledAt: string,
  outbox: CapturedTurnOutboxEvents
): Promise<SettleTurnResult> {
  let input: SettleTurnInput;
  let submittedDigests: readonly string[];
  try {
    assertTimestampOrder(
      startedAt,
      settledAt,
      "settled turn.startedAt",
      "settled turn.settledAt"
    );
    const settlementDigest = computeSettlementDigest({
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      ...attempt,
      principalId,
      ...(actorId === undefined ? {} : { actorId }),
      startedAt,
      settledAt,
      completionDigest
    });
    input = frozenNullRecord({
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      leaseToken: claim.leaseToken,
      ...attempt,
      principalId,
      ...(actorId === undefined ? {} : { actorId }),
      startedAt,
      settledAt,
      completion: completionForStore(completion),
      completionDigest,
      settlementDigest
    });
    submittedDigests = Object.freeze(outbox.events.map(turnOutboxEventDigest));
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("assemble_settlement", error);
  }
  let rawResult: unknown;
  try {
    rawResult = await store.settleTurn(input, outbox.events);
  } catch (error) {
    if (isCoordinationRejection(error)) throw error;
    throw new TurnSettlementUncertainError(error);
  }
  try {
    const result = captureSettleResult(
      rawResult,
      completionDigest,
      input.settlementDigest
    );
    assertExactOutboxProof(
      result.created,
      result.committedOutboxEventDigests,
      submittedDigests
    );
    acknowledgeOutbox(capturedOutboxAcknowledge(outbox));
    return result;
  } catch (error) {
    // Includes malformed created:false outbox proof: after settleTurn returned,
    // only durable recovery can distinguish commit from response corruption.
    throw new TurnSettlementUncertainError(error);
  }
}

export interface TurnOutboxContext extends PreparedAttemptIdentity {
  readonly queueId: string;
  readonly unitId: string;
  readonly node: MissionPipelineNode;
  readonly reused: boolean;
}

export interface TurnFailureOutboxContext extends PreparedAttemptIdentity {
  readonly queueId: string;
  readonly unitId: string;
  readonly node: MissionPipelineNode;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly usage: readonly UsageReceipt[];
}

/**
 * Run one physical body attempt while extending only its coordination lease.
 * This interval has no graph/time outcome semantics: a failure merely fences
 * the attempted result, and callback timer nodes remain the sole way for time
 * to affect routing.
 */
export async function runWithTurnHeartbeat<T>(input: {
  readonly store: Pick<TurnExecutionStore, "heartbeatTurn">;
  readonly queueId: string;
  readonly leaseToken: string;
  readonly everyMs: number;
  readonly extendByMs: number;
  readonly now: () => Date;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  const raw = captureCapabilityRecord(
    input,
    ["store", "queueId", "leaseToken", "everyMs", "extendByMs", "now", "operation"],
    ["store", "queueId", "leaseToken", "everyMs", "extendByMs", "now", "operation"],
    "runWithTurnHeartbeat input"
  );
  const heartbeatTurn = captureCapabilityMethod(
    raw.store,
    "heartbeatTurn",
    "turn heartbeat store"
  );
  const queueId = assertEvidenceString(raw.queueId, "runWithTurnHeartbeat input.queueId");
  const leaseToken = assertEvidenceString(
    raw.leaseToken,
    "runWithTurnHeartbeat input.leaseToken"
  );
  const everyMs = assertSafePositiveInt(raw.everyMs, "runWithTurnHeartbeat input.everyMs");
  const extendByMs = assertSafePositiveInt(
    raw.extendByMs,
    "runWithTurnHeartbeat input.extendByMs"
  );
  const now = raw.now;
  const operation = raw.operation;
  if (typeof now !== "function" || nodeTypes.isProxy(now)) {
    throw new Error("runWithTurnHeartbeat input.now must be a non-Proxy function");
  }
  if (typeof operation !== "function" || nodeTypes.isProxy(operation)) {
    throw new Error("runWithTurnHeartbeat input.operation must be a non-Proxy function");
  }
  let heartbeatError: unknown;
  let heartbeatFailed = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = (): Promise<void> => Promise.resolve()
    .then(() => heartbeatTurn(frozenNullRecord({
      queueId,
      leaseToken,
      extendByMs,
      at: nowIso(now as () => Date)
    })));

  // Claiming and attempt preparation may have consumed most of the original
  // lease. Renew under the exact fence before exposing the body capability.
  try {
    await heartbeat();
  } catch (error) {
    if (isBrandedError(error, leaseLostErrors)) throw error;
    throw new TurnLeaseHeartbeatError(error);
  }
  const timer = setInterval(() => {
    if (heartbeatInFlight !== undefined || heartbeatFailed) return;
    heartbeatInFlight = heartbeat()
      .catch((error: unknown) => {
        heartbeatFailed = true;
        heartbeatError = error;
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, everyMs);
  timer.unref();
  let operationResult!: { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };
  try {
    operationResult = {
      ok: true,
      value: await Promise.resolve().then(() => (operation as () => Promise<T>)())
    };
  } catch (error) {
    operationResult = { ok: false, error };
  } finally {
    clearInterval(timer);
    const finalHeartbeat = heartbeatInFlight;
    if (finalHeartbeat !== undefined) await finalHeartbeat;
  }
  if (heartbeatFailed) {
    if (isBrandedError(heartbeatError, leaseLostErrors)) throw heartbeatError;
    throw new TurnLeaseHeartbeatError(heartbeatError);
  }
  if (!operationResult.ok) throw operationResult.error;
  return operationResult.value;
}

export interface RunClaimedUnitTurnInput {
  readonly store: TurnExecutionStore;
  readonly claim: ClaimedUnitTurn;
  /** Host-authenticated authority. It is not caller-authored actor evidence. */
  readonly principalId: string;
  readonly ports: WorkerNodePorts;
  readonly successOutboxEvents?: (
    completion: NodeTurnCompletion,
    context: TurnOutboxContext
  ) => TurnOutboxEvents;
  readonly failureOutboxEvents?: (
    context: TurnFailureOutboxContext
  ) => TurnOutboxEvents;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export type UnitTurnRunResult =
  | {
      readonly status: "succeeded";
      readonly completion: NodeTurnCompletion;
      readonly completionDigest: string;
      readonly idempotencyKey: string;
      readonly attemptNumber: number;
      readonly attemptIndex: number;
      readonly reused: boolean;
    }
  | {
      readonly status: "terminal";
      readonly errorCode: string;
      readonly attempts: number;
    };

/** Execute and atomically settle one already claimed worker turn. */
export async function runClaimedUnitTurn(
  inputRaw: RunClaimedUnitTurnInput
): Promise<UnitTurnRunResult> {
  const raw = captureCapabilityRecord(
    inputRaw,
    [
      "store",
      "claim",
      "principalId",
      "ports",
      "successOutboxEvents",
      "failureOutboxEvents",
      "signal",
      "now"
    ],
    ["store", "claim", "principalId", "ports"],
    "runClaimedUnitTurn input"
  );
  const store = captureExecutionStore(raw.store);
  const claim = captureClaim(raw.claim);
  const compiled = compileGraph(claim.graph);
  const node = compiled.nodesById[claim.nodeId]!;
  if (node.kind === "human" || node.kind === "callback") {
    throw new WorkerNodeKindError(node.nodeId, node.kind);
  }
  const principalId = assertIdentifier(
    raw.principalId,
    "runClaimedUnitTurn input.principalId"
  );
  if (principalId !== node.principal.id) {
    throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
  }
  if (claim.inputArtifact.contractId !== node.input) {
    throw new Error(
      `node ${node.nodeId} input contract mismatch: expected ${node.input}, got ${claim.inputArtifact.contractId}`
    );
  }
  const successOutboxEvents = raw.successOutboxEvents;
  if (
    successOutboxEvents !== undefined
    && (typeof successOutboxEvents !== "function" || nodeTypes.isProxy(successOutboxEvents))
  ) {
    throw new Error("runClaimedUnitTurn input.successOutboxEvents must be a function");
  }
  const failureOutboxEvents = raw.failureOutboxEvents;
  if (
    failureOutboxEvents !== undefined
    && (typeof failureOutboxEvents !== "function" || nodeTypes.isProxy(failureOutboxEvents))
  ) {
    throw new Error("runClaimedUnitTurn input.failureOutboxEvents must be a function");
  }
  const now = raw.now === undefined ? () => new Date() : raw.now;
  if (typeof now !== "function" || nodeTypes.isProxy(now)) {
    throw new Error("runClaimedUnitTurn input.now must be a non-Proxy function");
  }
  const signal = raw.signal;
  if (
    signal !== undefined
    && (
      signal === null
      || typeof signal !== "object"
      || nodeTypes.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype
    )
  ) {
    throw new Error("runClaimedUnitTurn input.signal must be a non-Proxy AbortSignal");
  }

  let priorNonterminalAttempt: PreparedAttemptIdentity | undefined;
  while (true) {
    const prepared = await prepareAttempt(
      store,
      claim,
      node,
      priorNonterminalAttempt
    );
    if (prepared.disposition === "terminal") {
      return Object.freeze({
        status: "terminal" as const,
        errorCode: prepared.errorCode,
        attempts: prepared.attempts
      });
    }
    const attempt: PreparedAttemptIdentity = prepared;
    let completion: NodeTurnCompletion;
    let completionDigest: string;
    let startedAt: string;
    let settledAt: string;
    let reused = prepared.disposition === "cached";

    if (prepared.disposition === "cached") {
      completion = prepared.completion;
      completionDigest = prepared.completionDigest;
      startedAt = prepared.startedAt;
      settledAt = prepared.settledAt;
    } else {
      try {
        startedAt = nowIso(now as () => Date);
      } catch (error) {
        throw new TurnAttemptPersistenceUncertainError("assemble_completion", error);
      }
      const context: WorkerNodeTurnContext = Object.freeze({
        graph: compiled.graph,
        queueId: claim.queueId,
        unitId: claim.unitId,
        nodeId: node.nodeId,
        nodeRef: node.ref,
        attemptNumber: attempt.attemptNumber,
        attemptIndex: attempt.attemptIndex,
        idempotencyKey: attempt.idempotencyKey,
        inputArtifact: Object.freeze({
          contractId: claim.inputArtifact.contractId,
          digest: claim.inputArtifact.digest,
          ...(Object.hasOwn(claim.inputArtifact, "bytes")
            ? { bytes: claim.inputArtifact.bytes }
            : {})
        }),
        ...(signal === undefined ? {} : { signal: signal as AbortSignal })
      });
      try {
        completion = await runWithTurnHeartbeat({
          store,
          queueId: claim.queueId,
          leaseToken: claim.leaseToken,
          everyMs: Math.max(1, Math.floor(node.turn.leaseMs / 3)),
          extendByMs: node.turn.leaseMs,
          now: now as () => Date,
          operation: async () => {
            try {
              return await executeNodeTurnAttempt({
                node,
                context,
                inputArtifact: claim.inputArtifact,
                ports: raw.ports as WorkerNodePorts,
                ...(claimExecutionIdentityDigest(claim) === undefined
                  ? {}
                  : {
                      executionIdentityDigest: claimExecutionIdentityDigest(claim)!
                    })
              });
            } catch (error) {
              throw new BodyInvocationRejected(error);
            }
          }
        });
      } catch (error) {
        const captured = capturedBodyInvocationCause(error);
        if (!captured.captured) {
          // Only runWithTurnHeartbeat/store coordination can reach this arm;
          // every body-thrown value is wrapped under an unforgeable brand.
          throw error;
        }
        const invocationError = captured.cause;
        if (
          node.kind === "agent"
          && isNodeTurnInvocationUncertainError(
            invocationError,
            node.nodeId,
            attempt.idempotencyKey
          )
        ) {
          throw invocationError;
        }
        const failure = captureTurnFailure(
          invocationError,
          attempt,
          node.turn.maxAttempts,
          node
        );
        let supplied: TurnOutboxEvents | undefined;
        let failedAt: string;
        try {
          failedAt = nowIso(now as () => Date);
          supplied = failureOutboxEvents === undefined
            ? undefined
            : (failureOutboxEvents as RunClaimedUnitTurnInput["failureOutboxEvents"])!({
                queueId: claim.queueId,
                unitId: claim.unitId,
                node,
                ...attempt,
                errorCode: failure.errorCode,
                retryable: failure.retryable,
                terminal: failure.terminal,
                usage: failure.usage
              });
        } catch (assemblyError) {
          throw new TurnAttemptPersistenceUncertainError(
            "assemble_failure",
            assemblyError
          );
        }
        const failed = await recordFailure(
          store,
          claim,
          attempt,
          startedAt,
          failedAt,
          failure,
          supplied
        );
        if (failed.terminal) {
          return Object.freeze({
            status: "terminal" as const,
            errorCode: failed.errorCode,
            attempts: attempt.attemptIndex
          });
        }
        priorNonterminalAttempt = attempt;
        continue;
      }
      try {
        completionDigest = nodeTurnCompletionDigest(completion);
        settledAt = nowIso(now as () => Date);
        assertTimestampOrder(
          startedAt,
          settledAt,
          "completed turn.startedAt",
          "completed turn.settledAt"
        );
      } catch (error) {
        throw new TurnAttemptPersistenceUncertainError("assemble_completion", error);
      }
      const cached = await cacheCompletion(
        store,
        claim,
        node,
        attempt,
        completion,
        completionDigest,
        startedAt,
        settledAt
      );
      completion = cached.completion;
      completionDigest = cached.completionDigest;
      startedAt = cached.startedAt;
      settledAt = cached.settledAt;
      reused = !cached.created;
    }

    let outbox: CapturedTurnOutboxEvents;
    try {
      const supplied = successOutboxEvents === undefined
        ? undefined
        : (successOutboxEvents as RunClaimedUnitTurnInput["successOutboxEvents"])!(
            completion,
            {
              queueId: claim.queueId,
              unitId: claim.unitId,
              node,
              ...attempt,
              reused
            }
          );
      outbox = combineOutbox(
        receiptEvents(claim, attempt, completionUsage(completion), "succeeded"),
        supplied,
        "successful turn outbox"
      );
    } catch (error) {
      throw new TurnAttemptPersistenceUncertainError("assemble_settlement", error);
    }
    const settled = await settleCompletion(
      store,
      claim,
      attempt,
      principalId,
      undefined,
      completion,
      completionDigest,
      startedAt,
      settledAt,
      outbox
    );
    return Object.freeze({
      status: "succeeded" as const,
      completion,
      completionDigest,
      idempotencyKey: attempt.idempotencyKey,
      attemptNumber: attempt.attemptNumber,
      attemptIndex: attempt.attemptIndex,
      reused: reused || !settled.created
    });
  }
}

export interface RunNextUnitTurnsInput
  extends Omit<RunClaimedUnitTurnInput, "claim" | "store"> {
  readonly store: WorkerTurnRunnerStore;
  readonly leaseOwner: string;
  readonly batch?: number;
  readonly nodeId?: string;
}

export interface ClaimedUnitTurnSettlement {
  readonly claim: ClaimedUnitTurn;
  readonly result: PromiseSettledResult<UnitTurnRunResult>;
}

/** Claim a homogeneous batch and settle every unit independently. */
export async function runNextUnitTurns(
  inputRaw: RunNextUnitTurnsInput
): Promise<readonly ClaimedUnitTurnSettlement[]> {
  const raw = captureCapabilityRecord(
    inputRaw,
    [
      "store",
      "principalId",
      "ports",
      "leaseOwner",
      "batch",
      "nodeId",
      "successOutboxEvents",
      "failureOutboxEvents",
      "signal",
      "now"
    ],
    ["store", "principalId", "ports", "leaseOwner"],
    "runNextUnitTurns input"
  );
  const store = captureWorkerStore(raw.store);
  const principalId = assertIdentifier(raw.principalId, "runNextUnitTurns input.principalId");
  const leaseOwner = assertEvidenceString(raw.leaseOwner, "runNextUnitTurns input.leaseOwner");
  const batch = raw.batch === undefined
    ? 1
    : assertSafePositiveInt(raw.batch, "runNextUnitTurns input.batch");
  if (batch > MAX_TURN_BATCH_SIZE) {
    throw new Error(`runNextUnitTurns input.batch must be 1..${MAX_TURN_BATCH_SIZE}`);
  }
  const nodeId = raw.nodeId === undefined
    ? undefined
    : assertIdentifier(raw.nodeId, "runNextUnitTurns input.nodeId");
  let claimedRaw: unknown;
  try {
    claimedRaw = await store.claimUnitTurns(frozenNullRecord({
      principalId,
      leaseOwner,
      batch,
      ...(nodeId === undefined ? {} : { nodeId })
    }));
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("claim_worker", error);
  }
  let claims: readonly ClaimedUnitTurn[];
  try {
    const claimItems = captureDenseArrayItems(
      claimedRaw,
      "claimed unit turns",
      batch
    );
    claims = Object.freeze(claimItems.map((claim, index) =>
      captureClaim(claim, `claimed unit turns[${index}]`)
    ));
    const queueIds = new Set<string>();
    for (const claim of claims) {
      if (queueIds.has(claim.queueId)) {
        throw new Error(
          `turn runner store returned duplicate queueId ${JSON.stringify(claim.queueId)}`
        );
      }
      queueIds.add(claim.queueId);
      if (nodeId !== undefined && claim.nodeId !== nodeId) {
        throw new Error(
          `turn runner store returned node ${claim.nodeId} for requested node ${nodeId}`
        );
      }
    }
    if (claims.length > 1) {
      const first = claims[0]!;
      for (const claim of claims.slice(1)) {
        if (
          claim.graph.graphDigest !== first.graph.graphDigest
          || claim.nodeId !== first.nodeId
        ) {
          throw new Error(
            "turn runner store returned a non-homogeneous graph/node queue batch"
          );
        }
      }
    }
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("claim_worker", error);
  }
  const settled = await Promise.allSettled(
    claims.map((claim) => runClaimedUnitTurn({
      store,
      claim,
      principalId,
      ports: raw.ports as WorkerNodePorts,
      ...(raw.successOutboxEvents === undefined
        ? {}
        : {
            successOutboxEvents: raw.successOutboxEvents as RunClaimedUnitTurnInput["successOutboxEvents"]
          }),
      ...(raw.failureOutboxEvents === undefined
        ? {}
        : {
            failureOutboxEvents: raw.failureOutboxEvents as RunClaimedUnitTurnInput["failureOutboxEvents"]
          }),
      ...(raw.signal === undefined ? {} : { signal: raw.signal as AbortSignal }),
      ...(raw.now === undefined ? {} : { now: raw.now as () => Date })
    }))
  );
  return Object.freeze(
    claims.map((claim, index) => Object.freeze({ claim, result: settled[index]! }))
  );
}

/** Claim at most one queued worker turn. */
export async function runNextUnitTurn(
  inputRaw: Omit<RunNextUnitTurnsInput, "batch">
): Promise<UnitTurnRunResult | undefined> {
  const raw = captureCapabilityRecord(
    inputRaw,
    [
      "store",
      "principalId",
      "ports",
      "leaseOwner",
      "nodeId",
      "successOutboxEvents",
      "failureOutboxEvents",
      "signal",
      "now"
    ],
    ["store", "principalId", "ports", "leaseOwner"],
    "runNextUnitTurn input"
  );
  const settlements = await runNextUnitTurns({
    store: raw.store as WorkerTurnRunnerStore,
    principalId: raw.principalId as string,
    ports: raw.ports as WorkerNodePorts,
    leaseOwner: raw.leaseOwner as string,
    batch: 1,
    ...(Object.hasOwn(raw, "nodeId") ? { nodeId: raw.nodeId as string } : {}),
    ...(Object.hasOwn(raw, "successOutboxEvents")
      ? {
          successOutboxEvents:
            raw.successOutboxEvents as RunClaimedUnitTurnInput["successOutboxEvents"]
        }
      : {}),
    ...(Object.hasOwn(raw, "failureOutboxEvents")
      ? {
          failureOutboxEvents:
            raw.failureOutboxEvents as RunClaimedUnitTurnInput["failureOutboxEvents"]
        }
      : {}),
    ...(Object.hasOwn(raw, "signal") ? { signal: raw.signal as AbortSignal } : {}),
    ...(Object.hasOwn(raw, "now") ? { now: raw.now as () => Date } : {})
  });
  if (settlements.length === 0) return undefined;
  const result = settlements[0]!.result;
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

function captureExternalClaimReply(
  value: unknown,
  label: string
): ExternalUnitTurnClaimResult {
  const unionKeys = [
    "disposition",
    "claim",
    "queueId",
    "unitId",
    "nodeId",
    "attemptNumber",
    "attemptIndex",
    "idempotencyKey",
    "principalId",
    "actorId",
    "completionDigest",
    "startedAt",
    "settledAt",
    "settlementDigest",
    "committedOutboxEventDigests"
  ];
  const header = captureCapabilityRecord(
    value,
    unionKeys,
    ["disposition"],
    label
  );
  if (header.disposition === "claimed") {
    const raw = captureCapabilityRecord(
      value,
      ["disposition", "claim"],
      ["disposition", "claim"],
      label
    );
    return Object.freeze({
      disposition: "claimed" as const,
      claim: captureClaim(raw.claim, `${label}.claim`)
    });
  }
  if (header.disposition !== "settled") {
    throw new Error(`${label}.disposition must be "claimed" | "settled"`);
  }
  const required = unionKeys.filter((key) => key !== "claim");
  const raw = captureCapabilityRecord(value, required, required, label);
  const timestamps = assertTimestampOrder(
    raw.startedAt,
    raw.settledAt,
    `${label}.startedAt`,
    `${label}.settledAt`
  );
  return Object.freeze({
    disposition: "settled" as const,
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
    principalId: assertIdentifier(raw.principalId, `${label}.principalId`),
    actorId: assertEvidenceString(raw.actorId, `${label}.actorId`),
    completionDigest: assertSha256Hex(
      raw.completionDigest,
      `${label}.completionDigest`
    ),
    startedAt: timestamps.startedAt,
    settledAt: timestamps.endedAt,
    settlementDigest: assertSha256Hex(
      raw.settlementDigest,
      `${label}.settlementDigest`
    ),
    committedOutboxEventDigests: captureDigestList(
      raw.committedOutboxEventDigests,
      `${label}.committedOutboxEventDigests`
    )!
  });
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function assertExactExternalSettlement(
  settled: SettledExternalUnitTurn,
  inspection: ExternalUnitTurnInspection,
  node: MissionPipelineNode,
  principalId: string,
  actorId: string,
  completionDigest: string,
  outboxEventDigests: readonly string[]
): void {
  if (
    settled.attemptIndex > node.turn.maxAttempts
    || settled.idempotencyKey !== attemptKey(inspection, node, settled.attemptNumber)
    || settled.settlementDigest !== computeSettlementDigest({
      queueId: settled.queueId,
      unitId: settled.unitId,
      nodeId: settled.nodeId,
      attemptNumber: settled.attemptNumber,
      attemptIndex: settled.attemptIndex,
      idempotencyKey: settled.idempotencyKey,
      principalId: settled.principalId,
      actorId: settled.actorId,
      startedAt: settled.startedAt,
      settledAt: settled.settledAt,
      completionDigest: settled.completionDigest
    })
  ) {
    throw new Error("settled external turn returned untrustworthy attempt evidence");
  }
  const outboxMatches = settled.committedOutboxEventDigests.length === outboxEventDigests.length
    && settled.committedOutboxEventDigests.every(
      (value, index) => value === outboxEventDigests[index]
    );
  if (
    settled.queueId !== inspection.queueId
    || settled.unitId !== inspection.unitId
    || settled.nodeId !== inspection.nodeId
    || settled.principalId !== principalId
    || settled.actorId !== actorId
    || settled.completionDigest !== completionDigest
    || !outboxMatches
  ) {
    throw new TurnEvidenceConflictError(
      `external turn retry conflicts with settled evidence for ${inspection.unitId} at ${inspection.nodeId} (${inspection.queueId})`
    );
  }
}

interface ExternalCompletionInput {
  readonly store: ExternalTurnRunnerStore;
  readonly principalId: string;
  readonly kind: "human" | "callback";
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly outcome: string;
  readonly outputArtifact?: ArtifactEnvelope;
  readonly actorId: string;
  readonly outboxEvents?: TurnOutboxEvents;
  readonly now?: () => Date;
}

async function completeExternalTurn(
  input: ExternalCompletionInput
): Promise<UnitTurnRunResult> {
  const store = captureExternalStore(input.store);
  const principalId = assertIdentifier(input.principalId, "external turn principalId");
  const queueId = assertEvidenceString(input.queueId, "external turn queueId");
  const unitId = assertEvidenceString(input.unitId, "external turn unitId");
  const nodeId = assertIdentifier(input.nodeId, "external turn nodeId");
  const actorId = assertEvidenceString(input.actorId, "external turn actorId");
  const now = Object.hasOwn(input, "now") && input.now !== undefined
    ? input.now
    : () => new Date();
  if (typeof now !== "function" || nodeTypes.isProxy(now)) {
    throw new Error("external turn now must be a non-Proxy function");
  }
  let inspectionRaw: unknown;
  try {
    inspectionRaw = await store.inspectExternalUnitTurn(frozenNullRecord({
      principalId,
      kind: input.kind,
      queueId,
      unitId,
      nodeId
    }));
  } catch (error) {
    throw error;
  }
  if (inspectionRaw === undefined) {
    throw new Error(
      `${input.kind} turn is not queued for ${unitId} at node ${nodeId} (${queueId})`
    );
  }
  const inspection = captureExternalInspection(
    inspectionRaw,
    `${input.kind} turn inspection`
  );
  if (
    inspection.queueId !== queueId
    || inspection.unitId !== unitId
    || inspection.nodeId !== nodeId
  ) {
    throw new Error(`${input.kind} turn inspection returned mismatched coordinates`);
  }
  const node = compileGraph(inspection.graph).nodesById[nodeId]!;
  if (node.kind !== input.kind) {
    throw new WorkerNodeKindError(node.nodeId, node.kind);
  }
  if (principalId !== node.principal.id) {
    throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
  }
  if (inspection.inputArtifact.contractId !== node.input) {
    throw new Error(
      `node ${node.nodeId} input contract mismatch: expected ${node.input}, got ${inspection.inputArtifact.contractId}`
    );
  }
  const completion = validateNodeTurnCompletion(node, {
    outcome: input.outcome,
    ...(Object.hasOwn(input, "outputArtifact")
      ? { outputArtifact: input.outputArtifact }
      : {})
  });
  const completionDigest = nodeTurnCompletionDigest(completion);
  const outbox = combineOutbox(
    [],
    Object.hasOwn(input, "outboxEvents") ? input.outboxEvents : undefined,
    `${input.kind} turn outbox`
  );
  const outboxEventDigests = Object.freeze(outbox.events.map(turnOutboxEventDigest));

  let claimReplyRaw: unknown;
  try {
    claimReplyRaw = await store.claimExternalUnitTurn(frozenNullRecord({
      principalId,
      kind: input.kind,
      queueId,
      unitId,
      nodeId,
      actorId,
      completionDigest,
      outboxEventDigests
    }));
  } catch (error) {
    if (isCoordinationRejection(error)) throw error;
    throw new TurnAttemptPersistenceUncertainError("claim_external", error);
  }
  if (claimReplyRaw === undefined) {
    throw new TurnAttemptPersistenceUncertainError(
      "claim_external",
      new Error(`${input.kind} turn disappeared between inspection and exact claim`)
    );
  }
  let claimReply: ExternalUnitTurnClaimResult;
  try {
    claimReply = captureExternalClaimReply(
      claimReplyRaw,
      `${input.kind} turn exact claim result`
    );
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("claim_external", error);
  }
  if (claimReply.disposition === "settled") {
    try {
      assertExactExternalSettlement(
        claimReply,
        inspection,
        node,
        principalId,
        actorId,
        completionDigest,
        outboxEventDigests
      );
    } catch (error) {
      if (isBrandedError(error, conflictErrors)) throw error;
      throw new TurnAttemptPersistenceUncertainError("claim_external", error);
    }
    acknowledgeOutbox(capturedOutboxAcknowledge(outbox));
    return Object.freeze({
      status: "succeeded" as const,
      completion,
      completionDigest,
      idempotencyKey: claimReply.idempotencyKey,
      attemptNumber: claimReply.attemptNumber,
      attemptIndex: claimReply.attemptIndex,
      reused: true
    });
  }
  const claim = claimReply.claim;
  if (
    claim.queueId !== inspection.queueId
    || claim.unitId !== inspection.unitId
    || claim.nodeId !== inspection.nodeId
    || claim.graph.graphDigest !== inspection.graph.graphDigest
    || claim.inputArtifact.contractId !== inspection.inputArtifact.contractId
    || claim.inputArtifact.digest !== inspection.inputArtifact.digest
    || artifactBytes(claim.inputArtifact) !== artifactBytes(inspection.inputArtifact)
    || !sameOptionalString(
      claimExecutionIdentityDigest(claim),
      claimExecutionIdentityDigest(inspection)
    )
  ) {
    throw new TurnAttemptPersistenceUncertainError(
      "claim_external",
      new Error(`${input.kind} turn exact claim does not match its inspection`)
    );
  }

  const prepared = await prepareAttempt(store, claim, node);
  if (prepared.disposition === "terminal") {
    return Object.freeze({
      status: "terminal" as const,
      errorCode: prepared.errorCode,
      attempts: prepared.attempts
    });
  }
  if (prepared.disposition === "cached") {
    throw new TurnAttemptPersistenceUncertainError(
      "prepare",
      new Error(
        `${input.kind} turn returned an unattributed cached completion; exact recovery must use claimExternalUnitTurn.disposition=settled`
      )
    );
  }
  let startedAt: string;
  let settledAt: string;
  try {
    startedAt = nowIso(now);
    settledAt = nowIso(now);
    assertTimestampOrder(
      startedAt,
      settledAt,
      `${input.kind} turn.startedAt`,
      `${input.kind} turn.settledAt`
    );
  } catch (error) {
    throw new TurnAttemptPersistenceUncertainError("assemble_settlement", error);
  }
  const settled = await settleCompletion(
    store,
    claim,
    prepared,
    principalId,
    actorId,
    completion,
    completionDigest,
    startedAt,
    settledAt,
    outbox
  );
  return Object.freeze({
    status: "succeeded" as const,
    completion,
    completionDigest,
    idempotencyKey: prepared.idempotencyKey,
    attemptNumber: prepared.attemptNumber,
    attemptIndex: prepared.attemptIndex,
    reused: !settled.created
  });
}

export interface RecordHumanNodeDecisionInput {
  readonly store: ExternalTurnRunnerStore;
  readonly principalId: string;
  readonly decision: HumanNodeDecision;
  readonly outboxEvents?: TurnOutboxEvents;
  readonly now?: () => Date;
}

/** Inbound human completion; actor attribution never grants authority. */
export async function recordHumanNodeDecision(
  inputRaw: RecordHumanNodeDecisionInput
): Promise<UnitTurnRunResult> {
  const raw = captureCapabilityRecord(
    inputRaw,
    ["store", "principalId", "decision", "outboxEvents", "now"],
    ["store", "principalId", "decision"],
    "recordHumanNodeDecision input"
  );
  const decision = captureCapabilityRecord(
    raw.decision,
    ["queueId", "unitId", "nodeId", "outcome", "outputArtifact", "actor"],
    ["queueId", "unitId", "nodeId", "outcome", "actor"],
    "human node decision"
  );
  const actor = captureCapabilityRecord(
    decision.actor,
    ["actorId"],
    ["actorId"],
    "human node decision.actor"
  );
  return completeExternalTurn({
    store: raw.store as ExternalTurnRunnerStore,
    principalId: raw.principalId as string,
    kind: "human",
    queueId: decision.queueId as string,
    unitId: decision.unitId as string,
    nodeId: decision.nodeId as string,
    outcome: decision.outcome as string,
    ...(decision.outputArtifact === undefined
      ? {}
      : { outputArtifact: decision.outputArtifact as ArtifactEnvelope }),
    actorId: actor.actorId as string,
    ...(raw.outboxEvents === undefined
      ? {}
      : { outboxEvents: raw.outboxEvents as TurnOutboxEvents }),
    ...(raw.now === undefined ? {} : { now: raw.now as () => Date })
  });
}

export interface AdmitCallbackNodeEventInput {
  readonly store: ExternalTurnRunnerStore;
  readonly principalId: string;
  readonly event: CallbackNodeEvent;
  readonly outboxEvents?: TurnOutboxEvents;
  readonly now?: () => Date;
}

/** Inbound callback completion. Timers live outside the engine and call here. */
export async function admitCallbackNodeEvent(
  inputRaw: AdmitCallbackNodeEventInput
): Promise<UnitTurnRunResult> {
  const raw = captureCapabilityRecord(
    inputRaw,
    ["store", "principalId", "event", "outboxEvents", "now"],
    ["store", "principalId", "event"],
    "admitCallbackNodeEvent input"
  );
  const event = captureCapabilityRecord(
    raw.event,
    ["queueId", "unitId", "nodeId", "outcome", "outputArtifact", "actor"],
    ["queueId", "unitId", "nodeId", "outcome", "outputArtifact", "actor"],
    "callback node event"
  );
  const actor = captureCapabilityRecord(
    event.actor,
    ["actorId"],
    ["actorId"],
    "callback node event.actor"
  );
  return completeExternalTurn({
    store: raw.store as ExternalTurnRunnerStore,
    principalId: raw.principalId as string,
    kind: "callback",
    queueId: event.queueId as string,
    unitId: event.unitId as string,
    nodeId: event.nodeId as string,
    outcome: event.outcome as string,
    outputArtifact: event.outputArtifact as ArtifactEnvelope,
    actorId: actor.actorId as string,
    ...(raw.outboxEvents === undefined
      ? {}
      : { outboxEvents: raw.outboxEvents as TurnOutboxEvents }),
    ...(raw.now === undefined ? {} : { now: raw.now as () => Date })
  });
}

/** The reserved outcome is intentionally exported for store-side synthesis. */
export const JOIN_UNSATISFIABLE_OUTCOME = ENGINE_JOIN_UNSATISFIABLE_OUTCOME;

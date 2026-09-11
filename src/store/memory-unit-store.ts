// store/memory-unit-store.ts — executable N3 UnitStore specification.
//
// The implementation intentionally favors explicit retained evidence over a
// compact mutable workflow object. Queue occurrences, attempts, cached body
// results, failures, settlements, journey, artifacts, join progress events,
// dead letters, and outbox rows are append-only. Only lease rows and the
// fairness cursor are replaceable coordination state.

import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  artifactRef,
  validateArtifactEnvelope,
  validateArtifactRef,
  type ArtifactEnvelope,
  type ArtifactRef
} from "../contracts/artifact.js";
import { canonicalJson, digest } from "../contracts/digest.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";
import { compileGraph, type CompiledGraph } from "../graph/compile.js";
import { snapshotGraphValidationData } from "../graph/limits.js";
import {
  graphDefinitionRef,
  JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
  MISSION_PIPELINE_ENGINE_PRINCIPAL_ID,
  validateGraphDefinition,
  validateMissionPipelineNode,
  type GraphDefinition,
  type MissionPipelineNode
} from "../graph/definition.js";
import {
  assertIdentifier,
  assertSafePositiveInt,
  assertSha256Hex,
  typeName
} from "../internal/guards.js";
import {
  captureCapabilityRecord,
  captureDenseArrayItems
} from "../internal/capability.js";
import {
  assertEvidenceString,
  deepFrozenClone
} from "../internal/evidence.js";
import {
  ENGINE_JOIN_UNSATISFIABLE_OUTCOME,
  MAX_AGENT_TURN_USAGE_RECEIPTS,
  validateNodeTurnCompletion,
  type NodeTurnCompletion
} from "../execute/ports.js";
import {
  MAX_TURN_BATCH_SIZE,
  MAX_TURN_OUTBOX_EVENTS,
  TurnAuthorityError,
  TurnEvidenceConflictError,
  TurnLeaseLostError,
  turnOutboxEventDigest,
  type CacheTurnCompletionInput,
  type CacheTurnCompletionResult,
  type ClaimExternalUnitTurnInput,
  type ClaimUnitTurnsInput,
  type ClaimedUnitTurn,
  type ExternalUnitTurnClaimResult,
  type ExternalUnitTurnInspection,
  type HeartbeatTurnInput,
  type InspectExternalUnitTurnInput,
  type PrepareTurnAttemptInput,
  type RecordTurnFailureInput,
  type RecordTurnFailureResult,
  type SettleTurnInput,
  type SettleTurnResult,
  type TurnAttemptPreparation,
  type TurnOutboxEventInput,
  type TurnOutboxEvents
} from "../execute/unit-runner.js";
import {
  nodeExecutionFingerprint,
  nodeTurnCompletionDigest,
  nodeTurnIdempotencyKey
} from "../execute/turn.js";
import type { GraphStore } from "./graph-store.js";
import { validateGraphDefinitionRef } from "./graph-store.js";
import { MemoryGraphStore } from "./memory-graph-store.js";
import { createJoinInputArtifact, validateJoinInputArtifact } from "./join-input.js";
import {
  evaluateJoinThreshold,
  matchingOutcomeEdges
} from "./routing.js";
import {
  MAX_UNIT_STORE_LIST_LIMIT,
  MISSION_PIPELINE_UNIT_SCHEMA_VERSION,
  nodeTurnFailureDigest,
  nodeTurnSettlementDigest,
  validateNodeTurnFailureMessage,
  type AdmitUnitInput,
  type AdmitUnitResult,
  type GetArtifactInput,
  type JoinAcceptedOffer,
  type JoinImpossibleEdge,
  type JoinInboundProgress,
  type JoinProgress,
  type JoinUnsatisfiableJourneyRecord,
  type JourneyRoutingEffect,
  type ListQueuedUnitsInput,
  type ListUnitEvidenceInput,
  type MissionPipelineUnit,
  type QueueJoinProvenance,
  type QueuedUnit,
  type ReadJoinProgressInput,
  type ReadJourneyInput,
  type ReadUnitInput,
  type SettleTransactionCheckpoint,
  type StoredTurnCompletion,
  type UnitAdmittedJourneyRecord,
  type UnitAttemptFailureJourneyRecord,
  type UnitDeadLetterRecord,
  type UnitJourneyRecord,
  type UnitOutboxEventRecord,
  type UnitQueueOccurrence,
  type UnitStore,
  type UnitTurnJourneyRecord
} from "./unit-store.js";

const WORKER_KINDS = new Set(["code", "model", "agent"]);
const DateConstructor = Date;
const dateParse = Date.parse;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;

function timestampEpoch(value: string): number {
  return Reflect.apply(dateParse, DateConstructor, [value]);
}

function timestampFromEpoch(epoch: number): string {
  return Reflect.apply(dateToISOString, new DateConstructor(epoch), []);
}

interface LeaseRow {
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly mode: "worker" | "external";
  readonly principalId: string;
  readonly external?: {
    readonly kind: "human" | "callback";
    readonly actorId: string;
    readonly completionDigest: string;
    readonly outboxEventDigests: readonly string[];
  };
}

interface AttemptReservation {
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  readonly nodeRef: { readonly id: string; readonly version: number };
  readonly fingerprint: string;
  readonly inputDigest: string;
  readonly executionIdentityDigest?: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
}

interface CachedCompletionRow extends StoredTurnCompletion {
  readonly queueId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
}

interface FailureRow extends Omit<RecordTurnFailureInput, "leaseToken"> {
  readonly committedOutboxEventDigests: readonly string[];
}

interface SettlementRow extends Omit<SettleTurnInput, "leaseToken"> {
  readonly committedOutboxEventDigests: readonly string[];
}

interface SyntheticJourneyDraft {
  readonly nodeId: string;
  readonly at: string;
  readonly causeEvidenceDigest: string;
  readonly artifact: ArtifactEnvelope;
  readonly syntheticOutcomeDigest: string;
  readonly routing: JourneyRoutingEffect[];
}

interface RoutingPlan {
  readonly effects: readonly JourneyRoutingEffect[];
  readonly joins: ReadonlyMap<string, JoinProgress>;
  readonly queues: readonly UnitQueueOccurrence[];
  readonly artifacts: readonly ArtifactEnvelope[];
  readonly synthetic: readonly SyntheticJourneyDraft[];
  readonly nextEnqueueSequence: number;
}

interface MemoryState {
  readonly units: Map<string, MissionPipelineUnit>;
  readonly unitGraphs: Map<string, GraphDefinition>;
  readonly artifacts: Map<string, ArtifactEnvelope>;
  readonly queues: Map<string, UnitQueueOccurrence>;
  readonly leases: Map<string, LeaseRow>;
  readonly reservations: Map<string, readonly AttemptReservation[]>;
  readonly cachedCompletions: Map<string, CachedCompletionRow>;
  readonly failures: Map<string, FailureRow>;
  readonly settlements: Map<string, SettlementRow>;
  readonly journey: Map<string, readonly UnitJourneyRecord[]>;
  readonly joins: Map<string, JoinProgress>;
  readonly outbox: readonly UnitOutboxEventRecord[];
  readonly outboxDedupeKeys: Set<string>;
  readonly deadLetters: readonly UnitDeadLetterRecord[];
  readonly fairnessCursor: Map<string, string>;
  readonly nextEnqueueSequence: number;
}

export interface MemoryUnitStoreOptions {
  readonly graphStore?: GraphStore;
  readonly now?: () => Date;
  readonly idFactory?: (kind: "queue" | "lease" | "outbox" | "dead-letter") => string;
  /** Test-driver fault. Pre-commit throws roll back; post_commit_reply does not. */
  readonly settleCheckpoint?: (checkpoint: SettleTransactionCheckpoint) => void;
  /** Privileged normalized state, normally loaded by a durable adapter. */
  readonly initialState?: MemoryUnitStoreStateSnapshot;
}

export const MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION =
  "mission-pipeline-memory-unit-store-state.v1" as const;

export interface MemoryUnitStoreStateSnapshot {
  readonly schemaVersion: typeof MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION;
  readonly unitGraphs: readonly Readonly<{
    unitId: string;
    graph: GraphDefinition;
  }>[];
  readonly units: readonly MissionPipelineUnit[];
  readonly artifacts: readonly ArtifactEnvelope[];
  readonly queues: readonly UnitQueueOccurrence[];
  readonly journey: readonly UnitJourneyRecord[];
  readonly joins: readonly JoinProgress[];
  readonly attempts: readonly AttemptReservation[];
  readonly cachedCompletions: readonly CachedCompletionRow[];
  readonly failures: readonly FailureRow[];
  readonly settlements: readonly SettlementRow[];
  readonly outbox: readonly UnitOutboxEventRecord[];
  readonly outboxDedupeKeys: readonly string[];
  readonly deadLetters: readonly UnitDeadLetterRecord[];
  readonly leases: readonly Readonly<{ queueId: string; lease: LeaseRow }>[];
  readonly fairnessCursor: readonly Readonly<{
    sharedNodeKey: string;
    lastGraphLaneKey: string;
  }>[];
  readonly nextEnqueueSequence: number;
}

export interface MemoryUnitStoreEvidenceSnapshot {
  readonly units: readonly MissionPipelineUnit[];
  readonly artifacts: readonly ArtifactEnvelope[];
  readonly queues: readonly UnitQueueOccurrence[];
  readonly journey: readonly UnitJourneyRecord[];
  readonly joins: readonly JoinProgress[];
  readonly attempts: readonly AttemptReservation[];
  readonly cachedCompletions: readonly CachedCompletionRow[];
  readonly failures: readonly FailureRow[];
  readonly settlements: readonly SettlementRow[];
  readonly outbox: readonly UnitOutboxEventRecord[];
  readonly deadLetters: readonly UnitDeadLetterRecord[];
  readonly leases: readonly Readonly<{ queueId: string; lease: LeaseRow }>[];
}

function emptyState(): MemoryState {
  return {
    units: new Map(),
    unitGraphs: new Map(),
    artifacts: new Map(),
    queues: new Map(),
    leases: new Map(),
    reservations: new Map(),
    cachedCompletions: new Map(),
    failures: new Map(),
    settlements: new Map(),
    journey: new Map(),
    joins: new Map(),
    outbox: Object.freeze([]),
    outboxDedupeKeys: new Set(),
    deadLetters: Object.freeze([]),
    fairnessCursor: new Map(),
    nextEnqueueSequence: 1
  };
}

function cloneState(state: MemoryState): MemoryState {
  return {
    units: new Map(state.units),
    unitGraphs: new Map(state.unitGraphs),
    artifacts: new Map(state.artifacts),
    queues: new Map(state.queues),
    leases: new Map(state.leases),
    reservations: new Map(
      [...state.reservations].map(([key, rows]) => [key, [...rows]])
    ),
    cachedCompletions: new Map(state.cachedCompletions),
    failures: new Map(state.failures),
    settlements: new Map(state.settlements),
    journey: new Map(
      [...state.journey].map(([key, rows]) => [key, [...rows]])
    ),
    joins: new Map(state.joins),
    outbox: [...state.outbox],
    outboxDedupeKeys: new Set(state.outboxDedupeKeys),
    deadLetters: [...state.deadLetters],
    fairnessCursor: new Map(state.fairnessCursor),
    nextEnqueueSequence: state.nextEnqueueSequence
  };
}

const STATE_SNAPSHOT_KEYS = [
  "schemaVersion",
  "unitGraphs",
  "units",
  "artifacts",
  "queues",
  "journey",
  "joins",
  "attempts",
  "cachedCompletions",
  "failures",
  "settlements",
  "outbox",
  "outboxDedupeKeys",
  "deadLetters",
  "leases",
  "fairnessCursor",
  "nextEnqueueSequence"
] as const;

function snapshotArray(value: unknown, label: string): readonly unknown[] {
  return captureDenseArrayItems(value, label);
}

function snapshotRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  return captureCapabilityRecord(value, allowedKeys, requiredKeys, label);
}

function putUnique<K, V>(map: Map<K, V>, key: K, value: V, label: string): void {
  if (map.has(key)) throw new Error(`${label}: duplicate identity ${JSON.stringify(key)}`);
  map.set(key, value);
}

function assertGraphRefEqual(
  actual: { readonly id: string; readonly version: number; readonly digest: string },
  expected: { readonly id: string; readonly version: number; readonly digest: string },
  label: string
): void {
  if (!graphRefEqual(actual, expected)) {
    throw new Error(`${label}: graph reference does not match the unit's digest-sealed graph`);
  }
}

function validatedStringArray(
  value: unknown,
  label: string,
  validate: (item: unknown, itemLabel: string) => string
): readonly string[] {
  const result = snapshotArray(value, label).map((item, index) =>
    validate(item, `${label}[${index}]`)
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${label}: duplicate value`);
  }
  return Object.freeze(result);
}

function validatedOrderedStringArray(
  value: unknown,
  label: string,
  validate: (item: unknown, itemLabel: string) => string
): readonly string[] {
  return Object.freeze(snapshotArray(value, label).map((item, index) =>
    validate(item, `${label}[${index}]`)
  ));
}

function validateSnapshotNodeRef(
  value: unknown,
  label: string
): Readonly<{ id: string; version: number }> {
  const raw = snapshotRecord(value, ["id", "version"], ["id", "version"], label);
  return Object.freeze({
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`)
  });
}

function sameNodeRef(
  left: { readonly id: string; readonly version: number },
  right: { readonly id: string; readonly version: number }
): boolean {
  return left.id === right.id && left.version === right.version;
}

function validateSnapshotUnit(value: unknown, label: string): MissionPipelineUnit {
  const keys = [
    "schemaVersion", "unitId", "graph", "seedArtifact", "admittedAt",
    "principalId", "admissionDigest"
  ];
  const raw = snapshotRecord(value, keys, keys, label);
  if (raw.schemaVersion !== MISSION_PIPELINE_UNIT_SCHEMA_VERSION) {
    throw new Error(`${label}.schemaVersion must be ${MISSION_PIPELINE_UNIT_SCHEMA_VERSION}`);
  }
  const base = deepFrozenClone({
    schemaVersion: MISSION_PIPELINE_UNIT_SCHEMA_VERSION,
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    graph: validateGraphDefinitionRef(raw.graph, `${label}.graph`),
    seedArtifact: validateArtifactRef(raw.seedArtifact),
    admittedAt: assertCanonicalTimestamp(raw.admittedAt, `${label}.admittedAt`),
    principalId: assertIdentifier(raw.principalId, `${label}.principalId`)
  }, `${label} base`);
  const admissionDigest = assertSha256Hex(raw.admissionDigest, `${label}.admissionDigest`);
  if (admissionDigest !== digest(base)) {
    throw new Error(`${label}: admission digest mismatch`);
  }
  return deepFrozenClone({ ...base, admissionDigest }, label);
}

function validateSnapshotJoinOffer(value: unknown, label: string): JoinAcceptedOffer {
  const keys = [
    "edgeId", "sourceNodeId", "sourceQueueId", "sourceEvidenceDigest",
    "artifact", "offeredAt"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => key !== "sourceQueueId"),
    label
  );
  const sourceQueueId = Object.hasOwn(raw, "sourceQueueId")
    ? assertEvidenceString(raw.sourceQueueId, `${label}.sourceQueueId`)
    : undefined;
  return deepFrozenClone({
    edgeId: assertIdentifier(raw.edgeId, `${label}.edgeId`),
    sourceNodeId: assertIdentifier(raw.sourceNodeId, `${label}.sourceNodeId`),
    ...(sourceQueueId === undefined ? {} : { sourceQueueId }),
    sourceEvidenceDigest: assertSha256Hex(
      raw.sourceEvidenceDigest,
      `${label}.sourceEvidenceDigest`
    ),
    artifact: validateArtifactRef(raw.artifact),
    offeredAt: assertCanonicalTimestamp(raw.offeredAt, `${label}.offeredAt`)
  }, label);
}

function validateSnapshotQueue(value: unknown, label: string): UnitQueueOccurrence {
  const keys = [
    "queueId", "unitId", "graph", "nodeId", "nodeRef", "inputArtifact",
    "queuedAt", "enqueueSequence", "sourceEvidenceDigest", "inboundEdgeIds", "join"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => key !== "join"),
    label
  );
  const inboundEdgeIds = validatedStringArray(
    raw.inboundEdgeIds,
    `${label}.inboundEdgeIds`,
    assertIdentifier
  );
  let join: QueueJoinProvenance | undefined;
  if (Object.hasOwn(raw, "join")) {
    const joinRaw = snapshotRecord(
      raw.join,
      ["joinNodeId", "selectedEdgeId", "accepted"],
      ["joinNodeId", "selectedEdgeId", "accepted"],
      `${label}.join`
    );
    const accepted = Object.freeze(snapshotArray(joinRaw.accepted, `${label}.join.accepted`)
      .map((offer, index) => validateSnapshotJoinOffer(
        offer,
        `${label}.join.accepted[${index}]`
      )));
    const acceptedEdgeIds = accepted.map((offer) => offer.edgeId);
    if (new Set(acceptedEdgeIds).size !== acceptedEdgeIds.length) {
      throw new Error(`${label}.join.accepted: duplicate edge identity`);
    }
    const selectedEdgeId = assertIdentifier(
      joinRaw.selectedEdgeId,
      `${label}.join.selectedEdgeId`
    );
    if (!acceptedEdgeIds.includes(selectedEdgeId)) {
      throw new Error(`${label}.join.selectedEdgeId must name an accepted offer`);
    }
    join = deepFrozenClone({
      joinNodeId: assertIdentifier(joinRaw.joinNodeId, `${label}.join.joinNodeId`),
      selectedEdgeId,
      accepted
    }, `${label}.join`);
  }
  return deepFrozenClone({
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    graph: validateGraphDefinitionRef(raw.graph, `${label}.graph`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    nodeRef: validateSnapshotNodeRef(raw.nodeRef, `${label}.nodeRef`),
    inputArtifact: validateArtifactEnvelope(raw.inputArtifact),
    queuedAt: assertCanonicalTimestamp(raw.queuedAt, `${label}.queuedAt`),
    enqueueSequence: assertSafePositiveInt(raw.enqueueSequence, `${label}.enqueueSequence`),
    sourceEvidenceDigest: assertSha256Hex(
      raw.sourceEvidenceDigest,
      `${label}.sourceEvidenceDigest`
    ),
    inboundEdgeIds,
    ...(join === undefined ? {} : { join })
  }, label);
}

function validateSnapshotReservation(value: unknown, label: string): AttemptReservation {
  const keys = [
    "queueId", "unitId", "nodeId", "nodeRef", "fingerprint", "inputDigest",
    "executionIdentityDigest", "attemptNumber", "attemptIndex", "idempotencyKey"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => key !== "executionIdentityDigest"),
    label
  );
  const executionIdentityDigest = Object.hasOwn(raw, "executionIdentityDigest")
    ? assertSha256Hex(raw.executionIdentityDigest, `${label}.executionIdentityDigest`)
    : undefined;
  return deepFrozenClone({
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    nodeRef: validateSnapshotNodeRef(raw.nodeRef, `${label}.nodeRef`),
    fingerprint: assertSha256Hex(raw.fingerprint, `${label}.fingerprint`),
    inputDigest: assertSha256Hex(raw.inputDigest, `${label}.inputDigest`),
    ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest }),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`)
  }, label);
}

function validateSnapshotCachedCompletion(
  value: unknown,
  state: MemoryState,
  label: string
): CachedCompletionRow {
  const keys = [
    "queueId", "attemptNumber", "attemptIndex", "idempotencyKey", "completion",
    "completionDigest", "startedAt", "settledAt"
  ];
  const raw = snapshotRecord(value, keys, keys, label);
  const queueId = assertEvidenceString(raw.queueId, `${label}.queueId`);
  const queue = state.queues.get(queueId);
  if (queue === undefined) throw new Error(`${label}: references unknown queue ${queueId}`);
  const node = nodeForQueue(state, queue);
  const completion = validateNodeTurnCompletion(node, raw.completion, `${label}.completion`);
  const completionDigest = assertSha256Hex(raw.completionDigest, `${label}.completionDigest`);
  if (completionDigest !== nodeTurnCompletionDigest(completion)) {
    throw new Error(`${label}: completion digest mismatch`);
  }
  const timestamps = assertTimestampOrder(
    raw.startedAt,
    raw.settledAt,
    `${label}.startedAt`,
    `${label}.settledAt`
  );
  return deepFrozenClone({
    queueId,
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
    completion,
    completionDigest,
    startedAt: timestamps.startedAt,
    settledAt: timestamps.endedAt
  }, label);
}

function validateSnapshotFailure(value: unknown, label: string): FailureRow {
  const keys = [
    "queueId", "unitId", "nodeId", "attemptNumber", "attemptIndex", "idempotencyKey",
    "startedAt", "failedAt", "errorCode", "errorMessage", "principalId", "retryable",
    "terminal", "usage", "failureDigest", "committedOutboxEventDigests"
  ];
  const raw = snapshotRecord(value, keys, keys, label);
  const usage = Object.freeze(snapshotArray(raw.usage, `${label}.usage`)
    .map((receipt) => validateUsageReceipt(receipt)));
  const normalized = deepFrozenClone({
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
    principalId: assertIdentifier(raw.principalId, `${label}.principalId`),
    startedAt: assertCanonicalTimestamp(raw.startedAt, `${label}.startedAt`),
    failedAt: assertCanonicalTimestamp(raw.failedAt, `${label}.failedAt`),
    errorCode: assertIdentifier(raw.errorCode, `${label}.errorCode`),
    errorMessage: validateNodeTurnFailureMessage(raw.errorMessage, `${label}.errorMessage`),
    retryable: assertBoolean(raw.retryable, `${label}.retryable`),
    terminal: assertBoolean(raw.terminal, `${label}.terminal`),
    usage
  }, `${label} normalized`);
  if (timestampEpoch(normalized.failedAt) < timestampEpoch(normalized.startedAt)) {
    throw new Error(`${label}.failedAt must be at or after ${label}.startedAt`);
  }
  const failureDigest = assertSha256Hex(raw.failureDigest, `${label}.failureDigest`);
  if (failureDigest !== nodeTurnFailureDigest(normalized)) {
    throw new Error(`${label}: failure digest mismatch`);
  }
  const committedOutboxEventDigests = validatedOrderedStringArray(
    raw.committedOutboxEventDigests,
    `${label}.committedOutboxEventDigests`,
    assertSha256Hex
  );
  return deepFrozenClone({
    ...normalized,
    failureDigest,
    committedOutboxEventDigests
  }, label) as FailureRow;
}

function validateSnapshotSettlement(
  value: unknown,
  state: MemoryState,
  label: string
): SettlementRow {
  const keys = [
    "queueId", "unitId", "nodeId", "attemptNumber", "attemptIndex", "idempotencyKey",
    "principalId", "actorId", "startedAt", "settledAt", "completion",
    "completionDigest", "settlementDigest", "committedOutboxEventDigests"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => key !== "actorId"),
    label
  );
  const queueId = assertEvidenceString(raw.queueId, `${label}.queueId`);
  const queue = state.queues.get(queueId);
  if (queue === undefined) throw new Error(`${label}: references unknown queue ${queueId}`);
  const node = nodeForQueue(state, queue);
  const completion = validateNodeTurnCompletion(node, raw.completion, `${label}.completion`);
  const completionDigest = assertSha256Hex(raw.completionDigest, `${label}.completionDigest`);
  if (completionDigest !== nodeTurnCompletionDigest(completion)) {
    throw new Error(`${label}: completion digest mismatch`);
  }
  const actorId = Object.hasOwn(raw, "actorId")
    ? assertEvidenceString(raw.actorId, `${label}.actorId`)
    : undefined;
  const timestamps = assertTimestampOrder(
    raw.startedAt,
    raw.settledAt,
    `${label}.startedAt`,
    `${label}.settledAt`
  );
  const normalized = deepFrozenClone({
    queueId,
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
    principalId: assertIdentifier(raw.principalId, `${label}.principalId`),
    ...(actorId === undefined ? {} : { actorId }),
    startedAt: timestamps.startedAt,
    settledAt: timestamps.endedAt,
    completionDigest
  }, `${label} normalized`);
  const settlementDigest = assertSha256Hex(raw.settlementDigest, `${label}.settlementDigest`);
  if (settlementDigest !== nodeTurnSettlementDigest(normalized)) {
    throw new Error(`${label}: settlement digest mismatch`);
  }
  const committedOutboxEventDigests = validatedOrderedStringArray(
    raw.committedOutboxEventDigests,
    `${label}.committedOutboxEventDigests`,
    assertSha256Hex
  );
  return deepFrozenClone({
    ...normalized,
    completion,
    settlementDigest,
    committedOutboxEventDigests
  }, label) as SettlementRow;
}

function validateSnapshotLease(
  value: unknown,
  state: MemoryState,
  label: string
): Readonly<{ queueId: string; lease: LeaseRow }> {
  const entry = snapshotRecord(value, ["queueId", "lease"], ["queueId", "lease"], label);
  const queueId = assertEvidenceString(entry.queueId, `${label}.queueId`);
  const queue = state.queues.get(queueId);
  if (queue === undefined) throw new Error(`${label}: references unknown queue ${queueId}`);
  const leaseRaw = snapshotRecord(
    entry.lease,
    [
      "leaseOwner", "leaseToken", "acquiredAt", "heartbeatAt", "expiresAt",
      "mode", "principalId", "external"
    ],
    [
      "leaseOwner", "leaseToken", "acquiredAt", "heartbeatAt", "expiresAt",
      "mode", "principalId"
    ],
    `${label}.lease`
  );
  if (leaseRaw.mode !== "worker" && leaseRaw.mode !== "external") {
    throw new Error(`${label}.lease.mode must be worker or external`);
  }
  const acquiredAt = assertCanonicalTimestamp(leaseRaw.acquiredAt, `${label}.lease.acquiredAt`);
  const heartbeatAt = assertCanonicalTimestamp(
    leaseRaw.heartbeatAt,
    `${label}.lease.heartbeatAt`
  );
  const expiresAt = assertCanonicalTimestamp(leaseRaw.expiresAt, `${label}.lease.expiresAt`);
  if (
    timestampEpoch(heartbeatAt) < timestampEpoch(acquiredAt)
    || timestampEpoch(expiresAt) <= timestampEpoch(heartbeatAt)
  ) {
    throw new Error(`${label}.lease timestamps are not monotonically ordered`);
  }
  const node = nodeForQueue(state, queue);
  const principalId = assertIdentifier(leaseRaw.principalId, `${label}.lease.principalId`);
  if (principalId !== node.principal.id) {
    throw new Error(`${label}.lease.principalId conflicts with queue node authority`);
  }
  let external: LeaseRow["external"];
  if (leaseRaw.mode === "worker") {
    if (Object.hasOwn(leaseRaw, "external")) {
      throw new Error(`${label}.lease.external is forbidden for a worker lease`);
    }
    if (!WORKER_KINDS.has(node.kind)) {
      throw new Error(`${label}.lease worker mode conflicts with ${node.kind} node`);
    }
  } else {
    if (!Object.hasOwn(leaseRaw, "external")) {
      throw new Error(`${label}.lease.external is required for an external lease`);
    }
    const externalRaw = snapshotRecord(
      leaseRaw.external,
      ["kind", "actorId", "completionDigest", "outboxEventDigests"],
      ["kind", "actorId", "completionDigest", "outboxEventDigests"],
      `${label}.lease.external`
    );
    if (externalRaw.kind !== "human" && externalRaw.kind !== "callback") {
      throw new Error(`${label}.lease.external.kind must be human or callback`);
    }
    if (externalRaw.kind !== node.kind) {
      throw new Error(`${label}.lease.external.kind conflicts with queue node kind`);
    }
    external = deepFrozenClone({
      kind: externalRaw.kind,
      actorId: assertEvidenceString(externalRaw.actorId, `${label}.lease.external.actorId`),
      completionDigest: assertSha256Hex(
        externalRaw.completionDigest,
        `${label}.lease.external.completionDigest`
      ),
      outboxEventDigests: validatedOrderedStringArray(
        externalRaw.outboxEventDigests,
        `${label}.lease.external.outboxEventDigests`,
        assertSha256Hex
      )
    }, `${label}.lease.external`);
  }
  return deepFrozenClone({
    queueId,
    lease: {
      leaseOwner: assertEvidenceString(leaseRaw.leaseOwner, `${label}.lease.leaseOwner`),
      leaseToken: assertEvidenceString(leaseRaw.leaseToken, `${label}.lease.leaseToken`),
      acquiredAt,
      heartbeatAt,
      expiresAt,
      mode: leaseRaw.mode,
      principalId,
      ...(external === undefined ? {} : { external })
    }
  }, label);
}

const JOURNEY_KEYS = Object.freeze({
  unit_admitted: [
    "kind", "sequence", "unitId", "graph", "recordedAt", "recordDigest",
    "principalId", "seedArtifact", "entryQueueId", "entryNodeId", "entryEnqueueSequence"
  ],
  turn_settled: [
    "kind", "sequence", "unitId", "graph", "recordedAt", "recordDigest",
    "queueId", "nodeId", "nodeRef", "attemptNumber", "attemptIndex", "idempotencyKey",
    "inputArtifact", "outcome", "outputArtifact", "usage", "principalId", "actorId",
    "startedAt", "settledAt", "completionDigest", "settlementDigest", "routing"
  ],
  turn_failed: [
    "kind", "sequence", "unitId", "graph", "recordedAt", "recordDigest",
    "queueId", "nodeId", "nodeRef", "attemptNumber", "attemptIndex", "idempotencyKey",
    "inputArtifact", "principalId", "startedAt", "failedAt", "errorCode", "errorMessage",
    "retryable", "terminal", "usage", "failureDigest", "routing"
  ],
  join_unsatisfiable: [
    "kind", "sequence", "unitId", "graph", "recordedAt", "recordDigest",
    "nodeId", "outcome", "principalId", "startedAt", "settledAt",
    "causeEvidenceDigest", "artifact", "syntheticOutcomeDigest", "routing"
  ]
} as const);

function validateSnapshotJourneyRecord(value: unknown, label: string): UnitJourneyRecord {
  value = snapshotGraphValidationData(value, label);
  const kindRaw = snapshotRecord(
    value,
    [...new Set(Object.values(JOURNEY_KEYS).flat())],
    ["kind"],
    label
  );
  const kind = kindRaw.kind;
  if (
    kind !== "unit_admitted"
    && kind !== "turn_settled"
    && kind !== "turn_failed"
    && kind !== "join_unsatisfiable"
  ) {
    throw new Error(`${label}.kind is not a recognized journey record kind`);
  }
  const optional = kind === "turn_settled" ? new Set(["outputArtifact", "actorId"]) : new Set();
  const keys = JOURNEY_KEYS[kind];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => !optional.has(key)),
    label
  );
  assertSafePositiveInt(raw.sequence, `${label}.sequence`);
  assertEvidenceString(raw.unitId, `${label}.unitId`);
  validateGraphDefinitionRef(raw.graph, `${label}.graph`);
  assertCanonicalTimestamp(raw.recordedAt, `${label}.recordedAt`);
  const recordDigest = assertSha256Hex(raw.recordDigest, `${label}.recordDigest`);
  const cloned = deepFrozenClone(raw, label) as unknown as UnitJourneyRecord;
  const { recordDigest: _ignored, ...base } = cloned;
  if (recordDigest !== digest(base)) throw new Error(`${label}: journey record digest mismatch`);
  return cloned;
}

function validateSnapshotJoinProgress(
  value: unknown,
  state: MemoryState,
  label: string
): JoinProgress {
  const keys = [
    "unitId", "nodeId", "require", "inbound", "status", "selectedEdgeId",
    "queueId", "syntheticOutcomeDigest"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    ["unitId", "nodeId", "require", "inbound", "status"],
    label
  );
  const unitId = assertEvidenceString(raw.unitId, `${label}.unitId`);
  const nodeId = assertIdentifier(raw.nodeId, `${label}.nodeId`);
  const graph = state.unitGraphs.get(unitId);
  const node = graph === undefined ? undefined : compileGraph(graph).nodesById[nodeId];
  if (node?.join === undefined) throw new Error(`${label}: references a node without a join`);
  const require = raw.require;
  if (
    require !== "all"
    && (
      require === null
      || typeof require !== "object"
      || (require as { nOf?: unknown }).nOf === undefined
    )
  ) {
    throw new Error(`${label}.require is invalid`);
  }
  if (digest(require) !== digest(node.join.require)) {
    throw new Error(`${label}.require conflicts with the sealed graph`);
  }
  const inboundValues = snapshotArray(raw.inbound, `${label}.inbound`);
  if (inboundValues.length !== node.join.inbound.length) {
    throw new Error(`${label}.inbound must cover every declared join edge`);
  }
  const inbound = Object.freeze(inboundValues.map((entry, index): JoinInboundProgress => {
    const entryRaw = snapshotRecord(
      entry,
      ["edgeId", "state", "offer", "impossible"],
      ["edgeId", "state"],
      `${label}.inbound[${index}]`
    );
    const edgeId = assertIdentifier(entryRaw.edgeId, `${label}.inbound[${index}].edgeId`);
    if (edgeId !== node.join!.inbound[index]) {
      throw new Error(`${label}.inbound[${index}] is not in sealed join order`);
    }
    if (entryRaw.state === "pending") {
      if (Object.hasOwn(entryRaw, "offer") || Object.hasOwn(entryRaw, "impossible")) {
        throw new Error(`${label}.inbound[${index}] pending entry has resolution evidence`);
      }
      return Object.freeze({ edgeId, state: "pending" as const });
    }
    if (entryRaw.state === "offered") {
      if (!Object.hasOwn(entryRaw, "offer") || Object.hasOwn(entryRaw, "impossible")) {
        throw new Error(`${label}.inbound[${index}] offered entry has invalid evidence`);
      }
      const offer = validateSnapshotJoinOffer(
        entryRaw.offer,
        `${label}.inbound[${index}].offer`
      );
      if (offer.edgeId !== edgeId) {
        throw new Error(`${label}.inbound[${index}].offer edge identity mismatch`);
      }
      return Object.freeze({ edgeId, state: "offered" as const, offer });
    }
    if (entryRaw.state !== "impossible") {
      throw new Error(`${label}.inbound[${index}].state is invalid`);
    }
    if (!Object.hasOwn(entryRaw, "impossible") || Object.hasOwn(entryRaw, "offer")) {
      throw new Error(`${label}.inbound[${index}] impossible entry has invalid evidence`);
    }
    const impossibleRaw = snapshotRecord(
      entryRaw.impossible,
      ["edgeId", "sourceNodeId", "causeEvidenceDigest", "resolvedAt", "reason"],
      ["edgeId", "sourceNodeId", "causeEvidenceDigest", "resolvedAt", "reason"],
      `${label}.inbound[${index}].impossible`
    );
    if (impossibleRaw.reason !== "source_unreachable") {
      throw new Error(`${label}.inbound[${index}].impossible.reason is invalid`);
    }
    const impossible: JoinImpossibleEdge = deepFrozenClone({
      edgeId: assertIdentifier(
        impossibleRaw.edgeId,
        `${label}.inbound[${index}].impossible.edgeId`
      ),
      sourceNodeId: assertIdentifier(
        impossibleRaw.sourceNodeId,
        `${label}.inbound[${index}].impossible.sourceNodeId`
      ),
      causeEvidenceDigest: assertSha256Hex(
        impossibleRaw.causeEvidenceDigest,
        `${label}.inbound[${index}].impossible.causeEvidenceDigest`
      ),
      resolvedAt: assertCanonicalTimestamp(
        impossibleRaw.resolvedAt,
        `${label}.inbound[${index}].impossible.resolvedAt`
      ),
      reason: "source_unreachable" as const
    }, `${label}.inbound[${index}].impossible`);
    if (impossible.edgeId !== edgeId) {
      throw new Error(`${label}.inbound[${index}].impossible edge identity mismatch`);
    }
    return Object.freeze({ edgeId, state: "impossible" as const, impossible });
  }));
  if (raw.status !== "pending" && raw.status !== "queued" && raw.status !== "unsatisfiable") {
    throw new Error(`${label}.status is invalid`);
  }
  const selectedEdgeId = Object.hasOwn(raw, "selectedEdgeId")
    ? assertIdentifier(raw.selectedEdgeId, `${label}.selectedEdgeId`)
    : undefined;
  const queueId = Object.hasOwn(raw, "queueId")
    ? assertEvidenceString(raw.queueId, `${label}.queueId`)
    : undefined;
  const syntheticOutcomeDigest = Object.hasOwn(raw, "syntheticOutcomeDigest")
    ? assertSha256Hex(raw.syntheticOutcomeDigest, `${label}.syntheticOutcomeDigest`)
    : undefined;
  if (raw.status === "pending" && (
    selectedEdgeId !== undefined || queueId !== undefined || syntheticOutcomeDigest !== undefined
  )) {
    throw new Error(`${label}: pending join has resolution fields`);
  }
  if (raw.status === "queued" && (
    selectedEdgeId === undefined || queueId === undefined || syntheticOutcomeDigest !== undefined
  )) {
    throw new Error(`${label}: queued join has invalid resolution fields`);
  }
  if (raw.status === "unsatisfiable" && (
    selectedEdgeId !== undefined || queueId !== undefined || syntheticOutcomeDigest === undefined
  )) {
    throw new Error(`${label}: unsatisfiable join has invalid resolution fields`);
  }
  return deepFrozenClone({
    unitId,
    nodeId,
    require: node.join.require,
    inbound,
    status: raw.status,
    ...(selectedEdgeId === undefined ? {} : { selectedEdgeId }),
    ...(queueId === undefined ? {} : { queueId }),
    ...(syntheticOutcomeDigest === undefined ? {} : { syntheticOutcomeDigest })
  }, label);
}

function validateSnapshotOutboxEvent(value: unknown, label: string): UnitOutboxEventRecord {
  const keys = [
    "outboxEventId", "unitId", "queueId", "nodeId", "attemptNumber", "attemptIndex",
    "eventType", "payload", "dedupeKey", "eventDigest", "recordedAt"
  ];
  const raw = snapshotRecord(
    value,
    keys,
    keys.filter((key) => ![
      "queueId", "attemptNumber", "attemptIndex", "dedupeKey"
    ].includes(key)),
    label
  );
  const queueId = Object.hasOwn(raw, "queueId")
    ? assertEvidenceString(raw.queueId, `${label}.queueId`)
    : undefined;
  const attemptNumber = Object.hasOwn(raw, "attemptNumber")
    ? assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`)
    : undefined;
  const attemptIndex = Object.hasOwn(raw, "attemptIndex")
    ? assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`)
    : undefined;
  if ((attemptNumber === undefined) !== (attemptIndex === undefined)) {
    throw new Error(`${label}: attemptNumber and attemptIndex must appear together`);
  }
  const dedupeKey = Object.hasOwn(raw, "dedupeKey")
    ? assertEvidenceString(raw.dedupeKey, `${label}.dedupeKey`)
    : undefined;
  const eventType = assertEvidenceString(raw.eventType, `${label}.eventType`);
  const payload = snapshotGraphValidationData(raw.payload, `${label}.payload`);
  const eventDigest = assertSha256Hex(raw.eventDigest, `${label}.eventDigest`);
  const computed = turnOutboxEventDigest({
    eventType,
    payload,
    ...(dedupeKey === undefined ? {} : { dedupeKey })
  });
  if (eventDigest !== computed) throw new Error(`${label}: outbox event digest mismatch`);
  return deepFrozenClone({
    outboxEventId: assertEvidenceString(raw.outboxEventId, `${label}.outboxEventId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    ...(queueId === undefined ? {} : { queueId }),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    ...(attemptNumber === undefined ? {} : { attemptNumber, attemptIndex }),
    eventType,
    payload,
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    eventDigest,
    recordedAt: assertCanonicalTimestamp(raw.recordedAt, `${label}.recordedAt`)
  }, label);
}

/** Envelope inputs are derived evidence, never trusted just because re-sealed. */
function validateSnapshotEnvelopeJoins(state: MemoryState, label: string): void {
  for (const [unitId, graph] of state.unitGraphs) {
    // Hydration already validated and compiled these frozen graphs. Ordinary
    // graphs need no additional envelope-provenance compilation or traversal.
    if (!graph.nodes.some((node) => node.join?.compose === "envelope")) continue;
    const compiled = compileGraph(graph);
    const records = state.journey.get(unitId) ?? [];
    for (const node of compiled.nodes) {
      if (node.join?.compose !== "envelope") continue;
      const progress = state.joins.get(joinKey(unitId, node.nodeId));
      const queues = [...state.queues.values()].filter((queue) =>
        queue.unitId === unitId && queue.nodeId === node.nodeId
      );
      if (progress === undefined) {
        if (queues.length > 0 || records.some((record) =>
          record.kind === "turn_settled"
          || record.kind === "join_unsatisfiable"
          || (record.kind === "turn_failed" && record.terminal)
        )) throw new Error(`${label}: envelope join lacks retained progress`);
        continue;
      }
      const accepted = progress.inbound.flatMap((entry) => entry.state === "offered" ? [entry.offer] : []);
      const recordedAccepted = records.flatMap((record) =>
        record.kind !== "turn_settled" && record.kind !== "join_unsatisfiable" ? [] : record.routing.flatMap((effect) =>
          effect.kind !== "join_offer" || effect.targetNodeId !== node.nodeId || effect.disposition !== "accepted" ? [] : [{
            edgeId: effect.edgeId,
            sourceNodeId: record.nodeId,
            ...(record.kind === "turn_settled" ? { sourceQueueId: record.queueId } : {}),
            sourceEvidenceDigest: record.kind === "turn_settled" ? record.settlementDigest : record.syntheticOutcomeDigest,
            artifact: effect.artifact,
            offeredAt: record.settledAt
          }]
        )
      );
      if (
        recordedAccepted.length !== accepted.length
        || recordedAccepted.some((offer) => !accepted.some((item) => canonicalJson(item) === canonicalJson(offer)))
      ) {
        throw new Error(`${label}: envelope join accepted progress differs from journey offers`);
      }
      const acceptedSequences: number[] = [];
      const embedded = accepted.map((offer) => {
        const edge = compiled.edgesById[offer.edgeId];
        const source = compiled.nodesById[offer.sourceNodeId];
        if (edge?.from !== offer.sourceNodeId || source === undefined) {
          throw new Error(`${label}: envelope join offer source conflicts with sealed edge`);
        }
        const retained = state.artifacts.get(artifactKey(offer.artifact));
        if (retained === undefined) {
          throw new Error(`${label}: envelope join offer artifact is not retained`);
        }
        // Retention dedupes by contract/digest. Each offer preserves its own
        // optional bytes field even when another wrapper was retained first.
        const offeredArtifact = validateArtifactEnvelope({ ...offer.artifact, payload: retained.payload });
        let evidence: UnitTurnJourneyRecord | JoinUnsatisfiableJourneyRecord | undefined;
        if (offer.sourceQueueId !== undefined) {
          const sourceQueue = state.queues.get(offer.sourceQueueId);
          const settlement = state.settlements.get(offer.sourceQueueId);
          if (
            sourceQueue?.unitId !== unitId
            || sourceQueue.nodeId !== offer.sourceNodeId
            || !sameNodeRef(sourceQueue.nodeRef, source.ref)
            || settlement?.unitId !== unitId
            || settlement.nodeId !== offer.sourceNodeId
            || settlement.settlementDigest !== offer.sourceEvidenceDigest
            || settlement.settledAt !== offer.offeredAt
          ) {
            throw new Error(`${label}: envelope join source queue/settlement provenance mismatch`);
          }
          const effective = settlement.completion.outputArtifact ?? sourceQueue.inputArtifact;
          if (
            canonicalJson(artifactRef(effective)) !== canonicalJson(offer.artifact)
            || canonicalJson(effective.payload) !== canonicalJson(retained.payload)
            || !matchingOutcomeEdges([edge], settlement.completion.outcome, settlement.completion.outputArtifact).length
          ) {
            throw new Error(`${label}: envelope join offer differs from source completion/routing`);
          }
          evidence = records.find((record): record is UnitTurnJourneyRecord =>
            record.kind === "turn_settled"
            && record.queueId === offer.sourceQueueId
            && record.nodeId === offer.sourceNodeId
            && record.settlementDigest === offer.sourceEvidenceDigest
          );
        } else {
          evidence = records.find((record): record is JoinUnsatisfiableJourneyRecord =>
            record.kind === "join_unsatisfiable"
            && record.nodeId === offer.sourceNodeId
            && record.syntheticOutcomeDigest === offer.sourceEvidenceDigest
          );
          if (
            source.join === undefined
            || retained.contractId !== JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT
            || evidence === undefined
            || canonicalJson(evidence.artifact) !== canonicalJson(offer.artifact)
            || !matchingOutcomeEdges([edge], "join_unsatisfiable", retained).length
          ) {
            throw new Error(`${label}: envelope join synthetic source provenance mismatch`);
          }
          const sourceProgress = state.joins.get(joinKey(unitId, source.nodeId));
          const sourceAccepted = sourceProgress?.inbound.flatMap((entry) => entry.state === "offered" ? [entry.offer] : []) ?? [];
          const sourceImpossible = sourceProgress?.inbound.flatMap((entry) => entry.state === "impossible" ? [entry.impossible] : []) ?? [];
          const expectedSyntheticPayload = {
            schemaVersion: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
            unitId,
            graph: compiled.graph,
            nodeId: source.nodeId,
            require: source.join.require,
            accepted: sourceAccepted,
            impossible: sourceImpossible,
            causeEvidenceDigest: evidence.causeEvidenceDigest,
            resolvedAt: evidence.settledAt
          };
          if (
            sourceProgress?.status !== "unsatisfiable"
            || canonicalJson(retained.payload) !== canonicalJson(expectedSyntheticPayload)
            || evidence.syntheticOutcomeDigest !== digest({
              unitId,
              graphDigest: graph.graphDigest,
              nodeId: source.nodeId,
              outcome: "join_unsatisfiable",
              accepted: sourceAccepted.map((item) => item.edgeId),
              impossible: sourceImpossible.map((item) => item.edgeId),
              causeEvidenceDigest: evidence.causeEvidenceDigest,
              resolvedAt: evidence.settledAt,
              artifactDigest: retained.digest
            })
          ) {
            throw new Error(`${label}: envelope join synthetic artifact identity mismatch`);
          }
        }
        if (
          evidence === undefined
          || evidence.settledAt !== offer.offeredAt
          || !evidence.routing.some((effect) =>
            effect.kind === "join_offer"
            && effect.targetNodeId === node.nodeId
            && effect.edgeId === offer.edgeId
            && effect.disposition === "accepted"
            && canonicalJson(effect.artifact) === canonicalJson(offer.artifact)
          )
        ) {
          throw new Error(`${label}: envelope join offer lacks accepted journey evidence`);
        }
        acceptedSequences.push(evidence.sequence);
        return { ...offer, artifact: offeredArtifact };
      });
      const threshold = evaluateJoinThreshold(node.join.require, progress.inbound.map(({ edgeId, state: edgeState }) => ({ edgeId, state: edgeState })));
      if (progress.status !== "queued") {
        if (
          queues.length > 0
          || threshold.thresholdSatisfied
          || (progress.status === "unsatisfiable") !== threshold.unsatisfiable
        ) {
          throw new Error(`${label}: unresolved envelope join conflicts with retained queues/threshold`);
        }
        continue;
      }
      const queue = state.queues.get(progress.queueId!);
      const expectedProvenance = {
        joinNodeId: node.nodeId,
        selectedEdgeId: accepted[0]?.edgeId,
        accepted
      };
      if (
        !threshold.thresholdSatisfied
        || queues.length !== 1
        || queue === undefined
        || queue.join === undefined
        || progress.selectedEdgeId !== accepted[0]?.edgeId
        || canonicalJson(queue.join) !== canonicalJson(expectedProvenance)
        || canonicalJson(queue.inboundEdgeIds) !== canonicalJson(accepted.map((offer) => offer.edgeId))
      ) {
        throw new Error(`${label}: envelope join queue/progress provenance mismatch`);
      }
      const resolution = records.find((record) =>
        record.kind !== "unit_admitted" && record.routing.some((effect) =>
          effect.kind === "join_queued"
          && effect.targetNodeId === node.nodeId
          && effect.queueId === queue.queueId
          && effect.enqueueSequence === queue.enqueueSequence
          && effect.selectedEdgeId === progress.selectedEdgeId
          && canonicalJson(effect.acceptedEdgeIds) === canonicalJson(queue.inboundEdgeIds)
        )
      );
      const resolutionDigest = resolution?.kind === "turn_settled"
        ? resolution.settlementDigest
        : resolution?.kind === "join_unsatisfiable" ? resolution.syntheticOutcomeDigest : undefined;
      if (
        resolution === undefined
        || resolutionDigest !== queue.sourceEvidenceDigest
        || (resolution.kind !== "turn_settled" && resolution.kind !== "join_unsatisfiable")
        || resolution.settledAt !== queue.queuedAt
        || acceptedSequences.some((sequence) => sequence > resolution.sequence)
      ) {
        throw new Error(`${label}: envelope join queue lacks matching resolution evidence`);
      }
      const actual = validateJoinInputArtifact(graph, queue.inputArtifact);
      const expected = createJoinInputArtifact(graph, { unitId, nodeId: node.nodeId, accepted: embedded });
      const retainedInput = state.artifacts.get(artifactKey(actual));
      if (
        canonicalJson(actual) !== canonicalJson(expected)
        || retainedInput === undefined
        || canonicalJson(retainedInput) !== canonicalJson(expected)
      ) {
        throw new Error(`${label}: envelope join input differs from retained accepted provenance`);
      }
    }
  }
}

function validateSnapshotDeadLetter(value: unknown, label: string): UnitDeadLetterRecord {
  const keys = [
    "deadLetterId", "unitId", "queueId", "nodeId", "attemptNumber", "attemptIndex",
    "errorCode", "failureDigest", "principalId", "recordedAt"
  ];
  const raw = snapshotRecord(value, keys, keys, label);
  return deepFrozenClone({
    deadLetterId: assertEvidenceString(raw.deadLetterId, `${label}.deadLetterId`),
    unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
    queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
    attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
    errorCode: assertIdentifier(raw.errorCode, `${label}.errorCode`),
    failureDigest: assertSha256Hex(raw.failureDigest, `${label}.failureDigest`),
    principalId: assertIdentifier(raw.principalId, `${label}.principalId`),
    recordedAt: assertCanonicalTimestamp(raw.recordedAt, `${label}.recordedAt`)
  }, label);
}

function validateQueueCoordinates(
  state: MemoryState,
  row: {
    readonly queueId: string;
    readonly unitId: string;
    readonly nodeId: string;
    readonly attemptNumber: number;
    readonly attemptIndex: number;
    readonly idempotencyKey: string;
  },
  label: string
): AttemptReservation {
  const queue = state.queues.get(row.queueId);
  if (queue === undefined || queue.unitId !== row.unitId || queue.nodeId !== row.nodeId) {
    throw new Error(`${label}: queue/unit/node coordinates do not resolve`);
  }
  const reservation = (state.reservations.get(row.queueId) ?? []).find(
    (candidate) => candidate.attemptNumber === row.attemptNumber
  );
  if (
    reservation === undefined
    || reservation.attemptIndex !== row.attemptIndex
    || reservation.idempotencyKey !== row.idempotencyKey
  ) {
    throw new Error(`${label}: attempt coordinates do not resolve`);
  }
  return reservation;
}

function hydrateMemoryState(value: unknown): MemoryState {
  const label = "MemoryUnitStore initialState";
  const captured = snapshotRecord(value, STATE_SNAPSHOT_KEYS, STATE_SNAPSHOT_KEYS, label);
  const snapshot = captured as unknown as MemoryUnitStoreStateSnapshot;
  if (snapshot.schemaVersion !== MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `${label}.schemaVersion must be ${MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION}`
    );
  }
  const state = emptyState();

  const graphIdentities = new Map<string, string>();
  const nodeSignatures = new Map<string, string>();
  snapshotArray(snapshot.unitGraphs, `${label}.unitGraphs`).forEach((entry, index) => {
    const entryLabel = `${label}.unitGraphs[${index}]`;
    const raw = snapshotRecord(entry, ["unitId", "graph"], ["unitId", "graph"], entryLabel);
    const unitId = assertEvidenceString(raw.unitId, `${entryLabel}.unitId`);
    const graph = validateGraphDefinition(raw.graph);
    compileGraph(graph);
    putUnique(state.unitGraphs, unitId, graph, `${label}.unitGraphs`);
    const identity = `${graph.graphId}\0${graph.version}`;
    const priorDigest = graphIdentities.get(identity);
    if (priorDigest !== undefined && priorDigest !== graph.graphDigest) {
      throw new Error(`${entryLabel}: graph identity has conflicting digests`);
    }
    graphIdentities.set(identity, graph.graphDigest);
    for (const node of graph.nodes) {
      const ref = `${node.ref.id}\0${node.ref.version}`;
      const signature = digest({
        kind: node.kind,
        input: node.input,
        outcomes: [...node.outcomes.outcomes].sort()
      });
      const priorSignature = nodeSignatures.get(ref);
      if (priorSignature !== undefined && priorSignature !== signature) {
        throw new Error(`${entryLabel}: node definition ${node.ref.id}@${node.ref.version} conflicts`);
      }
      nodeSignatures.set(ref, signature);
    }
  });

  snapshotArray(snapshot.units, `${label}.units`).forEach((entry, index) => {
    const unit = validateSnapshotUnit(entry, `${label}.units[${index}]`);
    putUnique(state.units, unit.unitId, unit, `${label}.units`);
  });
  if (state.units.size !== state.unitGraphs.size) {
    throw new Error(`${label}: units and unitGraphs must have identical unit identities`);
  }
  for (const [unitId, unit] of state.units) {
    const graph = state.unitGraphs.get(unitId);
    if (graph === undefined) throw new Error(`${label}: unit ${unitId} has no graph`);
    assertGraphRefEqual(unit.graph, graphDefinitionRef(graph), `${label}: unit ${unitId}`);
  }

  snapshotArray(snapshot.artifacts, `${label}.artifacts`).forEach((entry, index) => {
    const artifact = validateArtifactEnvelope(entry);
    putUnique(state.artifacts, artifactKey(artifact), artifact, `${label}.artifacts[${index}]`);
  });
  for (const unit of state.units.values()) {
    if (!state.artifacts.has(artifactKey(unit.seedArtifact))) {
      throw new Error(`${label}: unit ${unit.unitId} seed artifact is missing`);
    }
  }

  const enqueueSequences = new Set<number>();
  snapshotArray(snapshot.queues, `${label}.queues`).forEach((entry, index) => {
    const queue = validateSnapshotQueue(entry, `${label}.queues[${index}]`);
    putUnique(state.queues, queue.queueId, queue, `${label}.queues`);
    if (enqueueSequences.has(queue.enqueueSequence)) {
      throw new Error(`${label}.queues: duplicate enqueue sequence ${queue.enqueueSequence}`);
    }
    enqueueSequences.add(queue.enqueueSequence);
    const unit = state.units.get(queue.unitId);
    const graph = state.unitGraphs.get(queue.unitId);
    if (unit === undefined || graph === undefined) {
      throw new Error(`${label}.queues[${index}]: references unknown unit ${queue.unitId}`);
    }
    assertGraphRefEqual(queue.graph, unit.graph, `${label}.queues[${index}]`);
    const node = compileGraph(graph).nodesById[queue.nodeId];
    if (node === undefined || !sameNodeRef(queue.nodeRef, node.ref)) {
      throw new Error(`${label}.queues[${index}]: node reference conflicts with sealed graph`);
    }
    if (queue.inputArtifact.contractId !== node.input) {
      throw new Error(`${label}.queues[${index}]: input artifact contract conflicts with node`);
    }
    const retainedArtifact = state.artifacts.get(artifactKey(queue.inputArtifact));
    if (retainedArtifact === undefined) {
      throw new Error(`${label}.queues[${index}]: input artifact is not retained`);
    }
    const inbound = new Set(graph.edges
      .filter((edge) => edge.to.includes(queue.nodeId))
      .map((edge) => edge.edgeId));
    if (queue.inboundEdgeIds.some((edgeId) => !inbound.has(edgeId))) {
      throw new Error(`${label}.queues[${index}]: inbound edge is not declared by the graph`);
    }
    if (queue.join !== undefined && queue.join.joinNodeId !== queue.nodeId) {
      throw new Error(`${label}.queues[${index}]: join provenance targets another node`);
    }
  });
  const nextEnqueueSequence = assertSafePositiveInt(
    snapshot.nextEnqueueSequence,
    `${label}.nextEnqueueSequence`
  );
  let maximumEnqueueSequence = 0;
  for (const sequence of enqueueSequences) {
    if (sequence > maximumEnqueueSequence) maximumEnqueueSequence = sequence;
  }
  if (nextEnqueueSequence <= maximumEnqueueSequence) {
    throw new Error(`${label}.nextEnqueueSequence must exceed every retained queue sequence`);
  }
  (state as { nextEnqueueSequence: number }).nextEnqueueSequence = nextEnqueueSequence;

  const globalAttemptIdentities = new Set<string>();
  snapshotArray(snapshot.attempts, `${label}.attempts`).forEach((entry, index) => {
    const reservation = validateSnapshotReservation(entry, `${label}.attempts[${index}]`);
    const queue = state.queues.get(reservation.queueId);
    if (
      queue === undefined
      || queue.unitId !== reservation.unitId
      || queue.nodeId !== reservation.nodeId
    ) {
      throw new Error(`${label}.attempts[${index}]: queue coordinates do not resolve`);
    }
    const node = nodeForQueue(state, queue);
    if (
      !sameNodeRef(reservation.nodeRef, node.ref)
      || reservation.fingerprint !== nodeExecutionFingerprint(node)
      || reservation.inputDigest !== queue.inputArtifact.digest
    ) {
      throw new Error(`${label}.attempts[${index}]: execution identity conflicts with queue`);
    }
    const expectedKey = nodeTurnIdempotencyKey({
      unitId: reservation.unitId,
      nodeId: reservation.nodeId,
      attemptNumber: reservation.attemptNumber,
      nodeRef: reservation.nodeRef,
      fingerprint: reservation.fingerprint,
      inputDigest: reservation.inputDigest,
      ...(reservation.executionIdentityDigest === undefined
        ? {}
        : { executionIdentityDigest: reservation.executionIdentityDigest })
    });
    if (reservation.idempotencyKey !== expectedKey) {
      throw new Error(`${label}.attempts[${index}]: idempotency key mismatch`);
    }
    const globalIdentity = `${reservation.unitId}\0${reservation.nodeId}\0${reservation.attemptNumber}`;
    if (globalAttemptIdentities.has(globalIdentity)) {
      throw new Error(`${label}.attempts[${index}]: duplicate global attempt identity`);
    }
    globalAttemptIdentities.add(globalIdentity);
    const rows = state.reservations.get(reservation.queueId) ?? [];
    if (
      rows.some((row) =>
        row.attemptNumber === reservation.attemptNumber
        || row.attemptIndex === reservation.attemptIndex
      )
    ) {
      throw new Error(`${label}.attempts[${index}]: duplicate attempt identity`);
    }
    if (reservation.attemptIndex !== rows.length + 1) {
      throw new Error(`${label}.attempts[${index}]: attempt indexes must be contiguous`);
    }
    state.reservations.set(reservation.queueId, Object.freeze([...rows, reservation]));
  });

  snapshotArray(snapshot.cachedCompletions, `${label}.cachedCompletions`)
    .forEach((entry, index) => {
      const cached = validateSnapshotCachedCompletion(
        entry,
        state,
        `${label}.cachedCompletions[${index}]`
      );
      const queue = state.queues.get(cached.queueId)!;
      const reservation = validateQueueCoordinates(state, {
        queueId: cached.queueId,
        unitId: queue.unitId,
        nodeId: queue.nodeId,
        attemptNumber: cached.attemptNumber,
        attemptIndex: cached.attemptIndex,
        idempotencyKey: cached.idempotencyKey
      }, `${label}.cachedCompletions[${index}]`);
      if (reservation.idempotencyKey !== cached.idempotencyKey) {
        throw new Error(`${label}.cachedCompletions[${index}]: reservation mismatch`);
      }
      putUnique(
        state.cachedCompletions,
        attemptKey(cached.queueId, cached.attemptNumber),
        cached,
        `${label}.cachedCompletions`
      );
    });

  snapshotArray(snapshot.failures, `${label}.failures`).forEach((entry, index) => {
    const failure = validateSnapshotFailure(entry, `${label}.failures[${index}]`);
    const reservation = validateQueueCoordinates(
      state,
      failure,
      `${label}.failures[${index}]`
    );
    const node = nodeForQueue(state, state.queues.get(failure.queueId)!);
    if (failure.principalId !== node.principal.id) {
      throw new Error(`${label}.failures[${index}]: principal conflicts with node`);
    }
    const expectedTerminal = !failure.retryable || reservation.attemptIndex >= node.turn.maxAttempts;
    if (failure.terminal !== expectedTerminal) {
      throw new Error(`${label}.failures[${index}]: terminal disposition mismatch`);
    }
    const key = attemptKey(failure.queueId, failure.attemptNumber);
    if (state.cachedCompletions.has(key)) {
      throw new Error(`${label}.failures[${index}]: contradicts cached completion`);
    }
    putUnique(state.failures, key, failure, `${label}.failures`);
  });

  snapshotArray(snapshot.settlements, `${label}.settlements`).forEach((entry, index) => {
    const settlement = validateSnapshotSettlement(
      entry,
      state,
      `${label}.settlements[${index}]`
    );
    validateQueueCoordinates(state, settlement, `${label}.settlements[${index}]`);
    const queue = state.queues.get(settlement.queueId)!;
    const node = nodeForQueue(state, queue);
    if (settlement.principalId !== node.principal.id) {
      throw new Error(`${label}.settlements[${index}]: principal conflicts with node`);
    }
    if (WORKER_KINDS.has(node.kind) && settlement.actorId !== undefined) {
      throw new Error(`${label}.settlements[${index}]: worker settlement has actorId`);
    }
    if (!WORKER_KINDS.has(node.kind) && settlement.actorId === undefined) {
      throw new Error(`${label}.settlements[${index}]: external settlement lacks actorId`);
    }
    if (WORKER_KINDS.has(node.kind)) {
      const cached = state.cachedCompletions.get(attemptKey(
        settlement.queueId,
        settlement.attemptNumber
      ));
      if (
        cached === undefined
        || cached.completionDigest !== settlement.completionDigest
        || cached.startedAt !== settlement.startedAt
        || cached.settledAt !== settlement.settledAt
      ) {
        throw new Error(`${label}.settlements[${index}]: worker cache evidence mismatch`);
      }
    }
    if (
      settlement.completion.outputArtifact !== undefined
      && !state.artifacts.has(artifactKey(settlement.completion.outputArtifact))
    ) {
      throw new Error(`${label}.settlements[${index}]: output artifact is not retained`);
    }
    if (state.failures.has(attemptKey(settlement.queueId, settlement.attemptNumber))) {
      throw new Error(`${label}.settlements[${index}]: contradicts failed attempt`);
    }
    putUnique(
      state.settlements,
      settlement.queueId,
      settlement,
      `${label}.settlements`
    );
  });

  snapshotArray(snapshot.journey, `${label}.journey`).forEach((entry, index) => {
    const record = validateSnapshotJourneyRecord(entry, `${label}.journey[${index}]`);
    const unit = state.units.get(record.unitId);
    if (unit === undefined) {
      throw new Error(`${label}.journey[${index}]: references unknown unit`);
    }
    assertGraphRefEqual(record.graph, unit.graph, `${label}.journey[${index}]`);
    const rows = state.journey.get(record.unitId) ?? [];
    if (record.sequence !== rows.length + 1) {
      throw new Error(`${label}.journey[${index}]: sequence is not contiguous`);
    }
    if (record.kind === "unit_admitted") {
      const seedArtifact = validateArtifactRef(record.seedArtifact);
      const entryQueue = state.queues.get(record.entryQueueId);
      if (
        rows.length !== 0
        || record.principalId !== unit.principalId
        || record.entryNodeId !== state.unitGraphs.get(record.unitId)!.entry
        || seedArtifact.contractId !== unit.seedArtifact.contractId
        || seedArtifact.digest !== unit.seedArtifact.digest
        || entryQueue?.unitId !== unit.unitId
        || entryQueue.nodeId !== record.entryNodeId
        || entryQueue.enqueueSequence !== record.entryEnqueueSequence
        || entryQueue.sourceEvidenceDigest !== unit.admissionDigest
      ) {
        throw new Error(`${label}.journey[${index}]: admission evidence mismatch`);
      }
    } else if (record.kind === "turn_settled") {
      const settlement = state.settlements.get(record.queueId);
      if (
        settlement === undefined
        || settlement.settlementDigest !== record.settlementDigest
        || settlement.completionDigest !== record.completionDigest
      ) {
        throw new Error(`${label}.journey[${index}]: settlement evidence mismatch`);
      }
    } else if (record.kind === "turn_failed") {
      const failure = state.failures.get(attemptKey(record.queueId, record.attemptNumber));
      if (failure === undefined || failure.failureDigest !== record.failureDigest) {
        throw new Error(`${label}.journey[${index}]: failure evidence mismatch`);
      }
    }
    state.journey.set(record.unitId, Object.freeze([...rows, record]));
  });
  for (const unitId of state.units.keys()) {
    const records = state.journey.get(unitId);
    if (records?.[0]?.kind !== "unit_admitted") {
      throw new Error(`${label}: unit ${unitId} lacks admission journey evidence`);
    }
  }

  snapshotArray(snapshot.joins, `${label}.joins`).forEach((entry, index) => {
    const progress = validateSnapshotJoinProgress(entry, state, `${label}.joins[${index}]`);
    putUnique(
      state.joins,
      joinKey(progress.unitId, progress.nodeId),
      progress,
      `${label}.joins`
    );
    if (progress.status === "queued") {
      const queue = state.queues.get(progress.queueId!);
      if (queue?.nodeId !== progress.nodeId || queue.unitId !== progress.unitId) {
        throw new Error(`${label}.joins[${index}]: queued resolution has no queue`);
      }
    }
  });
  for (const records of state.journey.values()) {
    for (const record of records) {
      if (record.kind !== "join_unsatisfiable") continue;
      const progress = state.joins.get(joinKey(record.unitId, record.nodeId));
      if (
        progress?.status !== "unsatisfiable"
        || progress.syntheticOutcomeDigest !== record.syntheticOutcomeDigest
        || !state.artifacts.has(artifactKey(record.artifact))
      ) {
        throw new Error(`${label}: join-unsatisfiable journey lacks matching progress/artifact`);
      }
    }
  }

  validateSnapshotEnvelopeJoins(state, label);

  const outboxIds = new Set<string>();
  snapshotArray(snapshot.outbox, `${label}.outbox`).forEach((entry, index) => {
    const event = validateSnapshotOutboxEvent(entry, `${label}.outbox[${index}]`);
    if (outboxIds.has(event.outboxEventId)) {
      throw new Error(`${label}.outbox: duplicate outbox identity ${event.outboxEventId}`);
    }
    outboxIds.add(event.outboxEventId);
    if (!state.units.has(event.unitId)) {
      throw new Error(`${label}.outbox[${index}]: references unknown unit`);
    }
    if (event.queueId !== undefined && !state.queues.has(event.queueId)) {
      throw new Error(`${label}.outbox[${index}]: references unknown queue`);
    }
    (state as { outbox: readonly UnitOutboxEventRecord[] }).outbox =
      Object.freeze([...state.outbox, event]);
  });
  const retainedDedupeKeys = validatedStringArray(
    snapshot.outboxDedupeKeys,
    `${label}.outboxDedupeKeys`,
    assertEvidenceString
  );
  const derivedDedupeKeys = state.outbox
    .flatMap((event) => event.dedupeKey === undefined ? [] : [event.dedupeKey]);
  const retainedDedupeSet = new Set(retainedDedupeKeys);
  if (derivedDedupeKeys.some((dedupeKey) => !retainedDedupeSet.has(dedupeKey))) {
    throw new Error(`${label}.outboxDedupeKeys must cover retained outbox evidence`);
  }
  for (const dedupeKey of retainedDedupeKeys) state.outboxDedupeKeys.add(dedupeKey);
  for (const row of [...state.failures.values(), ...state.settlements.values()]) {
    const committed = state.outbox
      .filter((event) =>
        event.queueId === row.queueId
        && event.attemptNumber === row.attemptNumber
        && event.attemptIndex === row.attemptIndex
      )
      .map((event) => event.eventDigest);
    if (!sameOrdered(row.committedOutboxEventDigests, committed)) {
      throw new Error(`${label}: committed outbox digests do not match retained events`);
    }
  }

  const deadLetterIds = new Set<string>();
  snapshotArray(snapshot.deadLetters, `${label}.deadLetters`).forEach((entry, index) => {
    const deadLetter = validateSnapshotDeadLetter(entry, `${label}.deadLetters[${index}]`);
    if (deadLetterIds.has(deadLetter.deadLetterId)) {
      throw new Error(`${label}.deadLetters: duplicate identity ${deadLetter.deadLetterId}`);
    }
    deadLetterIds.add(deadLetter.deadLetterId);
    const failure = state.failures.get(attemptKey(
      deadLetter.queueId,
      deadLetter.attemptNumber
    ));
    if (
      failure === undefined
      || !failure.terminal
      || failure.failureDigest !== deadLetter.failureDigest
      || failure.principalId !== deadLetter.principalId
    ) {
      throw new Error(`${label}.deadLetters[${index}]: terminal failure reference mismatch`);
    }
    (state as { deadLetters: readonly UnitDeadLetterRecord[] }).deadLetters =
      Object.freeze([...state.deadLetters, deadLetter]);
  });

  const leaseTokens = new Set<string>();
  snapshotArray(snapshot.leases, `${label}.leases`).forEach((entry, index) => {
    const restored = validateSnapshotLease(entry, state, `${label}.leases[${index}]`);
    if (leaseTokens.has(restored.lease.leaseToken)) {
      throw new Error(`${label}.leases: duplicate lease token ${restored.lease.leaseToken}`);
    }
    if (!isQueueOpen(state, restored.queueId)) {
      throw new Error(`${label}.leases[${index}]: concluded queue cannot retain a lease`);
    }
    leaseTokens.add(restored.lease.leaseToken);
    putUnique(state.leases, restored.queueId, restored.lease, `${label}.leases`);
  });

  const validFairness = new Map<string, Set<string>>();
  for (const graph of state.unitGraphs.values()) {
    for (const node of graph.nodes) {
      const shared = sharedNodeKey(node);
      const lanes = validFairness.get(shared) ?? new Set<string>();
      lanes.add(laneKey(graph));
      validFairness.set(shared, lanes);
    }
  }
  snapshotArray(snapshot.fairnessCursor, `${label}.fairnessCursor`)
    .forEach((entry, index) => {
      const entryLabel = `${label}.fairnessCursor[${index}]`;
      const raw = snapshotRecord(
        entry,
        ["sharedNodeKey", "lastGraphLaneKey"],
        ["sharedNodeKey", "lastGraphLaneKey"],
        entryLabel
      );
      if (typeof raw.sharedNodeKey !== "string" || typeof raw.lastGraphLaneKey !== "string") {
        throw new Error(`${entryLabel}: cursor keys must be strings`);
      }
      if (!validFairness.get(raw.sharedNodeKey)?.has(raw.lastGraphLaneKey)) {
        throw new Error(`${entryLabel}: cursor does not reference a retained shared-node lane`);
      }
      putUnique(
        state.fairnessCursor,
        raw.sharedNodeKey,
        raw.lastGraphLaneKey,
        `${label}.fairnessCursor`
      );
    });

  return state;
}

function artifactKey(ref: Pick<ArtifactRef, "contractId" | "digest">): string {
  return `${ref.contractId}\0${ref.digest}`;
}

function joinKey(unitId: string, nodeId: string): string {
  return `${unitId}\0${nodeId}`;
}

function attemptKey(queueId: string, attemptNumber: number): string {
  return `${queueId}\0${attemptNumber}`;
}

function unitNodeKey(unitId: string, nodeId: string): string {
  return `${unitId}\0${nodeId}`;
}

function laneKey(graph: GraphDefinition): string {
  return `${graph.graphId}\0${graph.version}\0${graph.graphDigest}`;
}

function sharedNodeKey(node: MissionPipelineNode): string {
  return `${node.nodeId}\0${node.ref.id}\0${node.ref.version}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean (got ${typeName(value)})`);
  }
  return value;
}

function assertCanonicalTimestamp(value: unknown, label: string): string {
  const epoch = typeof value === "string"
    ? Reflect.apply(dateParse, DateConstructor, [value])
    : Number.NaN;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(epoch)
    || Reflect.apply(dateToISOString, new DateConstructor(epoch), []) !== value
  ) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function assertTimestampOrder(
  startedRaw: unknown,
  endedRaw: unknown,
  startedLabel: string,
  endedLabel: string
): { readonly startedAt: string; readonly endedAt: string } {
  const startedAt = assertCanonicalTimestamp(startedRaw, startedLabel);
  const endedAt = assertCanonicalTimestamp(endedRaw, endedLabel);
  if (timestampEpoch(endedAt) < timestampEpoch(startedAt)) {
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
    || Object.getPrototypeOf(value) !== Date.prototype
  ) {
    throw new Error("MemoryUnitStore clock must return a non-Proxy Date");
  }
  const epoch = Reflect.apply(dateGetTime, value, []);
  if (!Number.isFinite(epoch)) {
    throw new Error("MemoryUnitStore clock must return a valid Date");
  }
  return Reflect.apply(dateToISOString, value, []);
}

function isLeaseActive(lease: LeaseRow | undefined, at: string): lease is LeaseRow {
  return lease !== undefined && timestampEpoch(at) < timestampEpoch(lease.expiresAt);
}

function sealRecord<T extends object>(value: T, label: string): T & { readonly recordDigest: string } {
  const base = deepFrozenClone(value, label);
  return deepFrozenClone(
    { ...base, recordDigest: digest(base) },
    `${label} sealed`
  ) as T & { readonly recordDigest: string };
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function nodeForQueue(state: MemoryState, queue: UnitQueueOccurrence): MissionPipelineNode {
  const graph = state.unitGraphs.get(queue.unitId);
  const node = graph === undefined ? undefined : compileGraph(graph).nodesById[queue.nodeId];
  if (graph === undefined || node === undefined) {
    throw new Error(`MemoryUnitStore invariant: queue ${queue.queueId} has no sealed graph/node`);
  }
  return node;
}

function graphForQueue(state: MemoryState, queue: UnitQueueOccurrence): GraphDefinition {
  const graph = state.unitGraphs.get(queue.unitId);
  if (graph === undefined) {
    throw new Error(`MemoryUnitStore invariant: queue ${queue.queueId} has no sealed graph`);
  }
  return graph;
}

function terminalFailureForQueue(state: MemoryState, queueId: string): FailureRow | undefined {
  const rows = [...state.failures.values()]
    .filter((failure) => failure.queueId === queueId && failure.terminal)
    .sort((a, b) => a.attemptIndex - b.attemptIndex);
  return rows.at(-1);
}

function isQueueOpen(state: MemoryState, queueId: string): boolean {
  return !state.settlements.has(queueId) && terminalFailureForQueue(state, queueId) === undefined;
}

function claimSnapshot(
  state: MemoryState,
  queue: UnitQueueOccurrence,
  leaseToken: string
): ClaimedUnitTurn {
  return deepFrozenClone(
    {
      queueId: queue.queueId,
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      graph: graphForQueue(state, queue),
      inputArtifact: queue.inputArtifact,
      leaseToken
    },
    `claimed queue ${queue.queueId}`
  );
}

function graphRefEqual(
  left: { readonly id: string; readonly version: number; readonly digest: string },
  right: { readonly id: string; readonly version: number; readonly digest: string }
): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

/** Memory UnitStore; also forwards GraphStore for ergonomic hermetic use. */
export class MemoryUnitStore implements UnitStore, GraphStore {
  readonly #graphStore: GraphStore;
  readonly #now: () => Date;
  readonly #idFactory: NonNullable<MemoryUnitStoreOptions["idFactory"]>;
  readonly #settleCheckpoint?: NonNullable<MemoryUnitStoreOptions["settleCheckpoint"]>;
  #state: MemoryState;

  constructor(options: MemoryUnitStoreOptions = {}) {
    this.#graphStore = options.graphStore ?? new MemoryGraphStore();
    this.#now = options.now ?? (() => new DateConstructor());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
    this.#settleCheckpoint = options.settleCheckpoint;
    this.#state = options.initialState === undefined
      ? emptyState()
      : hydrateMemoryState(options.initialState);
  }

  async publishGraph(graph: GraphDefinition): Promise<void> {
    await this.#graphStore.publishGraph(graph);
  }

  async loadGraph(ref: Parameters<GraphStore["loadGraph"]>[0]): Promise<GraphDefinition | undefined> {
    return this.#graphStore.loadGraph(ref);
  }

  #newId(kind: Parameters<NonNullable<MemoryUnitStoreOptions["idFactory"]>>[0]): string {
    return assertEvidenceString(this.#idFactory(kind), `MemoryUnitStore ${kind} id`);
  }

  #checkpoint(checkpoint: SettleTransactionCheckpoint): void {
    if (this.#settleCheckpoint !== undefined) this.#settleCheckpoint(checkpoint);
  }

  async admitUnit(inputRaw: AdmitUnitInput): Promise<AdmitUnitResult> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["unitId", "graph", "seedArtifact", "admittedAt", "principalId"],
      ["unitId", "graph", "seedArtifact", "admittedAt", "principalId"],
      "admitUnit input"
    );
    const unitId = assertEvidenceString(raw.unitId, "admitUnit input.unitId");
    const graphRef = validateGraphDefinitionRef(raw.graph, "admitUnit input.graph");
    const seedArtifact = validateArtifactEnvelope(raw.seedArtifact);
    const admittedAt = assertCanonicalTimestamp(raw.admittedAt, "admitUnit input.admittedAt");
    const principalId = assertIdentifier(raw.principalId, "admitUnit input.principalId");
    const graph = await this.#graphStore.loadGraph(graphRef);
    if (graph === undefined) {
      throw new Error(
        `admitUnit: graph ${graphRef.id}@${graphRef.version} (${graphRef.digest}) is not published`
      );
    }
    const compiled = compileGraph(graph);
    const entry = compiled.nodesById[compiled.entry]!;
    if (seedArtifact.contractId !== entry.input) {
      throw new Error(
        `admitUnit: entry node ${entry.nodeId} input contract mismatch: expected ${entry.input}, got ${seedArtifact.contractId}`
      );
    }
    const seedRef = artifactRef(seedArtifact);
    const admissionBase = {
      schemaVersion: MISSION_PIPELINE_UNIT_SCHEMA_VERSION,
      unitId,
      graph: graphRef,
      seedArtifact: seedRef,
      admittedAt,
      principalId
    };
    const admissionDigest = digest(admissionBase);
    const existing = this.#state.units.get(unitId);
    if (existing !== undefined) {
      if (existing.admissionDigest !== admissionDigest) {
        throw new TurnEvidenceConflictError(
          `admitUnit: unit ${unitId} conflicts with immutable admission ${existing.admissionDigest}; requested ${admissionDigest}`
        );
      }
      const entryQueue = [...this.#state.queues.values()].find(
        (queue) => queue.unitId === unitId && queue.sourceEvidenceDigest === admissionDigest
      );
      if (entryQueue === undefined) {
        throw new Error(`MemoryUnitStore invariant: admitted unit ${unitId} has no entry queue`);
      }
      return deepFrozenClone({ created: false, unit: existing, entryQueue }, "admitUnit replay");
    }

    const queueId = this.#newId("queue");
    if (this.#state.queues.has(queueId)) {
      throw new Error(`MemoryUnitStore idFactory produced duplicate queue id ${queueId}`);
    }
    const unit = deepFrozenClone(
      { ...admissionBase, admissionDigest },
      `unit ${unitId}`
    );
    const entryQueue = deepFrozenClone(
      {
        queueId,
        unitId,
        graph: graphRef,
        nodeId: entry.nodeId,
        nodeRef: entry.ref,
        inputArtifact: seedArtifact,
        queuedAt: admittedAt,
        enqueueSequence: this.#state.nextEnqueueSequence,
        sourceEvidenceDigest: admissionDigest,
        inboundEdgeIds: Object.freeze([])
      },
      `unit ${unitId} entry queue`
    );
    const admissionRecord = sealRecord(
      {
        kind: "unit_admitted" as const,
        sequence: 1,
        unitId,
        graph: graphRef,
        recordedAt: admittedAt,
        principalId,
        seedArtifact: seedRef,
        entryQueueId: queueId,
        entryNodeId: entry.nodeId,
        entryEnqueueSequence: entryQueue.enqueueSequence
      },
      `unit ${unitId} admission journey`
    ) as UnitAdmittedJourneyRecord;

    const draft = cloneState(this.#state);
    draft.units.set(unitId, unit);
    draft.unitGraphs.set(unitId, graph);
    if (!draft.artifacts.has(artifactKey(seedRef))) {
      draft.artifacts.set(artifactKey(seedRef), seedArtifact);
    }
    draft.queues.set(queueId, entryQueue);
    draft.journey.set(unitId, Object.freeze([admissionRecord]));
    (draft as { nextEnqueueSequence: number }).nextEnqueueSequence += 1;
    this.#state = draft;
    return deepFrozenClone({ created: true, unit, entryQueue }, "admitUnit result");
  }

  async readUnit(inputRaw: ReadUnitInput): Promise<MissionPipelineUnit | undefined> {
    const raw = captureCapabilityRecord(inputRaw, ["unitId"], ["unitId"], "readUnit input");
    const unit = this.#state.units.get(assertEvidenceString(raw.unitId, "readUnit input.unitId"));
    return unit === undefined ? undefined : deepFrozenClone(unit, "readUnit result");
  }

  async readJourney(inputRaw: ReadJourneyInput): Promise<readonly UnitJourneyRecord[]> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["unitId"],
      ["unitId"],
      "readJourney input"
    );
    const unitId = assertEvidenceString(raw.unitId, "readJourney input.unitId");
    return deepFrozenClone(this.#state.journey.get(unitId) ?? [], "readJourney result");
  }

  async readJoinProgress(inputRaw: ReadJoinProgressInput): Promise<JoinProgress | undefined> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["unitId", "nodeId"],
      ["unitId", "nodeId"],
      "readJoinProgress input"
    );
    const progress = this.#state.joins.get(joinKey(
      assertEvidenceString(raw.unitId, "readJoinProgress input.unitId"),
      assertIdentifier(raw.nodeId, "readJoinProgress input.nodeId")
    ));
    return progress === undefined
      ? undefined
      : deepFrozenClone(progress, "readJoinProgress result");
  }

  async getArtifact(inputRaw: GetArtifactInput): Promise<ArtifactEnvelope | undefined> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["artifact"],
      ["artifact"],
      "getArtifact input"
    );
    const ref = validateArtifactRef(raw.artifact);
    const artifact = this.#state.artifacts.get(artifactKey(ref));
    return artifact === undefined ? undefined : deepFrozenClone(artifact, "getArtifact result");
  }

  async listQueuedUnits(inputRaw: ListQueuedUnitsInput): Promise<readonly QueuedUnit[]> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["principalId", "nodeId", "graphId", "limit"],
      ["principalId", "nodeId"],
      "listQueuedUnits input"
    );
    const principalId = assertIdentifier(raw.principalId, "listQueuedUnits input.principalId");
    const nodeId = assertIdentifier(raw.nodeId, "listQueuedUnits input.nodeId");
    const graphId = raw.graphId === undefined
      ? undefined
      : assertIdentifier(raw.graphId, "listQueuedUnits input.graphId");
    const limit = raw.limit === undefined
      ? 100
      : assertSafePositiveInt(raw.limit, "listQueuedUnits input.limit");
    if (limit > MAX_UNIT_STORE_LIST_LIMIT) {
      throw new Error(`listQueuedUnits input.limit must be 1..${MAX_UNIT_STORE_LIST_LIMIT}`);
    }
    const now = nowIso(this.#now);
    const candidateQueues = [...this.#state.queues.values()]
      .filter((queue) => queue.nodeId === nodeId)
      .filter((queue) => graphId === undefined || queue.graph.id === graphId)
      .filter((queue) => nodeForQueue(this.#state, queue).principal.id === principalId);
    return deepFrozenClone(
      candidateQueues
        .filter((queue) => isQueueOpen(this.#state, queue.queueId))
        .filter((queue) => !isLeaseActive(this.#state.leases.get(queue.queueId), now))
        .sort((a, b) => a.enqueueSequence - b.enqueueSequence)
        .slice(0, limit)
        .map((queue): QueuedUnit => {
          const node = nodeForQueue(this.#state, queue);
          return {
            queueId: queue.queueId,
            unitId: queue.unitId,
            graph: queue.graph,
            nodeId: queue.nodeId,
            nodeRef: queue.nodeRef,
            nodeKind: node.kind,
            principalId: node.principal.id,
            inputArtifact: queue.inputArtifact,
            queuedAt: queue.queuedAt,
            outcomes: node.outcomes.outcomes.filter(
              (outcome) => outcome !== ENGINE_JOIN_UNSATISFIABLE_OUTCOME
            ),
            ...(queue.join === undefined ? {} : { join: queue.join })
          };
        }),
      "listQueuedUnits result"
    );
  }

  async claimUnitTurns(inputRaw: ClaimUnitTurnsInput): Promise<readonly ClaimedUnitTurn[]> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["principalId", "leaseOwner", "batch", "nodeId"],
      ["principalId", "leaseOwner", "batch"],
      "claimUnitTurns input"
    );
    const principalId = assertIdentifier(raw.principalId, "claimUnitTurns input.principalId");
    const leaseOwner = assertEvidenceString(raw.leaseOwner, "claimUnitTurns input.leaseOwner");
    const batch = assertSafePositiveInt(raw.batch, "claimUnitTurns input.batch");
    if (batch > MAX_TURN_BATCH_SIZE) {
      throw new Error(`claimUnitTurns input.batch must be 1..${MAX_TURN_BATCH_SIZE}`);
    }
    const requestedNodeId = raw.nodeId === undefined
      ? undefined
      : assertIdentifier(raw.nodeId, "claimUnitTurns input.nodeId");
    const at = nowIso(this.#now);
    const eligible = [...this.#state.queues.values()]
      .filter((queue) => isQueueOpen(this.#state, queue.queueId))
      .filter((queue) => !isLeaseActive(this.#state.leases.get(queue.queueId), at))
      .filter((queue) => requestedNodeId === undefined || queue.nodeId === requestedNodeId)
      .filter((queue) => {
        const node = nodeForQueue(this.#state, queue);
        return node.principal.id === principalId && WORKER_KINDS.has(node.kind);
      })
      .sort((a, b) => a.enqueueSequence - b.enqueueSequence);
    if (eligible.length === 0) return Object.freeze([]);

    const headByShared = new Map<string, UnitQueueOccurrence>();
    for (const queue of eligible) {
      const key = sharedNodeKey(nodeForQueue(this.#state, queue));
      if (!headByShared.has(key)) headByShared.set(key, queue);
    }
    const selectedShared = [...headByShared]
      .sort((a, b) => {
        const order = a[1].enqueueSequence - b[1].enqueueSequence;
        return order === 0 ? codeUnitCompare(a[0], b[0]) : order;
      })[0]![0];
    const sharedEligible = eligible.filter(
      (queue) => sharedNodeKey(nodeForQueue(this.#state, queue)) === selectedShared
    );
    const lanes = new Map<string, UnitQueueOccurrence[]>();
    for (const queue of sharedEligible) {
      const key = laneKey(graphForQueue(this.#state, queue));
      const rows = lanes.get(key) ?? [];
      rows.push(queue);
      lanes.set(key, rows);
    }
    const laneKeys = [...lanes.keys()].sort(codeUnitCompare);
    const prior = this.#state.fairnessCursor.get(selectedShared);
    let selectedLane: string;
    if (prior === undefined) {
      selectedLane = [...lanes]
        .sort((a, b) => {
          const order = a[1][0]!.enqueueSequence - b[1][0]!.enqueueSequence;
          return order === 0 ? codeUnitCompare(a[0], b[0]) : order;
        })[0]![0];
    } else {
      selectedLane = laneKeys.find((key) => key > prior) ?? laneKeys[0]!;
    }
    const selected = lanes.get(selectedLane)!.slice(0, batch);
    const draft = cloneState(this.#state);
    const claims: ClaimedUnitTurn[] = [];
    for (const queue of selected) {
      const node = nodeForQueue(this.#state, queue);
      const leaseToken = this.#newId("lease");
      if ([...draft.leases.values()].some((lease) => lease.leaseToken === leaseToken)) {
        throw new Error(`MemoryUnitStore idFactory produced duplicate lease token ${leaseToken}`);
      }
      const expiresAt = timestampFromEpoch(timestampEpoch(at) + node.turn.leaseMs);
      draft.leases.set(queue.queueId, deepFrozenClone({
        leaseOwner,
        leaseToken,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt,
        mode: "worker" as const,
        principalId
      }, `queue ${queue.queueId} worker lease`));
      claims.push(claimSnapshot(this.#state, queue, leaseToken));
    }
    draft.fairnessCursor.set(selectedShared, selectedLane);
    this.#state = draft;
    return deepFrozenClone(claims, "claimUnitTurns result");
  }

  #findExactQueue(
    queueIdRaw: unknown,
    unitIdRaw: unknown,
    nodeIdRaw: unknown,
    label: string
  ): UnitQueueOccurrence | undefined {
    const queueId = assertEvidenceString(queueIdRaw, `${label}.queueId`);
    const unitId = assertEvidenceString(unitIdRaw, `${label}.unitId`);
    const nodeId = assertIdentifier(nodeIdRaw, `${label}.nodeId`);
    const queue = this.#state.queues.get(queueId);
    if (queue === undefined || queue.unitId !== unitId || queue.nodeId !== nodeId) {
      return undefined;
    }
    return queue;
  }

  #requireExactQueue(
    queueIdRaw: unknown,
    unitIdRaw: unknown,
    nodeIdRaw: unknown,
    label: string
  ): UnitQueueOccurrence {
    const queue = this.#findExactQueue(queueIdRaw, unitIdRaw, nodeIdRaw, label);
    if (queue === undefined) {
      throw new Error(`${label}: queue/unit/node coordinates do not identify one retained occurrence`);
    }
    return queue;
  }

  #assertActiveLease(
    state: MemoryState,
    queueId: string,
    leaseTokenRaw: unknown,
    at: string
  ): LeaseRow {
    const leaseToken = assertEvidenceString(leaseTokenRaw, "turn leaseToken");
    const lease = state.leases.get(queueId);
    if (!isLeaseActive(lease, at) || lease.leaseToken !== leaseToken) {
      throw new TurnLeaseLostError(queueId);
    }
    return lease;
  }

  async inspectExternalUnitTurn(
    inputRaw: InspectExternalUnitTurnInput
  ): Promise<ExternalUnitTurnInspection | undefined> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["principalId", "kind", "queueId", "unitId", "nodeId"],
      ["principalId", "kind", "queueId", "unitId", "nodeId"],
      "inspectExternalUnitTurn input"
    );
    const principalId = assertIdentifier(
      raw.principalId,
      "inspectExternalUnitTurn input.principalId"
    );
    if (raw.kind !== "human" && raw.kind !== "callback") {
      throw new Error('inspectExternalUnitTurn input.kind must be "human" | "callback"');
    }
    const queue = this.#findExactQueue(
      raw.queueId,
      raw.unitId,
      raw.nodeId,
      "inspectExternalUnitTurn input"
    );
    if (queue === undefined) return undefined;
    const node = nodeForQueue(this.#state, queue);
    if (node.kind !== raw.kind) return undefined;
    if (node.principal.id !== principalId) {
      throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
    }
    if (terminalFailureForQueue(this.#state, queue.queueId) !== undefined) return undefined;
    return deepFrozenClone(
      {
        queueId: queue.queueId,
        unitId: queue.unitId,
        nodeId: queue.nodeId,
        graph: graphForQueue(this.#state, queue),
        inputArtifact: queue.inputArtifact
      },
      "inspectExternalUnitTurn result"
    );
  }

  async claimExternalUnitTurn(
    inputRaw: ClaimExternalUnitTurnInput
  ): Promise<ExternalUnitTurnClaimResult | undefined> {
    const raw = captureCapabilityRecord(
      inputRaw,
      [
        "principalId", "kind", "queueId", "unitId", "nodeId", "actorId",
        "completionDigest", "outboxEventDigests"
      ],
      [
        "principalId", "kind", "queueId", "unitId", "nodeId", "actorId",
        "completionDigest", "outboxEventDigests"
      ],
      "claimExternalUnitTurn input"
    );
    const principalId = assertIdentifier(raw.principalId, "claimExternalUnitTurn input.principalId");
    if (raw.kind !== "human" && raw.kind !== "callback") {
      throw new Error('claimExternalUnitTurn input.kind must be "human" | "callback"');
    }
    const kind = raw.kind;
    const actorId = assertEvidenceString(raw.actorId, "claimExternalUnitTurn input.actorId");
    const completionDigest = assertSha256Hex(
      raw.completionDigest,
      "claimExternalUnitTurn input.completionDigest"
    );
    const digestValues = captureDenseArrayItems(
      raw.outboxEventDigests,
      "claimExternalUnitTurn input.outboxEventDigests",
      MAX_TURN_OUTBOX_EVENTS
    );
    const outboxEventDigests = Object.freeze(digestValues.map((value, index) =>
      assertSha256Hex(value, `claimExternalUnitTurn input.outboxEventDigests[${index}]`)
    ));
    const queue = this.#findExactQueue(
      raw.queueId,
      raw.unitId,
      raw.nodeId,
      "claimExternalUnitTurn input"
    );
    if (queue === undefined) return undefined;
    const node = nodeForQueue(this.#state, queue);
    if (node.kind !== kind) return undefined;
    if (node.principal.id !== principalId) {
      throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
    }
    const settled = this.#state.settlements.get(queue.queueId);
    if (settled !== undefined) {
      if (
        settled.principalId !== principalId
        || settled.actorId !== actorId
        || settled.completionDigest !== completionDigest
        || !sameOrdered(settled.committedOutboxEventDigests, outboxEventDigests)
      ) {
        throw new TurnEvidenceConflictError(
          `external completion conflicts with settled evidence for queue ${queue.queueId}`
        );
      }
      return deepFrozenClone({
        disposition: "settled" as const,
        queueId: settled.queueId,
        unitId: settled.unitId,
        nodeId: settled.nodeId,
        attemptNumber: settled.attemptNumber,
        attemptIndex: settled.attemptIndex,
        idempotencyKey: settled.idempotencyKey,
        principalId: settled.principalId,
        actorId,
        completionDigest: settled.completionDigest,
        startedAt: settled.startedAt,
        settledAt: settled.settledAt,
        settlementDigest: settled.settlementDigest,
        committedOutboxEventDigests: settled.committedOutboxEventDigests
      }, "settled external turn recovery");
    }
    if (terminalFailureForQueue(this.#state, queue.queueId) !== undefined) return undefined;

    const at = nowIso(this.#now);
    const existingLease = this.#state.leases.get(queue.queueId);
    if (isLeaseActive(existingLease, at)) {
      const exact = existingLease.mode === "external"
        && existingLease.principalId === principalId
        && existingLease.external?.kind === kind
        && existingLease.external.actorId === actorId
        && existingLease.external.completionDigest === completionDigest
        && sameOrdered(existingLease.external.outboxEventDigests, outboxEventDigests);
      if (!exact) return undefined;
      return deepFrozenClone({
        disposition: "claimed" as const,
        claim: claimSnapshot(this.#state, queue, existingLease.leaseToken)
      }, "recovered external claim");
    }
    const leaseToken = this.#newId("lease");
    if ([...this.#state.leases.values()].some((lease) => lease.leaseToken === leaseToken)) {
      throw new Error(`MemoryUnitStore idFactory produced duplicate lease token ${leaseToken}`);
    }
    const expiresAt = timestampFromEpoch(timestampEpoch(at) + node.turn.leaseMs);
    const draft = cloneState(this.#state);
    draft.leases.set(queue.queueId, deepFrozenClone({
      leaseOwner: `external:${principalId}:${actorId}`,
      leaseToken,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt,
      mode: "external" as const,
      principalId,
      external: {
        kind,
        actorId,
        completionDigest,
        outboxEventDigests
      }
    }, `queue ${queue.queueId} external lease`));
    this.#state = draft;
    return deepFrozenClone({
      disposition: "claimed" as const,
      claim: claimSnapshot(this.#state, queue, leaseToken)
    }, "new external claim");
  }

  async heartbeatTurn(inputRaw: HeartbeatTurnInput): Promise<void> {
    const raw = captureCapabilityRecord(
      inputRaw,
      ["queueId", "leaseToken", "extendByMs", "at"],
      ["queueId", "leaseToken", "extendByMs", "at"],
      "heartbeatTurn input"
    );
    const queueId = assertEvidenceString(raw.queueId, "heartbeatTurn input.queueId");
    const queue = this.#state.queues.get(queueId);
    if (queue === undefined) throw new TurnLeaseLostError(queueId);
    const at = assertCanonicalTimestamp(raw.at, "heartbeatTurn input.at");
    const lease = this.#assertActiveLease(this.#state, queueId, raw.leaseToken, at);
    const extendByMs = assertSafePositiveInt(raw.extendByMs, "heartbeatTurn input.extendByMs");
    const node = nodeForQueue(this.#state, queue);
    if (lease.mode !== "worker" || lease.principalId !== node.principal.id) {
      throw new TurnLeaseLostError(queueId);
    }
    if (extendByMs > node.turn.leaseMs) {
      throw new Error(
        `heartbeatTurn input.extendByMs ${extendByMs} exceeds node ${node.nodeId} leaseMs ${node.turn.leaseMs}`
      );
    }
    if (timestampEpoch(at) < timestampEpoch(lease.heartbeatAt)) {
      throw new Error("heartbeatTurn input.at cannot precede the prior heartbeat");
    }
    const draft = cloneState(this.#state);
    draft.leases.set(queueId, deepFrozenClone({
      ...lease,
      heartbeatAt: at,
      expiresAt: timestampFromEpoch(timestampEpoch(at) + extendByMs)
    }, `queue ${queueId} heartbeated lease`));
    this.#state = draft;
  }

  #validatePreparationIdentity(
    inputRaw: PrepareTurnAttemptInput,
    requireLease = true
  ): {
    readonly raw: Record<string, unknown>;
    readonly queue: UnitQueueOccurrence;
    readonly node: MissionPipelineNode;
    readonly fingerprint: string;
    readonly inputDigest: string;
    readonly executionIdentityDigest?: string;
  } {
    const raw = captureCapabilityRecord(
      inputRaw,
      [
        "queueId", "unitId", "nodeId", "leaseToken", "nodeRef", "fingerprint",
        "inputDigest", "maxAttempts", "executionIdentityDigest"
      ],
      [
        "queueId", "unitId", "nodeId", "leaseToken", "nodeRef", "fingerprint",
        "inputDigest", "maxAttempts"
      ],
      "prepareTurnAttempt input"
    );
    const queue = this.#requireExactQueue(
      raw.queueId, raw.unitId, raw.nodeId, "prepareTurnAttempt input"
    );
    const node = nodeForQueue(this.#state, queue);
    const refRaw = captureCapabilityRecord(
      raw.nodeRef,
      ["id", "version"],
      ["id", "version"],
      "prepareTurnAttempt input.nodeRef"
    );
    const refId = assertIdentifier(refRaw.id, "prepareTurnAttempt input.nodeRef.id");
    const refVersion = assertSafePositiveInt(
      refRaw.version,
      "prepareTurnAttempt input.nodeRef.version"
    );
    if (refId !== node.ref.id || refVersion !== node.ref.version) {
      throw new TurnEvidenceConflictError(
        `prepareTurnAttempt node ref conflicts for queue ${queue.queueId}`
      );
    }
    const fingerprint = assertSha256Hex(raw.fingerprint, "prepareTurnAttempt input.fingerprint");
    if (fingerprint !== nodeExecutionFingerprint(node)) {
      throw new TurnEvidenceConflictError(
        `prepareTurnAttempt fingerprint conflicts for node ${node.nodeId}`
      );
    }
    const inputDigest = assertSha256Hex(raw.inputDigest, "prepareTurnAttempt input.inputDigest");
    if (inputDigest !== queue.inputArtifact.digest) {
      throw new TurnEvidenceConflictError(
        `prepareTurnAttempt input digest conflicts for queue ${queue.queueId}`
      );
    }
    const maxAttempts = assertSafePositiveInt(
      raw.maxAttempts,
      "prepareTurnAttempt input.maxAttempts"
    );
    if (maxAttempts !== node.turn.maxAttempts) {
      throw new TurnEvidenceConflictError(
        `prepareTurnAttempt maxAttempts conflicts for node ${node.nodeId}`
      );
    }
    const executionIdentityDigest = raw.executionIdentityDigest === undefined
      ? undefined
      : assertSha256Hex(
          raw.executionIdentityDigest,
          "prepareTurnAttempt input.executionIdentityDigest"
        );
    if (requireLease && terminalFailureForQueue(this.#state, queue.queueId) === undefined) {
      this.#assertActiveLease(this.#state, queue.queueId, raw.leaseToken, nowIso(this.#now));
    }
    return {
      raw,
      queue,
      node,
      fingerprint,
      inputDigest,
      ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
    };
  }

  async prepareTurnAttempt(inputRaw: PrepareTurnAttemptInput): Promise<TurnAttemptPreparation> {
    const validated = this.#validatePreparationIdentity(inputRaw);
    const { queue, node, fingerprint, inputDigest, executionIdentityDigest } = validated;
    const terminal = terminalFailureForQueue(this.#state, queue.queueId);
    if (terminal !== undefined) {
      return Object.freeze({
        disposition: "terminal" as const,
        errorCode: terminal.errorCode,
        attempts: terminal.attemptIndex
      });
    }
    if (this.#state.settlements.has(queue.queueId)) {
      throw new TurnEvidenceConflictError(`queue ${queue.queueId} is already settled`);
    }
    const reservations = this.#state.reservations.get(queue.queueId) ?? [];
    const current = reservations.at(-1);
    if (current !== undefined) {
      if (current.executionIdentityDigest !== executionIdentityDigest) {
        throw new TurnEvidenceConflictError(
          `prepareTurnAttempt execution identity conflicts for queue ${queue.queueId}`
        );
      }
      const failure = this.#state.failures.get(attemptKey(queue.queueId, current.attemptNumber));
      if (failure === undefined) {
        const cached = this.#state.cachedCompletions.get(
          attemptKey(queue.queueId, current.attemptNumber)
        );
        if (cached !== undefined) {
          return deepFrozenClone({
            disposition: "cached" as const,
            attemptNumber: current.attemptNumber,
            attemptIndex: current.attemptIndex,
            idempotencyKey: current.idempotencyKey,
            completion: cached.completion,
            completionDigest: cached.completionDigest,
            startedAt: cached.startedAt,
            settledAt: cached.settledAt
          }, "cached turn preparation");
        }
        return Object.freeze({
          disposition: "reserved" as const,
          attemptNumber: current.attemptNumber,
          attemptIndex: current.attemptIndex,
          idempotencyKey: current.idempotencyKey
        });
      }
      if (failure.terminal) {
        return Object.freeze({
          disposition: "terminal" as const,
          errorCode: failure.errorCode,
          attempts: failure.attemptIndex
        });
      }
    }
    const attemptIndex = current === undefined ? 1 : current.attemptIndex + 1;
    const globalAttemptNumber = [...this.#state.reservations.values()]
      .flat()
      .filter((reservation) =>
        reservation.unitId === queue.unitId && reservation.nodeId === queue.nodeId
      )
      .reduce((maximum, reservation) => Math.max(maximum, reservation.attemptNumber), 0) + 1;
    const idempotencyKey = nodeTurnIdempotencyKey({
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      attemptNumber: globalAttemptNumber,
      nodeRef: node.ref,
      fingerprint,
      inputDigest,
      ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
    });
    const reservation = deepFrozenClone({
      queueId: queue.queueId,
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      nodeRef: node.ref,
      fingerprint,
      inputDigest,
      ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest }),
      attemptNumber: globalAttemptNumber,
      attemptIndex,
      idempotencyKey
    }, `queue ${queue.queueId} attempt reservation`);
    const draft = cloneState(this.#state);
    draft.reservations.set(queue.queueId, Object.freeze([...reservations, reservation]));
    this.#state = draft;
    return Object.freeze({
      disposition: "reserved" as const,
      attemptNumber: globalAttemptNumber,
      attemptIndex,
      idempotencyKey
    });
  }

  #captureOutbox(
    outboxRaw: TurnOutboxEvents | undefined,
    label: string
  ): {
    readonly events: readonly TurnOutboxEventInput[];
    readonly digests: readonly string[];
  } {
    const items = captureDenseArrayItems(outboxRaw ?? [], label, MAX_TURN_OUTBOX_EVENTS);
    const events = Object.freeze(items.map((eventRaw, index) => {
      const eventLabel = `${label}[${index}]`;
      const event = captureCapabilityRecord(
        eventRaw,
        ["eventType", "payload", "dedupeKey"],
        ["eventType", "payload"],
        eventLabel
      );
      const dedupeKey = event.dedupeKey === undefined
        ? undefined
        : assertEvidenceString(event.dedupeKey, `${eventLabel}.dedupeKey`);
      return deepFrozenClone({
        eventType: assertEvidenceString(event.eventType, `${eventLabel}.eventType`),
        payload: snapshotGraphValidationData(event.payload, `${eventLabel}.payload`),
        ...(dedupeKey === undefined ? {} : { dedupeKey })
      }, eventLabel);
    }));
    const batchDedupe = events
      .map((event) => event.dedupeKey)
      .filter((value): value is string => value !== undefined);
    const duplicate = batchDedupe.find((value, index) => batchDedupe.indexOf(value) !== index);
    if (duplicate !== undefined) {
      throw new Error(`${label}: duplicate outbox dedupeKey ${duplicate} within one transaction`);
    }
    return Object.freeze({
      events,
      digests: Object.freeze(events.map(turnOutboxEventDigest))
    });
  }

  #assertOutboxDedupeAvailable(
    events: readonly TurnOutboxEventInput[],
    label: string
  ): void {
    for (const event of events) {
      if (event.dedupeKey !== undefined && this.#state.outboxDedupeKeys.has(event.dedupeKey)) {
        throw new Error(
          `${label}: outbox dedupeKey ${event.dedupeKey} already exists; rejecting the whole transaction`
        );
      }
    }
  }

  #requireReservation(
    state: MemoryState,
    queue: UnitQueueOccurrence,
    raw: Record<string, unknown>,
    label: string
  ): AttemptReservation {
    const attemptNumber = assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`);
    const attemptIndex = assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`);
    const idempotencyKey = assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`);
    const reservation = (state.reservations.get(queue.queueId) ?? []).find(
      (candidate) => candidate.attemptNumber === attemptNumber
    );
    if (
      reservation === undefined
      || reservation.attemptIndex !== attemptIndex
      || reservation.idempotencyKey !== idempotencyKey
    ) {
      throw new TurnEvidenceConflictError(
        `${label}: attempt identity conflicts for queue ${queue.queueId}`
      );
    }
    return reservation;
  }

  async cacheTurnCompletion(
    inputRaw: CacheTurnCompletionInput
  ): Promise<CacheTurnCompletionResult> {
    const raw = captureCapabilityRecord(
      inputRaw,
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "completion", "completionDigest", "startedAt", "settledAt"
      ],
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "completion", "completionDigest", "startedAt", "settledAt"
      ],
      "cacheTurnCompletion input"
    );
    const queue = this.#requireExactQueue(
      raw.queueId, raw.unitId, raw.nodeId, "cacheTurnCompletion input"
    );
    const node = nodeForQueue(this.#state, queue);
    if (!WORKER_KINDS.has(node.kind)) {
      throw new Error(
        `cacheTurnCompletion: ${node.kind} node ${node.nodeId} has no worker body cache`
      );
    }
    const reservation = this.#requireReservation(
      this.#state, queue, raw, "cacheTurnCompletion input"
    );
    const completion = validateNodeTurnCompletion(
      node,
      raw.completion,
      "cacheTurnCompletion input.completion"
    );
    const completionDigest = assertSha256Hex(
      raw.completionDigest,
      "cacheTurnCompletion input.completionDigest"
    );
    const computed = nodeTurnCompletionDigest(completion);
    if (completionDigest !== computed) {
      throw new TurnEvidenceConflictError(
        `cacheTurnCompletion: completion digest ${completionDigest} != computed ${computed}`
      );
    }
    const timestamps = assertTimestampOrder(
      raw.startedAt,
      raw.settledAt,
      "cacheTurnCompletion input.startedAt",
      "cacheTurnCompletion input.settledAt"
    );
    const key = attemptKey(queue.queueId, reservation.attemptNumber);
    const existing = this.#state.cachedCompletions.get(key);
    if (existing !== undefined) {
      if (
        existing.completionDigest !== completionDigest
        || existing.startedAt !== timestamps.startedAt
        || existing.settledAt !== timestamps.endedAt
      ) {
        throw new TurnEvidenceConflictError(
          `cacheTurnCompletion conflicts with cached evidence for queue ${queue.queueId} attempt ${reservation.attemptNumber}`
        );
      }
      return deepFrozenClone({
        created: false,
        completion: existing.completion,
        completionDigest: existing.completionDigest,
        startedAt: existing.startedAt,
        settledAt: existing.settledAt
      }, "cacheTurnCompletion replay");
    }
    if (this.#state.failures.has(key) || this.#state.settlements.has(queue.queueId)) {
      throw new TurnEvidenceConflictError(
        `cacheTurnCompletion contradicts concluded evidence for queue ${queue.queueId}`
      );
    }
    this.#assertActiveLease(
      this.#state,
      queue.queueId,
      raw.leaseToken,
      nowIso(this.#now)
    );
    const cached = deepFrozenClone({
      queueId: queue.queueId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      completion,
      completionDigest,
      startedAt: timestamps.startedAt,
      settledAt: timestamps.endedAt
    }, `queue ${queue.queueId} cached completion`);
    const draft = cloneState(this.#state);
    draft.cachedCompletions.set(key, cached);
    this.#state = draft;
    return deepFrozenClone({
      created: true,
      completion,
      completionDigest,
      startedAt: timestamps.startedAt,
      settledAt: timestamps.endedAt
    }, "cacheTurnCompletion result");
  }

  #planRouting(input: {
    readonly state: MemoryState;
    readonly unitId: string;
    readonly sourceNodeId: string;
    readonly sourceQueueId?: string;
    readonly outcome: string;
    readonly outputArtifact?: ArtifactEnvelope;
    readonly effectiveArtifact: ArtifactEnvelope;
    readonly at: string;
    readonly sourceEvidenceDigest: string;
    readonly closingQueueIds: ReadonlySet<string>;
  }): RoutingPlan {
    const graph = input.state.unitGraphs.get(input.unitId);
    if (graph === undefined) {
      throw new Error(`MemoryUnitStore invariant: unit ${input.unitId} has no graph`);
    }
    const compiled = compileGraph(graph);
    const graphRef = graphDefinitionRef(graph);
    const plannedJoins = new Map(input.state.joins);
    const plannedQueues: UnitQueueOccurrence[] = [];
    const plannedArtifacts = new Map<string, ArtifactEnvelope>();
    const synthetic: SyntheticJourneyDraft[] = [];
    const rootEffects: JourneyRoutingEffect[] = [];
    let nextEnqueueSequence = input.state.nextEnqueueSequence;

    if (input.outputArtifact !== undefined) {
      plannedArtifacts.set(artifactKey(input.outputArtifact), input.outputArtifact);
    }

    const ensureJoin = (node: MissionPipelineNode): JoinProgress => {
      if (node.join === undefined) {
        throw new Error(`MemoryUnitStore invariant: node ${node.nodeId} is not a join`);
      }
      const key = joinKey(input.unitId, node.nodeId);
      const existing = plannedJoins.get(key);
      if (existing !== undefined) return existing;
      const created = deepFrozenClone({
        unitId: input.unitId,
        nodeId: node.nodeId,
        require: node.join.require,
        inbound: node.join.inbound.map((edgeId) => ({
          edgeId,
          state: "pending" as const
        })),
        status: "pending" as const
      }, `join ${input.unitId}/${node.nodeId} initial progress`);
      plannedJoins.set(key, created);
      return created;
    };

    // Initialize every declared join so liveness can resolve an untouched leg.
    for (const node of compiled.nodes) {
      if (node.join !== undefined) ensureJoin(node);
    }

    const artifactByRef = (ref: ArtifactRef): ArtifactEnvelope | undefined =>
      plannedArtifacts.get(artifactKey(ref)) ?? input.state.artifacts.get(artifactKey(ref));

    const addQueue = (
      node: MissionPipelineNode,
      artifact: ArtifactEnvelope,
      at: string,
      sourceEvidenceDigest: string,
      inboundEdgeIds: readonly string[],
      join?: QueueJoinProvenance
    ): UnitQueueOccurrence => {
      if (artifact.contractId !== node.input) {
        throw new Error(
          `routing target node ${node.nodeId} input contract mismatch: expected ${node.input}, got ${artifact.contractId}`
        );
      }
      const queueId = this.#newId("queue");
      if (
        input.state.queues.has(queueId)
        || plannedQueues.some((queue) => queue.queueId === queueId)
      ) {
        throw new Error(`MemoryUnitStore idFactory produced duplicate queue id ${queueId}`);
      }
      const queue = deepFrozenClone({
        queueId,
        unitId: input.unitId,
        graph: graphRef,
        nodeId: node.nodeId,
        nodeRef: node.ref,
        inputArtifact: artifact,
        queuedAt: at,
        enqueueSequence: nextEnqueueSequence,
        sourceEvidenceDigest,
        inboundEdgeIds,
        ...(join === undefined ? {} : { join })
      }, `routed queue ${queueId}`);
      nextEnqueueSequence += 1;
      plannedQueues.push(queue);
      return queue;
    };

    const setJoinInbound = (
      progress: JoinProgress,
      edgeId: string,
      replacement: JoinInboundProgress
    ): JoinProgress => deepFrozenClone({
      ...progress,
      inbound: progress.inbound.map((state) => state.edgeId === edgeId ? replacement : state)
    }, `join ${progress.unitId}/${progress.nodeId} edge ${edgeId} progress`);

    const queueJoinIfSatisfied = (
      node: MissionPipelineNode,
      progress: JoinProgress,
      effects: JourneyRoutingEffect[],
      at: string,
      sourceEvidenceDigest: string
    ): JoinProgress => {
      if (progress.status !== "pending" || node.join === undefined) return progress;
      const threshold = evaluateJoinThreshold(
        node.join.require,
        progress.inbound.map((edge) => ({ edgeId: edge.edgeId, state: edge.state }))
      );
      if (!threshold.thresholdSatisfied) return progress;
      const accepted = progress.inbound
        .filter((edge): edge is Extract<JoinInboundProgress, { state: "offered" }> =>
          edge.state === "offered"
        )
        .map((edge) => edge.offer);
      const selected = accepted[0];
      if (selected === undefined) {
        throw new Error(`MemoryUnitStore invariant: satisfied join ${node.nodeId} has no offer`);
      }
      const selectedArtifact = artifactByRef(selected.artifact);
      if (selectedArtifact === undefined) {
        throw new Error(
          `MemoryUnitStore invariant: join ${node.nodeId} selected missing artifact ${selected.artifact.digest}`
        );
      }
      const inputArtifact = node.join.compose === "envelope"
        ? createJoinInputArtifact(graph, {
            unitId: input.unitId,
            nodeId: node.nodeId,
            accepted: accepted.map((offer) => {
              const artifact = artifactByRef(offer.artifact);
              if (artifact === undefined) {
                throw new Error(`MemoryUnitStore invariant: join ${node.nodeId} accepted missing artifact ${offer.artifact.digest}`);
              }
              return { ...offer, artifact: validateArtifactEnvelope({ ...offer.artifact, payload: artifact.payload }) };
            })
          })
        : selectedArtifact;
      if (node.join.compose === "envelope") {
        plannedArtifacts.set(artifactKey(inputArtifact), inputArtifact);
      }
      const provenance = deepFrozenClone({
        joinNodeId: node.nodeId,
        selectedEdgeId: selected.edgeId,
        accepted
      }, `join ${node.nodeId} queue provenance`);
      const queue = addQueue(
        node,
        inputArtifact,
        at,
        sourceEvidenceDigest,
        accepted.map((offer) => offer.edgeId),
        provenance
      );
      effects.push(deepFrozenClone({
        kind: "join_queued" as const,
        targetNodeId: node.nodeId,
        queueId: queue.queueId,
        enqueueSequence: queue.enqueueSequence,
        selectedEdgeId: selected.edgeId,
        acceptedEdgeIds: accepted.map((offer) => offer.edgeId)
      }, `join ${node.nodeId} queued routing effect`));
      return deepFrozenClone({
        ...progress,
        status: "queued" as const,
        selectedEdgeId: selected.edgeId,
        queueId: queue.queueId
      }, `join ${node.nodeId} queued progress`);
    };

    const routeEvent = (event: {
      readonly sourceNodeId: string;
      readonly sourceQueueId?: string;
      readonly outcome: string;
      readonly outputArtifact?: ArtifactEnvelope;
      readonly effectiveArtifact: ArtifactEnvelope;
      readonly at: string;
      readonly evidenceDigest: string;
      readonly effects: JourneyRoutingEffect[];
    }): void => {
      const outbound = compiled.outboundByNode[event.sourceNodeId] ?? [];
      const matched = matchingOutcomeEdges(outbound, event.outcome, event.outputArtifact);
      const matchedIds = new Set(matched.map((edge) => edge.edgeId));

      // Ordinary targets dedupe all matching edge arms from this one event.
      const ordinaryTargets = new Map<string, string[]>();
      for (const edge of matched) {
        for (const targetNodeId of edge.to) {
          const target = compiled.nodesById[targetNodeId]!;
          if (target.join !== undefined) continue;
          const edgeIds = ordinaryTargets.get(targetNodeId) ?? [];
          edgeIds.push(edge.edgeId);
          ordinaryTargets.set(targetNodeId, edgeIds);
        }
      }
      for (const [targetNodeId, edgeIds] of ordinaryTargets) {
        const target = compiled.nodesById[targetNodeId]!;
        const queue = addQueue(
          target,
          event.effectiveArtifact,
          event.at,
          event.evidenceDigest,
          edgeIds
        );
        event.effects.push(deepFrozenClone({
          kind: "queue_enqueued" as const,
          targetNodeId,
          queueId: queue.queueId,
          enqueueSequence: queue.enqueueSequence,
          edgeIds,
          inputArtifact: artifactRef(event.effectiveArtifact)
        }, `queue ${queue.queueId} routing effect`));
      }

      // Join matches are applied in the sealed join.inbound order. Every
      // accepted artifact is validated even when nOf needs fewer offers.
      for (const target of compiled.nodes) {
        if (target.join === undefined) continue;
        const relevant = target.join.inbound.filter((edgeId) => {
          const edge = compiled.edgesById[edgeId]!;
          return edge.from === event.sourceNodeId && matchedIds.has(edgeId);
        });
        if (relevant.length === 0) continue;
        const key = joinKey(input.unitId, target.nodeId);
        let progress = ensureJoin(target);
        for (const edgeId of relevant) {
          const artifact = artifactRef(event.effectiveArtifact);
          if (progress.status !== "pending") {
            event.effects.push(deepFrozenClone({
              kind: "join_offer" as const,
              targetNodeId: target.nodeId,
              edgeId,
              disposition: "join_already_resolved_noop" as const,
              artifact
            }, `join ${target.nodeId} late offer effect`));
            continue;
          }
          const inbound = progress.inbound.find((state) => state.edgeId === edgeId)!;
          if (inbound.state !== "pending") {
            event.effects.push(deepFrozenClone({
              kind: "join_offer" as const,
              targetNodeId: target.nodeId,
              edgeId,
              disposition: "edge_already_resolved_noop" as const,
              artifact
            }, `join ${target.nodeId} duplicate offer effect`));
            continue;
          }
          if (target.join.compose !== "envelope" && event.effectiveArtifact.contractId !== target.input) {
            throw new Error(
              `routing join target node ${target.nodeId} input contract mismatch on edge ${edgeId}: expected ${target.input}, got ${event.effectiveArtifact.contractId}`
            );
          }
          const offer = deepFrozenClone({
            edgeId,
            sourceNodeId: event.sourceNodeId,
            ...(event.sourceQueueId === undefined
              ? {}
              : { sourceQueueId: event.sourceQueueId }),
            sourceEvidenceDigest: event.evidenceDigest,
            artifact,
            offeredAt: event.at
          }, `join ${target.nodeId} accepted offer ${edgeId}`) as JoinAcceptedOffer;
          progress = setJoinInbound(progress, edgeId, {
            edgeId,
            state: "offered",
            offer
          });
          event.effects.push(deepFrozenClone({
            kind: "join_offer" as const,
            targetNodeId: target.nodeId,
            edgeId,
            disposition: "accepted" as const,
            artifact
          }, `join ${target.nodeId} accepted effect ${edgeId}`));
        }
        progress = queueJoinIfSatisfied(
          target,
          progress,
          event.effects,
          event.at,
          event.evidenceDigest
        );
        plannedJoins.set(key, progress);
      }
    };

    routeEvent({
      sourceNodeId: input.sourceNodeId,
      ...(input.sourceQueueId === undefined ? {} : { sourceQueueId: input.sourceQueueId }),
      outcome: input.outcome,
      ...(input.outputArtifact === undefined ? {} : { outputArtifact: input.outputArtifact }),
      effectiveArtifact: input.effectiveArtifact,
      at: input.at,
      evidenceDigest: input.sourceEvidenceDigest,
      effects: rootEffects
    });

    const openNodeIds = (): readonly string[] => [
      ...[...input.state.queues.values()]
        .filter((queue) => !input.closingQueueIds.has(queue.queueId))
        .filter((queue) => isQueueOpen(input.state, queue.queueId))
        .map((queue) => queue.nodeId),
      ...plannedQueues.map((queue) => queue.nodeId)
    ];

    const canReach = (targetNodeId: string): boolean => {
      const pending = [...openNodeIds()];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.shift()!;
        if (current === targetNodeId) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const edge of compiled.outboundByNode[current] ?? []) {
          for (const target of edge.to) {
            const targetNode = compiled.nodesById[target]!;
            if (targetNode.join !== undefined) {
              const progress = plannedJoins.get(joinKey(input.unitId, target));
              const inbound = progress?.inbound.find((state) => state.edgeId === edge.edgeId);
              // A resolved join never fires again, and an already-resolved
              // inbound edge cannot carry another occurrence through it.
              if (progress?.status !== "pending" || inbound?.state !== "pending") {
                continue;
              }
            }
            if (!visited.has(target)) pending.push(target);
          }
        }
      }
      return false;
    };

    // Resolve unreachable pending legs to a deterministic fixed point. A
    // synthetic outcome can itself offer downstream joins or enqueue work.
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (const node of compiled.nodes) {
        if (node.join === undefined) continue;
        const key = joinKey(input.unitId, node.nodeId);
        let progress = ensureJoin(node);
        if (progress.status !== "pending") continue;
        for (const inbound of progress.inbound) {
          if (inbound.state !== "pending") continue;
          const edge = compiled.edgesById[inbound.edgeId]!;
          if (canReach(edge.from)) continue;
          const impossible = deepFrozenClone({
            edgeId: inbound.edgeId,
            sourceNodeId: edge.from,
            causeEvidenceDigest: input.sourceEvidenceDigest,
            resolvedAt: input.at,
            reason: "source_unreachable" as const
          }, `join ${node.nodeId} impossible edge ${inbound.edgeId}`) as JoinImpossibleEdge;
          progress = setJoinInbound(progress, inbound.edgeId, {
            edgeId: inbound.edgeId,
            state: "impossible",
            impossible
          });
          rootEffects.push(deepFrozenClone({
            kind: "join_impossible" as const,
            targetNodeId: node.nodeId,
            edgeId: inbound.edgeId,
            disposition: "resolved" as const
          }, `join ${node.nodeId} impossible routing effect`));
          const threshold = evaluateJoinThreshold(
            node.join.require,
            progress.inbound.map((state) => ({ edgeId: state.edgeId, state: state.state }))
          );
          if (threshold.unsatisfiable) {
            const accepted = progress.inbound
              .filter((state): state is Extract<JoinInboundProgress, { state: "offered" }> =>
                state.state === "offered"
              )
              .map((state) => state.offer);
            const impossibleEdges = progress.inbound
              .filter((state): state is Extract<JoinInboundProgress, { state: "impossible" }> =>
                state.state === "impossible"
              )
              .map((state) => state.impossible);
            const payload = deepFrozenClone({
              schemaVersion: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
              unitId: input.unitId,
              graph: graphRef,
              nodeId: node.nodeId,
              require: node.join.require,
              accepted,
              impossible: impossibleEdges,
              causeEvidenceDigest: input.sourceEvidenceDigest,
              resolvedAt: input.at
            }, `join ${node.nodeId} unsatisfiable artifact payload`);
            const syntheticArtifact = validateArtifactEnvelope({
              contractId: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
              digest: digest(payload),
              payload
            });
            plannedArtifacts.set(artifactKey(syntheticArtifact), syntheticArtifact);
            const syntheticOutcomeDigest = digest({
              unitId: input.unitId,
              graphDigest: graph.graphDigest,
              nodeId: node.nodeId,
              outcome: "join_unsatisfiable",
              accepted: accepted.map((offer) => offer.edgeId),
              impossible: impossibleEdges.map((entry) => entry.edgeId),
              causeEvidenceDigest: input.sourceEvidenceDigest,
              resolvedAt: input.at,
              artifactDigest: syntheticArtifact.digest
            });
            progress = deepFrozenClone({
              ...progress,
              status: "unsatisfiable" as const,
              syntheticOutcomeDigest
            }, `join ${node.nodeId} unsatisfiable progress`);
            const syntheticDraft: SyntheticJourneyDraft = {
              nodeId: node.nodeId,
              at: input.at,
              causeEvidenceDigest: input.sourceEvidenceDigest,
              artifact: syntheticArtifact,
              syntheticOutcomeDigest,
              routing: []
            };
            synthetic.push(syntheticDraft);
            rootEffects.push(deepFrozenClone({
              kind: "join_unsatisfiable" as const,
              targetNodeId: node.nodeId,
              syntheticOutcomeDigest,
              artifact: artifactRef(syntheticArtifact)
            }, `join ${node.nodeId} unsatisfiable routing effect`));
            plannedJoins.set(key, progress);
            routeEvent({
              sourceNodeId: node.nodeId,
              outcome: "join_unsatisfiable",
              outputArtifact: syntheticArtifact,
              effectiveArtifact: syntheticArtifact,
              at: input.at,
              evidenceDigest: syntheticOutcomeDigest,
              effects: syntheticDraft.routing
            });
          } else {
            plannedJoins.set(key, progress);
          }
          changed = true;
          break outer;
        }
      }
    }

    return {
      effects: deepFrozenClone(rootEffects, "routing effects"),
      joins: plannedJoins,
      queues: deepFrozenClone(plannedQueues, "planned routed queues"),
      artifacts: deepFrozenClone([...plannedArtifacts.values()], "planned routing artifacts"),
      synthetic: deepFrozenClone(synthetic, "planned synthetic journey"),
      nextEnqueueSequence
    };
  }

  #appendOutboxRows(
    draft: MemoryState,
    input: {
      readonly unitId: string;
      readonly queueId?: string;
      readonly nodeId: string;
      readonly attemptNumber?: number;
      readonly attemptIndex?: number;
      readonly recordedAt: string;
      readonly events: readonly TurnOutboxEventInput[];
      readonly digests: readonly string[];
    }
  ): void {
    const appended: UnitOutboxEventRecord[] = [];
    for (const [index, event] of input.events.entries()) {
      const outboxEventId = this.#newId("outbox");
      if (
        [...draft.outbox, ...appended].some((row) => row.outboxEventId === outboxEventId)
      ) {
        throw new Error(`MemoryUnitStore idFactory produced duplicate outbox id ${outboxEventId}`);
      }
      appended.push(deepFrozenClone({
        outboxEventId,
        unitId: input.unitId,
        ...(input.queueId === undefined ? {} : { queueId: input.queueId }),
        nodeId: input.nodeId,
        ...(input.attemptNumber === undefined
          ? {}
          : { attemptNumber: input.attemptNumber }),
        ...(input.attemptIndex === undefined ? {} : { attemptIndex: input.attemptIndex }),
        eventType: event.eventType,
        payload: event.payload,
        ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
        eventDigest: input.digests[index]!,
        recordedAt: input.recordedAt
      }, `outbox event ${outboxEventId}`));
      if (event.dedupeKey !== undefined) draft.outboxDedupeKeys.add(event.dedupeKey);
    }
    (draft as { outbox: readonly UnitOutboxEventRecord[] }).outbox = Object.freeze([
      ...draft.outbox,
      ...appended
    ]);
  }

  #appendJourney(
    draft: MemoryState,
    unitId: string,
    rows: readonly UnitJourneyRecord[]
  ): void {
    draft.journey.set(unitId, Object.freeze([
      ...(draft.journey.get(unitId) ?? []),
      ...rows
    ]));
  }

  #syntheticJourneyRecords(
    unitId: string,
    graph: GraphDefinition,
    drafts: readonly SyntheticJourneyDraft[],
    firstSequence: number
  ): readonly JoinUnsatisfiableJourneyRecord[] {
    return Object.freeze(drafts.map((entry, index) => sealRecord({
      kind: "join_unsatisfiable" as const,
      sequence: firstSequence + index,
      unitId,
      graph: graphDefinitionRef(graph),
      recordedAt: entry.at,
      nodeId: entry.nodeId,
      outcome: "join_unsatisfiable" as const,
      principalId: MISSION_PIPELINE_ENGINE_PRINCIPAL_ID,
      startedAt: entry.at,
      settledAt: entry.at,
      causeEvidenceDigest: entry.causeEvidenceDigest,
      artifact: artifactRef(entry.artifact),
      syntheticOutcomeDigest: entry.syntheticOutcomeDigest,
      routing: entry.routing
    }, `join ${unitId}/${entry.nodeId} unsatisfiable journey`) as JoinUnsatisfiableJourneyRecord));
  }

  async recordTurnFailure(
    inputRaw: RecordTurnFailureInput,
    outboxRaw?: TurnOutboxEvents
  ): Promise<RecordTurnFailureResult> {
    const raw = captureCapabilityRecord(
      inputRaw,
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "startedAt", "failedAt", "errorCode", "errorMessage",
        "principalId", "retryable", "terminal", "usage", "failureDigest"
      ],
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "startedAt", "failedAt", "errorCode", "errorMessage",
        "principalId", "retryable", "terminal", "usage", "failureDigest"
      ],
      "recordTurnFailure input"
    );
    const queue = this.#requireExactQueue(
      raw.queueId, raw.unitId, raw.nodeId, "recordTurnFailure input"
    );
    const node = nodeForQueue(this.#state, queue);
    if (!WORKER_KINDS.has(node.kind)) {
      throw new Error(
        `recordTurnFailure: ${node.kind} node ${node.nodeId} cannot record a worker failure`
      );
    }
    const principalId = assertIdentifier(raw.principalId, "recordTurnFailure input.principalId");
    if (principalId !== node.principal.id) {
      throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
    }
    const reservation = this.#requireReservation(
      this.#state, queue, raw, "recordTurnFailure input"
    );
    const timestamps = assertTimestampOrder(
      raw.startedAt,
      raw.failedAt,
      "recordTurnFailure input.startedAt",
      "recordTurnFailure input.failedAt"
    );
    const errorCode = assertIdentifier(raw.errorCode, "recordTurnFailure input.errorCode");
    const errorMessage = validateNodeTurnFailureMessage(
      raw.errorMessage,
      "recordTurnFailure input.errorMessage"
    );
    const retryable = assertBoolean(raw.retryable, "recordTurnFailure input.retryable");
    const terminal = assertBoolean(raw.terminal, "recordTurnFailure input.terminal");
    const expectedTerminal = !retryable || reservation.attemptIndex >= node.turn.maxAttempts;
    if (terminal !== expectedTerminal) {
      throw new TurnEvidenceConflictError(
        `recordTurnFailure terminal=${terminal} conflicts with retry/max-attempt disposition ${expectedTerminal}`
      );
    }
    const usageRaw = captureDenseArrayItems(
      raw.usage,
      "recordTurnFailure input.usage",
      MAX_AGENT_TURN_USAGE_RECEIPTS
    );
    const usage = Object.freeze(usageRaw.map((receipt) => validateUsageReceipt(receipt)));
    if (node.kind === "code") {
      if (usage.length > 0) {
        throw new Error(`recordTurnFailure: ${node.kind} node ${node.nodeId} cannot record usage`);
      }
    }
    const leaseToken = assertEvidenceString(raw.leaseToken, "recordTurnFailure input.leaseToken");
    const normalizedBase = deepFrozenClone({
      queueId: queue.queueId,
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      principalId,
      startedAt: timestamps.startedAt,
      failedAt: timestamps.endedAt,
      errorCode,
      errorMessage,
      retryable,
      terminal,
      usage
    }, "recordTurnFailure normalized evidence");
    const failureDigest = assertSha256Hex(
      raw.failureDigest,
      "recordTurnFailure input.failureDigest"
    );
    const computed = nodeTurnFailureDigest(normalizedBase);
    if (failureDigest !== computed) {
      throw new TurnEvidenceConflictError(
        `recordTurnFailure digest ${failureDigest} != computed ${computed}`
      );
    }
    const outbox = this.#captureOutbox(outboxRaw, "recordTurnFailure outboxEvents");
    const key = attemptKey(queue.queueId, reservation.attemptNumber);
    const existing = this.#state.failures.get(key);
    if (existing !== undefined) {
      if (
        existing.failureDigest !== failureDigest
        || !sameOrdered(existing.committedOutboxEventDigests, outbox.digests)
      ) {
        throw new TurnEvidenceConflictError(
          `recordTurnFailure conflicts with retained attempt ${reservation.attemptNumber} for queue ${queue.queueId}`
        );
      }
      return Object.freeze({
        created: false,
        failureDigest,
        committedOutboxEventDigests: existing.committedOutboxEventDigests
      });
    }
    if (
      this.#state.cachedCompletions.has(key)
      || this.#state.settlements.has(queue.queueId)
    ) {
      throw new TurnEvidenceConflictError(
        `recordTurnFailure contradicts completion evidence for queue ${queue.queueId}`
      );
    }
    const lease = this.#assertActiveLease(
      this.#state,
      queue.queueId,
      leaseToken,
      nowIso(this.#now)
    );
    if (lease.mode !== "worker" || lease.principalId !== principalId) {
      throw new TurnAuthorityError(node.nodeId, node.principal.id, lease.principalId);
    }
    this.#assertOutboxDedupeAvailable(outbox.events, "recordTurnFailure outboxEvents");

    const graph = graphForQueue(this.#state, queue);
    const existingJourney = this.#state.journey.get(queue.unitId) ?? [];
    const routing = terminal
      ? this.#planRouting({
          state: this.#state,
          unitId: queue.unitId,
          sourceNodeId: queue.nodeId,
          sourceQueueId: queue.queueId,
          outcome: "engine_terminal_failure",
          effectiveArtifact: queue.inputArtifact,
          at: timestamps.endedAt,
          sourceEvidenceDigest: failureDigest,
          closingQueueIds: new Set([queue.queueId])
        })
      : {
          effects: Object.freeze([]),
          joins: this.#state.joins,
          queues: Object.freeze([]),
          artifacts: Object.freeze([]),
          synthetic: Object.freeze([]),
          nextEnqueueSequence: this.#state.nextEnqueueSequence
        } satisfies RoutingPlan;
    const failureJourney = sealRecord({
      kind: "turn_failed" as const,
      sequence: existingJourney.length + 1,
      unitId: queue.unitId,
      graph: queue.graph,
      recordedAt: timestamps.endedAt,
      queueId: queue.queueId,
      nodeId: queue.nodeId,
      nodeRef: node.ref,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      inputArtifact: artifactRef(queue.inputArtifact),
      principalId,
      startedAt: timestamps.startedAt,
      failedAt: timestamps.endedAt,
      errorCode,
      errorMessage,
      retryable,
      terminal,
      usage,
      failureDigest,
      routing: routing.effects
    }, `queue ${queue.queueId} failed journey`) as UnitAttemptFailureJourneyRecord;
    const syntheticJourney = this.#syntheticJourneyRecords(
      queue.unitId,
      graph,
      routing.synthetic,
      existingJourney.length + 2
    );
    const failure = deepFrozenClone({
      ...normalizedBase,
      failureDigest,
      committedOutboxEventDigests: outbox.digests
    }, `queue ${queue.queueId} failed attempt`) as FailureRow;

    const draft = cloneState(this.#state);
    draft.failures.set(key, failure);
    this.#appendJourney(draft, queue.unitId, [failureJourney, ...syntheticJourney]);
    for (const artifact of routing.artifacts) {
      if (!draft.artifacts.has(artifactKey(artifact))) {
        draft.artifacts.set(artifactKey(artifact), artifact);
      }
    }
    for (const [progressKey, progress] of routing.joins) {
      draft.joins.set(progressKey, progress);
    }
    for (const plannedQueue of routing.queues) {
      draft.queues.set(plannedQueue.queueId, plannedQueue);
    }
    (draft as { nextEnqueueSequence: number }).nextEnqueueSequence =
      routing.nextEnqueueSequence;
    this.#appendOutboxRows(draft, {
      unitId: queue.unitId,
      queueId: queue.queueId,
      nodeId: queue.nodeId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      recordedAt: timestamps.endedAt,
      events: outbox.events,
      digests: outbox.digests
    });
    if (terminal) {
      const deadLetterId = this.#newId("dead-letter");
      if (draft.deadLetters.some((row) => row.deadLetterId === deadLetterId)) {
        throw new Error(`MemoryUnitStore idFactory produced duplicate dead-letter id ${deadLetterId}`);
      }
      const deadLetter = deepFrozenClone({
        deadLetterId,
        unitId: queue.unitId,
        queueId: queue.queueId,
        nodeId: queue.nodeId,
        attemptNumber: reservation.attemptNumber,
        attemptIndex: reservation.attemptIndex,
        errorCode,
        failureDigest,
        principalId,
        recordedAt: timestamps.endedAt
      }, `dead letter ${deadLetterId}`);
      (draft as { deadLetters: readonly UnitDeadLetterRecord[] }).deadLetters =
        Object.freeze([...draft.deadLetters, deadLetter]);
      draft.leases.delete(queue.queueId);
    }
    this.#state = draft;
    return Object.freeze({ created: true, failureDigest });
  }

  async settleTurn(
    inputRaw: SettleTurnInput,
    outboxRaw?: TurnOutboxEvents
  ): Promise<SettleTurnResult> {
    const raw = captureCapabilityRecord(
      inputRaw,
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "principalId", "actorId", "startedAt", "settledAt",
        "completion", "completionDigest", "settlementDigest"
      ],
      [
        "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
        "idempotencyKey", "principalId", "startedAt", "settledAt", "completion",
        "completionDigest", "settlementDigest"
      ],
      "settleTurn input"
    );
    const queue = this.#requireExactQueue(raw.queueId, raw.unitId, raw.nodeId, "settleTurn input");
    const node = nodeForQueue(this.#state, queue);
    const reservation = this.#requireReservation(this.#state, queue, raw, "settleTurn input");
    const principalId = assertIdentifier(raw.principalId, "settleTurn input.principalId");
    const actorId = Object.hasOwn(raw, "actorId")
      ? assertEvidenceString(raw.actorId, "settleTurn input.actorId")
      : undefined;
    const timestamps = assertTimestampOrder(
      raw.startedAt,
      raw.settledAt,
      "settleTurn input.startedAt",
      "settleTurn input.settledAt"
    );
    const completion = validateNodeTurnCompletion(node, raw.completion, "settleTurn input.completion");
    const completionDigest = assertSha256Hex(
      raw.completionDigest,
      "settleTurn input.completionDigest"
    );
    const computedCompletion = nodeTurnCompletionDigest(completion);
    if (completionDigest !== computedCompletion) {
      throw new TurnEvidenceConflictError(
        `settleTurn completion digest ${completionDigest} != computed ${computedCompletion}`
      );
    }
    const settlementBase = deepFrozenClone({
      queueId: queue.queueId,
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      principalId,
      ...(actorId === undefined ? {} : { actorId }),
      startedAt: timestamps.startedAt,
      settledAt: timestamps.endedAt,
      completionDigest
    }, "settleTurn settlement seal input");
    const settlementDigest = assertSha256Hex(
      raw.settlementDigest,
      "settleTurn input.settlementDigest"
    );
    const computedSettlement = nodeTurnSettlementDigest(settlementBase);
    if (settlementDigest !== computedSettlement) {
      throw new TurnEvidenceConflictError(
        `settleTurn settlement digest ${settlementDigest} != computed ${computedSettlement}`
      );
    }
    const outbox = this.#captureOutbox(outboxRaw, "settleTurn outboxEvents");
    const existing = this.#state.settlements.get(queue.queueId);
    if (existing !== undefined) {
      if (
        existing.completionDigest !== completionDigest
        || existing.settlementDigest !== settlementDigest
        || !sameOrdered(existing.committedOutboxEventDigests, outbox.digests)
      ) {
        throw new TurnEvidenceConflictError(
          `settleTurn conflicts with retained settlement for queue ${queue.queueId}`
        );
      }
      return Object.freeze({
        created: false,
        completionDigest,
        settlementDigest,
        committedOutboxEventDigests: existing.committedOutboxEventDigests
      });
    }
    const attemptIdentity = attemptKey(queue.queueId, reservation.attemptNumber);
    if (this.#state.failures.has(attemptIdentity)) {
      throw new TurnEvidenceConflictError(
        `settleTurn contradicts failed attempt ${reservation.attemptNumber} for queue ${queue.queueId}`
      );
    }
    if (node.principal.id !== principalId) {
      throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
    }
    const leaseToken = assertEvidenceString(raw.leaseToken, "settleTurn input.leaseToken");
    const lease = this.#assertActiveLease(
      this.#state,
      queue.queueId,
      leaseToken,
      nowIso(this.#now)
    );
    if (WORKER_KINDS.has(node.kind)) {
      if (lease.mode !== "worker" || actorId !== undefined) {
        throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
      }
      const cached = this.#state.cachedCompletions.get(attemptIdentity);
      if (
        cached === undefined
        || cached.completionDigest !== completionDigest
        || cached.startedAt !== timestamps.startedAt
        || cached.settledAt !== timestamps.endedAt
      ) {
        throw new TurnEvidenceConflictError(
          `settleTurn requires the exact cached worker completion for queue ${queue.queueId}`
        );
      }
    } else {
      if (actorId === undefined || lease.mode !== "external" || lease.external === undefined) {
        throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
      }
      if (
        lease.external.kind !== node.kind
        || lease.external.actorId !== actorId
        || lease.external.completionDigest !== completionDigest
        || !sameOrdered(lease.external.outboxEventDigests, outbox.digests)
      ) {
        throw new TurnEvidenceConflictError(
          `settleTurn external request conflicts with claimed evidence for queue ${queue.queueId}`
        );
      }
    }
    this.#assertOutboxDedupeAvailable(outbox.events, "settleTurn outboxEvents");

    const outputArtifact = completion.outputArtifact;
    const effectiveArtifact = outputArtifact ?? queue.inputArtifact;
    const graph = graphForQueue(this.#state, queue);
    const routing = this.#planRouting({
      state: this.#state,
      unitId: queue.unitId,
      sourceNodeId: queue.nodeId,
      sourceQueueId: queue.queueId,
      outcome: completion.outcome,
      ...(outputArtifact === undefined ? {} : { outputArtifact }),
      effectiveArtifact,
      at: timestamps.endedAt,
      sourceEvidenceDigest: settlementDigest,
      closingQueueIds: new Set([queue.queueId])
    });
    const existingJourney = this.#state.journey.get(queue.unitId) ?? [];
    const turnJourney = sealRecord({
      kind: "turn_settled" as const,
      sequence: existingJourney.length + 1,
      unitId: queue.unitId,
      graph: queue.graph,
      recordedAt: timestamps.endedAt,
      queueId: queue.queueId,
      nodeId: queue.nodeId,
      nodeRef: node.ref,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      inputArtifact: artifactRef(queue.inputArtifact),
      outcome: completion.outcome,
      ...(outputArtifact === undefined ? {} : { outputArtifact: artifactRef(outputArtifact) }),
      usage: completion.usage ?? Object.freeze([]),
      principalId,
      ...(actorId === undefined ? {} : { actorId }),
      startedAt: timestamps.startedAt,
      settledAt: timestamps.endedAt,
      completionDigest,
      settlementDigest,
      routing: routing.effects
    }, `queue ${queue.queueId} settled journey`) as UnitTurnJourneyRecord;
    const syntheticJourney = this.#syntheticJourneyRecords(
      queue.unitId,
      graph,
      routing.synthetic,
      existingJourney.length + 2
    );
    const settlement = deepFrozenClone({
      queueId: queue.queueId,
      unitId: queue.unitId,
      nodeId: queue.nodeId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      idempotencyKey: reservation.idempotencyKey,
      principalId,
      ...(actorId === undefined ? {} : { actorId }),
      startedAt: timestamps.startedAt,
      settledAt: timestamps.endedAt,
      completion,
      completionDigest,
      settlementDigest,
      committedOutboxEventDigests: outbox.digests
    }, `queue ${queue.queueId} settlement`) as SettlementRow;

    // Copy-on-write transaction. The failpoint observes every stable logical
    // boundary while the live state remains unchanged until the final swap.
    const draft = cloneState(this.#state);
    draft.settlements.set(queue.queueId, settlement);
    this.#appendJourney(draft, queue.unitId, [turnJourney, ...syntheticJourney]);
    this.#checkpoint("journey_append");

    for (const artifact of routing.artifacts) {
      if (!draft.artifacts.has(artifactKey(artifact))) {
        draft.artifacts.set(artifactKey(artifact), artifact);
      }
    }
    this.#checkpoint("artifact_retain");

    // Edge evaluation was completed against the sealed graph before any live
    // write; this checkpoint pins that logical transaction boundary.
    this.#checkpoint("edge_evaluation");

    for (const [progressKey, progress] of routing.joins) {
      draft.joins.set(progressKey, progress);
    }
    this.#checkpoint("join_progress");

    for (const plannedQueue of routing.queues) {
      draft.queues.set(plannedQueue.queueId, plannedQueue);
    }
    (draft as { nextEnqueueSequence: number }).nextEnqueueSequence =
      routing.nextEnqueueSequence;
    this.#checkpoint("successor_enqueue");

    this.#appendOutboxRows(draft, {
      unitId: queue.unitId,
      queueId: queue.queueId,
      nodeId: queue.nodeId,
      attemptNumber: reservation.attemptNumber,
      attemptIndex: reservation.attemptIndex,
      recordedAt: timestamps.endedAt,
      events: outbox.events,
      digests: outbox.digests
    });
    this.#checkpoint("outbox_append");

    draft.leases.delete(queue.queueId);
    this.#checkpoint("lease_release");

    this.#state = draft;
    this.#checkpoint("post_commit_reply");
    return Object.freeze({ created: true, completionDigest, settlementDigest });
  }

  #captureEvidenceListInput(
    inputRaw: ListUnitEvidenceInput | undefined,
    label: string
  ): { readonly unitId?: string; readonly limit: number } {
    const raw = captureCapabilityRecord(
      inputRaw ?? {},
      ["unitId", "limit"],
      [],
      label
    );
    const unitId = raw.unitId === undefined
      ? undefined
      : assertEvidenceString(raw.unitId, `${label}.unitId`);
    const limit = raw.limit === undefined
      ? MAX_UNIT_STORE_LIST_LIMIT
      : assertSafePositiveInt(raw.limit, `${label}.limit`);
    if (limit > MAX_UNIT_STORE_LIST_LIMIT) {
      throw new Error(`${label}.limit must be 1..${MAX_UNIT_STORE_LIST_LIMIT}`);
    }
    return { ...(unitId === undefined ? {} : { unitId }), limit };
  }

  async listOutboxEvents(
    inputRaw?: ListUnitEvidenceInput
  ): Promise<readonly UnitOutboxEventRecord[]> {
    const input = this.#captureEvidenceListInput(inputRaw, "listOutboxEvents input");
    return deepFrozenClone(
      this.#state.outbox
        .filter((row) => input.unitId === undefined || row.unitId === input.unitId)
        .slice(0, input.limit),
      "listOutboxEvents result"
    );
  }

  async listDeadLetters(
    inputRaw?: ListUnitEvidenceInput
  ): Promise<readonly UnitDeadLetterRecord[]> {
    const input = this.#captureEvidenceListInput(inputRaw, "listDeadLetters input");
    return deepFrozenClone(
      this.#state.deadLetters
        .filter((row) => input.unitId === undefined || row.unitId === input.unitId)
        .slice(0, input.limit),
      "listDeadLetters result"
    );
  }

  /** Privileged normalized observer used only by the shipped conformance driver. */
  evidenceSnapshot(): MemoryUnitStoreEvidenceSnapshot {
    return deepFrozenClone({
      units: [...this.#state.units.values()],
      artifacts: [...this.#state.artifacts.values()],
      queues: [...this.#state.queues.values()],
      journey: [...this.#state.journey.values()].flat(),
      joins: [...this.#state.joins.values()],
      attempts: [...this.#state.reservations.values()].flat(),
      cachedCompletions: [...this.#state.cachedCompletions.values()],
      failures: [...this.#state.failures.values()],
      settlements: [...this.#state.settlements.values()],
      outbox: this.#state.outbox,
      deadLetters: this.#state.deadLetters,
      leases: [...this.#state.leases].map(([queueId, lease]) => ({ queueId, lease }))
    }, "MemoryUnitStore evidence snapshot");
  }

  /**
   * Privileged, serialization-safe continuation state for a durable adapter.
   * This includes mutable coordination projections in addition to evidence.
   */
  stateSnapshot(): MemoryUnitStoreStateSnapshot {
    return deepFrozenClone({
      schemaVersion: MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION,
      unitGraphs: [...this.#state.unitGraphs].map(([unitId, graph]) => ({ unitId, graph })),
      units: [...this.#state.units.values()],
      artifacts: [...this.#state.artifacts.values()],
      queues: [...this.#state.queues.values()],
      journey: [...this.#state.journey.values()].flat(),
      joins: [...this.#state.joins.values()],
      attempts: [...this.#state.reservations.values()].flat(),
      cachedCompletions: [...this.#state.cachedCompletions.values()],
      failures: [...this.#state.failures.values()],
      settlements: [...this.#state.settlements.values()],
      outbox: this.#state.outbox,
      outboxDedupeKeys: [...this.#state.outboxDedupeKeys],
      deadLetters: this.#state.deadLetters,
      leases: [...this.#state.leases].map(([queueId, lease]) => ({ queueId, lease })),
      fairnessCursor: [...this.#state.fairnessCursor].map(
        ([sharedNodeKey, lastGraphLaneKey]) => ({ sharedNodeKey, lastGraphLaneKey })
      ),
      nextEnqueueSequence: this.#state.nextEnqueueSequence
    }, "MemoryUnitStore state snapshot");
  }
}

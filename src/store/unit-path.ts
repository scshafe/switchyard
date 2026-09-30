// store/unit-path.ts — a pure execution-state projection of one unit journey.
//
// Consoles, tests, and a frontend need "which nodes settled with which
// outcome, which queues are still open, how far did each join get, what did
// the model attempts cost" without re-deriving it from journey records case
// by case. This module derives all of it from the journey alone: no store,
// no graph, no clock, no host state.
//
// It fails closed. A journey whose record seals, sequence, unit or graph
// identity, or queue references are inconsistent is refused, because a
// projection of tampered or partial evidence would be a confident wrong
// answer. It deliberately knows nothing about delivery: outbox and relay
// facts belong to the host and are supplied beside this projection, never
// inferred from it.

import { validateArtifactRef, type ArtifactRef } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import { validateUsageReceipt } from "../contracts/usage-receipt.js";
import type { GraphDefinitionRef } from "../graph/definition.js";
import {
  assertIdentifier,
  assertPlainObject,
  assertRequiredKeys,
  assertSafePositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  typeName
} from "../internal/guards.js";
import { captureDenseArrayItems } from "../internal/capability.js";
import {
  assertEvidenceString,
  snapshotBoundedValidationData,
  type ValidationDataLimits
} from "../internal/evidence.js";
import { validateGraphDefinitionRef } from "./graph-store.js";
import type { UnitJourneyRecord } from "./unit-store.js";

export const UNIT_PATH_SCHEMA_VERSION = "switchyard-unit-path.v1" as const;
export const MAX_UNIT_PATH_RECORDS = 100_000;

/** Journeys carry refs and receipts, never payloads; the budget is generous but finite. */
export const UNIT_PATH_VALIDATION_LIMITS: ValidationDataLimits = Object.freeze({
  maxDepth: 16,
  maxValues: 4_000_000,
  maxStringCodeUnits: 67_108_864
});

export type UnitPathOccurrenceState = "open" | "settled" | "dead";

/** One queued occurrence of the unit at one node, from enqueue to resolution. */
export interface UnitPathOccurrence {
  readonly queueId: string;
  readonly nodeId: string;
  readonly enqueueSequence: number;
  /** Journey sequence of the record that queued it; 1 for the admission entry queue. */
  readonly queuedBySequence: number;
  /** Ordinary inbound edge ids, or the accepted edge ids of a fired join; [] at admission. */
  readonly inboundEdgeIds: readonly string[];
  readonly state: UnitPathOccurrenceState;
  /** Settled plus failed attempt records for this occurrence. */
  readonly attempts: number;
  readonly failures: number;
  readonly outcome?: string;
  /** The most recent failure's code while open with failures, or the terminal code when dead. */
  readonly errorCode?: string;
  readonly settledAt?: string;
  readonly failedAt?: string;
  readonly principalId?: string;
  readonly actorId?: string;
}

/**
 * State of the node's latest occurrence: `pending` is queued with no failed
 * attempt, `failed` is queued after at least one retryable failure, `dead` is
 * a terminal failure, `settled` is a recorded outcome. A node absent from the
 * projection was never queued.
 */
export type UnitPathNodeState = "pending" | "failed" | "dead" | "settled";

export interface UnitPathUsage {
  readonly receipts: number;
  readonly chargedTokens: number;
  readonly chargedCostMicroUsd: number;
}

export interface UnitPathNode {
  readonly nodeId: string;
  readonly state: UnitPathNodeState;
  /** Every occurrence in enqueue order; the last one determines `state`. */
  readonly occurrences: readonly UnitPathOccurrence[];
  /** Settled outcomes in journey order. */
  readonly outcomes: readonly string[];
  readonly usage: UnitPathUsage;
}

export type UnitPathJoinStatus = "pending" | "queued" | "unsatisfiable";

export interface UnitPathJoin {
  readonly nodeId: string;
  readonly status: UnitPathJoinStatus;
  /**
   * Inbound edges the journey has resolved. An edge the journey never mentions
   * is still pending; the graph, not the journey, knows the full inbound set.
   */
  readonly edges: Readonly<Record<string, "offered" | "impossible">>;
  /** Offers recorded after the edge or the join was already resolved. */
  readonly lateOffers: number;
  readonly queueId?: string;
  readonly selectedEdgeId?: string;
  /**
   * Present when the engine synthesized `join_unsatisfiable`. The join node
   * was never queued, so it has no `nodes` entry; the synthetic outcome's own
   * routing effects are applied like any other record's.
   */
  readonly syntheticOutcomeDigest?: string;
}

export interface UnitPathProjection {
  readonly schemaVersion: typeof UNIT_PATH_SCHEMA_VERSION;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly seedArtifact: ArtifactRef;
  readonly entryNodeId: string;
  readonly records: number;
  readonly lastSequence: number;
  readonly lastRecordedAt: string;
  readonly nodes: Readonly<Record<string, UnitPathNode>>;
  /** Times each edge carried the unit: ordinary enqueues plus accepted join offers. */
  readonly edges: Readonly<Record<string, number>>;
  readonly joins: Readonly<Record<string, UnitPathJoin>>;
  /** Queue ids with no settlement or terminal failure yet, in enqueue order. */
  readonly openQueueIds: readonly string[];
  /** True when no queue is open; nothing further can happen without re-admission. */
  readonly concluded: boolean;
  readonly usage: UnitPathUsage;
}

const BASE_KEYS = ["sequence", "unitId", "graph", "recordedAt", "recordDigest", "kind"] as const;
const ADMITTED_KEYS = new Set([
  ...BASE_KEYS,
  "principalId", "seedArtifact", "entryQueueId", "entryNodeId", "entryEnqueueSequence"
]);
const SETTLED_KEYS = new Set([
  ...BASE_KEYS,
  "queueId", "nodeId", "nodeRef", "attemptNumber", "attemptIndex", "idempotencyKey",
  "inputArtifact", "outcome", "outputArtifact", "usage", "principalId", "actorId",
  "startedAt", "settledAt", "completionDigest", "settlementDigest", "routing"
]);
const SETTLED_REQUIRED = new Set([...SETTLED_KEYS].filter((key) => key !== "outputArtifact" && key !== "actorId"));
const FAILED_KEYS = new Set([
  ...BASE_KEYS,
  "queueId", "nodeId", "nodeRef", "attemptNumber", "attemptIndex", "idempotencyKey",
  "inputArtifact", "principalId", "startedAt", "failedAt", "errorCode", "errorMessage",
  "retryable", "terminal", "usage", "failureDigest", "routing"
]);
const UNSATISFIABLE_KEYS = new Set([
  ...BASE_KEYS,
  "nodeId", "outcome", "principalId", "startedAt", "settledAt", "causeEvidenceDigest",
  "artifact", "syntheticOutcomeDigest", "routing"
]);
const EFFECT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  queue_enqueued: ["kind", "targetNodeId", "queueId", "enqueueSequence", "edgeIds", "inputArtifact"],
  join_offer: ["kind", "targetNodeId", "edgeId", "disposition", "artifact"],
  join_impossible: ["kind", "targetNodeId", "edgeId", "disposition"],
  join_queued: ["kind", "targetNodeId", "queueId", "enqueueSequence", "selectedEdgeId", "acceptedEdgeIds"],
  join_unsatisfiable: ["kind", "targetNodeId", "syntheticOutcomeDigest", "artifact"]
});

const DateConstructor = Date;
const dateParse = Date.parse;
const dateToISOString = Date.prototype.toISOString;

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

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean (got ${typeName(value)})`);
  return value;
}

function identifierList(value: unknown, label: string): readonly string[] {
  return Object.freeze(
    captureDenseArrayItems(value, label).map((item, index) => assertIdentifier(item, `${label}[${index}]`))
  );
}

/** Prototype-free frozen record: identifier "constructor" must be ordinary data. */
function frozenRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value
    });
  }
  return Object.freeze(record);
}

function assertRecordSeal(record: Record<string, unknown>, label: string): void {
  const { recordDigest, ...base } = record;
  const sealed = assertSha256Hex(recordDigest, `${label}.recordDigest`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(`${label}: record digest mismatch — sealed ${sealed} != computed ${computed}`);
  }
}

interface MutableOccurrence {
  readonly queueId: string;
  readonly nodeId: string;
  readonly enqueueSequence: number;
  readonly queuedBySequence: number;
  readonly inboundEdgeIds: readonly string[];
  state: UnitPathOccurrenceState;
  attempts: number;
  failures: number;
  outcome?: string;
  errorCode?: string;
  settledAt?: string;
  failedAt?: string;
  principalId?: string;
  actorId?: string;
}

interface MutableJoin {
  readonly nodeId: string;
  status: UnitPathJoinStatus;
  readonly edges: Map<string, "offered" | "impossible">;
  lateOffers: number;
  queueId?: string;
  selectedEdgeId?: string;
  syntheticOutcomeDigest?: string;
}

interface MutableUsage {
  receipts: number;
  chargedTokens: number;
  chargedCostMicroUsd: number;
}

class PathBuilder {
  readonly occurrences = new Map<string, MutableOccurrence>();
  readonly nodeOrder: string[] = [];
  readonly outcomesByNode = new Map<string, string[]>();
  readonly usageByNode = new Map<string, MutableUsage>();
  readonly edges = new Map<string, number>();
  readonly joins = new Map<string, MutableJoin>();
  readonly total: MutableUsage = { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 };
  lastEnqueueSequence = 0;

  touchNode(nodeId: string): void {
    if (!this.nodeOrder.includes(nodeId)) this.nodeOrder.push(nodeId);
  }

  enqueue(occurrence: MutableOccurrence, label: string): void {
    if (this.occurrences.has(occurrence.queueId)) {
      throw new Error(`${label}: queue ${occurrence.queueId} was already queued`);
    }
    if (occurrence.enqueueSequence <= this.lastEnqueueSequence) {
      throw new Error(
        `${label}: queue ${occurrence.queueId} enqueue sequence ${occurrence.enqueueSequence} is not after ${this.lastEnqueueSequence}`
      );
    }
    this.lastEnqueueSequence = occurrence.enqueueSequence;
    this.occurrences.set(occurrence.queueId, occurrence);
    this.touchNode(occurrence.nodeId);
  }

  openOccurrence(queueId: string, nodeId: string, label: string): MutableOccurrence {
    const occurrence = this.occurrences.get(queueId);
    if (occurrence === undefined) {
      throw new Error(`${label}: queue ${queueId} was never queued in this journey`);
    }
    if (occurrence.nodeId !== nodeId) {
      throw new Error(
        `${label}: queue ${queueId} belongs to node ${occurrence.nodeId}, not ${nodeId}`
      );
    }
    if (occurrence.state !== "open") {
      throw new Error(`${label}: queue ${queueId} is already ${occurrence.state}`);
    }
    return occurrence;
  }

  join(nodeId: string): MutableJoin {
    let join = this.joins.get(nodeId);
    if (join === undefined) {
      join = { nodeId, status: "pending", edges: new Map(), lateOffers: 0 };
      this.joins.set(nodeId, join);
    }
    return join;
  }

  countEdge(edgeId: string): void {
    this.edges.set(edgeId, (this.edges.get(edgeId) ?? 0) + 1);
  }

  addUsage(nodeId: string, receiptsRaw: unknown, label: string): void {
    const receipts = captureDenseArrayItems(receiptsRaw, label).map((receipt) => validateUsageReceipt(receipt));
    const usage = this.usageByNode.get(nodeId) ?? { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 };
    for (const receipt of receipts) {
      usage.receipts += 1;
      usage.chargedTokens += receipt.chargedTokens;
      usage.chargedCostMicroUsd += receipt.chargedCostMicroUsd;
      this.total.receipts += 1;
      this.total.chargedTokens += receipt.chargedTokens;
      this.total.chargedCostMicroUsd += receipt.chargedCostMicroUsd;
    }
    this.usageByNode.set(nodeId, usage);
  }

  applyRouting(effectsRaw: unknown, sequence: number, label: string): void {
    const effects = captureDenseArrayItems(effectsRaw, `${label}.routing`);
    effects.forEach((effectRaw, index) => {
      const effectLabel = `${label}.routing[${index}]`;
      const raw = assertPlainObject(effectRaw, effectLabel);
      assertRequiredKeys(raw, new Set(["kind", "targetNodeId"]), effectLabel);
      const kind = raw.kind;
      if (typeof kind !== "string" || !Object.hasOwn(EFFECT_KEYS, kind)) {
        throw new Error(`${effectLabel}.kind must be a routing effect kind (got ${typeof kind === "string" ? JSON.stringify(kind) : typeName(kind)})`);
      }
      const keys = new Set(EFFECT_KEYS[kind]!);
      assertStrictKeys(raw, keys, effectLabel);
      assertRequiredKeys(raw, keys, effectLabel);
      const targetNodeId = assertIdentifier(raw.targetNodeId, `${effectLabel}.targetNodeId`);
      switch (kind) {
        case "queue_enqueued": {
          const edgeIds = identifierList(raw.edgeIds, `${effectLabel}.edgeIds`);
          validateArtifactRef(raw.inputArtifact);
          this.enqueue({
            queueId: assertEvidenceString(raw.queueId, `${effectLabel}.queueId`),
            nodeId: targetNodeId,
            enqueueSequence: assertSafePositiveInt(raw.enqueueSequence, `${effectLabel}.enqueueSequence`),
            queuedBySequence: sequence,
            inboundEdgeIds: edgeIds,
            state: "open",
            attempts: 0,
            failures: 0
          }, effectLabel);
          for (const edgeId of edgeIds) this.countEdge(edgeId);
          return;
        }
        case "join_offer": {
          const edgeId = assertIdentifier(raw.edgeId, `${effectLabel}.edgeId`);
          validateArtifactRef(raw.artifact);
          const join = this.join(targetNodeId);
          if (raw.disposition === "accepted") {
            if (join.status !== "pending" || join.edges.has(edgeId)) {
              throw new Error(`${effectLabel}: edge ${edgeId} was accepted at join ${targetNodeId} after it was resolved`);
            }
            join.edges.set(edgeId, "offered");
            this.countEdge(edgeId);
            return;
          }
          if (raw.disposition === "edge_already_resolved_noop" || raw.disposition === "join_already_resolved_noop") {
            join.lateOffers += 1;
            return;
          }
          throw new Error(`${effectLabel}.disposition is not a join offer disposition`);
        }
        case "join_impossible": {
          const edgeId = assertIdentifier(raw.edgeId, `${effectLabel}.edgeId`);
          const join = this.join(targetNodeId);
          if (raw.disposition === "resolved") {
            if (join.edges.has(edgeId)) {
              throw new Error(`${effectLabel}: edge ${edgeId} at join ${targetNodeId} was already resolved`);
            }
            join.edges.set(edgeId, "impossible");
            return;
          }
          if (raw.disposition === "already_resolved_noop") return;
          throw new Error(`${effectLabel}.disposition is not a join impossibility disposition`);
        }
        case "join_queued": {
          const join = this.join(targetNodeId);
          if (join.status !== "pending") {
            throw new Error(`${effectLabel}: join ${targetNodeId} queued twice`);
          }
          const accepted = identifierList(raw.acceptedEdgeIds, `${effectLabel}.acceptedEdgeIds`);
          const selectedEdgeId = assertIdentifier(raw.selectedEdgeId, `${effectLabel}.selectedEdgeId`);
          if (!accepted.includes(selectedEdgeId)) {
            throw new Error(`${effectLabel}: selected edge ${selectedEdgeId} is not an accepted edge`);
          }
          const queueId = assertEvidenceString(raw.queueId, `${effectLabel}.queueId`);
          this.enqueue({
            queueId,
            nodeId: targetNodeId,
            enqueueSequence: assertSafePositiveInt(raw.enqueueSequence, `${effectLabel}.enqueueSequence`),
            queuedBySequence: sequence,
            inboundEdgeIds: accepted,
            state: "open",
            attempts: 0,
            failures: 0
          }, effectLabel);
          join.status = "queued";
          join.queueId = queueId;
          join.selectedEdgeId = selectedEdgeId;
          return;
        }
        case "join_unsatisfiable": {
          const join = this.join(targetNodeId);
          if (join.status !== "pending") {
            throw new Error(`${effectLabel}: join ${targetNodeId} resolved twice`);
          }
          validateArtifactRef(raw.artifact);
          join.status = "unsatisfiable";
          join.syntheticOutcomeDigest = assertSha256Hex(
            raw.syntheticOutcomeDigest,
            `${effectLabel}.syntheticOutcomeDigest`
          );
          return;
        }
        default:
          throw new Error(`${effectLabel}.kind is unsupported`);
      }
    });
  }
}

/**
 * Project one unit's journey, as returned by `UnitStore.readJourney`, into
 * per-node, per-edge, per-join execution state plus usage totals. Pure and
 * deterministic: the same journey yields a deep-equal frozen projection.
 */
export function projectUnitPath(journeyRaw: unknown): UnitPathProjection {
  const label = "unit journey";
  const journey = captureDenseArrayItems(
    snapshotBoundedValidationData(journeyRaw, label, UNIT_PATH_VALIDATION_LIMITS),
    label,
    MAX_UNIT_PATH_RECORDS
  );
  if (journey.length === 0) throw new Error(`${label} must contain the admission record`);

  const admittedLabel = `${label}[0]`;
  const admitted = assertPlainObject(journey[0], admittedLabel);
  if (!Object.hasOwn(admitted, "kind") || admitted.kind !== "unit_admitted") {
    throw new Error(`${admittedLabel} must be the unit_admitted record (got ${typeof admitted.kind === "string" ? JSON.stringify(admitted.kind) : typeName(admitted.kind)})`);
  }
  assertStrictKeys(admitted, ADMITTED_KEYS, admittedLabel);
  assertRequiredKeys(admitted, ADMITTED_KEYS, admittedLabel);
  if (admitted.sequence !== 1) throw new Error(`${admittedLabel}.sequence must be 1`);
  assertRecordSeal(admitted, admittedLabel);
  const unitId = assertEvidenceString(admitted.unitId, `${admittedLabel}.unitId`);
  const graph = validateGraphDefinitionRef(admitted.graph, `${admittedLabel}.graph`);
  const seedArtifact = validateArtifactRef(admitted.seedArtifact);
  const entryNodeId = assertIdentifier(admitted.entryNodeId, `${admittedLabel}.entryNodeId`);
  assertIdentifier(admitted.principalId, `${admittedLabel}.principalId`);
  let lastRecordedAt = assertCanonicalTimestamp(admitted.recordedAt, `${admittedLabel}.recordedAt`);

  const builder = new PathBuilder();
  builder.enqueue({
    queueId: assertEvidenceString(admitted.entryQueueId, `${admittedLabel}.entryQueueId`),
    nodeId: entryNodeId,
    enqueueSequence: assertSafePositiveInt(admitted.entryEnqueueSequence, `${admittedLabel}.entryEnqueueSequence`),
    queuedBySequence: 1,
    inboundEdgeIds: Object.freeze([]),
    state: "open",
    attempts: 0,
    failures: 0
  }, admittedLabel);

  for (let index = 1; index < journey.length; index += 1) {
    const recordLabel = `${label}[${index}]`;
    const record = assertPlainObject(journey[index], recordLabel);
    assertRequiredKeys(record, new Set(BASE_KEYS), recordLabel);
    const sequence = assertSafePositiveInt(record.sequence, `${recordLabel}.sequence`);
    if (sequence !== index + 1) {
      throw new Error(`${recordLabel}.sequence must be ${index + 1} (got ${sequence})`);
    }
    if (record.unitId !== unitId) throw new Error(`${recordLabel} changes the unit identity`);
    const recordGraph = validateGraphDefinitionRef(record.graph, `${recordLabel}.graph`);
    if (recordGraph.id !== graph.id || recordGraph.version !== graph.version || recordGraph.digest !== graph.digest) {
      throw new Error(`${recordLabel} changes the graph identity`);
    }
    lastRecordedAt = assertCanonicalTimestamp(record.recordedAt, `${recordLabel}.recordedAt`);
    assertRecordSeal(record, recordLabel);

    switch (record.kind) {
      case "turn_settled": {
        assertStrictKeys(record, SETTLED_KEYS, recordLabel);
        assertRequiredKeys(record, SETTLED_REQUIRED, recordLabel);
        const nodeId = assertIdentifier(record.nodeId, `${recordLabel}.nodeId`);
        const occurrence = builder.openOccurrence(
          assertEvidenceString(record.queueId, `${recordLabel}.queueId`),
          nodeId,
          recordLabel
        );
        assertSafePositiveInt(record.attemptNumber, `${recordLabel}.attemptNumber`);
        assertSafePositiveInt(record.attemptIndex, `${recordLabel}.attemptIndex`);
        validateArtifactRef(record.inputArtifact);
        if (Object.hasOwn(record, "outputArtifact")) validateArtifactRef(record.outputArtifact);
        const outcome = assertIdentifier(record.outcome, `${recordLabel}.outcome`);
        occurrence.state = "settled";
        occurrence.attempts += 1;
        occurrence.outcome = outcome;
        occurrence.settledAt = assertCanonicalTimestamp(record.settledAt, `${recordLabel}.settledAt`);
        occurrence.principalId = assertIdentifier(record.principalId, `${recordLabel}.principalId`);
        if (Object.hasOwn(record, "actorId")) {
          occurrence.actorId = assertEvidenceString(record.actorId, `${recordLabel}.actorId`);
        }
        const outcomes = builder.outcomesByNode.get(nodeId) ?? [];
        outcomes.push(outcome);
        builder.outcomesByNode.set(nodeId, outcomes);
        builder.addUsage(nodeId, record.usage, `${recordLabel}.usage`);
        builder.applyRouting(record.routing, sequence, recordLabel);
        break;
      }
      case "turn_failed": {
        assertStrictKeys(record, FAILED_KEYS, recordLabel);
        assertRequiredKeys(record, FAILED_KEYS, recordLabel);
        const nodeId = assertIdentifier(record.nodeId, `${recordLabel}.nodeId`);
        const occurrence = builder.openOccurrence(
          assertEvidenceString(record.queueId, `${recordLabel}.queueId`),
          nodeId,
          recordLabel
        );
        assertSafePositiveInt(record.attemptNumber, `${recordLabel}.attemptNumber`);
        assertSafePositiveInt(record.attemptIndex, `${recordLabel}.attemptIndex`);
        validateArtifactRef(record.inputArtifact);
        const terminal = assertBoolean(record.terminal, `${recordLabel}.terminal`);
        assertBoolean(record.retryable, `${recordLabel}.retryable`);
        occurrence.attempts += 1;
        occurrence.failures += 1;
        occurrence.errorCode = assertIdentifier(record.errorCode, `${recordLabel}.errorCode`);
        occurrence.failedAt = assertCanonicalTimestamp(record.failedAt, `${recordLabel}.failedAt`);
        occurrence.principalId = assertIdentifier(record.principalId, `${recordLabel}.principalId`);
        if (terminal) occurrence.state = "dead";
        builder.addUsage(nodeId, record.usage, `${recordLabel}.usage`);
        builder.applyRouting(record.routing, sequence, recordLabel);
        break;
      }
      case "join_unsatisfiable": {
        assertStrictKeys(record, UNSATISFIABLE_KEYS, recordLabel);
        assertRequiredKeys(record, UNSATISFIABLE_KEYS, recordLabel);
        const nodeId = assertIdentifier(record.nodeId, `${recordLabel}.nodeId`);
        if (record.outcome !== "join_unsatisfiable") {
          throw new Error(`${recordLabel}.outcome must be join_unsatisfiable`);
        }
        validateArtifactRef(record.artifact);
        const synthetic = assertSha256Hex(record.syntheticOutcomeDigest, `${recordLabel}.syntheticOutcomeDigest`);
        const join = builder.join(nodeId);
        if (join.status !== "unsatisfiable" || join.syntheticOutcomeDigest !== synthetic) {
          throw new Error(`${recordLabel}: synthetic outcome at ${nodeId} has no matching join_unsatisfiable routing effect`);
        }
        builder.applyRouting(record.routing, sequence, recordLabel);
        break;
      }
      case "unit_admitted":
        throw new Error(`${recordLabel}: a journey has exactly one admission record`);
      default:
        throw new Error(`${recordLabel}.kind is not a journey record kind (got ${typeof record.kind === "string" ? JSON.stringify(record.kind) : typeName(record.kind)})`);
    }
  }

  const occurrences = [...builder.occurrences.values()].sort((a, b) => a.enqueueSequence - b.enqueueSequence);
  const openQueueIds = Object.freeze(
    occurrences.filter((occurrence) => occurrence.state === "open").map((occurrence) => occurrence.queueId)
  );
  const nodes = frozenRecord(builder.nodeOrder.map((nodeId) => {
    const own = occurrences
      .filter((occurrence) => occurrence.nodeId === nodeId)
      .map((occurrence) => Object.freeze({
        queueId: occurrence.queueId,
        nodeId: occurrence.nodeId,
        enqueueSequence: occurrence.enqueueSequence,
        queuedBySequence: occurrence.queuedBySequence,
        inboundEdgeIds: occurrence.inboundEdgeIds,
        state: occurrence.state,
        attempts: occurrence.attempts,
        failures: occurrence.failures,
        ...(occurrence.outcome === undefined ? {} : { outcome: occurrence.outcome }),
        ...(occurrence.errorCode === undefined ? {} : { errorCode: occurrence.errorCode }),
        ...(occurrence.settledAt === undefined ? {} : { settledAt: occurrence.settledAt }),
        ...(occurrence.failedAt === undefined ? {} : { failedAt: occurrence.failedAt }),
        ...(occurrence.principalId === undefined ? {} : { principalId: occurrence.principalId }),
        ...(occurrence.actorId === undefined ? {} : { actorId: occurrence.actorId })
      }));
    const latest = own[own.length - 1];
    if (latest === undefined) {
      throw new Error(`unit path projection invariant: node ${nodeId} has no occurrence`);
    }
    const state: UnitPathNodeState = latest.state === "settled"
      ? "settled"
      : latest.state === "dead"
        ? "dead"
        : latest.failures > 0
          ? "failed"
          : "pending";
    const usage = builder.usageByNode.get(nodeId) ?? { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 };
    return [nodeId, Object.freeze({
      nodeId,
      state,
      occurrences: Object.freeze(own),
      outcomes: Object.freeze([...(builder.outcomesByNode.get(nodeId) ?? [])]),
      usage: Object.freeze({ ...usage })
    })] as const;
  }));
  const joins = frozenRecord([...builder.joins.values()].map((join) => [join.nodeId, Object.freeze({
    nodeId: join.nodeId,
    status: join.status,
    edges: frozenRecord([...join.edges.entries()]),
    lateOffers: join.lateOffers,
    ...(join.queueId === undefined ? {} : { queueId: join.queueId }),
    ...(join.selectedEdgeId === undefined ? {} : { selectedEdgeId: join.selectedEdgeId }),
    ...(join.syntheticOutcomeDigest === undefined ? {} : { syntheticOutcomeDigest: join.syntheticOutcomeDigest })
  })] as const));

  return Object.freeze({
    schemaVersion: UNIT_PATH_SCHEMA_VERSION,
    unitId,
    graph,
    seedArtifact,
    entryNodeId,
    records: journey.length,
    lastSequence: journey.length,
    lastRecordedAt,
    nodes,
    edges: frozenRecord([...builder.edges.entries()]),
    joins,
    openQueueIds,
    concluded: openQueueIds.length === 0,
    usage: Object.freeze({ ...builder.total })
  });
}

/** The journey record type this projection consumes, re-declared for callers' convenience. */
export type UnitPathJourney = readonly UnitJourneyRecord[];

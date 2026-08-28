// store/unit-store.ts — durable v2 MissionPipelineUnit / journey store port.
//
// This is the host-neutral contract implemented by the N3 memory executable
// specification and, in N4, by the consumer-owned Postgres adapter. The
// successful position-changing operation is settleTurn: journey evidence,
// artifacts, deterministic routing, join progress, successor queues, outbox,
// and lease release commit together. Terminal failure has the analogous
// atomic failure/dead-letter/join-resolution boundary.
//
// APPEND-ONLY: unit headers, queue occurrences, attempt reservations, cached
// completions, failures, journey records, artifacts, join evidence, outbox,
// and dead letters are immutable once appended. Only fenced leases and the
// fairness cursor are mutable coordination state. Queue rows are a retained,
// rebuildable projection; conclusion is derived from journey evidence.

import type { ArtifactEnvelope, ArtifactRef } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import type {
  GraphDefinitionRef,
  JoinRequirement,
  MissionPipelineNodeKind,
  MissionPipelineNodeRef
} from "../graph/definition.js";
import {
  JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
  MISSION_PIPELINE_ENGINE_PRINCIPAL_ID
} from "../graph/definition.js";
import type { NodeTurnCompletion } from "../execute/ports.js";
import type {
  TurnOutboxEventInput,
  TurnRunnerStore
} from "../execute/unit-runner.js";
import { turnOutboxEventDigest } from "../execute/unit-runner.js";
export {
  MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH,
  nodeTurnFailureDigest,
  nodeTurnSettlementDigest,
  validateNodeTurnFailureMessage,
  type NodeTurnFailureDigestInput,
  type NodeTurnSettlementDigestInput
} from "../execute/turn-evidence.js";

export const MISSION_PIPELINE_UNIT_SCHEMA_VERSION =
  "mission-pipeline-unit.v2" as const;
export {
  JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
  MISSION_PIPELINE_ENGINE_PRINCIPAL_ID
};
export const MAX_UNIT_STORE_LIST_LIMIT = 10_000;

/** Stable logical transaction checkpoints shared by memory and PG testkits. */
export const SETTLE_TRANSACTION_CHECKPOINTS = Object.freeze([
  "journey_append",
  "artifact_retain",
  "edge_evaluation",
  "join_progress",
  "successor_enqueue",
  "outbox_append",
  "lease_release",
  "post_commit_reply"
] as const);
export type SettleTransactionCheckpoint =
  (typeof SETTLE_TRANSACTION_CHECKPOINTS)[number];

export interface MissionPipelineUnit {
  readonly schemaVersion: typeof MISSION_PIPELINE_UNIT_SCHEMA_VERSION;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly seedArtifact: ArtifactRef;
  readonly admittedAt: string;
  readonly principalId: string;
  readonly admissionDigest: string;
}

export interface AdmitUnitInput {
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly seedArtifact: ArtifactEnvelope;
  readonly admittedAt: string;
  /** Authenticated admission authority; retained as evidence, never a secret. */
  readonly principalId: string;
}

export interface QueueJoinProvenance {
  readonly joinNodeId: string;
  readonly selectedEdgeId: string;
  readonly accepted: readonly JoinAcceptedOffer[];
}

/** Immutable queue occurrence. Resolved occurrences remain inspectable. */
export interface UnitQueueOccurrence {
  readonly queueId: string;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly inputArtifact: ArtifactEnvelope;
  readonly queuedAt: string;
  readonly enqueueSequence: number;
  readonly sourceEvidenceDigest: string;
  readonly inboundEdgeIds: readonly string[];
  readonly join?: QueueJoinProvenance;
}

export interface AdmitUnitResult {
  readonly created: boolean;
  readonly unit: MissionPipelineUnit;
  readonly entryQueue: UnitQueueOccurrence;
}

export interface JoinAcceptedOffer {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourceQueueId?: string;
  readonly sourceEvidenceDigest: string;
  readonly artifact: ArtifactRef;
  readonly offeredAt: string;
}

export interface JoinImpossibleEdge {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly causeEvidenceDigest: string;
  readonly resolvedAt: string;
  readonly reason: "source_unreachable";
}

export type JoinInboundProgress =
  | { readonly edgeId: string; readonly state: "pending" }
  | {
      readonly edgeId: string;
      readonly state: "offered";
      readonly offer: JoinAcceptedOffer;
    }
  | {
      readonly edgeId: string;
      readonly state: "impossible";
      readonly impossible: JoinImpossibleEdge;
    };

export interface JoinProgress {
  readonly unitId: string;
  readonly nodeId: string;
  readonly require: JoinRequirement;
  readonly inbound: readonly JoinInboundProgress[];
  readonly status: "pending" | "queued" | "unsatisfiable";
  readonly selectedEdgeId?: string;
  readonly queueId?: string;
  readonly syntheticOutcomeDigest?: string;
}

export type JourneyRoutingEffect =
  | {
      readonly kind: "queue_enqueued";
      readonly targetNodeId: string;
      readonly queueId: string;
      readonly enqueueSequence: number;
      readonly edgeIds: readonly string[];
      readonly inputArtifact: ArtifactRef;
    }
  | {
      readonly kind: "join_offer";
      readonly targetNodeId: string;
      readonly edgeId: string;
      readonly disposition:
        | "accepted"
        | "edge_already_resolved_noop"
        | "join_already_resolved_noop";
      readonly artifact: ArtifactRef;
    }
  | {
      readonly kind: "join_impossible";
      readonly targetNodeId: string;
      readonly edgeId: string;
      readonly disposition: "resolved" | "already_resolved_noop";
    }
  | {
      readonly kind: "join_queued";
      readonly targetNodeId: string;
      readonly queueId: string;
      readonly enqueueSequence: number;
      readonly selectedEdgeId: string;
      readonly acceptedEdgeIds: readonly string[];
    }
  | {
      readonly kind: "join_unsatisfiable";
      readonly targetNodeId: string;
      readonly syntheticOutcomeDigest: string;
      readonly artifact: ArtifactRef;
    };

interface JourneyRecordBase {
  readonly sequence: number;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly recordedAt: string;
  readonly recordDigest: string;
}

export interface UnitAdmittedJourneyRecord extends JourneyRecordBase {
  readonly kind: "unit_admitted";
  readonly principalId: string;
  readonly seedArtifact: ArtifactRef;
  readonly entryQueueId: string;
  readonly entryNodeId: string;
  readonly entryEnqueueSequence: number;
}

export interface UnitTurnJourneyRecord extends JourneyRecordBase {
  readonly kind: "turn_settled";
  readonly queueId: string;
  readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly inputArtifact: ArtifactRef;
  readonly outcome: string;
  readonly outputArtifact?: ArtifactRef;
  readonly usage: readonly UsageReceipt[];
  readonly principalId: string;
  readonly actorId?: string;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly completionDigest: string;
  readonly settlementDigest: string;
  readonly routing: readonly JourneyRoutingEffect[];
}

export interface UnitAttemptFailureJourneyRecord extends JourneyRecordBase {
  readonly kind: "turn_failed";
  readonly queueId: string;
  readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly idempotencyKey: string;
  readonly inputArtifact: ArtifactRef;
  readonly principalId: string;
  readonly startedAt: string;
  readonly failedAt: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly usage: readonly UsageReceipt[];
  readonly failureDigest: string;
  readonly routing: readonly JourneyRoutingEffect[];
}

export interface JoinUnsatisfiableJourneyRecord extends JourneyRecordBase {
  readonly kind: "join_unsatisfiable";
  readonly nodeId: string;
  readonly outcome: "join_unsatisfiable";
  readonly principalId: typeof MISSION_PIPELINE_ENGINE_PRINCIPAL_ID;
  readonly startedAt: string;
  readonly settledAt: string;
  readonly causeEvidenceDigest: string;
  readonly artifact: ArtifactRef;
  readonly syntheticOutcomeDigest: string;
  readonly routing: readonly JourneyRoutingEffect[];
}

export type UnitJourneyRecord =
  | UnitAdmittedJourneyRecord
  | UnitTurnJourneyRecord
  | UnitAttemptFailureJourneyRecord
  | JoinUnsatisfiableJourneyRecord;

export interface QueuedUnit {
  readonly queueId: string;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef;
  readonly nodeKind: MissionPipelineNodeKind;
  readonly principalId: string;
  readonly inputArtifact: ArtifactEnvelope;
  readonly queuedAt: string;
  readonly outcomes: readonly string[];
  readonly join?: QueueJoinProvenance;
}

export interface ListQueuedUnitsInput {
  readonly principalId: string;
  readonly nodeId: string;
  readonly graphId?: string;
  readonly limit?: number;
}

export interface ReadUnitInput {
  readonly unitId: string;
}

export interface ReadJourneyInput {
  readonly unitId: string;
}

export interface ReadJoinProgressInput {
  readonly unitId: string;
  readonly nodeId: string;
}

export interface GetArtifactInput {
  readonly artifact: ArtifactRef;
}

export interface UnitOutboxEventRecord {
  readonly outboxEventId: string;
  readonly unitId: string;
  readonly queueId?: string;
  readonly nodeId: string;
  readonly attemptNumber?: number;
  readonly attemptIndex?: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly dedupeKey?: string;
  readonly eventDigest: string;
  readonly recordedAt: string;
}

export interface UnitDeadLetterRecord {
  readonly deadLetterId: string;
  readonly unitId: string;
  readonly queueId: string;
  readonly nodeId: string;
  readonly attemptNumber: number;
  readonly attemptIndex: number;
  readonly errorCode: string;
  readonly failureDigest: string;
  readonly principalId: string;
  readonly recordedAt: string;
}

export interface ListUnitEvidenceInput {
  readonly unitId?: string;
  readonly limit?: number;
}

/**
 * Full N3 persistence capability. Bodies receive only N2's narrow runner port;
 * admission, queue reads, artifact reads, and journey reads remain host-side.
 */
export interface UnitStore extends TurnRunnerStore {
  admitUnit(input: AdmitUnitInput): Promise<AdmitUnitResult>;
  readUnit(input: ReadUnitInput): Promise<MissionPipelineUnit | undefined>;
  readJourney(input: ReadJourneyInput): Promise<readonly UnitJourneyRecord[]>;
  readJoinProgress(input: ReadJoinProgressInput): Promise<JoinProgress | undefined>;
  listQueuedUnits(input: ListQueuedUnitsInput): Promise<readonly QueuedUnit[]>;
  getArtifact(input: GetArtifactInput): Promise<ArtifactEnvelope | undefined>;
  listOutboxEvents(input?: ListUnitEvidenceInput): Promise<readonly UnitOutboxEventRecord[]>;
  listDeadLetters(input?: ListUnitEvidenceInput): Promise<readonly UnitDeadLetterRecord[]>;
}

export function unitOutboxEventDigest(event: TurnOutboxEventInput): string {
  return turnOutboxEventDigest(event);
}

/** Useful structural alias for adapters retaining an exact completion. */
export interface StoredTurnCompletion {
  readonly completion: NodeTurnCompletion;
  readonly completionDigest: string;
  readonly startedAt: string;
  readonly settledAt: string;
}

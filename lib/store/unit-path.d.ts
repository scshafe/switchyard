import { type ArtifactRef } from "../contracts/artifact.js";
import type { GraphDefinitionRef } from "../graph/definition.js";
import { type ValidationDataLimits } from "../internal/evidence.js";
import type { UnitJourneyRecord } from "./unit-store.js";
export declare const UNIT_PATH_SCHEMA_VERSION: "mission-pipeline-unit-path.v1";
export declare const MAX_UNIT_PATH_RECORDS = 100000;
/** Journeys carry refs and receipts, never payloads; the budget is generous but finite. */
export declare const UNIT_PATH_VALIDATION_LIMITS: ValidationDataLimits;
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
/**
 * Project one unit's journey, as returned by `UnitStore.readJourney`, into
 * per-node, per-edge, per-join execution state plus usage totals. Pure and
 * deterministic: the same journey yields a deep-equal frozen projection.
 */
export declare function projectUnitPath(journeyRaw: unknown): UnitPathProjection;
/** The journey record type this projection consumes, re-declared for callers' convenience. */
export type UnitPathJourney = readonly UnitJourneyRecord[];

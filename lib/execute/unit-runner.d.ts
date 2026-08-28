import { type ArtifactEnvelope } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import { type GraphDefinition, type MissionPipelineNode, type MissionPipelineNodeRef } from "../graph/definition.js";
import { type CallbackNodeEvent, type HumanNodeDecision, type NodeTurnCompletion } from "./ports.js";
import { type WorkerNodePorts } from "./turn.js";
export declare const NODE_TURN_USAGE_EVENT_TYPE: "node_turn_usage_receipt";
export declare const NODE_TURN_USAGE_EVENT_SCHEMA_VERSION: "node-turn-usage-receipt-event.v1";
export declare const MAX_TURN_BATCH_SIZE = 256;
export declare const MAX_TURN_OUTBOX_EVENTS = 1024;
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
export type ExternalUnitTurnClaimResult = {
    readonly disposition: "claimed";
    readonly claim: ClaimedUnitTurn;
} | SettledExternalUnitTurn;
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
export type TurnAttemptPreparation = ({
    readonly disposition: "reserved";
} & PreparedAttemptIdentity) | ({
    readonly disposition: "cached";
    readonly completion: NodeTurnCompletion;
    readonly completionDigest: string;
    readonly startedAt: string;
    readonly settledAt: string;
} & PreparedAttemptIdentity) | {
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
export interface RetrySafeTurnOutboxEvents extends ReadonlyArray<TurnOutboxEventInput> {
    acknowledge(): void;
}
export type TurnOutboxEvents = readonly TurnOutboxEventInput[] | RetrySafeTurnOutboxEvents;
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
    recordTurnFailure(input: RecordTurnFailureInput, outboxEvents?: TurnOutboxEvents): Promise<RecordTurnFailureResult>;
    settleTurn(input: SettleTurnInput, outboxEvents?: TurnOutboxEvents): Promise<SettleTurnResult>;
}
export interface WorkerTurnRunnerStore extends TurnExecutionStore {
    claimUnitTurns(input: ClaimUnitTurnsInput): Promise<readonly ClaimedUnitTurn[]>;
}
export interface ExternalTurnRunnerStore extends Pick<TurnExecutionStore, "prepareTurnAttempt" | "settleTurn"> {
    /**
     * Read-only validation snapshot; it must not acquire or extend a lease. It
     * MUST retain and return the sealed graph/input metadata for both a queued
     * occurrence and an already-settled occurrence so exact response-loss
     * retries can reach `claimExternalUnitTurn.disposition = "settled"`.
     */
    inspectExternalUnitTurn(input: InspectExternalUnitTurnInput): Promise<ExternalUnitTurnInspection | undefined>;
    /**
     * Acquire an exact-request lease, or recover an already-settled exact
     * completion. A differing actor/completion/outbox batch is a conflict.
     */
    claimExternalUnitTurn(input: ClaimExternalUnitTurnInput): Promise<ExternalUnitTurnClaimResult | undefined>;
}
export interface TurnRunnerStore extends WorkerTurnRunnerStore, ExternalTurnRunnerStore {
}
/** Store adapters throw this exact type for an expired/reclaimed queue fence. */
export declare class TurnLeaseLostError extends Error {
    readonly code = "turn_lease_lost";
    readonly queueId: string;
    constructor(queueId: string);
}
/** Same attempt identity produced contradictory completion/failure evidence. */
export declare class TurnEvidenceConflictError extends Error {
    readonly code = "turn_evidence_conflict";
    constructor(message: string);
}
/** A heartbeat failed without a typed stale-fence proof; never a node failure. */
export declare class TurnLeaseHeartbeatError extends Error {
    readonly code = "turn_lease_heartbeat_failed";
    constructor(cause: unknown);
}
export type TurnAttemptEvidenceOperation = "assemble_completion" | "assemble_failure" | "assemble_settlement" | "claim_worker" | "claim_external" | "prepare" | "cache_completion" | "record_failure";
/** An evidence operation may have committed; only durable recovery may decide. */
export declare class TurnAttemptPersistenceUncertainError extends Error {
    readonly code = "turn_attempt_persistence_uncertain";
    readonly operation: TurnAttemptEvidenceOperation;
    constructor(operation: TurnAttemptEvidenceOperation, cause: unknown);
}
/** settleTurn may have committed. Never translate this into a failed attempt. */
export declare class TurnSettlementUncertainError extends Error {
    readonly code = "turn_settlement_uncertain";
    constructor(cause: unknown);
}
export declare class TurnAuthorityError extends Error {
    readonly code = "turn_principal_rejected";
    constructor(nodeId: string, expected: string, actual: string);
}
export declare class TurnOutboxEvidenceNotCommittedError extends Error {
    readonly code = "turn_outbox_evidence_not_committed";
    constructor();
}
export declare function turnOutboxEventDigest(eventRaw: unknown): string;
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
export declare function runWithTurnHeartbeat<T>(input: {
    readonly store: Pick<TurnExecutionStore, "heartbeatTurn">;
    readonly queueId: string;
    readonly leaseToken: string;
    readonly everyMs: number;
    readonly extendByMs: number;
    readonly now: () => Date;
    readonly operation: () => Promise<T>;
}): Promise<T>;
export interface RunClaimedUnitTurnInput {
    readonly store: TurnExecutionStore;
    readonly claim: ClaimedUnitTurn;
    /** Host-authenticated authority. It is not caller-authored actor evidence. */
    readonly principalId: string;
    readonly ports: WorkerNodePorts;
    readonly successOutboxEvents?: (completion: NodeTurnCompletion, context: TurnOutboxContext) => TurnOutboxEvents;
    readonly failureOutboxEvents?: (context: TurnFailureOutboxContext) => TurnOutboxEvents;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
}
export type UnitTurnRunResult = {
    readonly status: "succeeded";
    readonly completion: NodeTurnCompletion;
    readonly completionDigest: string;
    readonly idempotencyKey: string;
    readonly attemptNumber: number;
    readonly attemptIndex: number;
    readonly reused: boolean;
} | {
    readonly status: "terminal";
    readonly errorCode: string;
    readonly attempts: number;
};
/** Execute and atomically settle one already claimed worker turn. */
export declare function runClaimedUnitTurn(inputRaw: RunClaimedUnitTurnInput): Promise<UnitTurnRunResult>;
export interface RunNextUnitTurnsInput extends Omit<RunClaimedUnitTurnInput, "claim" | "store"> {
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
export declare function runNextUnitTurns(inputRaw: RunNextUnitTurnsInput): Promise<readonly ClaimedUnitTurnSettlement[]>;
/** Claim at most one queued worker turn. */
export declare function runNextUnitTurn(inputRaw: Omit<RunNextUnitTurnsInput, "batch">): Promise<UnitTurnRunResult | undefined>;
export interface RecordHumanNodeDecisionInput {
    readonly store: ExternalTurnRunnerStore;
    readonly principalId: string;
    readonly decision: HumanNodeDecision;
    readonly outboxEvents?: TurnOutboxEvents;
    readonly now?: () => Date;
}
/** Inbound human completion; actor attribution never grants authority. */
export declare function recordHumanNodeDecision(inputRaw: RecordHumanNodeDecisionInput): Promise<UnitTurnRunResult>;
export interface AdmitCallbackNodeEventInput {
    readonly store: ExternalTurnRunnerStore;
    readonly principalId: string;
    readonly event: CallbackNodeEvent;
    readonly outboxEvents?: TurnOutboxEvents;
    readonly now?: () => Date;
}
/** Inbound callback completion. Timers live outside the engine and call here. */
export declare function admitCallbackNodeEvent(inputRaw: AdmitCallbackNodeEventInput): Promise<UnitTurnRunResult>;
/** The reserved outcome is intentionally exported for store-side synthesis. */
export declare const JOIN_UNSATISFIABLE_OUTCOME: "join_unsatisfiable";
export {};

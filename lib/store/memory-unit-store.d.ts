import { type ArtifactEnvelope } from "../contracts/artifact.js";
import { type GraphDefinition } from "../graph/definition.js";
import { type CacheTurnCompletionInput, type CacheTurnCompletionResult, type ClaimExternalUnitTurnInput, type ClaimUnitTurnsInput, type ClaimedUnitTurn, type ExternalUnitTurnClaimResult, type ExternalUnitTurnInspection, type HeartbeatTurnInput, type InspectExternalUnitTurnInput, type PrepareTurnAttemptInput, type RecordTurnFailureInput, type RecordTurnFailureResult, type SettleTurnInput, type SettleTurnResult, type TurnAttemptPreparation, type TurnOutboxEvents } from "../execute/unit-runner.js";
import type { GraphStore } from "./graph-store.js";
import { type AdmitUnitInput, type AdmitUnitResult, type GetArtifactInput, type JoinProgress, type ListQueuedUnitsInput, type ListUnitEvidenceInput, type MissionPipelineUnit, type QueuedUnit, type ReadJoinProgressInput, type ReadJourneyInput, type ReadUnitInput, type SettleTransactionCheckpoint, type StoredTurnCompletion, type UnitDeadLetterRecord, type UnitJourneyRecord, type UnitOutboxEventRecord, type UnitQueueOccurrence, type UnitStore } from "./unit-store.js";
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
    readonly nodeRef: {
        readonly id: string;
        readonly version: number;
    };
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
export interface MemoryUnitStoreOptions {
    readonly graphStore?: GraphStore;
    readonly now?: () => Date;
    readonly idFactory?: (kind: "queue" | "lease" | "outbox" | "dead-letter") => string;
    /** Test-driver fault. Pre-commit throws roll back; post_commit_reply does not. */
    readonly settleCheckpoint?: (checkpoint: SettleTransactionCheckpoint) => void;
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
    readonly leases: readonly Readonly<{
        queueId: string;
        lease: LeaseRow;
    }>[];
}
/** Memory UnitStore; also forwards GraphStore for ergonomic hermetic use. */
export declare class MemoryUnitStore implements UnitStore, GraphStore {
    #private;
    constructor(options?: MemoryUnitStoreOptions);
    publishGraph(graph: GraphDefinition): Promise<void>;
    loadGraph(ref: Parameters<GraphStore["loadGraph"]>[0]): Promise<GraphDefinition | undefined>;
    admitUnit(inputRaw: AdmitUnitInput): Promise<AdmitUnitResult>;
    readUnit(inputRaw: ReadUnitInput): Promise<MissionPipelineUnit | undefined>;
    readJourney(inputRaw: ReadJourneyInput): Promise<readonly UnitJourneyRecord[]>;
    readJoinProgress(inputRaw: ReadJoinProgressInput): Promise<JoinProgress | undefined>;
    getArtifact(inputRaw: GetArtifactInput): Promise<ArtifactEnvelope | undefined>;
    listQueuedUnits(inputRaw: ListQueuedUnitsInput): Promise<readonly QueuedUnit[]>;
    claimUnitTurns(inputRaw: ClaimUnitTurnsInput): Promise<readonly ClaimedUnitTurn[]>;
    inspectExternalUnitTurn(inputRaw: InspectExternalUnitTurnInput): Promise<ExternalUnitTurnInspection | undefined>;
    claimExternalUnitTurn(inputRaw: ClaimExternalUnitTurnInput): Promise<ExternalUnitTurnClaimResult | undefined>;
    heartbeatTurn(inputRaw: HeartbeatTurnInput): Promise<void>;
    prepareTurnAttempt(inputRaw: PrepareTurnAttemptInput): Promise<TurnAttemptPreparation>;
    cacheTurnCompletion(inputRaw: CacheTurnCompletionInput): Promise<CacheTurnCompletionResult>;
    recordTurnFailure(inputRaw: RecordTurnFailureInput, outboxRaw?: TurnOutboxEvents): Promise<RecordTurnFailureResult>;
    settleTurn(inputRaw: SettleTurnInput, outboxRaw?: TurnOutboxEvents): Promise<SettleTurnResult>;
    listOutboxEvents(inputRaw?: ListUnitEvidenceInput): Promise<readonly UnitOutboxEventRecord[]>;
    listDeadLetters(inputRaw?: ListUnitEvidenceInput): Promise<readonly UnitDeadLetterRecord[]>;
    /** Privileged normalized observer used only by the shipped conformance driver. */
    evidenceSnapshot(): MemoryUnitStoreEvidenceSnapshot;
}
export {};

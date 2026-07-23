import { type ArtifactEnvelope, type ArtifactRef } from "./contracts/artifact.js";
import { type PipelineDefinition } from "./definition.js";
import { type AcquireLeaseInput, type ClaimNextShardInput, type CompleteShardInput, type CreateRunInput, type DeadLetterInput, type FailShardInput, type HeartbeatLeaseInput, type HeartbeatShardInput, type OutboxEventInput, type PersistStageFailureInput, type PersistStageSuccessInput, type PersistedStageResult, type PipelineStore, type PrepareStageExecutionInput, type ShardClaim, type ShardFinalization, type StagePreparation, type ReleaseLeaseInput, type WorkLease } from "./store.js";
interface LeaseRow {
    leaseOwner: string;
    leaseToken: string;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
}
export interface StageAttemptRecord {
    attempt: number;
    status: "succeeded" | "failed";
    startedAt: string;
    finishedAt: string;
    errorCode?: string;
    errorMessage?: string;
    retryable?: boolean;
    terminal?: boolean;
}
export interface DeadLetterRecord extends DeadLetterInput {
    deadLetterId: string;
}
export interface OutboxEventRecord {
    outboxEventId: string;
    runId: string;
    itemId: string;
    nodeId: string;
    idempotencyKey: string;
    eventType: string;
    payload: unknown;
    dedupeKey?: string;
    recordedAt: string;
}
export interface MemoryPipelineStoreOptions {
    /** Injectable clock — the default `at` for every lease-touching operation. */
    now?: () => Date;
}
export declare class MemoryPipelineStore implements PipelineStore {
    #private;
    constructor(options?: MemoryPipelineStoreOptions);
    publishDefinition(definitionRaw: PipelineDefinition): Promise<void>;
    loadDefinition(pipelineId: string, version: number): Promise<PipelineDefinition | undefined>;
    createRun(input: CreateRunInput): Promise<void>;
    claimNextShard(input: ClaimNextShardInput): Promise<ShardClaim | undefined>;
    heartbeatShard(input: HeartbeatShardInput): Promise<void>;
    completeShard(input: CompleteShardInput): Promise<ShardFinalization>;
    failShard(input: FailShardInput): Promise<void>;
    prepareStageExecution(input: PrepareStageExecutionInput): Promise<StagePreparation>;
    persistStageSuccess(input: PersistStageSuccessInput, outboxEvents?: readonly OutboxEventInput[]): Promise<PersistedStageResult>;
    persistStageFailure(input: PersistStageFailureInput): Promise<void>;
    recordDeadLetter(input: DeadLetterInput): Promise<{
        created: boolean;
    }>;
    putArtifact(envelopeRaw: ArtifactEnvelope): Promise<ArtifactRef>;
    getArtifact(ref: ArtifactRef): Promise<ArtifactEnvelope | undefined>;
    acquireLease(input: AcquireLeaseInput): Promise<WorkLease | undefined>;
    heartbeatLease(input: HeartbeatLeaseInput): Promise<void>;
    releaseLease(input: ReleaseLeaseInput): Promise<void>;
    get deadLetterRecords(): readonly DeadLetterRecord[];
    get outboxEventRecords(): readonly OutboxEventRecord[];
    attemptsForKey(idempotencyKey: string): readonly StageAttemptRecord[];
    leaseSnapshot(leaseKey: string): (LeaseRow & {
        leaseKey: string;
    }) | undefined;
    shardLeaseSnapshot(shardId: string): (LeaseRow & {
        leaseKey: string;
    }) | undefined;
}
export {};

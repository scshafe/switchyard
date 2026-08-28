import { type ArtifactEnvelope } from "../contracts/artifact.js";
import type { GraphStore } from "./graph-store.js";
import { type JoinProgress, type SettleTransactionCheckpoint, type UnitDeadLetterRecord, type UnitJourneyRecord, type UnitOutboxEventRecord, type UnitQueueOccurrence, type UnitStore } from "./unit-store.js";
export interface UnitStoreConformanceCachedCompletion {
    readonly queueId: string;
    readonly completionDigest: string;
}
export interface UnitStoreConformanceSettlement {
    readonly queueId: string;
    readonly settlementDigest: string;
}
export interface UnitStoreConformanceLease {
    readonly queueId: string;
    readonly lease: {
        readonly leaseToken: string;
    };
}
/** Minimal implementation-neutral evidence shape used by atomicity cases. */
export interface UnitStoreConformanceEvidence {
    readonly artifacts: readonly ArtifactEnvelope[];
    readonly queues: readonly UnitQueueOccurrence[];
    readonly journey: readonly UnitJourneyRecord[];
    readonly joins: readonly JoinProgress[];
    readonly cachedCompletions: readonly UnitStoreConformanceCachedCompletion[];
    readonly settlements: readonly UnitStoreConformanceSettlement[];
    readonly outbox: readonly UnitOutboxEventRecord[];
    readonly deadLetters: readonly UnitDeadLetterRecord[];
    readonly leases: readonly UnitStoreConformanceLease[];
}
export interface UnitStoreConformanceDriver {
    readonly graphStore: GraphStore;
    readonly unitStore: UnitStore;
    /** A fresh Date object at the driver's current deterministic instant. */
    now(): Date;
    advanceClock(milliseconds: number): void;
    armSettleCrash(checkpoint: SettleTransactionCheckpoint): void;
    recover(): Promise<void>;
    checkpointHits(): readonly SettleTransactionCheckpoint[];
    evidence(): Promise<UnitStoreConformanceEvidence>;
    close(): Promise<void>;
}
export interface UnitStoreConformanceFactoryContext {
    readonly backendName: string;
    readonly scenario: string;
}
export type UnitStoreConformanceDriverFactory = (context: UnitStoreConformanceFactoryContext) => UnitStoreConformanceDriver | Promise<UnitStoreConformanceDriver>;
export interface RegisterUnitStoreConformanceOptions {
    readonly backendName: string;
    readonly createDriver: UnitStoreConformanceDriverFactory;
}
/** Register the same executable store contract under one backend label. */
export declare function registerUnitStoreConformanceTests(options: RegisterUnitStoreConformanceOptions): void;

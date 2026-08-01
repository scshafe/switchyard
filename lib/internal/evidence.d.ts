/** Internal validation/snapshot helpers for in-memory evidence ledgers. */
export declare function assertEvidenceString(value: unknown, label: string): string;
export declare function assertEvidenceDigest(value: unknown, label: string): string;
export declare function assertEvidenceAttemptIdentity(value: {
    runId?: unknown;
    itemId?: unknown;
    nodeId?: unknown;
    stage?: unknown;
    attempt?: unknown;
    idempotencyKey?: unknown;
}, label: string): void;
export interface EvidenceOutboxAttemptIdentity {
    readonly runId: string;
    readonly itemId: string;
    readonly nodeId: string;
    readonly stage: Readonly<{
        id: string;
        version: number;
    }>;
    readonly attempt: number;
    readonly idempotencyKey: string;
}
/**
 * Capture an outbox-hook context once. `output` is deliberately admitted but
 * ignored: evidence selection is identity-only and must never inspect a
 * caller-owned output payload or invoke one of its accessors.
 */
export declare function snapshotEvidenceOutboxContext(value: unknown, label: string): EvidenceOutboxAttemptIdentity;
export declare function deepFrozenClone<T>(value: T, label: string): T;
/**
 * Descriptor-first validation snapshot that preserves invalid leaf values so
 * public validators can retain their precise legacy diagnostics. Plain
 * containers are detached/frozen; accessors, Proxies, symbols, sparse arrays,
 * and cycles are still rejected before application validation reads them.
 */
export declare function snapshotValidationData<T>(value: T, label: string): T;

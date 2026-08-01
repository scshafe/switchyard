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
export declare function deepFrozenClone<T>(value: T, label: string): T;

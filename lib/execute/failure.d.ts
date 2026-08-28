export interface ExecutionFailure {
    readonly code: string;
    readonly retryable: boolean;
}
/** A deliberate failure whose stable code and retry disposition are trusted. */
export declare class ExecutionFailureError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    constructor(code: string, retryable: boolean, cause?: unknown);
}
/** Descriptor-free brand check safe for hostile thrown Proxy values. */
export declare function isExecutionFailureError(value: unknown): value is ExecutionFailureError;
/**
 * Map any thrown value to a stable code plus retry disposition. `retryable:
 * false` is terminal for one v2 unit turn. Legacy item/shard scope is an
 * adapter concern and intentionally absent from this shared contract.
 */
export declare function classifyExecutionFailure(error: unknown): ExecutionFailure;

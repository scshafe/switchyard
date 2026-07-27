export declare function validatePipelineShardReasonCode(value: unknown, label?: string): string;
/** Transient control outcome: release and requeue without failed-attempt evidence. */
export declare class PipelineShardDeferredError extends Error {
    readonly reasonCode: string;
    constructor(reasonCode: string, cause?: unknown);
}
/** Conclusive control outcome: obsolete work is cancelled, never failed. */
export declare class PipelineShardCancelledError extends Error {
    readonly reasonCode: string;
    constructor(reasonCode: string, cause?: unknown);
}
export declare function isPipelineShardControlError(error: unknown): error is PipelineShardDeferredError | PipelineShardCancelledError;

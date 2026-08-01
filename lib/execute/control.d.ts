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
/**
 * Host-neutral control signal for externally fenced execution. The payload is
 * deliberately opaque to Mission Pipeline: a host may validate it as
 * dependencies, a continuation reference, delivery instructions, or another
 * domain-specific parking contract after {@code runBoundShard} returns.
 *
 * The bound runner returns a canonical frozen snapshot and performs no suspension or
 * lease operation. If this bound-only signal escapes after legacy
 * `runOneShard` has claimed a Pipeline-owned shard, the runner conclusively
 * fails that shard with `pipeline_control_outcome_unsupported`; it never
 * abandons the lease until expiry.
 */
export declare class PipelineControlOutcomeError extends Error {
    readonly outcome: unknown;
    constructor(outcome: unknown, cause?: unknown);
}
export declare function isPipelineShardControlError(error: unknown): error is PipelineShardDeferredError | PipelineShardCancelledError | PipelineControlOutcomeError;

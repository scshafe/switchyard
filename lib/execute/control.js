// execute/control.ts — explicit non-failure control outcomes that a host
// adapter may raise while the runner owns a shard claim. This includes a
// NodeInvoker and any claim-scoped PipelineStore method that discovers current
// host authority changed during prepare, persistence, heartbeat, or finalize.
//
// These signals are deliberately distinct from PipelineStageError:
// - DEFER means transient host authority is busy. It releases/requeues the
//   shard without appending a failed stage attempt or burning retry budget.
// - CANCEL means the claimed work is obsolete (for example, source
//   supersession). It conclusively cancels the shard without pretending a
//   stage or lease failed.
//
// A control signal may bypass the outer attempt ONLY when the adapter has not
// produced an unrecorded external side effect or usage charge. Independently
// durable/idempotent inner work is allowed (Inbox DecisionRuntime is the
// motivating case); an at_most_once invoker must never defer after its effect.
//
// executeDurableStage rethrows both BEFORE attempt persistence. runOneShard
// settles its Pipeline-owned lease through PipelineStore.deferShard/
// cancelShard; runBoundShard returns host control data and performs no
// settlement.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).
export function validatePipelineShardReasonCode(value, label = "pipeline shard control") {
    if (typeof value !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
        throw new Error(`${label}: reasonCode must be a 1..200 character identifier`);
    }
    return value;
}
/** Transient control outcome: release and requeue without failed-attempt evidence. */
export class PipelineShardDeferredError extends Error {
    reasonCode;
    constructor(reasonCode, cause) {
        const stable = validatePipelineShardReasonCode(reasonCode, "PipelineShardDeferredError");
        super(stable, cause === undefined ? undefined : { cause });
        this.name = "PipelineShardDeferredError";
        this.reasonCode = stable;
    }
}
/** Conclusive control outcome: obsolete work is cancelled, never failed. */
export class PipelineShardCancelledError extends Error {
    reasonCode;
    constructor(reasonCode, cause) {
        const stable = validatePipelineShardReasonCode(reasonCode, "PipelineShardCancelledError");
        super(stable, cause === undefined ? undefined : { cause });
        this.name = "PipelineShardCancelledError";
        this.reasonCode = stable;
    }
}
/**
 * Host-neutral control signal for externally fenced execution. The payload is
 * deliberately opaque to Mission Pipeline: a host may validate it as
 * dependencies, a continuation reference, delivery instructions, or another
 * domain-specific parking contract after {@code runBoundShard} returns.
 *
 * The bound runner returns the payload verbatim and performs no suspension or
 * lease operation. The legacy `runOneShard` path does not settle this signal.
 */
export class PipelineControlOutcomeError extends Error {
    outcome;
    constructor(outcome, cause) {
        super("Pipeline execution produced a host control outcome", cause === undefined ? undefined : { cause });
        this.name = "PipelineControlOutcomeError";
        this.outcome = outcome;
    }
}
export function isPipelineShardControlError(error) {
    return (error instanceof PipelineShardDeferredError
        || error instanceof PipelineShardCancelledError
        || error instanceof PipelineControlOutcomeError);
}

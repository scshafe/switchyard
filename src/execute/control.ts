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
// executeDurableStage rethrows both BEFORE attempt persistence. runOneShard is
// their sole settlement boundary through PipelineStore.deferShard/cancelShard.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).

export function validatePipelineShardReasonCode(
  value: unknown,
  label = "pipeline shard control"
): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)
  ) {
    throw new Error(
      `${label}: reasonCode must be a 1..200 character identifier`
    );
  }
  return value;
}

/** Transient control outcome: release and requeue without failed-attempt evidence. */
export class PipelineShardDeferredError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, cause?: unknown) {
    const stable = validatePipelineShardReasonCode(
      reasonCode,
      "PipelineShardDeferredError"
    );
    super(
      stable,
      cause === undefined ? undefined : { cause }
    );
    this.name = "PipelineShardDeferredError";
    this.reasonCode = stable;
  }
}

/** Conclusive control outcome: obsolete work is cancelled, never failed. */
export class PipelineShardCancelledError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string, cause?: unknown) {
    const stable = validatePipelineShardReasonCode(
      reasonCode,
      "PipelineShardCancelledError"
    );
    super(
      stable,
      cause === undefined ? undefined : { cause }
    );
    this.name = "PipelineShardCancelledError";
    this.reasonCode = stable;
  }
}

export function isPipelineShardControlError(
  error: unknown
): error is PipelineShardDeferredError | PipelineShardCancelledError {
  return (
    error instanceof PipelineShardDeferredError
    || error instanceof PipelineShardCancelledError
  );
}

// execute/shard-runner.ts — execute ONE shard through a single shared node
// walk. runOneShard owns the legacy Pipeline claim/heartbeat/finalize/release
// lifecycle. runBoundShard accepts host-bound work + an opaque external fence,
// appends only stage evidence, and returns an outcome for host settlement.
// Both execute compiled nodes in array order per item (CompiledPipeline.nodes
// are already topologically ordered) and isolate per-item failures (a terminal
// item skips its downstream nodes while the other items continue).
//
// PROMOTED from inbox-pipeline/src/worker/service.ts runOneShotPipelineWorker
// (the claim-one-shard shape with idle outcome; option validation — attempt
// budget 1..10, heartbeat cadence below the lease duration, the exact
// runId+shardId pairing rule; the artifacts map + pipeline_input/node_output
// slot resolution; the missing-artifact LOUD rejection; the terminal-item
// `break` + `continue` isolation; runWithHeartbeat with single-flight
// heartbeats, deferred heartbeat-error surfacing, and timer.unref; failShard
// swallowing a lost lease; completed/partial finalization outcomes) — re-cut
// over the PipelineStore port + the B3 durable executor, which now owns the
// prepare/persist/retry/dead-letter cycle that service.ts inlined.
// CHANGES in the promotion:
//   - NodeInvoker PORT for the non-code kinds (model/agent/gate): B3 defines
//     the port and ships a fake; B4 (model bindings + receipts), B5 (gate
//     decision flows), and B6 (agent steps) implement it. Dispatch is on
//     compiled node kind; catalog.resolveExecutable remains the LOUD
//     parity lookup for EVERY kind before dispatch;
//   - heartbeatEveryMs floor lowered from the inbox 5000ms to 1ms so hermetic
//     tests can observe heartbeats; production hosts configure their own
//     floors (the everyMs < leaseDurationMs relationship is kept);
//   - the inbox email-specific admissions (provider registration, hydration
//     readiness, claim-topology snapshot checks) stay HOST concerns — the
//     engine-level equivalents are the sealed-compiled-pipeline revalidation
//     (validateCompiledPipeline on the claim) and the compile-time checks.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).

import { validateCompiledPipeline, type CompiledPipelineNode } from "../compile.js";
import type { StageCatalog } from "../catalog.js";
import { digest } from "../contracts/digest.js";
import type { StageContext } from "../node.js";
import {
  ExternalFenceRejectedError,
  ShardLeaseLostError,
  type BoundPipelineEvidenceStore,
  type BoundPipelineShard,
  type OutboxEventInput,
  type PipelineStore,
  type ShardClaim,
  type ShardClaimItem
} from "../store.js";
import {
  classifyStageFailure,
  executeBoundDurableStage,
  executeDurableStage,
  type DurableStageResult,
  type ResolvedSlotValue,
  type StageFailureOutboxContext
} from "./durable-stage.js";
import {
  PipelineControlOutcomeError,
  PipelineShardCancelledError,
  PipelineShardDeferredError
} from "./control.js";

// ── NodeInvoker: the non-code execution port (B4/B5/B6 implement it) ──────

export interface NodeInvocation {
  runId: string;
  itemId: string;
  node: CompiledPipelineNode;
  /** The composed, contract-validated stage input. */
  input: unknown;
  attempt: number;
  signal?: AbortSignal;
}

/**
 * The injected executor for non-code node kinds. The durable executor still
 * owns idempotency, retries, dead letters, and contract validation around
 * every call — an invoker only performs ONE attempt and returns the raw
 * output (B4: model binding resolution + usage receipts; B5: gate decision
 * flows; B6: agent steps). A control outcome may bypass that outer attempt
 * only before any unrecorded side effect/usage; independently durable and
 * idempotent inner work is safe, but at_most_once effects are not replayable.
 */
export interface NodeInvoker {
  invoke(invocation: NodeInvocation): Promise<unknown>;
}

/**
 * The B3 FAKE invoker: identity by default (echoes the composed input — the
 * B2 "identity-only executables for non-code kinds" behavior), overridable
 * per stageId for tests. B4/B5/B6 replace it with real implementations.
 */
export function createFakeNodeInvoker(
  handlers: Record<string, (invocation: NodeInvocation) => unknown | Promise<unknown>> = {}
): NodeInvoker {
  return {
    async invoke(invocation: NodeInvocation): Promise<unknown> {
      const handler = handlers[invocation.node.stage.id];
      return handler === undefined ? invocation.input : handler(invocation);
    }
  };
}

// ── Heartbeats (promoted runWithHeartbeat) ────────────────────────────────

/**
 * Run `operation` while heartbeating the shard lease every `everyMs`:
 * single-flight (a slow heartbeat is never overlapped), failures captured and
 * surfaced AFTER the operation (a lost lease fences the result even when the
 * work itself succeeded), timer unref'd so it never holds the process open.
 */
export async function runWithShardHeartbeat<T>(input: {
  store: PipelineStore;
  shardId: string;
  leaseToken: string;
  everyMs: number;
  extendByMs: number;
  now: () => Date;
  operation: () => Promise<T>;
}): Promise<T> {
  let heartbeatError: unknown;
  let heartbeatInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeatInFlight || heartbeatError !== undefined) return;
    heartbeatInFlight = input.store
      .heartbeatShard({
        shardId: input.shardId,
        leaseToken: input.leaseToken,
        extendByMs: input.extendByMs,
        at: input.now().toISOString()
      })
      .catch((error: unknown) => {
        heartbeatError = error;
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, input.everyMs);
  timer.unref();
  let operationOutcome!:
    | { ok: true; value: T }
    | { ok: false; error: unknown };
  try {
    operationOutcome = {
      ok: true,
      value: await input.operation()
    };
  } catch (error) {
    operationOutcome = { ok: false, error };
  } finally {
    clearInterval(timer);
    // Snapshot then join the last single-flight heartbeat. Its catch handler
    // records the authoritative lease/control error and resolves this promise.
    const finalHeartbeat = heartbeatInFlight;
    if (finalHeartbeat) await finalHeartbeat;
  }
  // Heartbeat authority wins even when the operation also rejected. Otherwise
  // a concurrent supersession/cancel could be misreported as defer/failure.
  if (heartbeatError !== undefined) throw heartbeatError;
  if (!operationOutcome.ok) throw operationOutcome.error;
  return operationOutcome.value;
}

// ── The one-shot shard runner ─────────────────────────────────────────────

export interface ShardRunnerOptions {
  store: PipelineStore;
  catalog: StageCatalog;
  /** REQUIRED when the claimed pipeline contains any non-code node. */
  invoker?: NodeInvoker;
  leaseOwner: string;
  /** Default 1_200_000 (promoted). */
  leaseDurationMs?: number;
  /** Default max(10_000, leaseDurationMs/3); must be < leaseDurationMs. */
  heartbeatEveryMs?: number;
  /** Retry budget per node, 1..10, default 2. at_most_once nodes never retry. */
  maxAttempts?: number;
  /** Per-nodeId overrides of the retry budget. */
  maxAttemptsByNode?: Record<string, number>;
  /** Exact-claim narrowing (both or neither — promoted pairing rule). */
  runId?: string;
  shardId?: string;
  /**
   * Host hook: outbox events to append ATOMICALLY with a node's fresh success
   * (the transactional outbox — e.g. inbox's proposal externalization).
   */
  outboxEventsFor?: (context: {
    runId: string;
    node: CompiledPipelineNode;
    itemId: string;
    output: unknown;
    attempt: number;
  }) => readonly OutboxEventInput[];
  /**
   * Host hook: outbox events to append ATOMICALLY with a node's failed
   * attempt. Provider/model/agent usage receipts belong here; success-only
   * business events (for example a human-escalation projection) do not.
   */
  failureOutboxEventsFor?: (context: StageFailureOutboxContext) => readonly OutboxEventInput[];
  signal?: AbortSignal;
  /** Injectable clock (drives claim/heartbeat/finalize timestamps). */
  now?: () => Date;
}

export type ShardRunOutcome =
  | { status: "idle" }
  | {
      status: "completed";
      runId: string;
      shardId: string;
      itemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "partial";
      runId: string;
      shardId: string;
      itemCount: number;
      completedItemCount: number;
      terminalItemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | { status: "deferred"; runId: string; shardId: string; reasonCode: string }
  | { status: "cancelled"; runId: string; shardId: string; reasonCode: string }
  | { status: "failed"; runId: string; shardId: string; retryable: boolean; errorCode: string };

/**
 * Runner options for work whose lease/fence is owned by the host.
 *
 * Ownership options from {@link ShardRunnerOptions} are structurally absent:
 * no lease owner, duration, heartbeat cadence, or exact-claim selector can be
 * supplied. `fence` is passed through by identity to `evidenceStore`.
 */
export type BoundShardRunnerOptions<TFence> = Omit<
  ShardRunnerOptions,
  | "store"
  | "leaseOwner"
  | "leaseDurationMs"
  | "heartbeatEveryMs"
  | "runId"
  | "shardId"
  | "now"
> & {
  shard: BoundPipelineShard;
  evidenceStore: BoundPipelineEvidenceStore<TFence>;
  fence: TFence;
  /** Injectable clock for append evidence timestamps. */
  now?: () => Date;
};

/**
 * Host settlement instruction returned by {@link runBoundShard}. No arm
 * mutates or releases the external fence.
 */
export type BoundShardRunOutcome =
  | {
      status: "completed";
      runId: string;
      shardId: string;
      itemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "partial";
      runId: string;
      shardId: string;
      itemCount: number;
      completedItemCount: number;
      terminalItemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "control";
      runId: string;
      shardId: string;
      /** Opaque payload returned verbatim for host validation and settlement. */
      control: unknown;
    }
  | {
      status: "failed";
      runId: string;
      shardId: string;
      retryable: boolean;
      errorCode: string;
    };

interface ShardExecutionMetrics {
  itemCount: number;
  completedItemCount: number;
  terminalItemCount: number;
  stageExecutionCount: number;
  reusedStageCount: number;
}

interface ExecuteShardNodesInput {
  shard: BoundPipelineShard;
  catalog: StageCatalog;
  invoker?: NodeInvoker;
  executeStage(input: {
    item: ShardClaimItem;
    node: CompiledPipelineNode;
    slots: readonly ResolvedSlotValue[];
    invoke: (input: unknown, ctx: StageContext) => Promise<unknown>;
  }): Promise<DurableStageResult>;
}

/**
 * The single node-walk implementation shared by Pipeline-owned and
 * externally fenced runners. It contains no lease lifecycle operations.
 */
async function executeShardNodes(
  input: ExecuteShardNodesInput
): Promise<ShardExecutionMetrics> {
  const { shard } = input;
  const compiled = validateCompiledPipeline(shard.compiled);
  if (
    typeof shard.runId !== "string"
    || shard.runId.length === 0
    || typeof shard.shardId !== "string"
    || shard.shardId.length === 0
  ) {
    throw new Error(
      "Bound pipeline shard immutable configuration requires non-empty runId and shardId"
    );
  }
  if (shard.items.length === 0) {
    throw new Error(
      "Bound pipeline shard immutable configuration must contain at least one item"
    );
  }
  const itemIds = new Set<string>();
  const ordinals = new Set<number>();
  let lastOrdinal = 0;
  for (const item of shard.items) {
    if (
      typeof item.itemId !== "string"
      || item.itemId.length === 0
      || itemIds.has(item.itemId)
    ) {
      throw new Error(
        "Bound pipeline shard immutable configuration requires non-empty, unique itemId values"
      );
    }
    if (
      !Number.isInteger(item.ordinal)
      || item.ordinal < 1
      || ordinals.has(item.ordinal)
      || item.ordinal <= lastOrdinal
    ) {
      throw new Error(
        "Bound pipeline shard immutable configuration requires positive, unique, ascending ordinals"
      );
    }
    let actualInputDigest: string;
    try {
      actualInputDigest = digest(item.input);
    } catch (error) {
      throw new Error(
        `Bound pipeline shard item ${item.itemId} input is not digestable immutable configuration`,
        { cause: error }
      );
    }
    if (actualInputDigest !== item.inputDigest) {
      throw new Error(
        `Bound pipeline shard item ${item.itemId} inputDigest does not match its input`
      );
    }
    itemIds.add(item.itemId);
    ordinals.add(item.ordinal);
    lastOrdinal = item.ordinal;
  }

  let stageExecutionCount = 0;
  let reusedStageCount = 0;
  let terminalItemCount = 0;

  for (const item of shard.items) {
    const artifacts = new Map<string, unknown>();
    for (const node of compiled.nodes) {
      const slots: ResolvedSlotValue[] = node.inputs.map((nodeInput) => ({
        slot: nodeInput.slot,
        contract: nodeInput.contract,
        value:
          nodeInput.source.kind === "pipeline_input"
            ? item.input
            : artifacts.get(nodeInput.source.nodeId)
      }));
      if (slots.some(({ value }) => value === undefined)) {
        throw new Error(
          `Pipeline node ${node.nodeId} resolved an undefined input artifact — compiled topology violated`
        );
      }

      const executable = input.catalog.resolveExecutable(
        node.stage.id,
        node.stage.version
      );
      let invoke: (value: unknown, ctx: StageContext) => Promise<unknown>;
      if (node.kind === "code") {
        const run = executable.run;
        if (typeof run !== "function") {
          throw new Error(
            `Stage ${node.stage.id}@${node.stage.version} is kind "code" but its executable has no run() function`
          );
        }
        invoke = (value, ctx) => run.call(executable, value, ctx);
      } else {
        const invoker = input.invoker;
        if (!invoker) {
          throw new Error(
            `No NodeInvoker is configured for non-code pipeline node ${node.nodeId} (kind "${node.kind}")`
          );
        }
        invoke = (value, ctx) =>
          invoker.invoke({
            runId: shard.runId,
            itemId: item.itemId,
            node,
            input: value,
            attempt: ctx.attempt ?? 1,
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal })
          });
      }

      const result = await input.executeStage({ item, node, slots, invoke });
      stageExecutionCount += 1;
      if (result.status === "terminal") {
        terminalItemCount += 1;
        break;
      }
      if (result.reused) reusedStageCount += 1;
      artifacts.set(node.nodeId, result.output);
    }
  }

  return {
    itemCount: shard.items.length,
    completedItemCount: shard.items.length - terminalItemCount,
    terminalItemCount,
    stageExecutionCount,
    reusedStageCount
  };
}

async function settleShardControl(
  error: unknown,
  claim: ShardClaim,
  store: PipelineStore,
  now: () => Date
): Promise<ShardRunOutcome | undefined> {
  if (error instanceof PipelineShardDeferredError) {
    // A control outcome is true only after its fenced durable settlement.
    // Lost fences therefore propagate instead of manufacturing audit truth.
    await store.deferShard({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      reasonCode: error.reasonCode,
      at: now().toISOString()
    });
    return {
      status: "deferred",
      runId: claim.runId,
      shardId: claim.shardId,
      reasonCode: error.reasonCode
    };
  }
  if (error instanceof PipelineShardCancelledError) {
    await store.cancelShard({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      reasonCode: error.reasonCode,
      at: now().toISOString()
    });
    return {
      status: "cancelled",
      runId: claim.runId,
      shardId: claim.shardId,
      reasonCode: error.reasonCode
    };
  }
  return undefined;
}

/**
 * Claim and process AT MOST ONE shard (idle when nothing is claimable).
 * Per-item failure isolation: a terminal item breaks out of ITS node loop
 * (downstream nodes skipped) while the other items continue; only shard-scoped
 * failures (lease lost, immutable configuration/contract rejections) abort the
 * whole shard via failShard. Finalization is derived from persisted evidence
 * by completeShard once every member is resolved.
 */
export async function runOneShard(options: ShardRunnerOptions): Promise<ShardRunOutcome> {
  const leaseDurationMs = options.leaseDurationMs ?? 1_200_000;
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error("runOneShard: leaseDurationMs must be a positive integer");
  }
  const heartbeatEveryMs = options.heartbeatEveryMs ?? Math.max(10_000, Math.floor(leaseDurationMs / 3));
  if (!Number.isInteger(heartbeatEveryMs) || heartbeatEveryMs < 1 || heartbeatEveryMs >= leaseDurationMs) {
    throw new Error("runOneShard: heartbeatEveryMs must be a positive integer less than leaseDurationMs");
  }
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("runOneShard: maxAttempts must be an integer from 1 through 10");
  }
  if ((options.runId === undefined) !== (options.shardId === undefined)) {
    throw new Error("runOneShard: an exact shard run requires both runId and shardId");
  }
  const now = options.now ?? (() => new Date());

  const claim = await options.store.claimNextShard({
    leaseOwner: options.leaseOwner,
    leaseDurationMs,
    ...(options.runId === undefined ? {} : { runId: options.runId, shardId: options.shardId! }),
    at: now().toISOString()
  });
  if (!claim) return { status: "idle" };

  try {
    return await processClaim(claim, { ...options, leaseDurationMs, heartbeatEveryMs, maxAttempts, now });
  } catch (error) {
    // This signal exists exclusively for the external-fence runner. Legacy
    // ownership must not reinterpret it as a failed shard and release a lease.
    if (error instanceof PipelineControlOutcomeError) throw error;
    const controlOutcome = await settleShardControl(
      error,
      claim,
      options.store,
      now
    );
    if (controlOutcome) return controlOutcome;
    const failure = classifyStageFailure(error);
    try {
      await options.store.failShard({
        shardId: claim.shardId,
        leaseToken: claim.leaseToken,
        retryable: failure.retryable,
        errorCode: failure.code,
        at: now().toISOString()
      });
    } catch (finishError) {
      // Promoted: a lost lease during failure finalization is swallowed —
      // the new claimant owns the shard now.
      if (!(finishError instanceof ShardLeaseLostError)) {
        // A host may discover authoritative defer/cancel state only while
        // revalidating inside failShard's settlement transaction. Route that
        // late control through the same fenced settlement instead of appending
        // or reporting a false shard failure.
        const lateControlOutcome = await settleShardControl(
          finishError,
          claim,
          options.store,
          now
        );
        if (lateControlOutcome) return lateControlOutcome;
        throw finishError;
      }
    }
    return { status: "failed", runId: claim.runId, shardId: claim.shardId, retryable: failure.retryable, errorCode: failure.code };
  }
}

/**
 * Execute an already-bound shard under a host-owned fence.
 *
 * The runner performs only digest/contract validation, durable stage evidence,
 * invocation, retry routing, and deterministic node traversal. It cannot
 * claim, heartbeat, defer, cancel, complete, fail, or release host work
 * because those operations do not exist on {@link BoundPipelineEvidenceStore}.
 * The host validates the returned outcome and performs its one authoritative
 * settlement transaction.
 */
export async function runBoundShard<TFence>(
  options: BoundShardRunnerOptions<TFence>
): Promise<BoundShardRunOutcome> {
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error(
      "runBoundShard: maxAttempts must be an integer from 1 through 10"
    );
  }
  const now = options.now ?? (() => new Date());

  try {
    const metrics = await executeShardNodes({
      shard: options.shard,
      catalog: options.catalog,
      ...(options.invoker === undefined ? {} : { invoker: options.invoker }),
      executeStage: ({ item, node, slots, invoke }) =>
        executeBoundDurableStage({
          evidenceStore: options.evidenceStore,
          fence: options.fence,
          contracts: options.catalog.contracts,
          runId: options.shard.runId,
          itemId: item.itemId,
          node,
          slots,
          invoke,
          maxAttempts:
            options.maxAttemptsByNode?.[node.nodeId] ?? maxAttempts,
          ...(options.outboxEventsFor === undefined
            ? {}
            : {
                outboxEvents: (output, { runId, attempt }) =>
                  options.outboxEventsFor!({
                    runId,
                    node,
                    itemId: item.itemId,
                    output,
                    attempt
                  })
              }),
          ...(options.failureOutboxEventsFor === undefined
            ? {}
            : {
                failureOutboxEvents: options.failureOutboxEventsFor
              }),
          ...(options.signal === undefined
            ? {}
            : { signal: options.signal }),
          now
        })
    });

    if (metrics.terminalItemCount > 0) {
      return {
        status: "partial",
        runId: options.shard.runId,
        shardId: options.shard.shardId,
        itemCount: metrics.itemCount,
        completedItemCount: metrics.completedItemCount,
        terminalItemCount: metrics.terminalItemCount,
        stageExecutionCount: metrics.stageExecutionCount,
        reusedStageCount: metrics.reusedStageCount
      };
    }
    return {
      status: "completed",
      runId: options.shard.runId,
      shardId: options.shard.shardId,
      itemCount: metrics.itemCount,
      stageExecutionCount: metrics.stageExecutionCount,
      reusedStageCount: metrics.reusedStageCount
    };
  } catch (error) {
    // External authority failures are not stage outcomes. The host needs the
    // original typed rejection to decide whether its task was fenced/reclaimed.
    if (error instanceof ExternalFenceRejectedError) throw error;
    if (error instanceof PipelineControlOutcomeError) {
      return {
        status: "control",
        runId: options.shard.runId,
        shardId: options.shard.shardId,
        control: error.outcome
      };
    }
    if (error instanceof PipelineShardDeferredError) {
      return {
        status: "control",
        runId: options.shard.runId,
        shardId: options.shard.shardId,
        control: {
          kind: "deferred",
          reasonCode: error.reasonCode
        }
      };
    }
    if (error instanceof PipelineShardCancelledError) {
      return {
        status: "control",
        runId: options.shard.runId,
        shardId: options.shard.shardId,
        control: {
          kind: "cancelled",
          reasonCode: error.reasonCode
        }
      };
    }
    const failure = classifyStageFailure(error);
    return {
      status: "failed",
      runId: options.shard.runId,
      shardId: options.shard.shardId,
      retryable: failure.retryable,
      errorCode: failure.code
    };
  }
}

/**
 * Descriptive alias for hosts that call the pre-bound input an externally
 * claimed shard. This is the same implementation, not a second lifecycle.
 */
export const executeClaimedShard: typeof runBoundShard = runBoundShard;

async function processClaim(
  claim: ShardClaim,
  options: ShardRunnerOptions & { leaseDurationMs: number; heartbeatEveryMs: number; maxAttempts: number; now: () => Date }
): Promise<ShardRunOutcome> {
  const metrics = await executeShardNodes({
    shard: claim,
    catalog: options.catalog,
    ...(options.invoker === undefined ? {} : { invoker: options.invoker }),
    executeStage: ({ item, node, slots, invoke }) =>
      runWithShardHeartbeat({
        store: options.store,
        shardId: claim.shardId,
        leaseToken: claim.leaseToken,
        everyMs: options.heartbeatEveryMs,
        extendByMs: options.leaseDurationMs,
        now: options.now,
        operation: () =>
          executeDurableStage({
            store: options.store,
            contracts: options.catalog.contracts,
            shardId: claim.shardId,
            leaseToken: claim.leaseToken,
            runId: claim.runId,
            itemId: item.itemId,
            node,
            slots,
            invoke,
            maxAttempts:
              options.maxAttemptsByNode?.[node.nodeId] ?? options.maxAttempts,
            ...(options.outboxEventsFor === undefined
              ? {}
              : {
                  outboxEvents: (output, { runId, attempt }) =>
                    options.outboxEventsFor!({
                      runId,
                      node,
                      itemId: item.itemId,
                      output,
                      attempt
                    })
                }),
            ...(options.failureOutboxEventsFor === undefined
              ? {}
              : {
                  failureOutboxEvents: options.failureOutboxEventsFor
                }),
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
            now: options.now
          })
      })
  });

  const finalization = await options.store.completeShard({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    at: options.now().toISOString()
  });
  if (finalization.status === "partial") {
    return {
      status: "partial",
      runId: claim.runId,
      shardId: claim.shardId,
      itemCount: finalization.itemCount,
      completedItemCount: finalization.completedItemCount,
      terminalItemCount: finalization.terminalItemCount,
      stageExecutionCount: metrics.stageExecutionCount,
      reusedStageCount: metrics.reusedStageCount
    };
  }
  return {
    status: "completed",
    runId: claim.runId,
    shardId: claim.shardId,
    itemCount: finalization.itemCount,
    stageExecutionCount: metrics.stageExecutionCount,
    reusedStageCount: metrics.reusedStageCount
  };
}

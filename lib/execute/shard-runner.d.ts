import { type CompiledPipelineNode } from "../compile.js";
import { StageCatalog } from "../catalog.js";
import { type BoundPipelineEvidenceStore, type BoundPipelineExecutionIdentity, type BoundPipelineShard, type OutboxEvents, type PipelineStore } from "../store.js";
import { type StageFailureOutboxContext } from "./durable-stage.js";
export interface NodeInvocation {
    runId: string;
    itemId: string;
    node: CompiledPipelineNode;
    /** The composed, contract-validated stage input. */
    input: unknown;
    attempt: number;
    /** Stable across retries and external-fence takeovers. */
    idempotencyKey: string;
    signal?: AbortSignal;
}
/**
 * The injected executor for non-code node kinds. The durable executor still
 * owns idempotency, retries, dead letters, and contract validation around
 * every call — an invoker only performs ONE attempt and returns the raw
 * output (B4: model binding resolution + usage receipts; B5: gate decision
 * flows; B6: agent steps). A control outcome may bypass that outer attempt
 * only before any unrecorded side effect/usage; independently durable and
 * idempotent inner work is safe. v0.2 rejects at_most_once before invocation;
 * honest support requires durable intent plus indeterminate reconciliation.
 */
export interface NodeInvoker {
    invoke(invocation: NodeInvocation): Promise<unknown>;
}
/**
 * The B3 FAKE invoker: identity by default (echoes the composed input — the
 * B2 "identity-only executables for non-code kinds" behavior), overridable
 * per stageId for tests. B4/B5/B6 replace it with real implementations.
 */
export declare function createFakeNodeInvoker(handlers?: Record<string, (invocation: NodeInvocation) => unknown | Promise<unknown>>): NodeInvoker;
/**
 * Run `operation` while heartbeating the shard lease every `everyMs`:
 * single-flight (a slow heartbeat is never overlapped), failures captured and
 * surfaced AFTER the operation (a lost lease fences the result even when the
 * work itself succeeded), timer unref'd so it never holds the process open.
 */
export declare function runWithShardHeartbeat<T>(input: {
    store: PipelineStore;
    shardId: string;
    leaseToken: string;
    everyMs: number;
    extendByMs: number;
    now: () => Date;
    operation: () => Promise<T>;
}): Promise<T>;
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
    /** Retry budget per node, 1..10, default 2. */
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
        idempotencyKey: string;
    }) => OutboxEvents;
    /**
     * Host hook: outbox events to append ATOMICALLY with a node's failed
     * attempt. Provider/model/agent usage receipts belong here; success-only
     * business events (for example a human-escalation projection) do not.
     */
    failureOutboxEventsFor?: (context: StageFailureOutboxContext) => OutboxEvents;
    signal?: AbortSignal;
    /** Injectable clock (drives claim/heartbeat/finalize timestamps). */
    now?: () => Date;
}
export type ShardRunOutcome = {
    status: "idle";
} | {
    status: "completed";
    runId: string;
    shardId: string;
    itemCount: number;
    stageExecutionCount: number;
    reusedStageCount: number;
} | {
    status: "partial";
    runId: string;
    shardId: string;
    itemCount: number;
    completedItemCount: number;
    terminalItemCount: number;
    stageExecutionCount: number;
    reusedStageCount: number;
} | {
    status: "deferred";
    runId: string;
    shardId: string;
    reasonCode: string;
} | {
    status: "cancelled";
    runId: string;
    shardId: string;
    reasonCode: string;
} | {
    status: "failed";
    runId: string;
    shardId: string;
    retryable: boolean;
    errorCode: string;
};
/**
 * Runner options for work whose lease/fence is owned by the host.
 *
 * Ownership options from {@link ShardRunnerOptions} are structurally absent:
 * no lease owner, duration, heartbeat cadence, or exact-claim selector can be
 * supplied. `fence` is passed through by identity to `evidenceStore`.
 */
export type BoundShardRunnerOptions<TFence> = Omit<ShardRunnerOptions, "store" | "leaseOwner" | "leaseDurationMs" | "heartbeatEveryMs" | "runId" | "shardId" | "now"> & {
    shard: BoundPipelineShard;
    evidenceStore: BoundPipelineEvidenceStore<TFence>;
    fence: TFence;
    /** Digest-sealed immutable run/shard/definition/item/host-action identity. */
    executionIdentity: BoundPipelineExecutionIdentity;
    /** Injectable clock for append evidence timestamps. */
    now?: () => Date;
};
/**
 * Host settlement instruction returned by {@link runBoundShard}. No arm
 * mutates or releases the external fence.
 */
export type BoundShardRunOutcome = {
    status: "completed";
    runId: string;
    shardId: string;
    itemCount: number;
    stageExecutionCount: number;
    reusedStageCount: number;
} | {
    status: "partial";
    runId: string;
    shardId: string;
    itemCount: number;
    completedItemCount: number;
    terminalItemCount: number;
    stageExecutionCount: number;
    reusedStageCount: number;
} | {
    status: "control";
    runId: string;
    shardId: string;
    /** Opaque payload returned verbatim for host validation and settlement. */
    control: unknown;
} | {
    status: "failed";
    runId: string;
    shardId: string;
    retryable: boolean;
    errorCode: string;
};
/**
 * Seal the immutable identity a host action must present with every bound
 * evidence append. Fence generations may change during takeover; this value
 * must not.
 */
export declare function createBoundPipelineExecutionIdentity(input: {
    hostActionId: string;
    shard: BoundPipelineShard;
}): BoundPipelineExecutionIdentity;
/** Validate the seal and its exact correspondence to the supplied shard. */
export declare function validateBoundPipelineExecutionIdentity(value: unknown, shard: BoundPipelineShard): BoundPipelineExecutionIdentity;
/**
 * Claim and process AT MOST ONE shard (idle when nothing is claimable).
 * Per-item failure isolation: a terminal item breaks out of ITS node loop
 * (downstream nodes skipped) while the other items continue; only shard-scoped
 * failures (lease lost, immutable configuration/contract rejections) abort the
 * whole shard via failShard. Finalization is derived from persisted evidence
 * by completeShard once every member is resolved.
 */
export declare function runOneShard(options: ShardRunnerOptions): Promise<ShardRunOutcome>;
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
export declare function runBoundShard<TFence>(options: BoundShardRunnerOptions<TFence>): Promise<BoundShardRunOutcome>;
/**
 * Descriptive alias for hosts that call the pre-bound input an externally
 * claimed shard. This is the same implementation, not a second lifecycle.
 */
export declare const executeClaimedShard: typeof runBoundShard;

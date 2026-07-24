import { type CompiledPipelineNode } from "../compile.js";
import type { StageCatalog } from "../catalog.js";
import { type OutboxEventInput, type PipelineStore } from "../store.js";
import { type StageFailureOutboxContext } from "./durable-stage.js";
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
 * flows; B6: agent steps).
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
    status: "failed";
    runId: string;
    shardId: string;
    retryable: boolean;
    errorCode: string;
};
/**
 * Claim and process AT MOST ONE shard (idle when nothing is claimable).
 * Per-item failure isolation: a terminal item breaks out of ITS node loop
 * (downstream nodes skipped) while the other items continue; only shard-scoped
 * failures (lease lost, immutable configuration/contract rejections) abort the
 * whole shard via failShard. Finalization is derived from persisted evidence
 * by completeShard once every member is resolved.
 */
export declare function runOneShard(options: ShardRunnerOptions): Promise<ShardRunOutcome>;

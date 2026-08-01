import type { CompiledPipelineNode } from "../compile.js";
import type { ContractValidator } from "../catalog.js";
import type { NodeInvoker } from "../execute/shard-runner.js";
import type { RetrySafeOutboxEvents } from "../store.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import { type AgentStepRequest, type AgentStepResult, type AgentStepBudget } from "./step.js";
/**
 * The EAL implements this (A5: an adapter over a TurnExecutor). One call runs
 * one agent turn. `signal` fires when the invoker's deadline elapses — an
 * executor SHOULD abort and return status "timed_out", but the invoker also
 * races the deadline itself so a non-cooperative executor still surfaces as
 * timed_out.
 */
export interface AgentStepExecutor {
    execute(request: AgentStepRequest, signal?: AbortSignal): Promise<AgentStepResult>;
}
/**
 * The host-registered brief material for one agent stage. Agent nodes carry no
 * binding ref (kind:"agent" ⇒ bindingFingerprint "none"), so specs are keyed by
 * stage identity — a CLOSED catalog the host publishes (an unknown agent stage
 * is LOUD, never a silent default). `environment` is the descriptor the step
 * requires (an environment-descriptor.v1 value, carried not interpreted).
 */
export interface AgentStepSpec {
    stage: {
        id: string;
        version: number;
    };
    instructions: string;
    environment: Record<string, unknown>;
    deadlineMs: number;
    budget?: AgentStepBudget;
    /** Contract the composed input is sealed under for the request's inputArtifacts.
     *  Defaults to the node's primary input slot contract; required when the node
     *  has no input slots and this spec still wants an input artifact. */
    inputContract?: string;
}
export declare const AGENT_USAGE_RECEIPT_EVENT_TYPE = "agent_usage_receipt";
export declare const AGENT_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "agent-usage-receipt-event.v1";
export interface AgentUsageReceiptRecord {
    runId: string;
    itemId: string;
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    attempt: number;
    idempotencyKey: string;
    /** Exact provider-attempt key carried by AgentStepRequest. */
    providerIdempotencyKey: string;
    /** The 0-based index of this receipt within the step's usage array. */
    receiptIndex: number;
    receipt: UsageReceipt;
}
export interface AgentReceiptOutboxContext {
    runId: string;
    node: CompiledPipelineNode;
    itemId: string;
    /** Retained for source compatibility with the original success-only hook. */
    output?: unknown;
    attempt: number;
    /** Stable durable-stage action namespace. */
    idempotencyKey: string;
}
export interface AgentReceiptLedger {
    readonly records: readonly AgentUsageReceiptRecord[];
    onReceipt(record: AgentUsageReceiptRecord): void;
    outboxEventsFor(context: AgentReceiptOutboxContext): RetrySafeOutboxEvents;
    failureOutboxEventsFor(context: AgentReceiptOutboxContext): RetrySafeOutboxEvents;
}
/**
 * The receipt→outbox bridge (identical shape to the B4 model ledger):
 * receipts ride the SAME atomic append as their attempt's success or failure.
 */
export declare function createAgentReceiptLedger(): AgentReceiptLedger;
export interface AgentNodeInvokerOptions {
    executor: AgentStepExecutor;
    /** The published agent-stage specs (closed catalog). */
    specs: readonly AgentStepSpec[];
    /** The catalog ContractValidator — every spec's environment io/output contract
     *  referenced by a node must be known (fail closed at construction is deferred
     *  to the durable executor's output validation; this port keeps a handle for
     *  parity with the model/gate arms). */
    catalogContracts: ContractValidator;
    onReceipt?: (record: AgentUsageReceiptRecord) => void;
    /** Non-agent node kinds delegate here (chain with the model/gate arms). */
    fallback?: NodeInvoker;
    /** Injectable clock + timer for deadline racing (tests). Defaults to real. */
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => {
        cancel: () => void;
    };
}
/** Build the kind:"agent" NodeInvoker arm. */
export declare function createAgentNodeInvoker(options: AgentNodeInvokerOptions): NodeInvoker;

import { type UsageReceipt } from "../contracts/usage-receipt.js";
import type { ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import { type OutboxEventInput, type PipelineStore } from "../store.js";
import type { NodeInvoker } from "../execute/shard-runner.js";
import { type CompiledPrompt } from "../prompt/compiler.js";
import { type ModelStageBinding } from "./binding.js";
/** What the resolved invoker receives for ONE physical model call. */
export interface ModelInvocationRequest {
    runId: string;
    itemId: string;
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    attempt: number;
    /** The composed, contract-validated stage input. */
    input: unknown;
    /** The sealed binding this invoker was resolved from (identity convenience). */
    binding: ModelStageBinding;
}
/** One completed call: the raw model output + its MANDATORY usage receipt. */
export interface ModelInvocationResult {
    output: unknown;
    usage: UsageReceipt;
}
/**
 * A resolver-produced invoker for ONE sealed binding. When the binding carries
 * a `promptStackRef`, the resolver MUST surface the compiled prompt it will
 * use — createModelNodeInvoker verifies the compiled prompt's identity against
 * the binding (the promoted prompt-identity check).
 */
export interface ResolvedModelBinding {
    invoke(request: ModelInvocationRequest, signal?: AbortSignal): Promise<ModelInvocationResult>;
    compiledPrompt?: CompiledPrompt;
}
/**
 * The injected model-execution port (hosts bind their provider adapters here;
 * inbox's openai-compatible adapter is the reference implementation). The
 * binding a resolver receives is ALREADY validated (digest-sealed, recorded
 * parameters fail-closed) and matches the node's bindingFingerprint exactly.
 */
export interface ModelBindingResolver {
    resolve(binding: ModelStageBinding): ResolvedModelBinding | Promise<ResolvedModelBinding>;
}
/** One validated receipt, attributed to its exact attempt. */
export interface ModelUsageReceiptRecord {
    runId: string;
    itemId: string;
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    attempt: number;
    bindingDigest: string;
    receipt: UsageReceipt;
}
export declare const MODEL_USAGE_RECEIPT_EVENT_TYPE = "model_usage_receipt";
export declare const MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "model-usage-receipt-event.v1";
export interface ModelReceiptLedger {
    /** Every validated receipt observed, in order (failed-output attempts included). */
    readonly records: readonly ModelUsageReceiptRecord[];
    /** Wire as createModelNodeInvoker's onReceipt. */
    onReceipt(record: ModelUsageReceiptRecord): void;
    /**
     * Wire as ShardRunnerOptions.outboxEventsFor: drains this (itemId, nodeId)'s
     * pending receipts into outbox events that ride ATOMICALLY with the node's
     * fresh persistStageSuccess append.
     */
    outboxEventsFor(context: {
        node: CompiledPipelineNode;
        itemId: string;
        output: unknown;
    }): OutboxEventInput[];
}
/**
 * The receipt→outbox bridge: receipts recorded during an attempt ride the
 * SAME atomic append as the stage success. Receipts whose attempt never
 * reaches persistStageSuccess (e.g. the output later fails its contract) stay
 * in `records` for host-side persistence.
 */
export declare function createModelReceiptLedger(): ModelReceiptLedger;
/** Optional inference-concurrency fencing over the store's auxiliary leases. */
export interface ModelConcurrencyOptions {
    store: Pick<PipelineStore, "acquireLease" | "releaseLease">;
    leaseOwner: string;
    /** Parallel slots per inference profile; default = the profile's recorded maxConcurrency. */
    slots?: number;
    /** Lease TTL; MUST exceed the profile's timeoutMs. Default timeoutMs + 60_000. */
    leaseDurationMs?: number;
    /** How long to wait for a free slot before the retryable capacity failure. Default 0 (single sweep). */
    acquireTimeoutMs?: number;
    /** Poll cadence while waiting. Default 25ms. */
    pollMs?: number;
    now?: () => Date;
}
export interface ModelNodeInvokerOptions {
    resolver: ModelBindingResolver;
    /** The published sealed bindings this invoker may execute (validated LOUDLY up front). */
    bindings: readonly unknown[];
    /**
     * The catalog's ContractValidator: every binding's recorded responseContract
     * must be KNOWN (fail closed at construction — an unknown response contract
     * can never reach a provider).
     */
    catalogContracts: ContractValidator;
    /** Fires for EVERY validated receipt (see the module header). */
    onReceipt?: (record: ModelUsageReceiptRecord) => void;
    /** Non-model node kinds delegate here (B5 gate / B6 agent arms); absent ⇒ LOUD. */
    fallback?: NodeInvoker;
    concurrency?: ModelConcurrencyOptions;
}
/**
 * Build the kind:"model" NodeInvoker arm. Per invocation it:
 * 1. resolves the compiled node's bindingFingerprint to its published sealed
 *    binding (unknown fingerprint ⇒ TERMINAL shard-scoped — immutable
 *    configuration, the digest-must-match rule);
 * 2. resolves the binding through the ModelBindingResolver port ONCE (cached
 *    per bindingDigest) and verifies the promoted prompt-identity check: when
 *    the binding names a prompt stack, the resolver's compiled prompt must be
 *    digest-valid and its promptStack/persona identity must EQUAL the
 *    binding's refs;
 * 3. optionally acquires an inference-concurrency lease slot;
 * 4. invokes ONCE (the durable executor owns retries) and ENFORCES the receipt
 *    floor: missing/malformed/below-floor receipts are TERMINAL, non-retryable
 *    item failures — every completed call records a receipt via onReceipt.
 */
export declare function createModelNodeInvoker(options: ModelNodeInvokerOptions): NodeInvoker;

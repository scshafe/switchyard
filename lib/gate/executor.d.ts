import type { ContractId } from "../contracts/artifact.js";
import type { ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import type { PipelineNodeBindingRef } from "../definition.js";
import type { RetrySafeOutboxEvents } from "../store.js";
import { type NodeInvoker } from "../execute/shard-runner.js";
import { type ModelBindingResolver, type ModelUsageReceiptRecord } from "../model/invoker.js";
import type { GateStepKind } from "./contracts.js";
/** What a deterministic/validator step function receives alongside its input. */
export interface GateStepRunContext {
    readonly runId: string;
    readonly itemId: string;
    readonly nodeId: string;
    readonly stepId: string;
    /** The gate NODE attempt (the durable executor's attempt number). */
    readonly attempt: number;
    readonly signal?: AbortSignal;
}
/** Every gate step resolves to an outcome code + an output artifact. */
export interface GateStepResult {
    outcome: string;
    output: unknown;
}
/**
 * One entry of the CLOSED registry: pure host code, identified by the
 * implementation `{ id, version }` gate flows reference. The registry is
 * injected at construction — flow data can never supply code.
 */
export interface GateStepImplementation {
    readonly id: string;
    readonly version: number;
    run(input: unknown, context: GateStepRunContext): GateStepResult | Promise<GateStepResult>;
}
export declare const GATE_NODE_RESULT_SCHEMA_VERSION = "gate-node-result.v1";
export interface GateExecutedStep {
    stepId: string;
    kind: GateStepKind;
    outcome: string;
}
/** The accumulated actuals of one flow walk (enforced against the certificate bounds). */
export interface GateBudgetSpent {
    pathSteps: number;
    modelCalls: number;
    chargedTokens: number;
    chargedCostMicroUsd: number;
    elapsedMs: number;
}
export interface GateNodeResult {
    schemaVersion: typeof GATE_NODE_RESULT_SCHEMA_VERSION;
    disposition: "valid_decision" | "human_escalation";
    flow: {
        id: string;
        version: number;
        compiledDigest: string;
    };
    certificateDigest: string;
    /** The executed path, in order. */
    path: GateExecutedStep[];
    budgetSpent: GateBudgetSpent;
    /** Present exactly when disposition === "valid_decision". */
    decision?: {
        contract: ContractId;
        output: unknown;
    };
    /** Present exactly when disposition === "human_escalation". */
    escalation?: {
        reasonCode: string;
        sourceStepId: string;
        outcomeCode: string;
    };
}
export declare const GATE_HUMAN_ESCALATION_EVENT_TYPE = "gate_human_escalation";
export declare const GATE_HUMAN_ESCALATION_EVENT_SCHEMA_VERSION = "gate-human-escalation-event.v1";
/** One human escalation, attributed to its exact attempt. */
export interface GateHumanEscalationRecord {
    runId: string;
    itemId: string;
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    attempt: number;
    /** Stable durable-stage action namespace. */
    idempotencyKey: string;
    flow: {
        id: string;
        version: number;
        compiledDigest: string;
    };
    certificateDigest: string;
    reasonCode: string;
    sourceStepId: string;
    outcomeCode: string;
    budgetSpent: GateBudgetSpent;
}
export interface GateEscalationLedger {
    /** Every escalation observed, in order. */
    readonly records: readonly GateHumanEscalationRecord[];
    /** Wire as createGateNodeInvoker's onEscalation. */
    onEscalation(record: GateHumanEscalationRecord): void;
    /**
     * Wire as (part of) ShardRunnerOptions.outboxEventsFor: drains this
     * exact (runId, itemId, nodeId, attempt)'s pending escalations into
     * dedupe-keyed outbox events that ride ATOMICALLY with the gate node's
     * persistStageSuccess append. The failure hook exists only for an
     * indeterminate conflicting replay: it preserves the first pending
     * escalation proof with that failed attempt instead of losing it on restart.
     * Compose with the model receipt ledger's hook when a pipeline carries both
     * node kinds: `(ctx) => [...receipts.outboxEventsFor(ctx), ...gates.outboxEventsFor(ctx)]`.
     */
    outboxEventsFor(context: {
        runId: string;
        node: CompiledPipelineNode;
        itemId: string;
        output: unknown;
        attempt: number;
        idempotencyKey: string;
    }): RetrySafeOutboxEvents;
    failureOutboxEventsFor(context: {
        runId: string;
        node: CompiledPipelineNode;
        itemId: string;
        attempt: number;
        idempotencyKey: string;
    }): RetrySafeOutboxEvents;
}
/** The escalation→outbox bridge (the model receipt ledger's promoted shape). */
export declare function createGateEscalationLedger(): GateEscalationLedger;
/**
 * Project a sealed compiled gate flow to the {@link PipelineNodeBindingRef} a
 * kind:"gate" definition node carries (`{ kind:"decision", … }` — the node
 * vocabulary keeps the promoted binding-kind name). The compiler stamps
 * `bindingDigest` (the COMPILED digest, certificate included) into the
 * compiled node as `bindingFingerprint`, which this executor resolves.
 */
export declare function gateFlowBindingRef(compiledRaw: unknown): PipelineNodeBindingRef;
export interface GateNodeInvokerOptions {
    /** The SAME model-execution port kind:"model" nodes use. */
    resolver: ModelBindingResolver;
    /** The published sealed compiled flows this invoker may execute (validated LOUDLY up front). */
    flows: readonly unknown[];
    /** The CLOSED deterministic/validator step registry (validated LOUDLY up front). */
    steps: readonly GateStepImplementation[];
    /**
     * The catalog's ContractValidator: every flow/step contract (and every model
     * step's recorded responseContract) must be KNOWN at construction, and step
     * outputs are validated against their outputContract at run time.
     */
    catalogContracts: ContractValidator;
    /** Fires for EVERY validated gate model-step receipt (gateStepId set). */
    onReceipt?: (record: ModelUsageReceiptRecord) => void;
    /** Fires for every human_escalation terminal (wire the escalation ledger here). */
    onEscalation?: (record: GateHumanEscalationRecord) => void;
    /** Non-gate node kinds delegate here (chain with createModelNodeInvoker); absent ⇒ LOUD. */
    fallback?: NodeInvoker;
    /** Millisecond clock for elapsed accounting (injectable for tests). */
    now?: () => number;
}
/**
 * Build the kind:"gate" NodeInvoker arm. Construction FAILS CLOSED: flows are
 * seal-validated (certificates recomputed), every referenced contract must be
 * known, every deterministic/validator implementation must be present in the
 * closed registry, and duplicate flow digests / registry identities are LOUD.
 */
export declare function createGateNodeInvoker(options: GateNodeInvokerOptions): NodeInvoker;

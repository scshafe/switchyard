import type { ContractId } from "../contracts/artifact.js";
import type { ContractValidationIssue, ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import type { StageContext } from "../node.js";
import { type BoundPipelineEvidenceStore, type BoundPipelineExecutionIdentity, type OutboxEvents, type PipelineStageEvidenceStore, type StageFailureScope } from "../store.js";
export type { StageFailureScope } from "../store.js";
/** Multi-slot composed inputs are prepared under this promoted marker contract. */
export declare const COMPOSITE_INPUT_CONTRACT: ContractId;
/** The promoted default retry budget (inbox durable-pipeline maxAttempts ?? 2). */
export declare const DEFAULT_MAX_ATTEMPTS = 2;
export interface StageFailure {
    code: string;
    retryable: boolean;
    scope: StageFailureScope;
}
/**
 * The typed, deliberate stage failure. Stages/invokers throw it to control
 * routing precisely; anything else is classified by {@link classifyStageFailure}.
 */
export declare class PipelineStageError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly scope: StageFailureScope;
    constructor(code: string, retryable: boolean, cause?: unknown, scope?: StageFailureScope);
}
/**
 * A contract-validation rejection from the injected ContractValidator —
 * ALWAYS immediately terminal (immutable contract failure), shard-scoped
 * (promoted from StageInputContractError/StageOutputContractError →
 * "immutable_stage_contract_rejected", retryable false, scope shard: the same
 * sealed configuration applies to every item, so a contract mismatch is a
 * broken topology, not bad luck).
 */
export declare class ContractViolationError extends Error {
    readonly code = "immutable_stage_contract_rejected";
    readonly contractId: ContractId;
    readonly issues: ContractValidationIssue[];
    constructor(where: string, contractId: ContractId, issues: ContractValidationIssue[]);
}
/**
 * Invocation completed, but Mission could not safely assemble the evidence
 * required for an atomic append. This is indeterminate, never a settleable
 * stage result; replay must reuse the same provider-attempt key.
 */
export declare class StageEvidenceAssemblyError extends Error {
    readonly code = "stage_evidence_assembly_failed";
    readonly operation: "output_digest" | "success_outbox" | "failure_outbox" | "provider_receipt" | "gate_escalation" | "failure_metadata" | "timestamp";
    constructor(operation: StageEvidenceAssemblyError["operation"], cause: unknown);
}
/** A concurrent winner did not prove this invocation's event batch durable. */
export declare class OutboxEvidenceNotCommittedError extends Error {
    readonly code = "outbox_evidence_not_committed";
    constructor();
}
/** A success winner under the same stage key produced different bytes. */
export declare class StageResultConflictError extends Error {
    readonly code = "stage_result_conflict";
    constructor(expectedOutputDigest: string, committedOutputDigest: string);
}
/**
 * Promoted stableFailure: maps ANY thrown value to a stable
 * {code, retryable, scope} triple. Order matters — typed errors first, then
 * the promoted message heuristics, then the retryable item-scoped default.
 */
export declare function classifyStageFailure(error: unknown): StageFailure;
/**
 * The node's configuration fingerprint, derived from the CompiledPipelineNode
 * ALONE: the sealed binding fingerprint (sha256 | "none") + the descriptor's
 * configurationFingerprint (or the promoted "default" placeholder).
 */
export declare function stageFingerprint(node: CompiledPipelineNode): string;
/**
 * The B3 idempotency key: digest({runId,itemId,nodeId,stageId,version,
 * fingerprint,inputDigest[,executionIdentityDigest]}). `nodeId` prevents two
 * uses of the same stage in one DAG from colliding. Bound execution adds the
 * sealed host-action/run/shard/definition/item identity digest; Pipeline-owned
 * execution retains its durable run/shard store boundary. Identical replays
 * land on the same key, so successes are reused and budgets survive crashes.
 */
export declare function stageIdempotencyKey(input: {
    runId: string;
    itemId: string;
    node: CompiledPipelineNode;
    inputDigest: string;
    /** Bound execution identity; omitted on the Pipeline-owned legacy path. */
    executionIdentityDigest?: string;
}): string;
/** One resolved input slot: the compiled slot + the actual artifact value. */
export interface ResolvedSlotValue {
    slot: string;
    contract: ContractId;
    value: unknown;
}
/** Exact failed-attempt context for transactional-outbox projection. */
export interface StageFailureOutboxContext {
    runId: string;
    itemId: string;
    node: CompiledPipelineNode;
    attempt: number;
    idempotencyKey: string;
    errorCode: string;
    retryable: boolean;
    scope: StageFailureScope;
    terminal: boolean;
}
/**
 * Compose the invocation input from resolved slots — promoted verbatim from
 * worker/service.ts: ONE slot passes its bare value; several compose an
 * object keyed by slot name (contract {@link COMPOSITE_INPUT_CONTRACT}).
 */
export declare function composeStageInput(slots: readonly ResolvedSlotValue[]): {
    input: unknown;
    inputContract: ContractId;
};
export interface DurableStageInput {
    /** Evidence-only port; lease lifecycle authority is deliberately absent. */
    store: PipelineStageEvidenceStore;
    /** The injected payload-validation port (usually catalog.contracts). */
    contracts: ContractValidator;
    /** Fencing pair from the shard claim. */
    shardId: string;
    leaseToken: string;
    runId: string;
    itemId: string;
    node: CompiledPipelineNode;
    /** The node's resolved input slot values (validated per-slot before invoke). */
    slots: readonly ResolvedSlotValue[];
    /**
     * The actual execution of one attempt (the runner dispatches on node.kind:
     * a CodeStage.run for "code", the NodeInvoker port for model/agent/gate).
     * Receives the composed, contract-validated input.
     */
    invoke: (input: unknown, ctx: StageContext) => Promise<unknown>;
    /** Per-node retry budget; default {@link DEFAULT_MAX_ATTEMPTS}. */
    maxAttempts?: number;
    /**
     * Host hook: outbox events appended ATOMICALLY with this exact fresh attempt.
     * The output remains the first argument for compatibility with existing
     * one-argument host callbacks; attempt context is additive.
     */
    outboxEvents?: (output: unknown, context: {
        runId: string;
        attempt: number;
        idempotencyKey: string;
    }) => OutboxEvents;
    /**
     * Host hook: outbox events appended ATOMICALLY with this exact failed
     * attempt. This is deliberately distinct from the success hook: provider
     * usage can be billable even when a response or agent result is unusable.
     */
    failureOutboxEvents?: (context: StageFailureOutboxContext) => OutboxEvents;
    /**
     * Digest-sealed externally bound action identity. It namespaces the stable
     * stage idempotency key without changing legacy Pipeline-owned keys.
     */
    executionIdentityDigest?: string;
    signal?: AbortSignal;
    now?: () => Date;
}
export type DurableStageResult = {
    status: "succeeded";
    output: unknown;
    outputDigest: string;
    /** true ⇔ a previously persisted success was reused (nothing executed). */
    reused: boolean;
    idempotencyKey: string;
    attempts: number;
} | {
    /** The item is terminalized at this node (dead-lettered now or by a previous fenced attempt). */
    status: "terminal";
    errorCode: string;
    idempotencyKey: string;
};
/**
 * Durably execute ONE compiled node for ONE item. Item-scoped outcomes are
 * RETURNED (success or terminal — per-item failure isolation is the caller's
 * job); shard-scoped failures (lease lost, immutable configuration/contract
 * rejections, deliberate shard-scope PipelineStageErrors) are THROWN after
 * their attempt evidence is persisted, so the runner can fail the whole shard.
 *
 * Behavior, in order:
 * 1. validate every slot value via the ContractValidator (violation ⇒ terminal
 *    contract failure, thrown shard-scoped — nothing invoked);
 * 2. compose the input (promoted single-slot/composite rule), digest it,
 *    derive the idempotency key;
 * 3. prepareStageExecution: cached ⇒ validate + return reused:true; terminal ⇒
 *    return the terminal arm (replays stop at the same node, dead-letter
 *    exactly once); reserved ⇒ run attempt `prepared.attempt`;
 * 4. attempts exhausted already (crash replay past the budget) ⇒ dead-letter
 *    (idempotent) + terminal;
 * 5. invoke; validate the output contract; persistStageSuccess with the
 *    caller's outbox events (atomic);
 * 6. on failure: classify; item terminal = item scope AND
 *    (!retryable || attempt >= maxAttempts), so at_most_once item failures
 *    terminalize on their first attempt. Persist the attempt (fenced), with
 *    every item terminal's dead letter riding atomically. Shard scope never
 *    terminalizes the item: rethrow for failShard, promoting a retryable shard
 *    failure to conclusive when its stage-attempt budget is exhausted.
 */
export declare function executeDurableStage(input: DurableStageInput): Promise<DurableStageResult>;
/**
 * The externally fenced form of {@link DurableStageInput}. `fence` is an
 * opaque host value: Mission Pipeline passes the exact value to every evidence
 * operation without inspecting or retaining it. The supplied store has no
 * lease lifecycle methods.
 */
export interface BoundDurableStageInput<TFence> extends Omit<DurableStageInput, "store" | "shardId" | "leaseToken"> {
    evidenceStore: BoundPipelineEvidenceStore<TFence>;
    fence: TFence;
    executionIdentity: BoundPipelineExecutionIdentity;
}
/**
 * Execute one durable stage under a host-owned fence.
 *
 * This is a thin binding adapter over the established durable executor, not a
 * second retry/idempotency implementation. The private legacy marker pair is
 * consumed by the adapter and never reaches the host evidence store.
 */
export declare function executeBoundDurableStage<TFence>(input: BoundDurableStageInput<TFence>): Promise<DurableStageResult>;

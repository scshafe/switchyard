import type { ContractId } from "../contracts/artifact.js";
import type { ContractValidationIssue, ContractValidator } from "../catalog.js";
import type { CompiledPipelineNode } from "../compile.js";
import type { StageContext } from "../node.js";
import { type OutboxEventInput, type PipelineStore, type StageFailureScope } from "../store.js";
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
 * The B3 idempotency key: digest({runId,itemId,stageId,version,fingerprint,
 * inputDigest}) — every field derives from the run identity, the item, the
 * compiled node, and the exact input bytes; two identical replays land on the
 * same key, so successes are reused and the retry budget survives crashes.
 */
export declare function stageIdempotencyKey(input: {
    runId: string;
    itemId: string;
    node: CompiledPipelineNode;
    inputDigest: string;
}): string;
/** One resolved input slot: the compiled slot + the actual artifact value. */
export interface ResolvedSlotValue {
    slot: string;
    contract: ContractId;
    value: unknown;
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
    store: PipelineStore;
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
    /** Per-node retry budget; default {@link DEFAULT_MAX_ATTEMPTS}. at_most_once nodes never retry. */
    maxAttempts?: number;
    /** Host hook: outbox events appended ATOMICALLY with a fresh success. */
    outboxEvents?: (output: unknown) => readonly OutboxEventInput[];
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

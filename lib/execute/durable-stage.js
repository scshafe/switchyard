// execute/durable-stage.ts — the durable stage executor: idempotency-keyed,
// cached-reusing, retry-bounded, dead-lettering execution of ONE compiled node
// for ONE run item, fenced through the PipelineStore port.
//
// PROMOTED from inbox-pipeline/src/durable-executor.ts (the idempotency-key
// digest; cached-success reuse with reused=true; the bounded attempt loop
// `previousAttempts + 1 .. maxAttempts`; dead-letter on exhaustion) MERGED
// with the fenced per-attempt semantics of src/worker/service.ts (the
// prepare→invoke→persist cycle; the stableFailure taxonomy — code strings,
// retryable flags, and item/shard scopes are promoted; terminal =
// !retryable || attempt >= maxAttempts; terminal item replays stop at the
// same node).
// CHANGES in the promotion:
//   - the idempotency key is digest({runId,itemId,stageId,version,fingerprint,
//     inputDigest}) where `fingerprint` derives from the CompiledPipelineNode
//     ALONE (bindingFingerprint + configurationFingerprint — the inbox keyed
//     on configurationFingerprint ?? "default" only; here the sealed binding
//     participates, so a binding change changes the key);
//   - contract validation moved OUT of stages INTO this executor via the
//     injected ContractValidator port: every input slot value is validated
//     before invoke, the output after — stages receive pre-validated input;
//   - deliverySemantics participates in the retry policy: an "at_most_once"
//     node is NEVER retried (effective maxAttempts 1) regardless of the
//     configured budget; "at_least_once_idempotent" nodes use the per-node
//     budget (default 2, promoted default);
//   - immutable topology/contract/digest failures are IMMEDIATELY terminal
//     (never retried), promoted from the inbox
//     "immutable_configuration_rejected"/"immutable_stage_contract_rejected"
//     non-retryable arms.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).
import { digest } from "../contracts/digest.js";
import { ShardLeaseLostError, WorkLeaseLostError } from "../store.js";
/** Multi-slot composed inputs are prepared under this promoted marker contract. */
export const COMPOSITE_INPUT_CONTRACT = "pipeline-node-input.v1";
/** The promoted default retry budget (inbox durable-pipeline maxAttempts ?? 2). */
export const DEFAULT_MAX_ATTEMPTS = 2;
/**
 * The typed, deliberate stage failure. Stages/invokers throw it to control
 * routing precisely; anything else is classified by {@link classifyStageFailure}.
 */
export class PipelineStageError extends Error {
    code;
    retryable;
    scope;
    constructor(code, retryable, cause, scope = "shard") {
        super(code, cause === undefined ? undefined : { cause });
        this.name = "PipelineStageError";
        this.code = code;
        this.retryable = retryable;
        this.scope = scope;
    }
}
/**
 * A contract-validation rejection from the injected ContractValidator —
 * ALWAYS immediately terminal (immutable contract failure), shard-scoped
 * (promoted from StageInputContractError/StageOutputContractError →
 * "immutable_stage_contract_rejected", retryable false, scope shard: the same
 * sealed configuration applies to every item, so a contract mismatch is a
 * broken topology, not bad luck).
 */
export class ContractViolationError extends Error {
    code = "immutable_stage_contract_rejected";
    contractId;
    issues;
    constructor(where, contractId, issues) {
        super(`${where}: value rejected by contract ${contractId}: ${issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ") || "no issues reported"}`);
        this.name = "ContractViolationError";
        this.contractId = contractId;
        this.issues = issues;
    }
}
/**
 * Promoted stableFailure: maps ANY thrown value to a stable
 * {code, retryable, scope} triple. Order matters — typed errors first, then
 * the promoted message heuristics, then the retryable item-scoped default.
 */
export function classifyStageFailure(error) {
    if (error instanceof PipelineStageError) {
        return { code: error.code, retryable: error.retryable, scope: error.scope };
    }
    if (error instanceof ShardLeaseLostError) {
        return { code: "shard_lease_lost", retryable: true, scope: "shard" };
    }
    if (error instanceof WorkLeaseLostError) {
        return { code: "work_lease_lost", retryable: true, scope: "shard" };
    }
    if (error instanceof ContractViolationError) {
        return { code: error.code, retryable: false, scope: "shard" };
    }
    const text = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
    if (/schema|contract|identity|digest|binding|pipeline node|executable|topolog/.test(text)) {
        // Promoted: immutable configuration failures are terminal and shard-scoped.
        return { code: "immutable_configuration_rejected", retryable: false, scope: "shard" };
    }
    if (/timeout|timed out|fetch|connect|econn|socket|model|503|502|429/.test(text)) {
        return { code: "dependency_unavailable", retryable: true, scope: "item" };
    }
    return { code: "stage_execution_failed", retryable: true, scope: "item" };
}
function errorMessage(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
// ── Idempotency key ───────────────────────────────────────────────────────
/**
 * The node's configuration fingerprint, derived from the CompiledPipelineNode
 * ALONE: the sealed binding fingerprint (sha256 | "none") + the descriptor's
 * configurationFingerprint (or the promoted "default" placeholder).
 */
export function stageFingerprint(node) {
    return digest({
        bindingFingerprint: node.bindingFingerprint,
        configurationFingerprint: node.configurationFingerprint ?? "default"
    });
}
/**
 * The B3 idempotency key: digest({runId,itemId,stageId,version,fingerprint,
 * inputDigest}) — every field derives from the run identity, the item, the
 * compiled node, and the exact input bytes; two identical replays land on the
 * same key, so successes are reused and the retry budget survives crashes.
 */
export function stageIdempotencyKey(input) {
    return digest({
        runId: input.runId,
        itemId: input.itemId,
        stageId: input.node.stage.id,
        version: input.node.stage.version,
        fingerprint: stageFingerprint(input.node),
        inputDigest: input.inputDigest
    });
}
/**
 * Compose the invocation input from resolved slots — promoted verbatim from
 * worker/service.ts: ONE slot passes its bare value; several compose an
 * object keyed by slot name (contract {@link COMPOSITE_INPUT_CONTRACT}).
 */
export function composeStageInput(slots) {
    if (slots.length === 0)
        throw new Error("composeStageInput: a node must resolve at least one input slot");
    if (slots.length === 1)
        return { input: slots[0].value, inputContract: slots[0].contract };
    return {
        input: Object.fromEntries(slots.map(({ slot, value }) => [slot, value])),
        inputContract: COMPOSITE_INPUT_CONTRACT
    };
}
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
 * 6. on failure: classify; terminal = !retryable || attempt >= maxAttempts
 *    (at_most_once ⇒ maxAttempts 1); persist the failed attempt (+ the dead
 *    letter riding atomically when terminal + item-scoped); shard scope ⇒
 *    rethrow; terminal item ⇒ return terminal; else loop to the next attempt.
 */
export async function executeDurableStage(input) {
    const { store, contracts, node } = input;
    const now = input.now ?? (() => new Date());
    // 1. Per-slot input validation — the executor validates, stages receive
    //    pre-validated input (B2 contract).
    const validatedSlots = input.slots.map((slot) => {
        const result = contracts.validate(slot.contract, slot.value);
        if (!result.ok) {
            throw new ContractViolationError(`stage ${node.stage.id}@${node.stage.version} input slot ${slot.slot}`, slot.contract, result.issues);
        }
        return { slot: slot.slot, contract: slot.contract, value: result.value };
    });
    // 2. Compose + key.
    const { input: composedInput, inputContract } = composeStageInput(validatedSlots);
    const inputDigest = digest(composedInput);
    const idempotencyKey = stageIdempotencyKey({ runId: input.runId, itemId: input.itemId, node, inputDigest });
    const configuredMax = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMax > 10) {
        throw new Error(`executeDurableStage: maxAttempts must be an integer from 1 through 10 (got ${String(configuredMax)})`);
    }
    // deliverySemantics keys the retry policy: at_most_once is NEVER retried.
    const maxAttempts = node.deliverySemantics === "at_most_once" ? 1 : configuredMax;
    while (true) {
        // 3. Fenced reservation + cached-result lookup.
        const prepared = await store.prepareStageExecution({
            shardId: input.shardId,
            leaseToken: input.leaseToken,
            runId: input.runId,
            itemId: input.itemId,
            nodeId: node.nodeId,
            stage: { id: node.stage.id, version: node.stage.version },
            idempotencyKey,
            inputContract,
            input: composedInput,
            inputDigest
        });
        if (prepared.disposition === "cached") {
            const revalidated = contracts.validate(node.outputContract, prepared.output);
            if (!revalidated.ok) {
                throw new ContractViolationError(`stage ${node.stage.id}@${node.stage.version} cached output (node ${node.nodeId})`, node.outputContract, revalidated.issues);
            }
            return {
                status: "succeeded",
                output: revalidated.value,
                outputDigest: prepared.outputDigest,
                reused: true,
                idempotencyKey,
                attempts: 0
            };
        }
        if (prepared.disposition === "terminal") {
            // A previous fenced attempt already terminalized this item here —
            // replays stop at the same node without re-executing or re-dead-lettering.
            return { status: "terminal", errorCode: prepared.errorCode, idempotencyKey };
        }
        const attempt = prepared.attempt;
        // 4. Budget already exhausted (a crash landed between the last failed
        //    attempt and its terminalization): dead-letter idempotently, stop.
        if (attempt > maxAttempts) {
            await store.recordDeadLetter({
                runId: input.runId,
                itemId: input.itemId,
                nodeId: node.nodeId,
                stage: { id: node.stage.id, version: node.stage.version },
                idempotencyKey,
                input: composedInput,
                error: { code: "retry_budget_exhausted", message: `retry budget exhausted after ${attempt - 1} attempts` },
                attempts: attempt - 1,
                createdAt: now().toISOString()
            });
            return { status: "terminal", errorCode: "retry_budget_exhausted", idempotencyKey };
        }
        const startedAt = now().toISOString();
        const ctx = {
            runId: input.runId,
            itemId: input.itemId,
            attempt,
            ...(input.signal === undefined ? {} : { signal: input.signal })
        };
        let output;
        try {
            // 5. The attempt itself, then output-contract validation.
            const rawOutput = await input.invoke(composedInput, ctx);
            const validated = contracts.validate(node.outputContract, rawOutput);
            if (!validated.ok) {
                throw new ContractViolationError(`stage ${node.stage.id}@${node.stage.version} output (node ${node.nodeId})`, node.outputContract, validated.issues);
            }
            output = validated.value;
        }
        catch (error) {
            // 6. Failure routing (promoted terminal rule + taxonomy).
            if (error instanceof ShardLeaseLostError || error instanceof WorkLeaseLostError) {
                throw error; // the claim is dead — nothing may be appended under it
            }
            const failure = classifyStageFailure(error);
            const terminal = !failure.retryable || attempt >= maxAttempts;
            const message = errorMessage(error);
            await store.persistStageFailure({
                shardId: input.shardId,
                leaseToken: input.leaseToken,
                executionId: prepared.executionId,
                idempotencyKey,
                runId: input.runId,
                itemId: input.itemId,
                nodeId: node.nodeId,
                attempt,
                startedAt,
                finishedAt: now().toISOString(),
                errorCode: failure.code,
                errorMessage: message,
                retryable: failure.retryable,
                terminal,
                // The dead letter rides ATOMICALLY with the terminal ITEM failure —
                // exactly once (shard-scoped failures are not the item's dead letter:
                // the shard is failed/reclaimed instead).
                ...(terminal && failure.scope === "item"
                    ? {
                        deadLetter: {
                            runId: input.runId,
                            itemId: input.itemId,
                            nodeId: node.nodeId,
                            stage: { id: node.stage.id, version: node.stage.version },
                            idempotencyKey,
                            input: composedInput,
                            error: { code: failure.code, message },
                            attempts: attempt,
                            createdAt: now().toISOString()
                        }
                    }
                    : {})
            });
            if (failure.scope === "shard") {
                throw error instanceof Error ? error : new PipelineStageError(failure.code, failure.retryable, error, "shard");
            }
            if (terminal) {
                return { status: "terminal", errorCode: failure.code, idempotencyKey };
            }
            continue; // retryable item-scoped failure with budget left → next attempt
        }
        const outputDigest = digest(output);
        const persisted = await store.persistStageSuccess({
            shardId: input.shardId,
            leaseToken: input.leaseToken,
            executionId: prepared.executionId,
            idempotencyKey,
            runId: input.runId,
            itemId: input.itemId,
            nodeId: node.nodeId,
            attempt,
            startedAt,
            finishedAt: now().toISOString(),
            outputContract: node.outputContract,
            output,
            outputDigest
        }, input.outboxEvents === undefined ? [] : input.outboxEvents(output));
        return {
            status: "succeeded",
            output: persisted.output,
            outputDigest: persisted.outputDigest,
            // created:false = a concurrent/previous writer won the append; their
            // output is authoritative and this call reused it.
            reused: !persisted.created,
            idempotencyKey,
            attempts: attempt
        };
    }
}

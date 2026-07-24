// model/invoker.ts — the ModelBindingResolver PORT + createModelNodeInvoker:
// the NodeInvoker arm for kind:"model" compiled nodes.
//
// PROMOTED from inbox-pipeline/src/catalog/model-resolver.ts (the resolve-a-
// sealed-binding-to-an-invoker shape with its identity cross-checks — model /
// profile / prompt-stack / persona digests must all agree) and the receipt
// plumbing of src/usage-receipt.ts, RE-CUT over the B3 NodeInvoker port: the
// durable executor already owns idempotency, retries, dead letters, and
// contract validation, so this invoker performs exactly ONE attempt and throws
// typed PipelineStageErrors for routing.
//
// THE RECEIPT FLOOR (the inbox classification silent-zero gap, closed at
// FRAMEWORK level): EVERY completed model invocation MUST return a
// usage-receipt.v1. A missing receipt, a malformed receipt, or a receipt whose
// trust ∈ {estimated_tier_ceiling, unavailable} charges below 1 token / 1
// micro-USD is a TERMINAL, non-retryable failure — "no telemetry" can never
// masquerade as free usage, and a resolver that forgets its receipt can never
// ship work through this node kind.
//
// Receipts reach persistence two ways (both host-visible):
//   - `onReceipt` fires for EVERY validated receipt (including attempts whose
//     output later fails contract validation);
//   - createModelReceiptLedger() pairs an onReceipt collector with an
//     `outboxEventsFor` hook for ShardRunnerOptions, so the SUCCESS receipt
//     rides ATOMICALLY with persistStageSuccess through the transactional
//     outbox.
//
// INFERENCE CONCURRENCY (optional): the promoted worker capacity fence, re-cut
// over the PipelineStore auxiliary leases — slot keys
// `inference:<profileId>@<version>:<slot>`, lease TTL strictly above the
// profile timeout so a live call can never outlive its fence. Contention is a
// RETRYABLE item failure; a lost capacity fence discovered at release time is
// swallowed (the lease protects capacity, not evidence — a completed call's
// result and receipt must not be discarded for it).
//
// STANDALONE: node: + relative imports only (no npm deps, no zod).
import { setTimeout as sleep } from "node:timers/promises";
import { isPlainObject } from "../internal/guards.js";
import { validateUsageReceipt } from "../contracts/usage-receipt.js";
import { WorkLeaseLostError } from "../store.js";
import { PipelineStageError } from "../execute/durable-stage.js";
import { validateCompiledPrompt } from "../prompt/compiler.js";
import { validateModelStageBinding } from "./binding.js";
export const MODEL_USAGE_RECEIPT_EVENT_TYPE = "model_usage_receipt";
export const MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION = "model-usage-receipt-event.v1";
/**
 * The receipt→outbox bridge: receipts recorded during an attempt ride the
 * SAME atomic append as the stage success. Receipts whose attempt never
 * reaches persistStageSuccess (e.g. the output later fails its contract) stay
 * in `records` for host-side persistence.
 */
export function createModelReceiptLedger() {
    const records = [];
    const pending = new Map();
    const keyOf = (runId, itemId, nodeId, attempt) => JSON.stringify([runId, itemId, nodeId, attempt]);
    return {
        get records() {
            return records.slice();
        },
        onReceipt(record) {
            records.push(record);
            const key = keyOf(record.runId, record.itemId, record.nodeId, record.attempt);
            const queue = pending.get(key);
            if (queue)
                queue.push(record);
            else
                pending.set(key, [record]);
        },
        outboxEventsFor(context) {
            const key = keyOf(context.runId, context.itemId, context.node.nodeId, context.attempt);
            const queue = pending.get(key) ?? [];
            pending.delete(key);
            return queue.map((record) => ({
                eventType: MODEL_USAGE_RECEIPT_EVENT_TYPE,
                payload: {
                    schemaVersion: MODEL_USAGE_RECEIPT_EVENT_SCHEMA_VERSION,
                    runId: record.runId,
                    itemId: record.itemId,
                    nodeId: record.nodeId,
                    stage: record.stage,
                    attempt: record.attempt,
                    bindingDigest: record.bindingDigest,
                    receipt: record.receipt,
                    ...(record.gateStepId === undefined ? {} : { gateStepId: record.gateStepId })
                },
                dedupeKey: `model-receipt:${record.runId}:${record.itemId}:${record.nodeId}:${record.attempt}` +
                    (record.gateStepId === undefined ? "" : `:step:${record.gateStepId}`)
            }));
        }
    };
}
function assertContractValidator(value) {
    if (value === null ||
        typeof value !== "object" ||
        typeof value.knows !== "function" ||
        typeof value.validate !== "function") {
        throw new Error("createModelNodeInvoker: catalogContracts must implement the ContractValidator port { knows(contractId), validate(contractId, value) }");
    }
    return value;
}
/**
 * Verify a resolver-produced {@link ResolvedModelBinding} against its sealed
 * binding: the invoker must exist, and when the binding names a prompt stack
 * the resolver's compiled prompt must be digest-valid with promptStack/persona
 * identity EQUAL to the binding's refs (the promoted prompt-identity check).
 * Shared by createModelNodeInvoker and the gate executor's model steps
 * (gate/executor.ts) — one check, two callers. Throws typed shard-scoped
 * PipelineStageErrors.
 */
export function verifyResolvedModelBinding(resolvedRaw, binding) {
    if (resolvedRaw === null || typeof resolvedRaw !== "object" || typeof resolvedRaw.invoke !== "function") {
        throw new PipelineStageError("model_resolver_invalid", false, new Error(`resolver returned no invoke() for binding ${binding.bindingId}@${binding.version}`), "shard");
    }
    const resolved = resolvedRaw;
    // The promoted prompt-identity check: resolved prompt digest-valid AND
    // identical to the binding's promptStack/persona refs.
    if (binding.promptStackRef !== undefined) {
        if (resolved.compiledPrompt === undefined) {
            throw new PipelineStageError("model_prompt_identity_mismatch", false, new Error(`binding ${binding.bindingId}@${binding.version} names prompt stack ${binding.promptStackRef.id}@${binding.promptStackRef.version} but the resolver surfaced no compiled prompt`), "shard");
        }
        let prompt;
        try {
            prompt = validateCompiledPrompt(resolved.compiledPrompt);
        }
        catch (error) {
            throw new PipelineStageError("model_prompt_identity_mismatch", false, error, "shard");
        }
        const stackRef = binding.promptStackRef;
        if (prompt.promptStack.id !== stackRef.id ||
            prompt.promptStack.version !== stackRef.version ||
            prompt.promptStack.digest !== stackRef.digest) {
            throw new PipelineStageError("model_prompt_identity_mismatch", false, new Error(`resolved prompt stack ${prompt.promptStack.id}@${prompt.promptStack.version} (${prompt.promptStack.digest}) does not match binding ${binding.bindingId}@${binding.version} prompt stack ${stackRef.id}@${stackRef.version} (${stackRef.digest})`), "shard");
        }
        const personaRef = binding.personaRef;
        if (personaRef !== undefined &&
            (prompt.persona.id !== personaRef.id ||
                prompt.persona.version !== personaRef.version ||
                prompt.persona.digest !== personaRef.digest)) {
            throw new PipelineStageError("model_prompt_identity_mismatch", false, new Error(`resolved prompt persona ${prompt.persona.id}@${prompt.persona.version} does not match binding ${binding.bindingId}@${binding.version} persona ${personaRef.id}@${personaRef.version}`), "shard");
        }
    }
    return resolved;
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
export function createModelNodeInvoker(options) {
    if (options === null || typeof options !== "object") {
        throw new Error("createModelNodeInvoker: options must be an object");
    }
    const resolver = options.resolver;
    if (resolver === null || typeof resolver !== "object" || typeof resolver.resolve !== "function") {
        throw new Error("createModelNodeInvoker: resolver must implement the ModelBindingResolver port { resolve(binding) }");
    }
    const contracts = assertContractValidator(options.catalogContracts);
    if (!Array.isArray(options.bindings)) {
        throw new Error("createModelNodeInvoker: bindings must be an array of sealed ModelStageBindings");
    }
    // Validate every published binding LOUDLY up front; index by sealed digest.
    const bindingsByDigest = new Map();
    for (const raw of options.bindings) {
        const binding = validateModelStageBinding(raw);
        if (bindingsByDigest.has(binding.bindingDigest)) {
            throw new Error(`createModelNodeInvoker: duplicate model binding digest ${binding.bindingDigest} (${binding.bindingId}@${binding.version})`);
        }
        // Fail closed at construction: the recorded response contract must be known.
        const responseContract = binding.inferenceProfileRef.parameters.responseContract;
        if (!contracts.knows(responseContract)) {
            throw new Error(`createModelNodeInvoker: binding ${binding.bindingId}@${binding.version} records response contract ${responseContract}, which the catalog ContractValidator does not know (fail closed)`);
        }
        bindingsByDigest.set(binding.bindingDigest, binding);
    }
    const resolvedCache = new Map();
    async function resolveVerified(binding) {
        const cached = resolvedCache.get(binding.bindingDigest);
        if (cached)
            return cached;
        const resolved = verifyResolvedModelBinding(await resolver.resolve(binding), binding);
        resolvedCache.set(binding.bindingDigest, resolved);
        return resolved;
    }
    async function acquireSlot(binding) {
        const concurrency = options.concurrency;
        if (concurrency === undefined)
            return undefined;
        const profile = binding.inferenceProfileRef;
        const slots = concurrency.slots ?? profile.parameters.maxConcurrency;
        if (!Number.isInteger(slots) || slots < 1 || slots > 4096) {
            throw new PipelineStageError("model_concurrency_misconfigured", false, new Error(`slots must be an integer >= 1 (got ${String(slots)})`), "shard");
        }
        const leaseDurationMs = concurrency.leaseDurationMs ?? profile.parameters.timeoutMs + 60_000;
        if (!Number.isInteger(leaseDurationMs) || leaseDurationMs <= profile.parameters.timeoutMs) {
            // The fence must strictly outlive the longest possible call so a live
            // invocation can never lose its capacity lease mid-flight.
            throw new PipelineStageError("model_concurrency_misconfigured", false, new Error(`leaseDurationMs (${String(leaseDurationMs)}) must exceed the profile timeoutMs (${profile.parameters.timeoutMs})`), "shard");
        }
        const pollMs = concurrency.pollMs ?? 25;
        const now = concurrency.now ?? (() => new Date());
        const deadline = now().getTime() + (concurrency.acquireTimeoutMs ?? 0);
        while (true) {
            for (let slot = 0; slot < slots; slot += 1) {
                const lease = await concurrency.store.acquireLease({
                    leaseKey: `inference:${profile.id}@${profile.version}:${slot}`,
                    leaseOwner: concurrency.leaseOwner,
                    leaseDurationMs,
                    at: now().toISOString()
                });
                if (lease)
                    return { lease, store: concurrency.store };
            }
            if (now().getTime() >= deadline) {
                throw new PipelineStageError("inference_capacity_exhausted", true, new Error(`all ${slots} inference slot(s) for profile ${profile.id}@${profile.version} are leased`), "item");
            }
            await sleep(pollMs);
        }
    }
    return {
        async invoke(invocation) {
            const { node } = invocation;
            if (node.kind !== "model") {
                if (options.fallback)
                    return options.fallback.invoke(invocation);
                throw new PipelineStageError("model_invoker_wrong_kind", false, new Error(`createModelNodeInvoker handles kind "model" only; node ${node.nodeId} is kind "${node.kind}" and no fallback invoker is configured`), "shard");
            }
            const binding = bindingsByDigest.get(node.bindingFingerprint);
            if (!binding) {
                // The compiled node's sealed fingerprint names no published binding —
                // immutable configuration, LOUD (the digest-must-match rule).
                throw new PipelineStageError("model_binding_unresolved", false, new Error(`no published model binding matches bindingFingerprint ${node.bindingFingerprint} (node ${node.nodeId})`), "shard");
            }
            const resolved = await resolveVerified(binding);
            const slot = await acquireSlot(binding);
            try {
                const result = await resolved.invoke({
                    runId: invocation.runId,
                    itemId: invocation.itemId,
                    nodeId: node.nodeId,
                    stage: { id: node.stage.id, version: node.stage.version },
                    attempt: invocation.attempt,
                    input: invocation.input,
                    binding
                }, invocation.signal);
                // ── THE RECEIPT FLOOR ──────────────────────────────────────────────
                if (!isPlainObject(result) || !("output" in result)) {
                    throw new PipelineStageError("model_result_malformed", false, new Error(`resolver for binding ${binding.bindingId}@${binding.version} returned no { output, usage } result`), "item");
                }
                if (!("usage" in result) || result.usage === undefined || result.usage === null) {
                    throw new PipelineStageError("model_receipt_missing", false, new Error(`model invocation for node ${node.nodeId} (binding ${binding.bindingId}@${binding.version}) completed WITHOUT a usage receipt — every attempt must record one`), "item");
                }
                let receipt;
                try {
                    receipt = validateUsageReceipt(result.usage);
                }
                catch (error) {
                    // Includes the non-silent-zero floor: estimated_tier_ceiling /
                    // unavailable receipts charging 0 are rejected here — TERMINAL.
                    throw new PipelineStageError("model_receipt_rejected", false, error, "item");
                }
                options.onReceipt?.({
                    runId: invocation.runId,
                    itemId: invocation.itemId,
                    nodeId: node.nodeId,
                    stage: { id: node.stage.id, version: node.stage.version },
                    attempt: invocation.attempt,
                    bindingDigest: binding.bindingDigest,
                    receipt
                });
                const responseContract = binding.inferenceProfileRef.parameters.responseContract;
                const validatedOutput = contracts.validate(responseContract, result.output);
                if (!validatedOutput.ok) {
                    const details = validatedOutput.issues
                        .map((issue) => `${issue.path === undefined ? "" : `${issue.path}: `}${issue.message}`)
                        .join("; ");
                    throw new PipelineStageError("model_output_contract_invalid", true, new Error(`model response contract ${responseContract} rejected output` +
                        (details.length === 0 ? "" : `: ${details}`)), "item");
                }
                return validatedOutput.value;
            }
            finally {
                if (slot) {
                    try {
                        await slot.store.releaseLease({ leaseKey: slot.lease.leaseKey, leaseToken: slot.lease.leaseToken });
                    }
                    catch (error) {
                        // A lost capacity fence after completed work is swallowed: the
                        // lease protects capacity, not evidence — never discard a
                        // completed result (and its receipt) over it.
                        if (!(error instanceof WorkLeaseLostError))
                            throw error;
                    }
                }
            }
        }
    };
}

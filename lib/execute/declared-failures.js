// execute/declared-failures.ts — consumer-owned failure recovery policy.
// No provider admission, telemetry, or settlement is inferred from an error.
import { types as nodeTypes } from "node:util";
import { validateArtifactEnvelope } from "../contracts/artifact.js";
import { validateUsageReceipt } from "../contracts/usage-receipt.js";
import { validateMissionPipelineNodeBindingRef } from "../graph/definition.js";
import { captureCapabilityDataProperty, captureCapabilityRecord } from "../internal/capability.js";
import { assertIdentifier } from "../internal/guards.js";
import { classifyExecutionFailure, ExecutionFailureError, isExecutionFailureError } from "./failure.js";
import { ENGINE_JOIN_UNSATISFIABLE_OUTCOME, MAX_AGENT_TURN_USAGE_RECEIPTS, snapshotNodeTurnCompletion, snapshotWorkerNodeTurnContext } from "./ports.js";
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
const EMPTY_USAGE = Object.freeze([]);
function frozenRecord(value) {
    return Object.freeze(Object.assign(Object.create(null), value));
}
/** Input has already passed a bounded strict validator before this conversion. */
function prototypeFree(value) {
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return Object.freeze(value.map(prototypeFree));
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
        Object.defineProperty(result, key, { value: prototypeFree(value[key]), enumerable: true });
    }
    return Object.freeze(result);
}
function captureFunction(value, label) {
    if (typeof value !== "function" || nodeTypes.isProxy(value))
        throw new Error(`${label} must be a non-Proxy data-property function`);
    return value;
}
function captureMethod(port, key) {
    const method = captureFunction(captureCapabilityDataProperty(port, key, "declared failure port"), `declared failure port.${key}`);
    return (...args) => Reflect.apply(method, port, args);
}
function captureOutcomes(value) {
    if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        throw new Error("declared failure outcomes must be a plain non-Proxy data object");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 256)
        throw new Error("declared failure outcomes must contain at most 256 mappings");
    const result = Object.create(null);
    for (const key of keys) {
        if (typeof key !== "string")
            throw new Error("declared failure outcomes must not have symbol keys");
        assertIdentifier(key, "declared failure code");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!("value" in descriptor) || descriptor.enumerable !== true)
            throw new Error("declared failure outcome must be an enumerable data property");
        const outcome = assertIdentifier(descriptor.value, "declared failure outcome");
        if (outcome === ENGINE_JOIN_UNSATISFIABLE_OUTCOME)
            throw new Error("declared failure outcome is engine-reserved");
        result[key] = outcome;
    }
    return Object.freeze(result);
}
function paid(receipt) {
    return receipt.chargedTokens > 0 || receipt.chargedCostMicroUsd > 0
        || (receipt.observedInputTokens ?? 0) > 0 || (receipt.observedOutputTokens ?? 0) > 0
        || (receipt.observedCostMicroUsd ?? 0) > 0;
}
function assertAdmissionUsage(state, usage) {
    if (state.admission === "not_admitted" && usage.some(paid)) {
        throw new Error("not_admitted invocation cannot carry paid or positive observed usage");
    }
}
function signalAborted(context) {
    return context.signal !== undefined && Reflect.apply(abortedGetter, context.signal, []);
}
function assertNotAborted(context) {
    if (signalAborted(context)) {
        const error = new Error("Declared failure invocation aborted");
        error.name = "AbortError";
        throw error;
    }
}
function cancellation(error) {
    if (error === null || (typeof error !== "object" && typeof error !== "function") || nodeTypes.isProxy(error))
        return false;
    let cursor = error;
    while (cursor !== null && !nodeTypes.isProxy(cursor)) {
        for (const key of ["name", "code"]) {
            const property = Object.getOwnPropertyDescriptor(cursor, key);
            if (property !== undefined && "value" in property && typeof property.value === "string"
                && /^(AbortError|ABORT_ERR|ERR_CANCELLED|ERR_CANCELED|cancel(?:led|ed|lation)Error|abort(?:ed)?|cancel(?:led|ed|lation)?)$/i.test(property.value))
                return true;
        }
        cursor = Object.getPrototypeOf(cursor);
    }
    return false;
}
// Thrown objects retain their identity on pass-through. Evidence lives outside
// the error, keyed by the exact attempt; hostile properties are never read.
const recoveryEvidence = new WeakMap();
function retainUsage(error, state) {
    if (state.usage.length === 0 || error === null || (typeof error !== "object" && typeof error !== "function"))
        return;
    let byAttempt = recoveryEvidence.get(error);
    if (byAttempt === undefined) {
        byAttempt = new Map();
        recoveryEvidence.set(error, byAttempt);
    }
    const key = JSON.stringify([state.context.nodeId, state.context.idempotencyKey]);
    if (!byAttempt.has(key))
        byAttempt.set(key, state.usage);
}
class DeclaredFailureUnresolvedError extends Error {
    constructor(state, cause) {
        super("Declared failure invocation remains unresolved", { cause });
        retainUsage(this, state);
        Object.freeze(this);
    }
}
class DeclaredFailureRecoveryError extends ExecutionFailureError {
    constructor(state, cause) {
        super("immutable_stage_contract_rejected", false, cause);
        this.name = "DeclaredFailureRecoveryError";
        retainUsage(this, state);
        Object.freeze(this);
    }
}
/** @internal Exact-attempt lookup used by the runner. No public error usage is trusted. */
export function declaredFailureRecoveryUsage(error, nodeId, idempotencyKey) {
    if (error === null || (typeof error !== "object" && typeof error !== "function")
        || typeof nodeId !== "string" || typeof idempotencyKey !== "string")
        return undefined;
    return recoveryEvidence.get(error)?.get(JSON.stringify([nodeId, idempotencyKey]));
}
/**
 * Map selected definite failures to ordinary completions under explicit host
 * receipt policy. Node declarations and output contracts are still validated
 * by executeNodeTurnAttempt. Agent submit/await must share the same context
 * object; the engine already does so. No invocation state survives a process.
 */
export function withDeclaredFailureOutcomes(port, options) {
    const raw = captureCapabilityRecord(options, ["kind", "outcomes", "artifact", "receipt"], ["kind", "outcomes", "artifact"], "declared failure options");
    const candidateKind = raw.kind;
    if (candidateKind !== "code" && candidateKind !== "model" && candidateKind !== "agent")
        throw new Error("declared failure options.kind must be code, model, or agent");
    const kind = candidateKind;
    const outcomes = captureOutcomes(raw.outcomes);
    const artifact = captureFunction(raw.artifact, "declared failure options.artifact");
    if (kind === "code" && Object.hasOwn(raw, "receipt"))
        throw new Error("code declared failures must not supply a receipt policy");
    if (kind === "model" && !Object.hasOwn(raw, "receipt"))
        throw new Error("model declared failures require a receipt policy");
    const receiptPolicy = Object.hasOwn(raw, "receipt") ? captureFunction(raw.receipt, "declared failure options.receipt") : undefined;
    function start(input, contextRaw, bindingRaw) {
        const context = snapshotWorkerNodeTurnContext(contextRaw);
        assertNotAborted(context);
        const envelope = validateArtifactEnvelope({ ...context.inputArtifact, payload: input });
        const binding = bindingRaw === undefined ? undefined : prototypeFree(validateMissionPipelineNodeBindingRef(bindingRaw, "declared failure binding"));
        const ensureActive = () => {
            if (!state.active)
                throw new Error("declared failure evidence capture is closed");
        };
        const state = {
            input: prototypeFree(envelope.payload), context, ...(binding === undefined ? {} : { binding }),
            admission: "unknown", usage: EMPTY_USAGE, active: true, unresolved: false,
            capture: frozenRecord({
                setAdmission(admission) {
                    ensureActive();
                    if (admission !== "unknown" && admission !== "not_admitted" && admission !== "admitted")
                        throw new Error("invalid declared failure admission");
                    if (state.admission === "admitted" && admission !== "admitted")
                        throw new Error("admitted invocation cannot be downgraded");
                    if (admission === "not_admitted" && state.usage.some(paid))
                        throw new Error("not_admitted invocation cannot carry paid or positive observed usage");
                    state.admission = admission;
                },
                recordUsage(receipt) {
                    ensureActive();
                    if (kind === "code")
                        throw new Error("code invocation must not record usage");
                    const next = prototypeFree(validateUsageReceipt(receipt));
                    const maximum = kind === "model" ? 1 : MAX_AGENT_TURN_USAGE_RECEIPTS;
                    if (state.usage.length >= maximum)
                        throw new Error(`declared failure invocation permits at most ${maximum} receipts`);
                    assertAdmissionUsage(state, [next]);
                    state.usage = Object.freeze([...state.usage, next]);
                },
                markUnresolved() { ensureActive(); state.unresolved = true; }
            })
        };
        return state;
    }
    async function recover(error, state, operation) {
        state.active = false;
        retainUsage(error, state);
        if (signalAborted(state.context) || state.unresolved || cancellation(error)) {
            if (kind === "agent" && isExecutionFailureError(error))
                throw new DeclaredFailureUnresolvedError(state, error);
            throw error;
        }
        if (kind === "agent" && !isExecutionFailureError(error))
            throw error;
        const failure = frozenRecord(classifyExecutionFailure(error));
        if (!Object.hasOwn(outcomes, failure.code))
            throw error;
        const invocation = frozenRecord({
            kind, operation, input: state.input, context: state.context,
            ...(state.binding === undefined ? {} : { binding: state.binding }), failure,
            evidence: frozenRecord({ admission: state.admission, usage: state.usage })
        });
        try {
            if (kind !== "code" && state.usage.length === 0 && receiptPolicy !== undefined) {
                const proposed = await Reflect.apply(receiptPolicy, undefined, [invocation]);
                // Receipt-first extraction retains a valid prefix if a later receipt
                // is malformed. Policy evidence never replaces captured observations.
                try {
                    const accepted = prototypeFree(snapshotNodeTurnCompletion({ outcome: "failure_recovery", usage: proposed }).usage);
                    assertAdmissionUsage(state, accepted);
                    state.usage = accepted;
                }
                catch (validationError) {
                    // This error is created synchronously by the strict snapshot above.
                    const descriptor = Object.getOwnPropertyDescriptor(validationError, "usage");
                    if (descriptor !== undefined && "value" in descriptor) {
                        const prefix = prototypeFree(descriptor.value);
                        state.usage = state.admission === "not_admitted"
                            ? Object.freeze(prefix.slice(0, prefix.findIndex(paid) < 0 ? prefix.length : prefix.findIndex(paid)))
                            : prefix;
                    }
                    throw validationError;
                }
                assertAdmissionUsage(state, state.usage);
            }
            if (kind === "model" && state.usage.length !== 1)
                throw new Error("model declared failure requires exactly one receipt");
            if (signalAborted(state.context))
                throw error;
            const outputArtifact = prototypeFree(validateArtifactEnvelope(await Reflect.apply(artifact, undefined, [invocation])));
            if (signalAborted(state.context))
                throw error;
            return frozenRecord({ outcome: outcomes[failure.code], outputArtifact, ...(kind === "code" ? {} : { usage: state.usage }) });
        }
        catch (recoveryError) {
            retainUsage(recoveryError, state);
            if (signalAborted(state.context) || cancellation(recoveryError)) {
                if (kind === "agent" && isExecutionFailureError(recoveryError))
                    throw new DeclaredFailureUnresolvedError(state, recoveryError);
                throw recoveryError;
            }
            throw new DeclaredFailureRecoveryError(state, recoveryError);
        }
    }
    if (kind === "code") {
        const run = captureMethod(port, "run");
        return frozenRecord({ async run(input, context) {
                const state = start(input, context);
                try {
                    return await run(state.input, state.context, state.capture);
                }
                catch (error) {
                    return await recover(error, state, "code_run");
                }
                finally {
                    state.active = false;
                }
            } });
    }
    if (kind === "model") {
        const invoke = captureMethod(port, "invoke");
        return frozenRecord({ async invoke(input, binding, context) {
                const state = start(input, context, binding);
                try {
                    return await invoke(state.input, state.binding, state.context, state.capture);
                }
                catch (error) {
                    return await recover(error, state, "model_invoke");
                }
                finally {
                    state.active = false;
                }
            } });
    }
    const submit = captureMethod(port, "submitTurnIntent");
    const awaitResult = captureMethod(port, "awaitSettledResult");
    const pending = new WeakMap();
    return frozenRecord({
        async submitTurnIntent(input, context) {
            if (pending.has(context))
                throw new Error("agent declared failure invocation already submitted for this context");
            const state = start(input, context);
            pending.set(context, state);
            try {
                await submit(state.input, state.context, state.capture);
            }
            catch (error) {
                try {
                    state.completion = await recover(error, state, "agent_submit");
                }
                catch (rejection) {
                    pending.delete(context);
                    state.active = false;
                    throw rejection;
                }
            }
        },
        async awaitSettledResult(context) {
            const state = pending.get(context);
            if (state === undefined || state.awaiting)
                throw new Error("agent declared failure await requires its submitted context exactly once");
            state.awaiting = true;
            try {
                assertNotAborted(state.context);
                if (state.completion !== undefined)
                    return state.completion;
                try {
                    return await awaitResult(state.context, state.capture);
                }
                catch (error) {
                    return await recover(error, state, "agent_await");
                }
            }
            catch (error) {
                retainUsage(error, state);
                throw error;
            }
            finally {
                pending.delete(context);
                state.active = false;
            }
        }
    });
}

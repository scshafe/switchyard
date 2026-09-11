// model/invoker.ts — host-neutral model resolution for one v2 node turn.
//
// Provider dispatch, credentials, capacity fences, journals, and retry policy
// remain host-owned. This package validates the sealed binding/prompt identity
// and exposes the single-call boundary used by a ModelNodePort.
//
// A ModelNodePort receives the validated input payload, the node's sealed
// binding ref, and a WorkerNodeTurnContext. `modelTurnInvocationRequest`
// turns exactly those, plus the sealed binding the host published for that
// ref, into the request a resolved binding receives, so the provider boundary
// sees the same attempt identity the journey records. The older
// `ModelInvocationRequest` shape stays accepted until the next major.
import { captureCapabilityDataProperty, captureCapabilityMethod, captureCapabilityRecord } from "../internal/capability.js";
import { ExecutionFailureError } from "../execute/failure.js";
import { snapshotWorkerNodeTurnContext } from "../execute/ports.js";
import { validateCompiledPrompt } from "../prompt/compiler.js";
import { resolveModelBindingRef, validateModelStageBinding } from "./binding.js";
import { validateMissionPipelineNodeBindingRef } from "../graph/definition.js";
const INVOCATION_FIELD_KEYS = ["context", "input", "bindingRef", "binding"];
/**
 * Build the v2 request from what a ModelNodePort received. The context is
 * re-snapshotted, so a forged or partial context fails here; the binding ref
 * is the sealed node's, and the binding must be the exact sealed payload that
 * ref names (`resolveModelBindingRef`), so a request can never carry a
 * binding the graph did not pin. `input` is passed through untouched: it is
 * the payload the engine already validated.
 */
export function modelTurnInvocationRequest(fieldsRaw) {
    const label = "model turn invocation";
    const fields = captureCapabilityRecord(fieldsRaw, INVOCATION_FIELD_KEYS, INVOCATION_FIELD_KEYS, label);
    const context = snapshotWorkerNodeTurnContext(fields.context, `${label} context`);
    const bindingRef = validateMissionPipelineNodeBindingRef(fields.bindingRef, `${label} binding ref`);
    const binding = resolveModelBindingRef(bindingRef, fields.binding);
    return Object.freeze({
        unitId: context.unitId,
        queueId: context.queueId,
        nodeId: context.nodeId,
        nodeRef: context.nodeRef,
        attemptNumber: context.attemptNumber,
        attemptIndex: context.attemptIndex,
        idempotencyKey: context.idempotencyKey,
        inputArtifact: context.inputArtifact,
        input: fields.input,
        binding
    });
}
function terminalModelFailure(code, cause) {
    return new ExecutionFailureError(code, false, cause);
}
/**
 * Snapshot a resolver capability and prove any prompt it surfaces is the exact
 * digest-sealed prompt named by the binding. The returned wrapper retains only
 * the captured invoke capability and validated prompt data.
 */
export function verifyResolvedModelBinding(resolvedRaw, bindingRaw) {
    const binding = validateModelStageBinding(bindingRaw);
    let invoke;
    let compiledPromptRaw;
    try {
        invoke = captureCapabilityMethod(resolvedRaw, "invoke", "resolved model binding");
        compiledPromptRaw = captureCapabilityDataProperty(resolvedRaw, "compiledPrompt", "resolved model binding");
    }
    catch (cause) {
        throw terminalModelFailure("model_resolver_invalid", new Error(`resolver returned no invoke() for binding ${binding.bindingId}@${binding.version}`, { cause }));
    }
    let compiledPrompt;
    if (binding.promptStackRef !== undefined) {
        if (compiledPromptRaw === undefined) {
            throw terminalModelFailure("model_prompt_identity_mismatch", new Error(`binding ${binding.bindingId}@${binding.version} names prompt stack ` +
                `${binding.promptStackRef.id}@${binding.promptStackRef.version} but the resolver surfaced no compiled prompt`));
        }
        try {
            compiledPrompt = validateCompiledPrompt(compiledPromptRaw);
        }
        catch (cause) {
            throw terminalModelFailure("model_prompt_identity_mismatch", cause);
        }
        const stackRef = binding.promptStackRef;
        if (compiledPrompt.promptStack.id !== stackRef.id
            || compiledPrompt.promptStack.version !== stackRef.version
            || compiledPrompt.promptStack.digest !== stackRef.digest) {
            throw terminalModelFailure("model_prompt_identity_mismatch", new Error(`resolved prompt stack ${compiledPrompt.promptStack.id}@${compiledPrompt.promptStack.version} ` +
                `(${compiledPrompt.promptStack.digest}) does not match binding ${binding.bindingId}@${binding.version} ` +
                `prompt stack ${stackRef.id}@${stackRef.version} (${stackRef.digest})`));
        }
        const personaRef = binding.personaRef;
        if (personaRef !== undefined
            && (compiledPrompt.persona.id !== personaRef.id
                || compiledPrompt.persona.version !== personaRef.version
                || compiledPrompt.persona.digest !== personaRef.digest)) {
            throw terminalModelFailure("model_prompt_identity_mismatch", new Error(`resolved prompt persona ${compiledPrompt.persona.id}@${compiledPrompt.persona.version} ` +
                `does not match binding ${binding.bindingId}@${binding.version} persona ` +
                `${personaRef.id}@${personaRef.version}`));
        }
    }
    return Object.freeze({
        invoke: (request, signal) => invoke(request, signal),
        ...(compiledPrompt === undefined ? {} : { compiledPrompt })
    });
}

// model/invoker.ts — host-neutral model resolution for one v2 node turn.
//
// Provider dispatch, credentials, capacity fences, journals, and retry policy
// remain host-owned. This package validates the sealed binding/prompt identity
// and exposes the single-call boundary used by a ModelNodePort.

import {
  captureCapabilityDataProperty,
  captureCapabilityMethod
} from "../internal/capability.js";
import { ExecutionFailureError } from "../execute/failure.js";
import {
  validateCompiledPrompt,
  type CompiledPrompt
} from "../prompt/compiler.js";
import {
  validateModelStageBinding,
  type ModelStageBinding
} from "./binding.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";

/** What the resolved host receives for one physical model call. */
export interface ModelInvocationRequest {
  readonly runId: string;
  readonly itemId: string;
  readonly nodeId: string;
  readonly stage: { readonly id: string; readonly version: number };
  readonly attempt: number;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly binding: ModelStageBinding;
}

/** One completed physical call with its mandatory usage evidence. */
export interface ModelInvocationResult {
  readonly output: unknown;
  readonly usage: UsageReceipt;
}

export interface ResolvedModelBinding {
  invoke(
    request: ModelInvocationRequest,
    signal?: AbortSignal
  ): Promise<ModelInvocationResult>;
  readonly compiledPrompt?: CompiledPrompt;
}

/** Hosts resolve an exact sealed binding without granting engine credentials. */
export interface ModelBindingResolver {
  resolve(
    binding: ModelStageBinding
  ): ResolvedModelBinding | Promise<ResolvedModelBinding>;
}

function terminalModelFailure(code: string, cause: unknown): ExecutionFailureError {
  return new ExecutionFailureError(code, false, cause);
}

/**
 * Snapshot a resolver capability and prove any prompt it surfaces is the exact
 * digest-sealed prompt named by the binding. The returned wrapper retains only
 * the captured invoke capability and validated prompt data.
 */
export function verifyResolvedModelBinding(
  resolvedRaw: unknown,
  bindingRaw: ModelStageBinding
): ResolvedModelBinding {
  const binding = validateModelStageBinding(bindingRaw);
  let invoke: (...args: any[]) => any;
  let compiledPromptRaw: unknown;
  try {
    invoke = captureCapabilityMethod(
      resolvedRaw,
      "invoke",
      "resolved model binding"
    );
    compiledPromptRaw = captureCapabilityDataProperty(
      resolvedRaw,
      "compiledPrompt",
      "resolved model binding"
    );
  } catch (cause) {
    throw terminalModelFailure(
      "model_resolver_invalid",
      new Error(
        `resolver returned no invoke() for binding ${binding.bindingId}@${binding.version}`,
        { cause }
      )
    );
  }

  let compiledPrompt: CompiledPrompt | undefined;
  if (binding.promptStackRef !== undefined) {
    if (compiledPromptRaw === undefined) {
      throw terminalModelFailure(
        "model_prompt_identity_mismatch",
        new Error(
          `binding ${binding.bindingId}@${binding.version} names prompt stack ` +
          `${binding.promptStackRef.id}@${binding.promptStackRef.version} but the resolver surfaced no compiled prompt`
        )
      );
    }
    try {
      compiledPrompt = validateCompiledPrompt(compiledPromptRaw);
    } catch (cause) {
      throw terminalModelFailure("model_prompt_identity_mismatch", cause);
    }
    const stackRef = binding.promptStackRef;
    if (
      compiledPrompt.promptStack.id !== stackRef.id
      || compiledPrompt.promptStack.version !== stackRef.version
      || compiledPrompt.promptStack.digest !== stackRef.digest
    ) {
      throw terminalModelFailure(
        "model_prompt_identity_mismatch",
        new Error(
          `resolved prompt stack ${compiledPrompt.promptStack.id}@${compiledPrompt.promptStack.version} ` +
          `(${compiledPrompt.promptStack.digest}) does not match binding ${binding.bindingId}@${binding.version} ` +
          `prompt stack ${stackRef.id}@${stackRef.version} (${stackRef.digest})`
        )
      );
    }
    const personaRef = binding.personaRef;
    if (
      personaRef !== undefined
      && (
        compiledPrompt.persona.id !== personaRef.id
        || compiledPrompt.persona.version !== personaRef.version
        || compiledPrompt.persona.digest !== personaRef.digest
      )
    ) {
      throw terminalModelFailure(
        "model_prompt_identity_mismatch",
        new Error(
          `resolved prompt persona ${compiledPrompt.persona.id}@${compiledPrompt.persona.version} ` +
          `does not match binding ${binding.bindingId}@${binding.version} persona ` +
          `${personaRef.id}@${personaRef.version}`
        )
      );
    }
  }

  return Object.freeze({
    invoke: (request: ModelInvocationRequest, signal?: AbortSignal) =>
      invoke(request, signal),
    ...(compiledPrompt === undefined ? {} : { compiledPrompt })
  });
}

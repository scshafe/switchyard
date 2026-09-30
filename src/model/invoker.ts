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

import {
  captureCapabilityDataProperty,
  captureCapabilityMethod,
  captureCapabilityRecord
} from "../internal/capability.js";
import { ExecutionFailureError } from "../execute/failure.js";
import {
  snapshotWorkerNodeTurnContext,
  type WorkerNodeTurnContext
} from "../execute/ports.js";
import {
  validateCompiledPrompt,
  type CompiledPrompt
} from "../prompt/compiler.js";
import {
  resolveModelBindingRef,
  validateModelStageBinding,
  type ModelStageBinding
} from "./binding.js";
import type { ArtifactRef } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import {
  validateSwitchyardNodeBindingRef,
  type SwitchyardNodeBindingRef,
  type SwitchyardNodeRef
} from "../graph/definition.js";

/**
 * The pre-2.1.0 request shape. It names a run, an item, a stage, and one
 * attempt counter, none of which a v2 node turn has; hosts that still speak
 * it keep working, and removing it is a major.
 */
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

/** What a resolved binding receives for one physical call of a v2 node turn. */
export interface ModelTurnInvocationRequest {
  readonly unitId: string;
  /** Durable identity of the queued occurrence this attempt belongs to. */
  readonly queueId: string;
  readonly nodeId: string;
  readonly nodeRef: SwitchyardNodeRef;
  readonly attemptNumber: number;
  /** 1-based retry ordinal within this queue occurrence. */
  readonly attemptIndex: number;
  /** The sealed attempt identity the journey records for this turn. */
  readonly idempotencyKey: string;
  /** Content identity of the input; `input` is its validated payload. */
  readonly inputArtifact: ArtifactRef;
  readonly input: unknown;
  /** The sealed binding the node's binding ref names, proven by digest. */
  readonly binding: ModelStageBinding;
}

export type AnyModelInvocationRequest = ModelInvocationRequest | ModelTurnInvocationRequest;

/** One completed physical call with its mandatory usage evidence. */
export interface ModelInvocationResult {
  readonly output: unknown;
  readonly usage: UsageReceipt;
}

export interface ResolvedModelBinding {
  invoke(
    request: AnyModelInvocationRequest,
    signal?: AbortSignal
  ): Promise<ModelInvocationResult>;
  readonly compiledPrompt?: CompiledPrompt;
}

/** The three things a ModelNodePort holds, plus the sealed binding it published. */
export interface ModelTurnInvocationFields {
  readonly context: WorkerNodeTurnContext;
  readonly input: unknown;
  readonly bindingRef: SwitchyardNodeBindingRef;
  readonly binding: ModelStageBinding;
}

const INVOCATION_FIELD_KEYS = ["context", "input", "bindingRef", "binding"] as const;

/**
 * Build the v2 request from what a ModelNodePort received. The context is
 * re-snapshotted, so a forged or partial context fails here; the binding ref
 * is the sealed node's, and the binding must be the exact sealed payload that
 * ref names (`resolveModelBindingRef`), so a request can never carry a
 * binding the graph did not pin. `input` is passed through untouched: it is
 * the payload the engine already validated.
 */
export function modelTurnInvocationRequest(fieldsRaw: unknown): ModelTurnInvocationRequest {
  const label = "model turn invocation";
  const fields = captureCapabilityRecord(fieldsRaw, INVOCATION_FIELD_KEYS, INVOCATION_FIELD_KEYS, label);
  const context = snapshotWorkerNodeTurnContext(fields.context, `${label} context`);
  const bindingRef = validateSwitchyardNodeBindingRef(fields.bindingRef, `${label} binding ref`);
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
    invoke: (request: AnyModelInvocationRequest, signal?: AbortSignal) =>
      invoke(request, signal),
    ...(compiledPrompt === undefined ? {} : { compiledPrompt })
  });
}

import { type ContractId } from "../contracts/artifact.js";
import type { MissionPipelineNodeBindingRef } from "../graph/definition.js";
import type { PersonaRef, PromptStackRef } from "../prompt/contracts.js";
import { type VersionedDigestRef } from "../internal/guards.js";
export declare const MODEL_STAGE_BINDING_SCHEMA_VERSION = "model-stage-binding.v2";
/** Content-addressed reference to a published model revision. */
export type ModelRevisionRef = VersionedDigestRef;
export declare const THINKING_MODES: readonly ["off", "low", "medium", "high"];
export type ThinkingMode = (typeof THINKING_MODES)[number];
/**
 * The CLOSED tool-policy vocabulary (promoted from the inbox literal "none").
 * Deliberately single-valued for now: pipeline model nodes are tool-less;
 * widening this enum is a contract change reviewed with the gate/agent kinds,
 * never something a binding can smuggle in (unknown values fail closed).
 */
export declare const TOOL_POLICIES: readonly ["none"];
export type ToolPolicy = (typeof TOOL_POLICIES)[number];
export declare const INFERENCE_TIMEOUT_BOUNDS: Readonly<{
    min: 1000;
    max: 3600000;
}>;
export declare const MAX_INFERENCE_OUTPUT_TOKENS = 10000000;
export declare const MAX_INFERENCE_OUTPUT_BYTES = 1073741824;
export declare const MAX_INFERENCE_CONCURRENCY = 64;
/**
 * The RECORDED inference parameters — the turn-identity half of an inference
 * profile. Every field is REQUIRED and the object is strict: an absent or
 * unknown recorded parameter FAILS CLOSED (no silent defaults, no silent
 * passthrough of un-modeled knobs).
 */
export interface InferenceParameters {
    temperature: number;
    seed: number;
    thinking: ThinkingMode;
    timeoutMs: number;
    maxOutputTokens: number;
    maxOutputBytes: number;
    maxConcurrency: number;
    toolPolicy: ToolPolicy;
    /** The contract the RAW model response must satisfy (host-validated). */
    responseContract: ContractId;
}
/** LOUD, FAIL-CLOSED validator for {@link InferenceParameters}. */
export declare function validateInferenceParameters(value: unknown, label?: string): InferenceParameters;
/**
 * The inference profile as RECORDED inside a binding: identity + the recorded
 * parameters, sealed by `profileDigest = digest({id, version, parameters})`.
 */
export interface InferenceProfileRef {
    id: string;
    version: number;
    parameters: InferenceParameters;
    profileDigest: string;
}
/** Seal an inference profile ref: validate LOUDLY, stamp profileDigest. */
export declare function createInferenceProfileRef(input: unknown): InferenceProfileRef;
/** LOUD validator for a SEALED profile ref (digest recomputed). */
export declare function validateInferenceProfileRef(value: unknown, label?: string): InferenceProfileRef;
export interface ModelStageBindingInput {
    schemaVersion: typeof MODEL_STAGE_BINDING_SCHEMA_VERSION;
    bindingId: string;
    version: number;
    kind: "model";
    modelRevisionRef: ModelRevisionRef;
    inferenceProfileRef: InferenceProfileRef;
    personaRef?: PersonaRef;
    promptStackRef?: PromptStackRef;
}
/** The digest-sealed model stage binding. */
export interface ModelStageBinding extends ModelStageBindingInput {
    bindingDigest: string;
}
/**
 * Seal a binding: validate LOUDLY (recorded parameters fail closed), stamp
 * `bindingDigest = digest(base)`. Any parameter/ref change produces a new
 * digest — and therefore a new node fingerprint and idempotency key.
 */
export declare function createModelStageBinding(input: unknown): ModelStageBinding;
/** LOUD validator for a SEALED binding: full shape + digest recompute. */
export declare function validateModelStageBinding(value: unknown): ModelStageBinding;
/**
 * Project a sealed binding to the content-addressed reference carried by a v2
 * model node.
 */
export declare function modelStageBindingRef(bindingRaw: unknown): MissionPipelineNodeBindingRef;
/**
 * Resolve a node's binding REF against a published sealed binding — LOUD on
 * every mismatch (kind, identity, and ABOVE ALL the digest: a ref must prove
 * it names THIS exact sealed payload).
 */
export declare function resolveModelBindingRef(ref: MissionPipelineNodeBindingRef, bindingRaw: unknown): ModelStageBinding;

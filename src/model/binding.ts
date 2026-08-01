// model/binding.ts — ModelStageBinding: the digest-sealed record binding a
// kind:"model" pipeline node to ONE model revision + ONE recorded inference
// profile (+ optional persona/prompt-stack identity).
//
// PROMOTED from inbox-pipeline/src/runtime/contracts.ts ModelStageBinding
// (the sealed {bindingId, version, kind:"model", refs…, bindingDigest} shape)
// MERGED with the recorded half of src/catalog/contracts.ts InferenceProfile
// (temperature/seed/thinking/timeoutMs/maxOutputTokens/maxOutputBytes/
// maxConcurrency/toolPolicy/responseContract — the run-identity parameters).
// CHANGES in the promotion (the reason this is …v2, mirroring the
// pipeline-definition v1→v2 note):
//   - the binding EMBEDS its inference profile (id/version/PARAMETERS/seal)
//     instead of referencing a catalog row by digest alone: the recorded
//     parameters travel inside the sealed payload, so ANY parameter change
//     changes bindingDigest — and therefore the compiled node's
//     bindingFingerprint and the B3 idempotency key;
//   - `model` is renamed `modelRevisionRef` (the design vocabulary);
//   - persona/promptStack flip to OPTIONAL (`personaRef?`/`promptStackRef?`) —
//     the inbox required both while inferenceProfile was optional; here the
//     profile is REQUIRED (fail closed: no silent deployment defaults) and
//     prompt identity is required only when the stage uses a compiled prompt;
//   - UNKNOWN RECORDED PARAMETERS FAIL CLOSED: the parameter object is strict
//     (an unrecognized key throws), every parameter is REQUIRED, and the
//     thinking/toolPolicy vocabularies are closed enums — widening them is a
//     deliberate contract change, never a passthrough;
//   - the inbox profile's deployment half (runtimeHostRef, endpointRef,
//     networkZone, credentialRef) stays HOST-side: endpoints and credentials
//     are resolver concerns, not run identity.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { digest } from "../contracts/digest.js";
import { validateContractId, type ContractId } from "../contracts/artifact.js";
import type { PipelineNodeBindingRef } from "../definition.js";
import type { PersonaRef, PromptStackRef } from "../prompt/contracts.js";
import {
  assertEnum,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  assertVersionedRef,
  typeName,
  truncate,
  type VersionedDigestRef
} from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";

export const MODEL_STAGE_BINDING_SCHEMA_VERSION = "model-stage-binding.v2";

/** Content-addressed reference to a published model revision. */
export type ModelRevisionRef = VersionedDigestRef;

export const THINKING_MODES = ["off", "low", "medium", "high"] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];

/**
 * The CLOSED tool-policy vocabulary (promoted from the inbox literal "none").
 * Deliberately single-valued for now: pipeline model nodes are tool-less;
 * widening this enum is a contract change reviewed with the gate/agent kinds,
 * never something a binding can smuggle in (unknown values fail closed).
 */
export const TOOL_POLICIES = ["none"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];

export const INFERENCE_TIMEOUT_BOUNDS = Object.freeze({ min: 1_000, max: 3_600_000 });
export const MAX_INFERENCE_OUTPUT_TOKENS = 10_000_000;
export const MAX_INFERENCE_OUTPUT_BYTES = 1_073_741_824;
export const MAX_INFERENCE_CONCURRENCY = 64;

/**
 * The RECORDED inference parameters — the run-identity half of an inference
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

const PARAMETER_KEYS = new Set([
  "temperature",
  "seed",
  "thinking",
  "timeoutMs",
  "maxOutputTokens",
  "maxOutputBytes",
  "maxConcurrency",
  "toolPolicy",
  "responseContract"
]);

function assertBoundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}: must be an integer in ${min}..${max} (got ${typeName(value) === "number" ? String(value) : typeName(value)})`);
  }
  return value;
}

/** LOUD, FAIL-CLOSED validator for {@link InferenceParameters}. */
export function validateInferenceParameters(value: unknown, label = "inference parameters"): InferenceParameters {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, PARAMETER_KEYS, label);
  for (const key of PARAMETER_KEYS) {
    if (!(key in raw)) {
      throw new Error(`${label}: recorded parameter "${key}" is required (recorded parameters fail closed — no silent defaults)`);
    }
  }
  if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature) || raw.temperature < 0 || raw.temperature > 2) {
    throw new Error(`${label}: temperature must be a finite number in 0..2 (got ${typeName(raw.temperature) === "number" ? String(raw.temperature) : typeName(raw.temperature)})`);
  }
  const seed = assertBoundedInt(raw.seed, 0, Number.MAX_SAFE_INTEGER, `${label}: seed`);
  const thinking = assertEnum(raw.thinking, THINKING_MODES, `${label}: thinking`);
  const timeoutMs = assertBoundedInt(raw.timeoutMs, INFERENCE_TIMEOUT_BOUNDS.min, INFERENCE_TIMEOUT_BOUNDS.max, `${label}: timeoutMs`);
  const maxOutputTokens = assertBoundedInt(raw.maxOutputTokens, 1, MAX_INFERENCE_OUTPUT_TOKENS, `${label}: maxOutputTokens`);
  const maxOutputBytes = assertBoundedInt(raw.maxOutputBytes, 1, MAX_INFERENCE_OUTPUT_BYTES, `${label}: maxOutputBytes`);
  const maxConcurrency = assertBoundedInt(raw.maxConcurrency, 1, MAX_INFERENCE_CONCURRENCY, `${label}: maxConcurrency`);
  const toolPolicy = assertEnum(raw.toolPolicy, TOOL_POLICIES, `${label}: toolPolicy`);
  const responseContract = validateContractId(raw.responseContract, `${label}: responseContract`);
  return {
    temperature: raw.temperature,
    seed,
    thinking,
    timeoutMs,
    maxOutputTokens,
    maxOutputBytes,
    maxConcurrency,
    toolPolicy,
    responseContract
  };
}

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

const PROFILE_INPUT_KEYS = new Set(["id", "version", "parameters"]);
const PROFILE_KEYS = new Set([...PROFILE_INPUT_KEYS, "profileDigest"]);

function validateProfileBase(raw: Record<string, unknown>, label: string): Omit<InferenceProfileRef, "profileDigest"> {
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const parameters = validateInferenceParameters(raw.parameters, `${label} ${id}@${version}: parameters`);
  return { id, version, parameters };
}

/** Seal an inference profile ref: validate LOUDLY, stamp profileDigest. */
export function createInferenceProfileRef(input: unknown): InferenceProfileRef {
  const label = "inference profile";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, PROFILE_INPUT_KEYS, label);
  const base = validateProfileBase(raw, label);
  return { ...base, profileDigest: digest(base) };
}

/** LOUD validator for a SEALED profile ref (digest recomputed). */
export function validateInferenceProfileRef(value: unknown, label = "inference profile"): InferenceProfileRef {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, PROFILE_KEYS, label);
  const base = validateProfileBase(raw, label);
  const sealed = assertSha256Hex(raw.profileDigest, `${label}: profileDigest`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(`${label} ${base.id}@${base.version}: digest mismatch — sealed ${sealed} != computed ${computed}`);
  }
  return { ...base, profileDigest: sealed };
}

// ── ModelStageBinding ─────────────────────────────────────────────────────

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

const BINDING_INPUT_KEYS = new Set([
  "schemaVersion",
  "bindingId",
  "version",
  "kind",
  "modelRevisionRef",
  "inferenceProfileRef",
  "personaRef",
  "promptStackRef"
]);
const BINDING_KEYS = new Set([...BINDING_INPUT_KEYS, "bindingDigest"]);

function validateBindingBase(raw: Record<string, unknown>, label: string): ModelStageBindingInput {
  if (raw.schemaVersion !== MODEL_STAGE_BINDING_SCHEMA_VERSION) {
    throw new Error(
      `${label}: schemaVersion must be ${JSON.stringify(MODEL_STAGE_BINDING_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`
    );
  }
  const bindingId = assertIdentifier(raw.bindingId, `${label}: bindingId`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identityLabel = `${label} ${bindingId}@${version}`;
  if (raw.kind !== "model") {
    const got = typeof raw.kind === "string" ? JSON.stringify(truncate(raw.kind)) : typeName(raw.kind);
    throw new Error(`${identityLabel}: kind must be "model" (got ${got})`);
  }
  const modelRevisionRef = assertVersionedRef(raw.modelRevisionRef, `${identityLabel}: modelRevisionRef`);
  const inferenceProfileRef = validateInferenceProfileRef(raw.inferenceProfileRef, `${identityLabel}: inferenceProfileRef`);
  const base: ModelStageBindingInput = {
    schemaVersion: MODEL_STAGE_BINDING_SCHEMA_VERSION,
    bindingId,
    version,
    kind: "model",
    modelRevisionRef,
    inferenceProfileRef
  };
  if ("personaRef" in raw) {
    if (raw.personaRef === undefined) {
      throw new Error(`${identityLabel}: personaRef is present but undefined (omit the key instead)`);
    }
    base.personaRef = assertVersionedRef(raw.personaRef, `${identityLabel}: personaRef`);
  }
  if ("promptStackRef" in raw) {
    if (raw.promptStackRef === undefined) {
      throw new Error(`${identityLabel}: promptStackRef is present but undefined (omit the key instead)`);
    }
    base.promptStackRef = assertVersionedRef(raw.promptStackRef, `${identityLabel}: promptStackRef`);
  }
  return base;
}

/**
 * Seal a binding: validate LOUDLY (recorded parameters fail closed), stamp
 * `bindingDigest = digest(base)`. Any parameter/ref change produces a new
 * digest — and therefore a new compiled bindingFingerprint and idempotency key.
 */
export function createModelStageBinding(input: unknown): ModelStageBinding {
  const label = "model stage binding";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, BINDING_INPUT_KEYS, label);
  const base = validateBindingBase(raw, label);
  return { ...base, bindingDigest: digest(base) };
}

/** LOUD validator for a SEALED binding: full shape + digest recompute. */
export function validateModelStageBinding(value: unknown): ModelStageBinding {
  const label = "model stage binding";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BINDING_KEYS, label);
  const base = validateBindingBase(raw, label);
  const sealed = assertSha256Hex(raw.bindingDigest, `${label}: bindingDigest`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(
      `${label} ${base.bindingId}@${base.version}: digest mismatch — sealed ${sealed} != computed ${computed}`
    );
  }
  return { ...base, bindingDigest: sealed };
}

/**
 * Project a sealed binding to the {@link PipelineNodeBindingRef} a definition
 * node carries (`{ kind:"model", bindingId, version, bindingDigest }`) — the
 * compiler stamps `bindingDigest` into the compiled node as
 * `bindingFingerprint`.
 */
export function modelStageBindingRef(bindingRaw: unknown): PipelineNodeBindingRef {
  const binding = validateModelStageBinding(bindingRaw);
  return { kind: "model", bindingId: binding.bindingId, version: binding.version, bindingDigest: binding.bindingDigest };
}

/**
 * Resolve a node's binding REF against a published sealed binding — LOUD on
 * every mismatch (kind, identity, and ABOVE ALL the digest: a ref must prove
 * it names THIS exact sealed payload).
 */
export function resolveModelBindingRef(ref: PipelineNodeBindingRef, bindingRaw: unknown): ModelStageBinding {
  ref = deepFrozenClone(ref, "model binding resolution ref");
  const binding = validateModelStageBinding(bindingRaw);
  if (ref.kind !== "model") {
    throw new Error(`model binding resolution: ref kind must be "model" (got ${JSON.stringify(ref.kind)})`);
  }
  if (ref.bindingId !== binding.bindingId || ref.version !== binding.version) {
    throw new Error(
      `model binding resolution: ref ${ref.bindingId}@${ref.version} does not name binding ${binding.bindingId}@${binding.version}`
    );
  }
  if (ref.bindingDigest !== binding.bindingDigest) {
    throw new Error(
      `model binding resolution: digest mismatch for ${binding.bindingId}@${binding.version} — ref ${ref.bindingDigest} != sealed ${binding.bindingDigest}`
    );
  }
  return binding;
}

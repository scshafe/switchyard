// node.ts — the B2 node model: StageDescriptor (the typed, versioned identity
// of a pipeline stage) and the CodeStage executable shape.
//
// PROMOTED from inbox-pipeline/src/runtime/stage-registry.ts
// (StageDescriptorSchema: 1..16 unique input slots, the "`none` cannot be
// combined with another capability" rule, the bindingKind vocabulary
// none|model|decision) and src/stage.ts (the `{ id, version, run }` executable
// shape), DE-ZOD-ED to plain TS types + hand-written LOUD validators.
// NEW in the promotion:
//   - `kind: "code" | "model" | "agent" | "gate"` — the four node kinds of the
//     mission-pipeline design. `bindingKind` is now DERIVED from kind
//     (model ⇒ "model", gate ⇒ "decision", code/agent ⇒ "none"); an explicit
//     bindingKind must agree or the validator throws.
//   - `deliverySemantics: "at_most_once" | "at_least_once_idempotent"`
//     (required — the durable executor in B3 keys retry/idempotency policy on
//     it).
//   - `configurationFingerprint?` (sha256) moves from the inbox Stage object
//     onto the descriptor — configuration identity is catalog data, not code.
//   - contract validation moves OUT of stages INTO the executor via the
//     injected ContractValidator port (catalog.ts): `CodeStage.run` receives
//     already-validated input, so the inbox `runStage` input/output Zod-parse
//     wrapper is retired. Stages carry NO schema objects.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { validateContractId, type ContractId } from "./contracts/artifact.js";
import {
  assertEnum,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  typeName
} from "./internal/guards.js";

export { IDENTIFIER_PATTERN, IDENTIFIER_MIN_LENGTH, IDENTIFIER_MAX_LENGTH } from "./internal/guards.js";

/** The four node kinds of the mission-pipeline design (DESIGN §Node model). */
export const STAGE_KINDS = ["code", "model", "agent", "gate"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

/** Promoted inbox vocabulary; now derived from {@link StageKind}. */
export const STAGE_BINDING_KINDS = ["none", "model", "decision"] as const;
export type StageBindingKind = (typeof STAGE_BINDING_KINDS)[number];

/**
 * kind → the ONE bindingKind it implies: a model stage executes through a
 * digest-sealed model binding, a gate through a decision-flow binding, and
 * code/agent stages bind nothing. Kept as an explicit (redundant) descriptor
 * field so persisted descriptors read unambiguously — the validator derives it
 * when absent and rejects any conflicting explicit value.
 */
export const CANONICAL_BINDING_KIND: Record<StageKind, StageBindingKind> = {
  code: "none",
  model: "model",
  agent: "none",
  gate: "decision"
};

export const DELIVERY_SEMANTICS = ["at_most_once", "at_least_once_idempotent"] as const;
export type DeliverySemantics = (typeof DELIVERY_SEMANTICS)[number];

export const MAX_STAGE_INPUTS = 16;
export const MAX_STAGE_CAPABILITIES = 8;

/** One named, typed input slot of a stage. */
export interface StageInputSlot {
  slot: string;
  contract: ContractId;
}

/** What callers hand to {@link validateStageDescriptor} / StageCatalog.register. */
export interface StageDescriptorInput {
  stageId: string;
  version: number;
  kind: StageKind;
  inputs: readonly StageInputSlot[];
  outputContract: string;
  capabilities?: readonly string[];
  bindingKind?: StageBindingKind;
  deliverySemantics: DeliverySemantics;
  configurationFingerprint?: string;
}

/**
 * The NORMALIZED, validated stage descriptor: `capabilities` defaults to
 * `["none"]` and `bindingKind` is always present (derived from `kind`).
 */
export interface StageDescriptor {
  stageId: string;
  version: number;
  kind: StageKind;
  inputs: StageInputSlot[];
  outputContract: ContractId;
  capabilities: string[];
  bindingKind: StageBindingKind;
  deliverySemantics: DeliverySemantics;
  configurationFingerprint?: string;
}

const DESCRIPTOR_KEYS = new Set([
  "stageId",
  "version",
  "kind",
  "inputs",
  "outputContract",
  "capabilities",
  "bindingKind",
  "deliverySemantics",
  "configurationFingerprint"
]);
const INPUT_SLOT_KEYS = new Set(["slot", "contract"]);

/** Stable `stageId@version` rendering used in every error message. */
export function stageIdentity(stageId: string, version: number): string {
  return `${stageId}@${version}`;
}

/**
 * LOUD validator for {@link StageDescriptor}. Returns a fresh normalized
 * descriptor (capabilities defaulted, bindingKind derived) or throws with a
 * precise message naming the stage and the offending field.
 */
export function validateStageDescriptor(value: unknown): StageDescriptor {
  const label = "stage descriptor";
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, DESCRIPTOR_KEYS, label);
  const stageId = assertIdentifier(raw.stageId, `${label}: stageId`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = stageIdentity(stageId, version);
  const kind = assertEnum(raw.kind, STAGE_KINDS, `${label} ${identity}: kind`);

  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > MAX_STAGE_INPUTS) {
    throw new Error(
      `${label} ${identity}: inputs must be an array of 1..${MAX_STAGE_INPUTS} slot bindings (got ${Array.isArray(raw.inputs) ? raw.inputs.length : typeName(raw.inputs)})`
    );
  }
  const inputs: StageInputSlot[] = raw.inputs.map((slotRaw, index) => {
    const slotLabel = `${label} ${identity}: inputs[${index}]`;
    const slotObject = assertPlainObject(slotRaw, slotLabel);
    assertStrictKeys(slotObject, INPUT_SLOT_KEYS, slotLabel);
    return {
      slot: assertIdentifier(slotObject.slot, `${slotLabel}.slot`),
      contract: validateContractId(slotObject.contract, `${slotLabel}.contract`)
    };
  });
  if (new Set(inputs.map((input) => input.slot)).size !== inputs.length) {
    throw new Error(`${label} ${identity}: input slots must be unique`);
  }

  const outputContract = validateContractId(raw.outputContract, `${label} ${identity}: outputContract`);

  let capabilities: string[];
  if (raw.capabilities === undefined) {
    capabilities = ["none"];
  } else {
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length < 1 || raw.capabilities.length > MAX_STAGE_CAPABILITIES) {
      throw new Error(
        `${label} ${identity}: capabilities must be an array of 1..${MAX_STAGE_CAPABILITIES} capability strings (got ${Array.isArray(raw.capabilities) ? raw.capabilities.length : typeName(raw.capabilities)})`
      );
    }
    capabilities = raw.capabilities.map((capability, index) =>
      assertIdentifier(capability, `${label} ${identity}: capabilities[${index}]`)
    );
    if (new Set(capabilities).size !== capabilities.length) {
      throw new Error(`${label} ${identity}: capabilities must be unique`);
    }
    if (capabilities.includes("none") && capabilities.length !== 1) {
      throw new Error(`${label} ${identity}: capability "none" cannot be combined with another capability`);
    }
  }

  const canonicalBindingKind = CANONICAL_BINDING_KIND[kind];
  if (raw.bindingKind !== undefined) {
    const explicit = assertEnum(raw.bindingKind, STAGE_BINDING_KINDS, `${label} ${identity}: bindingKind`);
    if (explicit !== canonicalBindingKind) {
      throw new Error(
        `${label} ${identity}: bindingKind "${explicit}" conflicts with kind "${kind}" (kind "${kind}" implies bindingKind "${canonicalBindingKind}")`
      );
    }
  }

  const deliverySemantics = assertEnum(raw.deliverySemantics, DELIVERY_SEMANTICS, `${label} ${identity}: deliverySemantics`);

  const descriptor: StageDescriptor = {
    stageId,
    version,
    kind,
    inputs,
    outputContract,
    capabilities,
    bindingKind: canonicalBindingKind,
    deliverySemantics
  };
  if ("configurationFingerprint" in raw) {
    if (raw.configurationFingerprint === undefined) {
      throw new Error(`${label} ${identity}: configurationFingerprint is present but undefined (omit the key instead)`);
    }
    descriptor.configurationFingerprint = assertSha256Hex(
      raw.configurationFingerprint,
      `${label} ${identity}: configurationFingerprint`
    );
  }
  return descriptor;
}

/**
 * The per-attempt execution context the durable executor (B3) passes to a
 * stage. Deliberately minimal in B2 — every field is optional so hermetic
 * tests can call `run(input, {})`; B3 fills them in.
 */
export interface StageContext {
  /** Cooperative cancellation for this attempt. */
  readonly signal?: AbortSignal;
  /** Attempt-scoped identifiers for tracing (stamped by the executor). */
  readonly runId?: string;
  readonly itemId?: string;
  readonly attempt?: number;
}

/** The identity every registered executable carries, matching its descriptor. */
export interface StageExecutableIdentity {
  readonly id: string;
  readonly version: number;
}

/**
 * The kind:"code" executable — promoted from inbox src/stage.ts `Stage<I,O>`
 * minus the Zod input/output schemas: contract validation is the EXECUTOR's
 * job (ContractValidator port), so `run` receives already-validated input and
 * returns an output the executor validates against the descriptor's
 * outputContract.
 */
export interface CodeStage<I = unknown, O = unknown> extends StageExecutableIdentity {
  run(input: I, ctx: StageContext): Promise<O>;
}

/**
 * The executable half of an atomic catalog registration. For kind "code" this
 * is a {@link CodeStage} (run is REQUIRED — the catalog enforces it). Model /
 * agent / gate stages execute through injected ports (ModelBindingResolver,
 * AgentStepExecutor, the gate decision executor — B4+), so their registered
 * executable is the identity-bearing handle those ports resolve; it must still
 * be registered atomically with the descriptor (the parity fix).
 */
export interface StageExecutable extends StageExecutableIdentity {
  readonly run?: (input: any, ctx: StageContext) => Promise<any>;
}

/**
 * LOUD shape check for a registered executable. Executables are CODE (class
 * instances welcome), so unlike descriptors this does NOT require a plain
 * object or strict keys — only the identity fields and, when present, a
 * callable `run`.
 */
export function validateStageExecutable(value: unknown): StageExecutable {
  const label = "stage executable";
  if (value === null || typeof value !== "object") {
    throw new Error(`${label}: must be an object (got ${typeName(value)})`);
  }
  const raw = value as Record<string, unknown>;
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  if (raw.run !== undefined && typeof raw.run !== "function") {
    throw new Error(`${label} ${stageIdentity(id, version)}: run must be a function when present (got ${typeName(raw.run)})`);
  }
  return value as StageExecutable;
}

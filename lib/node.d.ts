import { type ContractId } from "./contracts/artifact.js";
export { IDENTIFIER_PATTERN, IDENTIFIER_MIN_LENGTH, IDENTIFIER_MAX_LENGTH } from "./internal/guards.js";
/** The four node kinds of the mission-pipeline design (DESIGN §Node model). */
export declare const STAGE_KINDS: readonly ["code", "model", "agent", "gate"];
export type StageKind = (typeof STAGE_KINDS)[number];
/** Promoted inbox vocabulary; now derived from {@link StageKind}. */
export declare const STAGE_BINDING_KINDS: readonly ["none", "model", "decision"];
export type StageBindingKind = (typeof STAGE_BINDING_KINDS)[number];
/**
 * kind → the ONE bindingKind it implies: a model stage executes through a
 * digest-sealed model binding, a gate through a decision-flow binding, and
 * code/agent stages bind nothing. Kept as an explicit (redundant) descriptor
 * field so persisted descriptors read unambiguously — the validator derives it
 * when absent and rejects any conflicting explicit value.
 */
export declare const CANONICAL_BINDING_KIND: Record<StageKind, StageBindingKind>;
export declare const DELIVERY_SEMANTICS: readonly ["at_most_once", "at_least_once_idempotent"];
export type DeliverySemantics = (typeof DELIVERY_SEMANTICS)[number];
export declare const MAX_STAGE_INPUTS = 16;
export declare const MAX_STAGE_CAPABILITIES = 8;
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
/** Stable `stageId@version` rendering used in every error message. */
export declare function stageIdentity(stageId: string, version: number): string;
/**
 * LOUD validator for {@link StageDescriptor}. Returns a fresh normalized
 * descriptor (capabilities defaulted, bindingKind derived) or throws with a
 * precise message naming the stage and the offending field.
 */
export declare function validateStageDescriptor(value: unknown): StageDescriptor;
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
    /**
     * Stable durable execution key. It is invariant across retries and fence
     * takeovers and is therefore the key an idempotent external operation must
     * use. It is present for every runner-owned invocation.
     */
    readonly idempotencyKey?: string;
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
export declare function validateStageExecutable(value: unknown): StageExecutable;

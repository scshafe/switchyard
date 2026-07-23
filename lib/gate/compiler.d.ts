import { type ContractId } from "../contracts/artifact.js";
import { type ModelStageBinding } from "../model/binding.js";
import { type VersionedDigestRef } from "../internal/guards.js";
import { type GateBudgetPolicyRef, type GateFlowRef, type GateFlowTransition, type GateGoalRef, type GateObjectiveRef, type GateStepBudgetTier, type GateStepOutcome, type GateValidityPolicyRef } from "./contracts.js";
import { GATE_FLOW_COMPILER_VERSION, type GateTerminationCertificate } from "./certificate.js";
export declare const COMPILED_GATE_FLOW_SCHEMA_VERSION = "compiled-gate-flow.v1";
export { GATE_FLOW_COMPILER_VERSION };
/** The promoted per-kind capability attribution (a closed 1-element tuple). */
export type GateStepCapability = "none" | "network:model";
export interface CompiledGateFlowStepCommon {
    stepId: string;
    level: {
        levelId: string;
        ordinal: number;
    };
    implementation: VersionedDigestRef;
    inputContract: ContractId;
    outputContract: ContractId;
    outcomes: GateStepOutcome[];
    /** The step's resolved budget tier (the runtime per-attempt ceilings). */
    budget: GateStepBudgetTier;
    capabilities: [GateStepCapability];
}
export type CompiledGateFlowStep = ({
    kind: "deterministic";
    capabilities: ["none"];
} & CompiledGateFlowStepCommon) | ({
    kind: "model";
    binding: ModelStageBinding;
    capabilities: ["network:model"];
} & CompiledGateFlowStepCommon) | ({
    kind: "validator";
    capabilities: ["none"];
} & CompiledGateFlowStepCommon);
export interface CompiledGateFlow {
    schemaVersion: typeof COMPILED_GATE_FLOW_SCHEMA_VERSION;
    compilerVersion: typeof GATE_FLOW_COMPILER_VERSION;
    flow: GateFlowRef;
    goal: GateGoalRef;
    objectives: GateObjectiveRef[];
    validityPolicy: GateValidityPolicyRef;
    budgetPolicy: GateBudgetPolicyRef;
    inputContract: ContractId;
    decisionContract: ContractId;
    decisionCodes: string[];
    entryStepId: string;
    /** Steps in deterministic topological order. */
    steps: CompiledGateFlowStep[];
    /** Transitions in deterministic (step-order, outcome-order) order. */
    transitions: GateFlowTransition[];
    terminationCertificate: GateTerminationCertificate;
    compiledDigest: string;
}
/**
 * Compile a gate flow against its immutable definitions. Every rejection is
 * LOUD; success mints the digest-sealed {@link GateTerminationCertificate} and
 * the digest-sealed {@link CompiledGateFlow} embedding it. Deterministic:
 * identical inputs compile to an identical sealed payload.
 */
export declare function compileGateFlow(inputRaw: unknown): CompiledGateFlow;
/**
 * LOUD validator for a sealed {@link CompiledGateFlow}: full shape validation
 * (including the embedded certificate's OWN recompute-and-verify), then the
 * compiled digest recompute — tampering anywhere throws "digest mismatch".
 */
export declare function validateCompiledGateFlow(value: unknown): CompiledGateFlow;

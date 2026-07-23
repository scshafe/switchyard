import { type GateBudgetPolicyRef, type GateFlowRef, type GateGoalRef, type GateObjectiveRef, type GateResourceBounds, type GateValidityPolicyRef } from "./contracts.js";
export declare const GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION = "gate-termination-certificate.v1";
/** The ONE compiler these certificates (and compiled flows) may name. */
export declare const GATE_FLOW_COMPILER_VERSION = "gate-flow-compiler.v1";
/**
 * The promoted proof payload. The five flags are literal `true`: the compiler
 * only mints a certificate AFTER each property is proven, so a `false` (or
 * absent) flag is not a weaker certificate — it is no certificate at all.
 */
export interface GateTerminationProof {
    entryStepId: string;
    stepCount: number;
    transitionCount: number;
    /** valid_decision + human_escalation transitions; >= 2 (one of each, minimum). */
    terminalTransitionCount: number;
    reachableStepCount: number;
    acyclic: true;
    exhaustiveOutcomes: true;
    humanFallbackForFailureOutcomes: true;
    escalationStrictlyIncreasesLevel: true;
    validDecisionRequiresValidator: true;
    /** The computed worst-case bounds (<= the budget policy limits, proven). */
    bounds: GateResourceBounds;
}
export declare function validateGateTerminationProof(value: unknown, label?: string): GateTerminationProof;
export interface GateTerminationCertificateInput {
    schemaVersion: typeof GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION;
    compilerVersion: typeof GATE_FLOW_COMPILER_VERSION;
    flow: GateFlowRef;
    goal: GateGoalRef;
    objectives: GateObjectiveRef[];
    validityPolicy: GateValidityPolicyRef;
    budgetPolicy: GateBudgetPolicyRef;
    proof: GateTerminationProof;
}
/** The digest-sealed termination certificate. */
export interface GateTerminationCertificate extends GateTerminationCertificateInput {
    certificateDigest: string;
}
/**
 * Seal a certificate payload (compiler-internal — hosts never mint
 * certificates; they receive them inside compiled flows and VALIDATE them).
 */
export declare function createGateTerminationCertificate(input: unknown): GateTerminationCertificate;
/**
 * The recompute-and-verify validator: full shape validation, then
 * `certificateDigest` MUST equal the recomputed canonical digest of the
 * payload — tampering with any field (a count, a flag, a bound, a ref) throws
 * "digest mismatch". Never trust a certificate you did not validate.
 */
export declare function validateGateTerminationCertificate(value: unknown): GateTerminationCertificate;

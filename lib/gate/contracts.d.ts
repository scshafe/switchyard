import { type ContractId } from "../contracts/artifact.js";
import { type ModelStageBinding } from "../model/binding.js";
import { type VersionedDigestRef } from "../internal/guards.js";
export declare const GATE_GOAL_SCHEMA_VERSION = "gate-goal-definition.v1";
export declare const GATE_OBJECTIVE_SCHEMA_VERSION = "gate-objective-definition.v1";
export declare const GATE_VALIDITY_POLICY_SCHEMA_VERSION = "gate-validity-policy.v1";
export declare const GATE_BUDGET_POLICY_SCHEMA_VERSION = "gate-budget-policy.v1";
export declare const GATE_FLOW_SCHEMA_VERSION = "gate-flow-definition.v1";
export declare const MAX_GATE_DESCRIPTION = 1000;
export declare const MAX_GATE_SHORT_DESCRIPTION = 500;
export declare const MAX_GATE_DECISION_CODES = 64;
export declare const MAX_GATE_OBJECTIVES = 32;
export declare const MAX_GATE_GUARDRAILS = 16;
export declare const MAX_GATE_BUDGET_TIERS = 64;
export declare const MAX_GATE_LEVELS = 32;
export declare const MAX_GATE_STEPS = 128;
export declare const MAX_GATE_TRANSITIONS = 4096;
export declare const MIN_GATE_STEP_OUTCOMES = 2;
export declare const MAX_GATE_STEP_OUTCOMES = 32;
export declare const MAX_GATE_LEVEL_ORDINAL = 255;
/** Content-addressed `{ id, version, digest }` references (promoted shape). */
export type GateGoalRef = VersionedDigestRef;
export type GateObjectiveRef = VersionedDigestRef;
export type GateValidityPolicyRef = VersionedDigestRef;
export type GateBudgetPolicyRef = VersionedDigestRef;
export type GateFlowRef = VersionedDigestRef;
/** Names a HOST-CODE implementation revision (deterministic/validator step code). */
export type GateImplementationRef = VersionedDigestRef;
/** The promoted `id\0version` identity key for reference-uniqueness rules. */
export declare function gateReferenceKey(reference: {
    id: string;
    version: number;
}): string;
export interface GateGoalDefinitionInput {
    schemaVersion: typeof GATE_GOAL_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    /** The question the gate answers about one input artifact. */
    question: string;
    inputContract: ContractId;
    /** The contract of a VALID decision artifact. */
    decisionContract: ContractId;
    /** The closed vocabulary of decision codes a valid decision may carry. */
    decisionCodes: string[];
}
/** The digest-sealed gate goal. */
export interface GateGoalDefinition extends GateGoalDefinitionInput {
    goalDigest: string;
}
/** Seal a gate goal: validate LOUDLY, stamp `goalDigest = digest(base)`. */
export declare function createGateGoalDefinition(input: unknown): GateGoalDefinition;
/** LOUD validator for a SEALED gate goal (digest recomputed). */
export declare function validateGateGoalDefinition(value: unknown): GateGoalDefinition;
/** Project a sealed goal to its `{ id, version, digest }` reference. */
export declare function gateGoalRef(goalRaw: unknown): GateGoalRef;
/** The promoted closed metric vocabulary. */
export declare const GATE_METRICS: readonly ["false_negative_rate", "false_positive_rate", "recall", "precision", "specificity", "accuracy", "human_escalation_rate"];
export type GateMetric = (typeof GATE_METRICS)[number];
export declare const GATE_METRIC_DIRECTIONS_VOCABULARY: readonly ["minimize", "maximize"];
export type GateMetricDirection = (typeof GATE_METRIC_DIRECTIONS_VOCABULARY)[number];
/** The promoted metric → required-direction table (a metric cannot be gamed by flipping its direction). */
export declare const GATE_METRIC_DIRECTIONS: Record<GateMetric, GateMetricDirection>;
export interface GateMetricTarget {
    metric: GateMetric;
    direction: GateMetricDirection;
    threshold?: number;
}
export interface GateMetricGuardrail {
    metric: GateMetric;
    direction: GateMetricDirection;
    threshold: number;
}
export interface GateEvidenceGate {
    minimumPositiveLabels: number;
    minimumNegativeLabels: number;
    minimumTotalLabels: number;
    confidenceLevel: number;
}
export interface GateObjectiveDefinitionInput {
    schemaVersion: typeof GATE_OBJECTIVE_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    goal: GateGoalRef;
    targetDecisionCode: string;
    primary: GateMetricTarget;
    guardrails: GateMetricGuardrail[];
    evidenceGate: GateEvidenceGate;
    /** The promoted mandatory abstention arm: uncertainty escalates to a human. */
    abstention: {
        disposition: "human_escalation";
        reasonCode: string;
    };
}
export interface GateObjectiveDefinition extends GateObjectiveDefinitionInput {
    objectiveDigest: string;
}
export declare function createGateObjectiveDefinition(input: unknown): GateObjectiveDefinition;
export declare function validateGateObjectiveDefinition(value: unknown): GateObjectiveDefinition;
export declare function gateObjectiveRef(objectiveRaw: unknown): GateObjectiveRef;
/** The promoted closed check vocabulary. */
export declare const GATE_VALIDITY_CHECKS: readonly ["output_contract", "decision_code", "evidence_authority", "source_freshness", "objective_guardrails"];
export type GateValidityCheck = (typeof GATE_VALIDITY_CHECKS)[number];
export interface GateValidityPolicyInput {
    schemaVersion: typeof GATE_VALIDITY_POLICY_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    goal: GateGoalRef;
    /** The ONE host-code validator implementation valid decisions must pass through. */
    validatorImplementation: GateImplementationRef;
    requiredChecks: GateValidityCheck[];
    failureReasonCode: string;
}
export interface GateValidityPolicy extends GateValidityPolicyInput {
    policyDigest: string;
}
export declare function createGateValidityPolicy(input: unknown): GateValidityPolicy;
export declare function validateGateValidityPolicy(value: unknown): GateValidityPolicy;
export declare function gateValidityPolicyRef(policyRaw: unknown): GateValidityPolicyRef;
export interface GateStepBudgetTier {
    tierId: string;
    maxAttempts: number;
    timeoutMs: number;
    maxTokensPerAttempt: number;
    maxCostMicroUsdPerAttempt: number;
}
export declare function validateGateStepBudgetTier(value: unknown, label?: string): GateStepBudgetTier;
/** The promoted six-dimension worst-case resource bounds. */
export interface GateResourceBounds {
    maximumPathSteps: number;
    maximumModelCalls: number;
    maximumAttempts: number;
    maximumTokens: number;
    maximumCostMicroUsd: number;
    maximumElapsedMs: number;
}
export declare function validateGateResourceBounds(value: unknown, label?: string): GateResourceBounds;
export interface GateBudgetPolicyInput {
    schemaVersion: typeof GATE_BUDGET_POLICY_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    tiers: GateStepBudgetTier[];
    limits: GateResourceBounds;
}
export interface GateBudgetPolicy extends GateBudgetPolicyInput {
    policyDigest: string;
}
export declare function createGateBudgetPolicy(input: unknown): GateBudgetPolicy;
export declare function validateGateBudgetPolicy(value: unknown): GateBudgetPolicy;
export declare function gateBudgetPolicyRef(policyRaw: unknown): GateBudgetPolicyRef;
export interface GateFlowLevel {
    levelId: string;
    /** Escalation moves STRICTLY upward through ordinals (compiler-proven). */
    ordinal: number;
    description: string;
}
export declare function validateGateFlowLevel(value: unknown, label?: string): GateFlowLevel;
export declare const GATE_STEP_OUTCOME_KINDS: readonly ["success", "failure", "uncertain"];
export type GateStepOutcomeKind = (typeof GATE_STEP_OUTCOME_KINDS)[number];
export interface GateStepOutcome {
    code: string;
    kind: GateStepOutcomeKind;
    description: string;
}
export declare function validateGateStepOutcome(value: unknown, label?: string): GateStepOutcome;
export declare const GATE_STEP_KINDS: readonly ["deterministic", "model", "validator"];
export type GateStepKind = (typeof GATE_STEP_KINDS)[number];
export interface GateFlowStepCommon {
    stepId: string;
    levelId: string;
    implementation: GateImplementationRef;
    budgetTierId: string;
    inputContract: ContractId;
    outputContract: ContractId;
    outcomes: GateStepOutcome[];
}
export type GateFlowStep = ({
    kind: "deterministic";
} & GateFlowStepCommon) | ({
    kind: "model";
    binding: ModelStageBinding;
} & GateFlowStepCommon) | ({
    kind: "validator";
} & GateFlowStepCommon);
export declare function validateGateFlowStep(value: unknown, label?: string): GateFlowStep;
export declare const GATE_TRANSITION_KINDS: readonly ["advance", "internal_escalation", "valid_decision", "human_escalation"];
export type GateTransitionKind = (typeof GATE_TRANSITION_KINDS)[number];
export interface GateTransitionCommon {
    sourceStepId: string;
    outcomeCode: string;
}
export type GateFlowTransition = ({
    kind: "advance";
    targetStepId: string;
} & GateTransitionCommon) | ({
    kind: "internal_escalation";
    targetStepId: string;
} & GateTransitionCommon) | ({
    kind: "valid_decision";
    decisionContract: ContractId;
} & GateTransitionCommon) | ({
    kind: "human_escalation";
    reasonCode: string;
} & GateTransitionCommon);
export declare function validateGateFlowTransition(value: unknown, label?: string): GateFlowTransition;
export interface GateFlowDefinitionInput {
    schemaVersion: typeof GATE_FLOW_SCHEMA_VERSION;
    id: string;
    version: number;
    description: string;
    goal: GateGoalRef;
    objectives: GateObjectiveRef[];
    validityPolicy: GateValidityPolicyRef;
    budgetPolicy: GateBudgetPolicyRef;
    levels: GateFlowLevel[];
    entryStepId: string;
    steps: GateFlowStep[];
    transitions: GateFlowTransition[];
}
export interface GateFlowDefinition extends GateFlowDefinitionInput {
    flowDigest: string;
}
/** Seal a gate flow definition: validate LOUDLY, stamp `flowDigest = digest(base)`. */
export declare function createGateFlowDefinition(input: unknown): GateFlowDefinition;
/** LOUD validator for a SEALED gate flow definition (digest recomputed). */
export declare function validateGateFlowDefinition(value: unknown): GateFlowDefinition;
export declare function gateFlowRef(flowRaw: unknown): GateFlowRef;
export interface GateFlowCompilationInput {
    flow: GateFlowDefinition;
    goal: GateGoalDefinition;
    objectives: GateObjectiveDefinition[];
    validityPolicy: GateValidityPolicy;
    budgetPolicy: GateBudgetPolicy;
}
export declare function validateGateFlowCompilationInput(value: unknown): GateFlowCompilationInput;

// gate/contracts.ts — the decision-flow vocabulary of the kind:"gate" node:
// digest-sealed goal / objective / validity-policy / budget-policy / flow
// definitions, flow steps (deterministic | model | validator), and the CLOSED
// transition vocabulary (advance | internal_escalation | valid_decision |
// human_escalation).
//
// PROMOTED from inbox-pipeline/src/decision/contracts.ts (the whole
// hierarchical decision vocabulary: versioned {id, version, digest} refs; the
// sealed definition shapes with their create*/ref projections; the metric
// direction table; the evidence gate; the two-terminal transition vocabulary;
// every uniqueness/refinement rule), DE-ZOD-ED to plain TS types +
// hand-written LOUD validators.
// CHANGES in the promotion:
//   - the module is named GATE, not decision (design critique finding 13 —
//     another system owned a "decision ledger"; the pipeline node kind is
//     "gate"), so the vocabulary is Gate* and the schema versions are
//     gate-*.v1. The TRANSITION vocabulary is kept EXACT (advance |
//     internal_escalation | valid_decision | human_escalation) and the goal
//     still speaks decisionContract/decisionCodes — a gate PRODUCES a
//     decision; only the module identity changed;
//   - model steps embed the package's sealed ModelStageBinding v2
//     (model/binding.ts) instead of the inbox v1 binding: v2 REQUIRES the
//     recorded inference profile, so the inbox "decision model binding
//     requires an exact inference profile" refinement is now STRUCTURAL —
//     a profile-less binding cannot be sealed at all;
//   - micro-USD spellings are normalized to the package convention
//     (maxCostMicroUsdPerAttempt / maximumCostMicroUsd — the inbox wrote
//     "Microusd");
//   - identifiers use the package identifier grammar (internal/guards.ts —
//     byte-identical to the inbox DecisionIdentifierSchema).
//
// The module carries NO authorization-granting vocabulary: a field that lets a
// flow authorize its own externalization is not representable — every object is
// strict-keyed (unknown keys throw), the transition kinds are a closed enum,
// and the ONLY terminals are valid_decision and human_escalation.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { digest } from "../contracts/digest.js";
import { validateContractId, type ContractId } from "../contracts/artifact.js";
import { validateModelStageBinding, type ModelStageBinding } from "../model/binding.js";
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

export const GATE_GOAL_SCHEMA_VERSION = "gate-goal-definition.v1";
export const GATE_OBJECTIVE_SCHEMA_VERSION = "gate-objective-definition.v1";
export const GATE_VALIDITY_POLICY_SCHEMA_VERSION = "gate-validity-policy.v1";
export const GATE_BUDGET_POLICY_SCHEMA_VERSION = "gate-budget-policy.v1";
export const GATE_FLOW_SCHEMA_VERSION = "gate-flow-definition.v1";

export const MAX_GATE_DESCRIPTION = 1_000;
export const MAX_GATE_SHORT_DESCRIPTION = 500;
export const MAX_GATE_DECISION_CODES = 64;
export const MAX_GATE_OBJECTIVES = 32;
export const MAX_GATE_GUARDRAILS = 16;
export const MAX_GATE_BUDGET_TIERS = 64;
export const MAX_GATE_LEVELS = 32;
export const MAX_GATE_STEPS = 128;
export const MAX_GATE_TRANSITIONS = 4_096;
export const MIN_GATE_STEP_OUTCOMES = 2;
export const MAX_GATE_STEP_OUTCOMES = 32;
export const MAX_GATE_LEVEL_ORDINAL = 255;

/** Content-addressed `{ id, version, digest }` references (promoted shape). */
export type GateGoalRef = VersionedDigestRef;
export type GateObjectiveRef = VersionedDigestRef;
export type GateValidityPolicyRef = VersionedDigestRef;
export type GateBudgetPolicyRef = VersionedDigestRef;
export type GateFlowRef = VersionedDigestRef;
/** Names a HOST-CODE implementation revision (deterministic/validator step code). */
export type GateImplementationRef = VersionedDigestRef;

// ── Shared LOUD helpers ───────────────────────────────────────────────────

function assertTrimmedText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label}: must be a string (got ${typeName(value)})`);
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new Error(`${label}: must be 1..${max} chars after trimming (got ${trimmed.length})`);
  }
  return trimmed;
}

function assertBoundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${label}: must be an integer in ${min}..${max} (got ${typeName(value) === "number" ? String(value) : typeName(value)})`
    );
  }
  return value;
}

function assertUnitInterval(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `${label}: must be a finite number in ${min}..${max} (got ${typeName(value) === "number" ? String(value) : typeName(value)})`
    );
  }
  return value;
}

function assertArray(value: unknown, min: number, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(
      `${label}: must be an array of ${min}..${max} entries (got ${Array.isArray(value) ? value.length : typeName(value)})`
    );
  }
  return value;
}

function assertSchemaVersion(raw: Record<string, unknown>, expected: string, label: string): void {
  if (raw.schemaVersion !== expected) {
    throw new Error(
      `${label}: schemaVersion must be ${JSON.stringify(expected)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`
    );
  }
}

function assertSealedDigest(
  raw: Record<string, unknown>,
  digestKey: string,
  base: object,
  identity: string,
  label: string
): string {
  const sealed = assertSha256Hex(raw[digestKey], `${label}: ${digestKey}`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(`${label} ${identity}: digest mismatch — sealed ${sealed} != computed ${computed}`);
  }
  return sealed;
}

/** The promoted `id\0version` identity key for reference-uniqueness rules. */
export function gateReferenceKey(reference: { id: string; version: number }): string {
  reference = deepFrozenClone(reference, "gate reference");
  return `${reference.id}\u0000${reference.version}`;
}

// ── Gate goal ─────────────────────────────────────────────────────────────

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

const GOAL_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "description",
  "question",
  "inputContract",
  "decisionContract",
  "decisionCodes"
]);
const GOAL_KEYS = new Set([...GOAL_INPUT_KEYS, "goalDigest"]);

function validateGoalBase(raw: Record<string, unknown>, label: string): GateGoalDefinitionInput {
  assertSchemaVersion(raw, GATE_GOAL_SCHEMA_VERSION, label);
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = `${label} ${id}@${version}`;
  const description = assertTrimmedText(raw.description, MAX_GATE_DESCRIPTION, `${identity}: description`);
  const question = assertTrimmedText(raw.question, MAX_GATE_DESCRIPTION, `${identity}: question`);
  const inputContract = validateContractId(raw.inputContract, `${identity}: inputContract`);
  const decisionContract = validateContractId(raw.decisionContract, `${identity}: decisionContract`);
  const decisionCodes = assertArray(raw.decisionCodes, 1, MAX_GATE_DECISION_CODES, `${identity}: decisionCodes`).map(
    (code, index) => assertIdentifier(code, `${identity}: decisionCodes[${index}]`)
  );
  if (new Set(decisionCodes).size !== decisionCodes.length) {
    throw new Error(`${identity}: gate goal decision codes must be unique`);
  }
  return { schemaVersion: GATE_GOAL_SCHEMA_VERSION, id, version, description, question, inputContract, decisionContract, decisionCodes };
}

/** Seal a gate goal: validate LOUDLY, stamp `goalDigest = digest(base)`. */
export function createGateGoalDefinition(input: unknown): GateGoalDefinition {
  const label = "gate goal";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, GOAL_INPUT_KEYS, label);
  const base = validateGoalBase(raw, label);
  return { ...base, goalDigest: digest(base) };
}

/** LOUD validator for a SEALED gate goal (digest recomputed). */
export function validateGateGoalDefinition(value: unknown): GateGoalDefinition {
  const label = "gate goal";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, GOAL_KEYS, label);
  const base = validateGoalBase(raw, label);
  const sealed = assertSealedDigest(raw, "goalDigest", base, `${base.id}@${base.version}`, label);
  return { ...base, goalDigest: sealed };
}

/** Project a sealed goal to its `{ id, version, digest }` reference. */
export function gateGoalRef(goalRaw: unknown): GateGoalRef {
  const goal = validateGateGoalDefinition(goalRaw);
  return { id: goal.id, version: goal.version, digest: goal.goalDigest };
}

// ── Gate objective (metrics + evidence gate + mandatory abstention) ───────

/** The promoted closed metric vocabulary. */
export const GATE_METRICS = [
  "false_negative_rate",
  "false_positive_rate",
  "recall",
  "precision",
  "specificity",
  "accuracy",
  "human_escalation_rate"
] as const;
export type GateMetric = (typeof GATE_METRICS)[number];

export const GATE_METRIC_DIRECTIONS_VOCABULARY = ["minimize", "maximize"] as const;
export type GateMetricDirection = (typeof GATE_METRIC_DIRECTIONS_VOCABULARY)[number];

/** The promoted metric → required-direction table (a metric cannot be gamed by flipping its direction). */
export const GATE_METRIC_DIRECTIONS: Record<GateMetric, GateMetricDirection> = {
  false_negative_rate: "minimize",
  false_positive_rate: "minimize",
  recall: "maximize",
  precision: "maximize",
  specificity: "maximize",
  accuracy: "maximize",
  human_escalation_rate: "minimize"
};

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
  abstention: { disposition: "human_escalation"; reasonCode: string };
}

export interface GateObjectiveDefinition extends GateObjectiveDefinitionInput {
  objectiveDigest: string;
}

const OBJECTIVE_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "description",
  "goal",
  "targetDecisionCode",
  "primary",
  "guardrails",
  "evidenceGate",
  "abstention"
]);
const OBJECTIVE_KEYS = new Set([...OBJECTIVE_INPUT_KEYS, "objectiveDigest"]);
const METRIC_TARGET_KEYS = new Set(["metric", "direction", "threshold"]);
const METRIC_GUARDRAIL_KEYS = new Set(["metric", "direction", "threshold"]);
const EVIDENCE_GATE_KEYS = new Set([
  "minimumPositiveLabels",
  "minimumNegativeLabels",
  "minimumTotalLabels",
  "confidenceLevel"
]);
const ABSTENTION_KEYS = new Set(["disposition", "reasonCode"]);

function validateMetricDirection(metric: GateMetric, direction: unknown, label: string): GateMetricDirection {
  const validated = assertEnum(direction, GATE_METRIC_DIRECTIONS_VOCABULARY, `${label}.direction`);
  if (validated !== GATE_METRIC_DIRECTIONS[metric]) {
    throw new Error(`${label}: ${metric} must be ${GATE_METRIC_DIRECTIONS[metric]}`);
  }
  return validated;
}

function validateObjectiveBase(raw: Record<string, unknown>, label: string): GateObjectiveDefinitionInput {
  assertSchemaVersion(raw, GATE_OBJECTIVE_SCHEMA_VERSION, label);
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = `${label} ${id}@${version}`;
  const description = assertTrimmedText(raw.description, MAX_GATE_DESCRIPTION, `${identity}: description`);
  const goal = assertVersionedRef(raw.goal, `${identity}: goal`);
  const targetDecisionCode = assertIdentifier(raw.targetDecisionCode, `${identity}: targetDecisionCode`);

  const primaryRaw = assertPlainObject(raw.primary, `${identity}: primary`);
  assertStrictKeys(primaryRaw, METRIC_TARGET_KEYS, `${identity}: primary`);
  const primaryMetric = assertEnum(primaryRaw.metric, GATE_METRICS, `${identity}: primary.metric`);
  const primary: GateMetricTarget = {
    metric: primaryMetric,
    direction: validateMetricDirection(primaryMetric, primaryRaw.direction, `${identity}: primary`)
  };
  if ("threshold" in primaryRaw) {
    if (primaryRaw.threshold === undefined) {
      throw new Error(`${identity}: primary.threshold is present but undefined (omit the key instead)`);
    }
    primary.threshold = assertUnitInterval(primaryRaw.threshold, 0, 1, `${identity}: primary.threshold`);
  }

  const guardrails = assertArray(raw.guardrails, 1, MAX_GATE_GUARDRAILS, `${identity}: guardrails`).map(
    (guardrailRaw, index): GateMetricGuardrail => {
      const guardrailLabel = `${identity}: guardrails[${index}]`;
      const guardrailObject = assertPlainObject(guardrailRaw, guardrailLabel);
      assertStrictKeys(guardrailObject, METRIC_GUARDRAIL_KEYS, guardrailLabel);
      const metric = assertEnum(guardrailObject.metric, GATE_METRICS, `${guardrailLabel}.metric`);
      return {
        metric,
        direction: validateMetricDirection(metric, guardrailObject.direction, guardrailLabel),
        threshold: assertUnitInterval(guardrailObject.threshold, 0, 1, `${guardrailLabel}.threshold`)
      };
    }
  );
  const guardrailMetrics = guardrails.map((guardrail) => guardrail.metric);
  if (new Set(guardrailMetrics).size !== guardrailMetrics.length) {
    throw new Error(`${identity}: objective guardrail metrics must be unique`);
  }
  if (guardrailMetrics.includes(primary.metric)) {
    throw new Error(
      `${identity}: primary metric thresholds belong on the primary metric, not a duplicate guardrail`
    );
  }

  const evidenceRaw = assertPlainObject(raw.evidenceGate, `${identity}: evidenceGate`);
  assertStrictKeys(evidenceRaw, EVIDENCE_GATE_KEYS, `${identity}: evidenceGate`);
  const evidenceGate: GateEvidenceGate = {
    minimumPositiveLabels: assertBoundedInt(evidenceRaw.minimumPositiveLabels, 1, 1_000_000, `${identity}: evidenceGate.minimumPositiveLabels`),
    minimumNegativeLabels: assertBoundedInt(evidenceRaw.minimumNegativeLabels, 1, 1_000_000, `${identity}: evidenceGate.minimumNegativeLabels`),
    minimumTotalLabels: assertBoundedInt(evidenceRaw.minimumTotalLabels, 2, 2_000_000, `${identity}: evidenceGate.minimumTotalLabels`),
    confidenceLevel: assertUnitInterval(evidenceRaw.confidenceLevel, 0.5, 0.9999, `${identity}: evidenceGate.confidenceLevel`)
  };
  if (evidenceGate.minimumTotalLabels < evidenceGate.minimumPositiveLabels + evidenceGate.minimumNegativeLabels) {
    throw new Error(`${identity}: minimum total labels must cover positive and negative label minimums`);
  }

  const abstentionRaw = assertPlainObject(raw.abstention, `${identity}: abstention`);
  assertStrictKeys(abstentionRaw, ABSTENTION_KEYS, `${identity}: abstention`);
  if (abstentionRaw.disposition !== "human_escalation") {
    const got = typeof abstentionRaw.disposition === "string" ? JSON.stringify(truncate(abstentionRaw.disposition)) : typeName(abstentionRaw.disposition);
    throw new Error(`${identity}: abstention.disposition must be "human_escalation" (got ${got})`);
  }
  const abstention = {
    disposition: "human_escalation" as const,
    reasonCode: assertIdentifier(abstentionRaw.reasonCode, `${identity}: abstention.reasonCode`)
  };

  return {
    schemaVersion: GATE_OBJECTIVE_SCHEMA_VERSION,
    id,
    version,
    description,
    goal,
    targetDecisionCode,
    primary,
    guardrails,
    evidenceGate,
    abstention
  };
}

export function createGateObjectiveDefinition(input: unknown): GateObjectiveDefinition {
  const label = "gate objective";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, OBJECTIVE_INPUT_KEYS, label);
  const base = validateObjectiveBase(raw, label);
  return { ...base, objectiveDigest: digest(base) };
}

export function validateGateObjectiveDefinition(value: unknown): GateObjectiveDefinition {
  const label = "gate objective";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, OBJECTIVE_KEYS, label);
  const base = validateObjectiveBase(raw, label);
  const sealed = assertSealedDigest(raw, "objectiveDigest", base, `${base.id}@${base.version}`, label);
  return { ...base, objectiveDigest: sealed };
}

export function gateObjectiveRef(objectiveRaw: unknown): GateObjectiveRef {
  const objective = validateGateObjectiveDefinition(objectiveRaw);
  return { id: objective.id, version: objective.version, digest: objective.objectiveDigest };
}

// ── Gate validity policy ──────────────────────────────────────────────────

/** The promoted closed check vocabulary. */
export const GATE_VALIDITY_CHECKS = [
  "output_contract",
  "decision_code",
  "evidence_authority",
  "source_freshness",
  "objective_guardrails"
] as const;
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

const VALIDITY_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "description",
  "goal",
  "validatorImplementation",
  "requiredChecks",
  "failureReasonCode"
]);
const VALIDITY_KEYS = new Set([...VALIDITY_INPUT_KEYS, "policyDigest"]);

function validateValidityBase(raw: Record<string, unknown>, label: string): GateValidityPolicyInput {
  assertSchemaVersion(raw, GATE_VALIDITY_POLICY_SCHEMA_VERSION, label);
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = `${label} ${id}@${version}`;
  const description = assertTrimmedText(raw.description, MAX_GATE_DESCRIPTION, `${identity}: description`);
  const goal = assertVersionedRef(raw.goal, `${identity}: goal`);
  const validatorImplementation = assertVersionedRef(raw.validatorImplementation, `${identity}: validatorImplementation`);
  const requiredChecks = assertArray(raw.requiredChecks, 1, GATE_VALIDITY_CHECKS.length, `${identity}: requiredChecks`).map(
    (check, index) => assertEnum(check, GATE_VALIDITY_CHECKS, `${identity}: requiredChecks[${index}]`)
  );
  if (new Set(requiredChecks).size !== requiredChecks.length) {
    throw new Error(`${identity}: validity policy checks must be unique`);
  }
  const failureReasonCode = assertIdentifier(raw.failureReasonCode, `${identity}: failureReasonCode`);
  return {
    schemaVersion: GATE_VALIDITY_POLICY_SCHEMA_VERSION,
    id,
    version,
    description,
    goal,
    validatorImplementation,
    requiredChecks,
    failureReasonCode
  };
}

export function createGateValidityPolicy(input: unknown): GateValidityPolicy {
  const label = "gate validity policy";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, VALIDITY_INPUT_KEYS, label);
  const base = validateValidityBase(raw, label);
  return { ...base, policyDigest: digest(base) };
}

export function validateGateValidityPolicy(value: unknown): GateValidityPolicy {
  const label = "gate validity policy";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, VALIDITY_KEYS, label);
  const base = validateValidityBase(raw, label);
  const sealed = assertSealedDigest(raw, "policyDigest", base, `${base.id}@${base.version}`, label);
  return { ...base, policyDigest: sealed };
}

export function gateValidityPolicyRef(policyRaw: unknown): GateValidityPolicyRef {
  const policy = validateGateValidityPolicy(policyRaw);
  return { id: policy.id, version: policy.version, digest: policy.policyDigest };
}

// ── Gate budget policy (tiers + resource bounds) ──────────────────────────

export interface GateStepBudgetTier {
  tierId: string;
  maxAttempts: number;
  timeoutMs: number;
  maxTokensPerAttempt: number;
  maxCostMicroUsdPerAttempt: number;
}

const TIER_KEYS = new Set([
  "tierId",
  "maxAttempts",
  "timeoutMs",
  "maxTokensPerAttempt",
  "maxCostMicroUsdPerAttempt"
]);

export function validateGateStepBudgetTier(value: unknown, label = "gate budget tier"): GateStepBudgetTier {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, TIER_KEYS, label);
  return {
    tierId: assertIdentifier(raw.tierId, `${label}.tierId`),
    maxAttempts: assertBoundedInt(raw.maxAttempts, 1, 20, `${label}.maxAttempts`),
    timeoutMs: assertBoundedInt(raw.timeoutMs, 100, 3_600_000, `${label}.timeoutMs`),
    maxTokensPerAttempt: assertBoundedInt(raw.maxTokensPerAttempt, 0, 2_000_000, `${label}.maxTokensPerAttempt`),
    maxCostMicroUsdPerAttempt: assertBoundedInt(raw.maxCostMicroUsdPerAttempt, 0, 1_000_000_000_000, `${label}.maxCostMicroUsdPerAttempt`)
  };
}

/** The promoted six-dimension worst-case resource bounds. */
export interface GateResourceBounds {
  maximumPathSteps: number;
  maximumModelCalls: number;
  maximumAttempts: number;
  maximumTokens: number;
  maximumCostMicroUsd: number;
  maximumElapsedMs: number;
}

const BOUNDS_KEYS = new Set([
  "maximumPathSteps",
  "maximumModelCalls",
  "maximumAttempts",
  "maximumTokens",
  "maximumCostMicroUsd",
  "maximumElapsedMs"
]);

export function validateGateResourceBounds(value: unknown, label = "gate resource bounds"): GateResourceBounds {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BOUNDS_KEYS, label);
  return {
    maximumPathSteps: assertBoundedInt(raw.maximumPathSteps, 1, 100, `${label}.maximumPathSteps`),
    maximumModelCalls: assertBoundedInt(raw.maximumModelCalls, 0, 100, `${label}.maximumModelCalls`),
    maximumAttempts: assertBoundedInt(raw.maximumAttempts, 1, 1_000, `${label}.maximumAttempts`),
    maximumTokens: assertBoundedInt(raw.maximumTokens, 0, 1_000_000, `${label}.maximumTokens`),
    maximumCostMicroUsd: assertBoundedInt(raw.maximumCostMicroUsd, 0, Number.MAX_SAFE_INTEGER, `${label}.maximumCostMicroUsd`),
    maximumElapsedMs: assertBoundedInt(raw.maximumElapsedMs, 1_000, 86_400_000, `${label}.maximumElapsedMs`)
  };
}

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

const BUDGET_INPUT_KEYS = new Set(["schemaVersion", "id", "version", "description", "tiers", "limits"]);
const BUDGET_KEYS = new Set([...BUDGET_INPUT_KEYS, "policyDigest"]);

function validateBudgetBase(raw: Record<string, unknown>, label: string): GateBudgetPolicyInput {
  assertSchemaVersion(raw, GATE_BUDGET_POLICY_SCHEMA_VERSION, label);
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = `${label} ${id}@${version}`;
  const description = assertTrimmedText(raw.description, MAX_GATE_DESCRIPTION, `${identity}: description`);
  const tiers = assertArray(raw.tiers, 1, MAX_GATE_BUDGET_TIERS, `${identity}: tiers`).map((tierRaw, index) =>
    validateGateStepBudgetTier(tierRaw, `${identity}: tiers[${index}]`)
  );
  const tierIds = tiers.map((tier) => tier.tierId);
  if (new Set(tierIds).size !== tierIds.length) {
    throw new Error(`${identity}: gate budget tier IDs must be unique`);
  }
  const limits = validateGateResourceBounds(raw.limits, `${identity}: limits`);
  return { schemaVersion: GATE_BUDGET_POLICY_SCHEMA_VERSION, id, version, description, tiers, limits };
}

export function createGateBudgetPolicy(input: unknown): GateBudgetPolicy {
  const label = "gate budget policy";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, BUDGET_INPUT_KEYS, label);
  const base = validateBudgetBase(raw, label);
  return { ...base, policyDigest: digest(base) };
}

export function validateGateBudgetPolicy(value: unknown): GateBudgetPolicy {
  const label = "gate budget policy";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BUDGET_KEYS, label);
  const base = validateBudgetBase(raw, label);
  const sealed = assertSealedDigest(raw, "policyDigest", base, `${base.id}@${base.version}`, label);
  return { ...base, policyDigest: sealed };
}

export function gateBudgetPolicyRef(policyRaw: unknown): GateBudgetPolicyRef {
  const policy = validateGateBudgetPolicy(policyRaw);
  return { id: policy.id, version: policy.version, digest: policy.policyDigest };
}

// ── Flow levels, step outcomes, steps ─────────────────────────────────────

export interface GateFlowLevel {
  levelId: string;
  /** Escalation moves STRICTLY upward through ordinals (compiler-proven). */
  ordinal: number;
  description: string;
}

const LEVEL_KEYS = new Set(["levelId", "ordinal", "description"]);

export function validateGateFlowLevel(value: unknown, label = "gate flow level"): GateFlowLevel {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, LEVEL_KEYS, label);
  return {
    levelId: assertIdentifier(raw.levelId, `${label}.levelId`),
    ordinal: assertBoundedInt(raw.ordinal, 0, MAX_GATE_LEVEL_ORDINAL, `${label}.ordinal`),
    description: assertTrimmedText(raw.description, MAX_GATE_SHORT_DESCRIPTION, `${label}.description`)
  };
}

export const GATE_STEP_OUTCOME_KINDS = ["success", "failure", "uncertain"] as const;
export type GateStepOutcomeKind = (typeof GATE_STEP_OUTCOME_KINDS)[number];

export interface GateStepOutcome {
  code: string;
  kind: GateStepOutcomeKind;
  description: string;
}

const OUTCOME_KEYS = new Set(["code", "kind", "description"]);

export function validateGateStepOutcome(value: unknown, label = "gate step outcome"): GateStepOutcome {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, OUTCOME_KEYS, label);
  return {
    code: assertIdentifier(raw.code, `${label}.code`),
    kind: assertEnum(raw.kind, GATE_STEP_OUTCOME_KINDS, `${label}.kind`),
    description: assertTrimmedText(raw.description, MAX_GATE_SHORT_DESCRIPTION, `${label}.description`)
  };
}

export const GATE_STEP_KINDS = ["deterministic", "model", "validator"] as const;
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

export type GateFlowStep =
  | ({ kind: "deterministic" } & GateFlowStepCommon)
  | ({ kind: "model"; binding: ModelStageBinding } & GateFlowStepCommon)
  | ({ kind: "validator" } & GateFlowStepCommon);

const STEP_COMMON_KEYS = [
  "kind",
  "stepId",
  "levelId",
  "implementation",
  "budgetTierId",
  "inputContract",
  "outputContract",
  "outcomes"
] as const;
const STEP_PLAIN_KEYS = new Set<string>(STEP_COMMON_KEYS);
const STEP_MODEL_KEYS = new Set<string>([...STEP_COMMON_KEYS, "binding"]);

export function validateGateFlowStep(value: unknown, label = "gate flow step"): GateFlowStep {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  const kind = assertEnum(raw.kind, GATE_STEP_KINDS, `${label}: kind`);
  assertStrictKeys(raw, kind === "model" ? STEP_MODEL_KEYS : STEP_PLAIN_KEYS, label);
  const stepId = assertIdentifier(raw.stepId, `${label}: stepId`);
  const stepLabel = `${label} ${stepId}`;
  const common: GateFlowStepCommon = {
    stepId,
    levelId: assertIdentifier(raw.levelId, `${stepLabel}: levelId`),
    implementation: assertVersionedRef(raw.implementation, `${stepLabel}: implementation`),
    budgetTierId: assertIdentifier(raw.budgetTierId, `${stepLabel}: budgetTierId`),
    inputContract: validateContractId(raw.inputContract, `${stepLabel}: inputContract`),
    outputContract: validateContractId(raw.outputContract, `${stepLabel}: outputContract`),
    outcomes: assertArray(raw.outcomes, MIN_GATE_STEP_OUTCOMES, MAX_GATE_STEP_OUTCOMES, `${stepLabel}: outcomes`).map(
      (outcomeRaw, index) => validateGateStepOutcome(outcomeRaw, `${stepLabel}: outcomes[${index}]`)
    )
  };
  const outcomeCodes = common.outcomes.map((outcome) => outcome.code);
  if (new Set(outcomeCodes).size !== outcomeCodes.length) {
    throw new Error(`${stepLabel}: gate step outcome codes must be unique`);
  }
  if (!common.outcomes.some((outcome) => outcome.kind === "failure")) {
    throw new Error(`${stepLabel}: every gate step must declare a failure outcome`);
  }
  if (kind === "model") {
    // The sealed v2 binding REQUIRES the recorded inference profile — the
    // promoted "exact inference profile" rule is structural here.
    return { kind, ...common, binding: validateModelStageBinding(raw.binding) };
  }
  return { kind, ...common };
}

// ── Transitions (the CLOSED, promoted vocabulary — nothing else exists) ───

export const GATE_TRANSITION_KINDS = [
  "advance",
  "internal_escalation",
  "valid_decision",
  "human_escalation"
] as const;
export type GateTransitionKind = (typeof GATE_TRANSITION_KINDS)[number];

export interface GateTransitionCommon {
  sourceStepId: string;
  outcomeCode: string;
}

export type GateFlowTransition =
  | ({ kind: "advance"; targetStepId: string } & GateTransitionCommon)
  | ({ kind: "internal_escalation"; targetStepId: string } & GateTransitionCommon)
  | ({ kind: "valid_decision"; decisionContract: ContractId } & GateTransitionCommon)
  | ({ kind: "human_escalation"; reasonCode: string } & GateTransitionCommon);

const TRANSITION_TARGET_KEYS = new Set(["kind", "sourceStepId", "outcomeCode", "targetStepId"]);
const TRANSITION_VALID_KEYS = new Set(["kind", "sourceStepId", "outcomeCode", "decisionContract"]);
const TRANSITION_HUMAN_KEYS = new Set(["kind", "sourceStepId", "outcomeCode", "reasonCode"]);

export function validateGateFlowTransition(value: unknown, label = "gate flow transition"): GateFlowTransition {
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  const kind = assertEnum(raw.kind, GATE_TRANSITION_KINDS, `${label}: kind`);
  const common: GateTransitionCommon = {
    sourceStepId: assertIdentifier(raw.sourceStepId, `${label}: sourceStepId`),
    outcomeCode: assertIdentifier(raw.outcomeCode, `${label}: outcomeCode`)
  };
  if (kind === "advance" || kind === "internal_escalation") {
    assertStrictKeys(raw, TRANSITION_TARGET_KEYS, label);
    return { kind, ...common, targetStepId: assertIdentifier(raw.targetStepId, `${label}: targetStepId`) };
  }
  if (kind === "valid_decision") {
    assertStrictKeys(raw, TRANSITION_VALID_KEYS, label);
    return { kind, ...common, decisionContract: validateContractId(raw.decisionContract, `${label}: decisionContract`) };
  }
  assertStrictKeys(raw, TRANSITION_HUMAN_KEYS, label);
  return { kind, ...common, reasonCode: assertIdentifier(raw.reasonCode, `${label}: reasonCode`) };
}

// ── The gate flow definition ──────────────────────────────────────────────

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

const FLOW_INPUT_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "description",
  "goal",
  "objectives",
  "validityPolicy",
  "budgetPolicy",
  "levels",
  "entryStepId",
  "steps",
  "transitions"
]);
const FLOW_KEYS = new Set([...FLOW_INPUT_KEYS, "flowDigest"]);

function validateFlowBase(raw: Record<string, unknown>, label: string): GateFlowDefinitionInput {
  assertSchemaVersion(raw, GATE_FLOW_SCHEMA_VERSION, label);
  const id = assertIdentifier(raw.id, `${label}: id`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  const identity = `${label} ${id}@${version}`;
  const description = assertTrimmedText(raw.description, MAX_GATE_DESCRIPTION, `${identity}: description`);
  const goal = assertVersionedRef(raw.goal, `${identity}: goal`);
  const objectives = assertArray(raw.objectives, 1, MAX_GATE_OBJECTIVES, `${identity}: objectives`).map(
    (objectiveRaw, index) => assertVersionedRef(objectiveRaw, `${identity}: objectives[${index}]`)
  );
  const objectiveKeys = objectives.map(gateReferenceKey);
  if (new Set(objectiveKeys).size !== objectiveKeys.length) {
    throw new Error(`${identity}: gate flow objective references must be unique`);
  }
  const validityPolicy = assertVersionedRef(raw.validityPolicy, `${identity}: validityPolicy`);
  const budgetPolicy = assertVersionedRef(raw.budgetPolicy, `${identity}: budgetPolicy`);
  const levels = assertArray(raw.levels, 1, MAX_GATE_LEVELS, `${identity}: levels`).map((levelRaw, index) =>
    validateGateFlowLevel(levelRaw, `${identity}: levels[${index}]`)
  );
  const levelIds = levels.map((level) => level.levelId);
  if (new Set(levelIds).size !== levelIds.length) {
    throw new Error(`${identity}: gate flow level IDs must be unique`);
  }
  const levelOrdinals = levels.map((level) => level.ordinal);
  if (new Set(levelOrdinals).size !== levelOrdinals.length) {
    throw new Error(`${identity}: gate flow level ordinals must be unique`);
  }
  const entryStepId = assertIdentifier(raw.entryStepId, `${identity}: entryStepId`);
  const steps = assertArray(raw.steps, 1, MAX_GATE_STEPS, `${identity}: steps`).map((stepRaw, index) =>
    validateGateFlowStep(stepRaw, `${identity}: steps[${index}]`)
  );
  const stepIds = steps.map((step) => step.stepId);
  if (new Set(stepIds).size !== stepIds.length) {
    throw new Error(`${identity}: gate flow step IDs must be unique`);
  }
  const transitions = assertArray(raw.transitions, 2, MAX_GATE_TRANSITIONS, `${identity}: transitions`).map(
    (transitionRaw, index) => validateGateFlowTransition(transitionRaw, `${identity}: transitions[${index}]`)
  );
  return {
    schemaVersion: GATE_FLOW_SCHEMA_VERSION,
    id,
    version,
    description,
    goal,
    objectives,
    validityPolicy,
    budgetPolicy,
    levels,
    entryStepId,
    steps,
    transitions
  };
}

/** Seal a gate flow definition: validate LOUDLY, stamp `flowDigest = digest(base)`. */
export function createGateFlowDefinition(input: unknown): GateFlowDefinition {
  const label = "gate flow";
  input = deepFrozenClone(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, FLOW_INPUT_KEYS, label);
  const base = validateFlowBase(raw, label);
  return { ...base, flowDigest: digest(base) };
}

/** LOUD validator for a SEALED gate flow definition (digest recomputed). */
export function validateGateFlowDefinition(value: unknown): GateFlowDefinition {
  const label = "gate flow";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, FLOW_KEYS, label);
  const base = validateFlowBase(raw, label);
  const sealed = assertSealedDigest(raw, "flowDigest", base, `${base.id}@${base.version}`, label);
  return { ...base, flowDigest: sealed };
}

export function gateFlowRef(flowRaw: unknown): GateFlowRef {
  const flow = validateGateFlowDefinition(flowRaw);
  return { id: flow.id, version: flow.version, digest: flow.flowDigest };
}

// ── The compilation input (flow + every immutable definition it names) ────

export interface GateFlowCompilationInput {
  flow: GateFlowDefinition;
  goal: GateGoalDefinition;
  objectives: GateObjectiveDefinition[];
  validityPolicy: GateValidityPolicy;
  budgetPolicy: GateBudgetPolicy;
}

const COMPILATION_INPUT_KEYS = new Set(["flow", "goal", "objectives", "validityPolicy", "budgetPolicy"]);

export function validateGateFlowCompilationInput(value: unknown): GateFlowCompilationInput {
  const label = "gate flow compilation input";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, COMPILATION_INPUT_KEYS, label);
  return {
    flow: validateGateFlowDefinition(raw.flow),
    goal: validateGateGoalDefinition(raw.goal),
    objectives: assertArray(raw.objectives, 1, MAX_GATE_OBJECTIVES, `${label}: objectives`).map((objectiveRaw) =>
      validateGateObjectiveDefinition(objectiveRaw)
    ),
    validityPolicy: validateGateValidityPolicy(raw.validityPolicy),
    budgetPolicy: validateGateBudgetPolicy(raw.budgetPolicy)
  };
}

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "@scshafe/switchyard/contracts/digest";
import {
  createGateBudgetPolicy,
  createGateFlowDefinition,
  createGateGoalDefinition,
  createGateObjectiveDefinition,
  createGateValidityPolicy,
  gateBudgetPolicyRef,
  gateGoalRef,
  gateObjectiveRef,
  gateValidityPolicyRef,
  validateGateFlowTransition,
  validateGateStepOutcome
} from "@scshafe/switchyard/gate/contracts";
import { validateGateTerminationCertificate } from "@scshafe/switchyard/gate/certificate";
import {
  compileGateFlow,
  validateCompiledGateFlow
} from "@scshafe/switchyard/gate/compiler";

const ref = (id) => ({ id, version: 1, digest: digest({ id, version: 1 }) });
const success = (code) => ({ code, kind: "success", description: `${code} succeeded` });
const failure = (code) => ({ code, kind: "failure", description: `${code} failed` });

function compilationInput() {
  const goal = createGateGoalDefinition({
    schemaVersion: "gate-goal-definition.v1",
    id: "item.action",
    version: 1,
    description: "Decide whether the item needs action.",
    question: "Does this immutable item need action?",
    inputContract: "routed-item.v1",
    decisionContract: "action-decision.v1",
    decisionCodes: ["requires-action", "no-action"]
  });
  const objective = createGateObjectiveDefinition({
    schemaVersion: "gate-objective-definition.v1",
    id: "item.action-recall",
    version: 1,
    description: "Avoid missed actionable items.",
    goal: gateGoalRef(goal),
    targetDecisionCode: "requires-action",
    primary: { metric: "false_negative_rate", direction: "minimize" },
    guardrails: [
      { metric: "human_escalation_rate", direction: "minimize", threshold: 0.5 }
    ],
    evidenceGate: {
      minimumPositiveLabels: 10,
      minimumNegativeLabels: 10,
      minimumTotalLabels: 20,
      confidenceLevel: 0.95
    },
    abstention: {
      disposition: "human_escalation",
      reasonCode: "objective-uncertain"
    }
  });
  const validatorImplementation = ref("gate.decision-validator");
  const validityPolicy = createGateValidityPolicy({
    schemaVersion: "gate-validity-policy.v1",
    id: "item.action-validity",
    version: 1,
    description: "Require current typed evidence.",
    goal: gateGoalRef(goal),
    validatorImplementation,
    requiredChecks: [
      "output_contract",
      "decision_code",
      "evidence_authority",
      "source_freshness",
      "objective_guardrails"
    ],
    failureReasonCode: "decision-invalid"
  });
  const budgetPolicy = createGateBudgetPolicy({
    schemaVersion: "gate-budget-policy.v1",
    id: "item.action-budget",
    version: 1,
    description: "Bound the deterministic proof path.",
    tiers: [{
      tierId: "deterministic",
      maxAttempts: 1,
      timeoutMs: 500,
      maxTokensPerAttempt: 0,
      maxCostMicroUsdPerAttempt: 0
    }],
    limits: {
      maximumPathSteps: 2,
      maximumModelCalls: 0,
      maximumAttempts: 2,
      maximumTokens: 0,
      maximumCostMicroUsd: 0,
      maximumElapsedMs: 1_000
    }
  });
  const flow = createGateFlowDefinition({
    schemaVersion: "gate-flow-definition.v1",
    id: "item.action-flow",
    version: 1,
    description: "Evidence check followed by an exact validator.",
    goal: gateGoalRef(goal),
    objectives: [gateObjectiveRef(objective)],
    validityPolicy: gateValidityPolicyRef(validityPolicy),
    budgetPolicy: gateBudgetPolicyRef(budgetPolicy),
    levels: [
      { levelId: "evidence-level", ordinal: 0, description: "Evidence" },
      { levelId: "validation-level", ordinal: 1, description: "Validation" }
    ],
    entryStepId: "evidence",
    steps: [
      {
        kind: "deterministic",
        stepId: "evidence",
        levelId: "evidence-level",
        implementation: ref("gate.evidence-check"),
        budgetTierId: "deterministic",
        inputContract: "routed-item.v1",
        outputContract: "action-decision.v1",
        outcomes: [success("eligible"), failure("ineligible")]
      },
      {
        kind: "validator",
        stepId: "validator",
        levelId: "validation-level",
        implementation: validatorImplementation,
        budgetTierId: "deterministic",
        inputContract: "action-decision.v1",
        outputContract: "action-decision.v1",
        outcomes: [success("valid"), failure("invalid")]
      }
    ],
    transitions: [
      {
        kind: "internal_escalation",
        sourceStepId: "evidence",
        outcomeCode: "eligible",
        targetStepId: "validator"
      },
      {
        kind: "human_escalation",
        sourceStepId: "evidence",
        outcomeCode: "ineligible",
        reasonCode: "evidence-ineligible"
      },
      {
        kind: "valid_decision",
        sourceStepId: "validator",
        outcomeCode: "valid",
        decisionContract: "action-decision.v1"
      },
      {
        kind: "human_escalation",
        sourceStepId: "validator",
        outcomeCode: "invalid",
        reasonCode: "decision-invalid"
      }
    ]
  });
  return { flow, goal, objectives: [objective], validityPolicy, budgetPolicy };
}

function replaceFlow(input, update) {
  const { flowDigest: _digest, ...draft } = input.flow;
  return {
    ...input,
    flow: createGateFlowDefinition({ ...draft, ...update })
  };
}

test("standalone gate contracts compile deterministically with a sealed proof", () => {
  const input = compilationInput();
  const compiled = compileGateFlow(input);
  assert.deepEqual(compileGateFlow(input), compiled);
  assert.deepEqual(validateCompiledGateFlow(compiled), compiled);
  assert.deepEqual(
    compiled.terminationCertificate.proof.bounds,
    {
      maximumPathSteps: 2,
      maximumModelCalls: 0,
      maximumAttempts: 2,
      maximumTokens: 0,
      maximumCostMicroUsd: 0,
      maximumElapsedMs: 1_000
    }
  );
  assert.equal(compiled.terminationCertificate.proof.exhaustiveOutcomes, true);
  assert.equal(compiled.terminationCertificate.proof.validDecisionRequiresValidator, true);
});

test("gate certificate validation recomputes the seal", () => {
  const certificate = compileGateFlow(compilationInput()).terminationCertificate;
  assert.deepEqual(validateGateTerminationCertificate(certificate), certificate);
  assert.throws(
    () => validateGateTerminationCertificate({
      ...certificate,
      proof: {
        ...certificate.proof,
        bounds: { ...certificate.proof.bounds, maximumAttempts: 3 }
      }
    }),
    /digest mismatch/
  );
});

test("gate compiler rejects incomplete outcomes and non-monotonic escalation", () => {
  const input = compilationInput();
  assert.throws(
    () => compileGateFlow(replaceFlow(input, {
      transitions: input.flow.transitions.slice(1)
    })),
    /has no transition/
  );
  assert.throws(
    () => compileGateFlow(replaceFlow(input, {
      steps: input.flow.steps.map((step) =>
        step.stepId === "validator"
          ? { ...step, levelId: "evidence-level" }
          : step)
    })),
    /higher gate level/
  );
});

test("gate data cannot smuggle executable routing or self-promotion fields", () => {
  assert.throws(
    () => validateGateFlowTransition({
      kind: "human_escalation",
      sourceStepId: "evidence",
      outcomeCode: "ineligible",
      reasonCode: "manual",
      promotionAuthorized: true
    }),
    /unknown key/
  );
  assert.throws(
    () => validateGateStepOutcome({
      code: "eligible",
      kind: "success",
      description: "eligible",
      targetStepId: "caller-selected"
    }),
    /unknown key/
  );
});

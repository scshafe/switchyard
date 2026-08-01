// mission-pipeline-gate.test.mjs — B5 of the STANDALONE mission-pipeline
// package: the gate module (decision-flow vocabulary promoted from the inbox
// decision compiler suite), compileGateFlow's proofs (cycle rejection,
// exhaustive terminals, escalation monotonicity, budget-cost bounds), the
// recompute-and-verify GateTerminationCertificate, and createGateNodeInvoker —
// the kind:"gate" NodeInvoker arm (closed step registry, model steps through
// the SAME ModelBindingResolver + receipt floor, valid_decision AND
// human_escalation terminals with the dedupe-keyed escalation outbox event).
//
// All hermetic (no network, no DB, no real model).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { digest } from "mission-pipeline/contracts/digest";
import { createPipelineDefinition } from "mission-pipeline/definition";
import { StageCatalog } from "mission-pipeline/catalog";
import { compilePipeline } from "mission-pipeline/compile";
import { MemoryPipelineStore } from "mission-pipeline/memory-store";
import { PipelineStageError, classifyStageFailure } from "mission-pipeline/execute/durable-stage";
import { runOneShard } from "mission-pipeline/execute/shard-runner";
import {
  createInferenceProfileRef,
  createModelStageBinding
} from "mission-pipeline/model/binding";
import {
  MODEL_USAGE_RECEIPT_EVENT_TYPE,
  createModelNodeInvoker,
  createModelReceiptLedger
} from "mission-pipeline/model/invoker";
import {
  GATE_TRANSITION_KINDS,
  createGateBudgetPolicy,
  createGateFlowDefinition,
  createGateGoalDefinition,
  createGateObjectiveDefinition,
  createGateValidityPolicy,
  gateBudgetPolicyRef,
  gateFlowRef,
  gateGoalRef,
  gateObjectiveRef,
  gateValidityPolicyRef,
  validateGateFlowTransition,
  validateGateGoalDefinition,
  validateGateStepOutcome
} from "mission-pipeline/gate/contracts";
import {
  validateGateTerminationCertificate
} from "mission-pipeline/gate/certificate";
import { compileGateFlow, validateCompiledGateFlow } from "mission-pipeline/gate/compiler";
import {
  GATE_HUMAN_ESCALATION_EVENT_TYPE,
  createGateEscalationLedger,
  createGateNodeInvoker,
  gateFlowBindingRef
} from "mission-pipeline/gate/executor";

// ── Fixtures (ported from the inbox decision-compiler suite, host-neutral) ─

function immutableRef(id) {
  return { id, version: 1, digest: digest({ id, version: 1 }) };
}

const evidenceImplementation = immutableRef("gate.evidence-check");
const recallImplementation = immutableRef("gate.recall-specialist");
const precisionImplementation = immutableRef("gate.precision-specialist");
const arbiterImplementation = immutableRef("gate.arbiter");
const validatorImplementation = immutableRef("gate.decision-validator");

const MODEL_PARAMETERS = Object.freeze({
  temperature: 0,
  seed: 7,
  thinking: "off",
  timeoutMs: 1_000,
  maxOutputTokens: 2_048,
  maxOutputBytes: 1_048_576,
  maxConcurrency: 2,
  toolPolicy: "none",
  responseContract: "model-response.v1"
});

function modelBinding(id) {
  return createModelStageBinding({
    schemaVersion: "model-stage-binding.v2",
    bindingId: id,
    version: 1,
    kind: "model",
    modelRevisionRef: immutableRef(`${id}.model`),
    inferenceProfileRef: createInferenceProfileRef({
      id: `${id}.profile`,
      version: 1,
      parameters: { ...MODEL_PARAMETERS }
    })
  });
}

function success(code) {
  return { code, kind: "success", description: `${code} succeeded` };
}

function uncertain(code) {
  return { code, kind: "uncertain", description: `${code} remains uncertain` };
}

function failure(code = "execution-failure") {
  return { code, kind: "failure", description: `${code} prevented a result` };
}

function validCompilationInput() {
  const goal = createGateGoalDefinition({
    schemaVersion: "gate-goal-definition.v1",
    id: "item.requires-human-action",
    version: 1,
    description: "Decide whether an item requires action by a human operator.",
    question: "Does this immutable item revision require human action?",
    inputContract: "routed-item.v1",
    decisionContract: "action-decision.v1",
    decisionCodes: ["requires-action", "no-action"]
  });
  const objective = createGateObjectiveDefinition({
    schemaVersion: "gate-objective-definition.v1",
    id: "item.action-recall",
    version: 1,
    description: "Minimize missed actionable items without unbounded review load.",
    goal: gateGoalRef(goal),
    targetDecisionCode: "requires-action",
    primary: { metric: "false_negative_rate", direction: "minimize" },
    guardrails: [
      { metric: "precision", direction: "maximize", threshold: 0.7 },
      { metric: "human_escalation_rate", direction: "minimize", threshold: 0.35 }
    ],
    evidenceGate: {
      minimumPositiveLabels: 25,
      minimumNegativeLabels: 25,
      minimumTotalLabels: 50,
      confidenceLevel: 0.95
    },
    abstention: { disposition: "human_escalation", reasonCode: "objective-uncertain" }
  });
  const validityPolicy = createGateValidityPolicy({
    schemaVersion: "gate-validity-policy.v1",
    id: "item.action-validity",
    version: 1,
    description: "Require typed output, current evidence, and objective guardrails.",
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
    description: "Bound every retry, inference, token, cost, and wall-clock path.",
    tiers: [
      {
        tierId: "deterministic",
        maxAttempts: 1,
        timeoutMs: 100,
        maxTokensPerAttempt: 0,
        maxCostMicroUsdPerAttempt: 0
      },
      {
        tierId: "model",
        maxAttempts: 2,
        timeoutMs: 1_000,
        maxTokensPerAttempt: 100,
        maxCostMicroUsdPerAttempt: 11
      }
    ],
    limits: {
      maximumPathSteps: 8,
      maximumModelCalls: 12,
      maximumAttempts: 16,
      maximumTokens: 2_000,
      maximumCostMicroUsd: 1_000,
      maximumElapsedMs: 20_000
    }
  });
  const steps = [
    {
      kind: "deterministic",
      stepId: "evidence",
      levelId: "level-0",
      implementation: evidenceImplementation,
      budgetTierId: "deterministic",
      inputContract: "routed-item.v1",
      outputContract: "gate-evidence.v1",
      outcomes: [success("eligible"), uncertain("ineligible"), failure()]
    },
    {
      kind: "model",
      stepId: "recall",
      levelId: "level-1",
      implementation: recallImplementation,
      budgetTierId: "model",
      inputContract: "gate-evidence.v1",
      outputContract: "action-candidate.v1",
      outcomes: [success("candidate"), uncertain("uncertain"), failure()],
      binding: modelBinding("action-recall")
    },
    {
      kind: "model",
      stepId: "precision",
      levelId: "level-1",
      implementation: precisionImplementation,
      budgetTierId: "model",
      inputContract: "action-candidate.v1",
      outputContract: "action-candidate.v1",
      outcomes: [success("agree"), uncertain("disagree"), failure()],
      binding: modelBinding("action-precision")
    },
    {
      kind: "model",
      stepId: "arbiter",
      levelId: "level-2",
      implementation: arbiterImplementation,
      budgetTierId: "model",
      inputContract: "action-candidate.v1",
      outputContract: "action-candidate.v1",
      outcomes: [success("candidate"), uncertain("unresolved"), failure()],
      binding: modelBinding("action-arbiter")
    },
    {
      kind: "validator",
      stepId: "validator",
      levelId: "level-3",
      implementation: validatorImplementation,
      budgetTierId: "deterministic",
      inputContract: "action-candidate.v1",
      outputContract: "action-decision.v1",
      outcomes: [success("valid"), failure("invalid")]
    }
  ];
  const transitions = [
    { kind: "internal_escalation", sourceStepId: "evidence", outcomeCode: "eligible", targetStepId: "recall" },
    { kind: "human_escalation", sourceStepId: "evidence", outcomeCode: "ineligible", reasonCode: "evidence-ineligible" },
    { kind: "human_escalation", sourceStepId: "evidence", outcomeCode: "execution-failure", reasonCode: "evidence-failure" },
    { kind: "advance", sourceStepId: "recall", outcomeCode: "candidate", targetStepId: "precision" },
    { kind: "internal_escalation", sourceStepId: "recall", outcomeCode: "uncertain", targetStepId: "arbiter" },
    { kind: "internal_escalation", sourceStepId: "recall", outcomeCode: "execution-failure", targetStepId: "arbiter" },
    { kind: "internal_escalation", sourceStepId: "precision", outcomeCode: "agree", targetStepId: "validator" },
    { kind: "internal_escalation", sourceStepId: "precision", outcomeCode: "disagree", targetStepId: "arbiter" },
    { kind: "internal_escalation", sourceStepId: "precision", outcomeCode: "execution-failure", targetStepId: "arbiter" },
    { kind: "internal_escalation", sourceStepId: "arbiter", outcomeCode: "candidate", targetStepId: "validator" },
    { kind: "human_escalation", sourceStepId: "arbiter", outcomeCode: "unresolved", reasonCode: "arbiter-unresolved" },
    { kind: "human_escalation", sourceStepId: "arbiter", outcomeCode: "execution-failure", reasonCode: "arbiter-failure" },
    { kind: "valid_decision", sourceStepId: "validator", outcomeCode: "valid", decisionContract: "action-decision.v1" },
    { kind: "human_escalation", sourceStepId: "validator", outcomeCode: "invalid", reasonCode: "decision-invalid" }
  ];
  const flow = createGateFlowDefinition({
    schemaVersion: "gate-flow-definition.v1",
    id: "item.action-gate-flow",
    version: 1,
    description: "Recall/precision pair with bounded stronger arbitration and deterministic validation.",
    goal: gateGoalRef(goal),
    objectives: [gateObjectiveRef(objective)],
    validityPolicy: gateValidityPolicyRef(validityPolicy),
    budgetPolicy: gateBudgetPolicyRef(budgetPolicy),
    levels: [
      { levelId: "level-0", ordinal: 0, description: "Evidence eligibility and security." },
      { levelId: "level-1", ordinal: 1, description: "Complementary first-line specialists." },
      { levelId: "level-2", ordinal: 2, description: "Stronger disagreement arbiter." },
      { levelId: "level-3", ordinal: 3, description: "Code-owned validity gate." }
    ],
    entryStepId: "evidence",
    steps,
    transitions
  });
  return { flow, goal, objectives: [objective], validityPolicy, budgetPolicy };
}

function replaceFlow(input, update) {
  const { flowDigest: _flowDigest, ...base } = input.flow;
  return { ...input, flow: createGateFlowDefinition({ ...base, ...update }) };
}

function replaceBudget(input, budget) {
  const next = replaceFlow(input, { budgetPolicy: gateBudgetPolicyRef(budget) });
  return { ...next, budgetPolicy: budget };
}

const EXPECTED_BOUNDS = Object.freeze({
  maximumPathSteps: 5,
  maximumModelCalls: 6,
  maximumAttempts: 8,
  maximumTokens: 600,
  maximumCostMicroUsd: 66,
  maximumElapsedMs: 6_200
});

// ── Compiler: the promoted proof suite ────────────────────────────────────

test("compiles the promoted flow deterministically and emits a digest-bound termination proof", () => {
  const input = validCompilationInput();
  const compiled = compileGateFlow(input);

  assert.deepEqual(compiled.steps.map((step) => step.stepId), [
    "evidence", "recall", "precision", "arbiter", "validator"
  ]);
  assert.equal(compiled.inputContract, "routed-item.v1");
  assert.equal(compiled.decisionContract, "action-decision.v1");
  assert.deepEqual(compiled.decisionCodes, ["requires-action", "no-action"]);
  assert.deepEqual(compiled.terminationCertificate.proof.bounds, EXPECTED_BOUNDS);
  assert.equal(compiled.terminationCertificate.proof.acyclic, true);
  assert.equal(compiled.terminationCertificate.proof.exhaustiveOutcomes, true);
  assert.equal(compiled.terminationCertificate.proof.humanFallbackForFailureOutcomes, true);
  assert.equal(compiled.terminationCertificate.proof.escalationStrictlyIncreasesLevel, true);
  assert.equal(compiled.terminationCertificate.proof.validDecisionRequiresValidator, true);
  assert.equal(compiled.terminationCertificate.proof.stepCount, 5);
  assert.equal(compiled.terminationCertificate.proof.terminalTransitionCount, 6);
  assert.equal(compiled.steps.find((step) => step.stepId === "recall")?.capabilities[0], "network:model");
  assert.equal(compiled.steps.find((step) => step.stepId === "evidence")?.capabilities[0], "none");
  // Determinism: same inputs, byte-identical sealed output.
  assert.deepEqual(compileGateFlow(input), compiled);
  // The sealed compiled flow round-trips through its validator.
  assert.deepEqual(validateCompiledGateFlow(compiled), compiled);

  // Tampering with the proof inside the compiled flow fails LOUD.
  assert.throws(() => validateCompiledGateFlow({
    ...compiled,
    terminationCertificate: {
      ...compiled.terminationCertificate,
      proof: { ...compiled.terminationCertificate.proof, stepCount: 4 }
    }
  }), /digest mismatch/);
});

test("certificate validator recomputes and verifies: round-trip, exact digest, tampering LOUD", () => {
  const compiled = compileGateFlow(validCompilationInput());
  const certificate = compiled.terminationCertificate;

  // Round-trip.
  assert.deepEqual(validateGateTerminationCertificate(certificate), certificate);
  // The seal is EXACTLY the canonical digest of the payload-without-digest.
  const { certificateDigest, ...payload } = certificate;
  assert.equal(certificateDigest, digest(payload));

  // Tamper a count → digest mismatch.
  assert.throws(
    () => validateGateTerminationCertificate({
      ...certificate,
      proof: { ...certificate.proof, transitionCount: certificate.proof.transitionCount + 1 }
    }),
    /digest mismatch/
  );
  // Tamper a bound → digest mismatch.
  assert.throws(
    () => validateGateTerminationCertificate({
      ...certificate,
      proof: { ...certificate.proof, bounds: { ...certificate.proof.bounds, maximumCostMicroUsd: 10 ** 9 } }
    }),
    /digest mismatch/
  );
  // A proof flag that is not literally true is NOT a weaker certificate — it is none.
  assert.throws(
    () => validateGateTerminationCertificate({
      ...certificate,
      proof: { ...certificate.proof, acyclic: false }
    }),
    /acyclic must be literally true/
  );
  // Fewer than two terminals can never certify (both terminals must exist).
  assert.throws(
    () => validateGateTerminationCertificate({
      ...certificate,
      proof: { ...certificate.proof, terminalTransitionCount: 1 }
    }),
    /terminalTransitionCount must be >= 2/
  );
});

test("strictly validates immutable definitions and non-executable flow data", () => {
  const input = validCompilationInput();
  // Unknown key on a sealed definition.
  assert.throws(() => validateGateGoalDefinition({ ...input.goal, extra: true }), /unknown key/);
  // Tampered sealed field.
  assert.throws(() => validateGateGoalDefinition({ ...input.goal, question: "tampered" }), /digest mismatch/);
  // A transition cannot smuggle executable/extra vocabulary.
  assert.throws(() => validateGateFlowTransition({
    kind: "advance",
    sourceStepId: "a",
    outcomeCode: "yes",
    targetStepId: "b",
    predicate: "arbitrary JavaScript"
  }), /unknown key/);
  // An outcome cannot carry routing decided by the model.
  assert.throws(() => validateGateStepOutcome({
    code: "yes",
    kind: "success",
    description: "yes",
    targetStepId: "model-selected-target"
  }), /unknown key/);

  // The exact-inference-profile rule is STRUCTURAL in v2: a model binding
  // cannot even be sealed without its recorded profile.
  assert.throws(() => createModelStageBinding({
    schemaVersion: "model-stage-binding.v2",
    bindingId: "no-profile",
    version: 1,
    kind: "model",
    modelRevisionRef: immutableRef("no-profile.model")
  }), /inferenceProfileRef/);
});

test("rejects missing, duplicate, unknown-target, cyclic, and multi-entry outcome graphs", () => {
  const input = validCompilationInput();
  // Ported: dropping a transition leaves an outcome without one.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.slice(1)
  })), /has no transition/);

  // Ported: a duplicated transition is a multi-mapping.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: [...input.flow.transitions, input.flow.transitions[0]]
  })), /has multiple transitions/);

  // Ported: a transition to a step that does not exist.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "evidence" && transition.outcomeCode === "eligible"
        ? { ...transition, targetStepId: "missing-step" }
        : transition)
  })), /unknown target step/);

  // Ported CYCLE REJECTION: arbiter joins level-1 and cycles back into precision.
  const cyclicSteps = input.flow.steps.map((step) => step.stepId === "arbiter"
    ? { ...step, levelId: "level-1" }
    : step);
  const cyclicTransitions = input.flow.transitions.map((transition) => {
    if (
      (transition.kind === "advance" || transition.kind === "internal_escalation")
      && transition.targetStepId === "arbiter"
    ) {
      if (transition.outcomeCode === "execution-failure") return {
        kind: "human_escalation",
        sourceStepId: transition.sourceStepId,
        outcomeCode: transition.outcomeCode,
        reasonCode: "cycle-test-failure"
      };
      return { ...transition, kind: "advance" };
    }
    if (transition.sourceStepId === "arbiter" && transition.outcomeCode === "candidate") {
      return { kind: "advance", sourceStepId: "arbiter", outcomeCode: "candidate", targetStepId: "precision" };
    }
    return transition;
  });
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    steps: cyclicSteps,
    transitions: cyclicTransitions
  })), /contains a cycle/);

  // Ported: making the entry terminal leaves recall as a second root.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "evidence" && transition.outcomeCode === "eligible"
        ? { kind: "human_escalation", sourceStepId: "evidence", outcomeCode: "eligible", reasonCode: "manual" }
        : transition)
  })), /exactly one entry step/);
});

test("enforces escalation monotonicity and a human fallback for every failure (MISSING TERMINAL rejected)", () => {
  const input = validCompilationInput();
  // Ported: advance may not cross levels.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "evidence" && transition.outcomeCode === "eligible"
        ? { kind: "advance", sourceStepId: "evidence", outcomeCode: "eligible", targetStepId: "recall" }
        : transition)
  })), /must remain at the same gate level/);

  // Ported NON-MONOTONIC ESCALATION: internal escalation must move UP.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "recall" && transition.outcomeCode === "uncertain"
        ? { kind: "internal_escalation", sourceStepId: "recall", outcomeCode: "uncertain", targetStepId: "precision" }
        : transition)
  })), /must move to a higher gate level/);

  // Ported: a failure outcome may never simply advance.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "recall" && transition.outcomeCode === "execution-failure"
        ? { kind: "advance", sourceStepId: "recall", outcomeCode: "execution-failure", targetStepId: "precision" }
        : transition)
  })), /Failure outcome .* must escalate internally or to a human/);

  // Ported: every step must declare a failure outcome at all.
  const invalidSteps = input.flow.steps.map((step) => step.stepId === "evidence"
    ? { ...step, outcomes: step.outcomes.filter((outcome) => outcome.kind !== "failure") }
    : step);
  assert.throws(() => replaceFlow(input, { steps: invalidSteps }), /must declare a failure outcome/);

  // Ported: a valid-only subtree cannot certify a failure path either.
  const validOnlySteps = input.flow.steps.map((step) => {
    if (step.stepId !== "arbiter") return step;
    return { ...step, outcomes: [success("candidate"), success("alternate-candidate")] };
  });
  const validOnlyTransitions = input.flow.transitions
    .filter((transition) => transition.sourceStepId !== "arbiter")
    .concat([
      { kind: "internal_escalation", sourceStepId: "arbiter", outcomeCode: "candidate", targetStepId: "validator" },
      { kind: "internal_escalation", sourceStepId: "arbiter", outcomeCode: "alternate-candidate", targetStepId: "validator" }
    ]);
  assert.throws(
    () => replaceFlow(input, { steps: validOnlySteps, transitions: validOnlyTransitions }),
    /must declare a failure outcome/
  );

  // MISSING TERMINAL: without ANY human_escalation the flow cannot compile —
  // rewriting every human terminal into an internal escalation trips the
  // level/exhaustiveness proofs long before a terminal-less flow could pass.
  const noHuman = input.flow.transitions.map((transition) => transition.kind === "human_escalation"
    ? { kind: "internal_escalation", sourceStepId: transition.sourceStepId, outcomeCode: transition.outcomeCode, targetStepId: "validator" }
    : transition);
  assert.throws(
    () => compileGateFlow(replaceFlow(input, { transitions: noHuman })),
    /higher gate level|same gate level|human escalation terminal|emits .* but .* expects/
  );
});

test("permits valid decisions only through the exact policy validator and goal contract", () => {
  const input = validCompilationInput();
  // Ported: valid_decision must originate from a validator step.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) =>
      transition.sourceStepId === "precision" && transition.outcomeCode === "agree"
        ? { kind: "valid_decision", sourceStepId: "precision", outcomeCode: "agree", decisionContract: "action-decision.v1" }
        : transition)
  })), /must originate from a validator step/);

  // Ported: the terminal must pin the goal decision contract.
  assert.throws(() => compileGateFlow(replaceFlow(input, {
    transitions: input.flow.transitions.map((transition) => transition.kind === "valid_decision"
      ? { ...transition, decisionContract: "wrong-decision.v1" }
      : transition)
  })), /must pin the goal decision contract/);

  // Ported: the validator step must run the validity policy's EXACT implementation.
  const mismatchedValidator = input.flow.steps.map((step) => step.stepId === "validator"
    ? { ...step, implementation: immutableRef("gate.other-validator") }
    : step);
  assert.throws(
    () => compileGateFlow(replaceFlow(input, { steps: mismatchedValidator })),
    /does not use the validity policy implementation/
  );
});

test("BUDGET OVERFLOW: every worst-case dimension must fit the immutable budget (ported per-dimension)", () => {
  for (const key of Object.keys(EXPECTED_BOUNDS)) {
    const input = validCompilationInput();
    const { policyDigest: _policyDigest, ...base } = input.budgetPolicy;
    const budget = createGateBudgetPolicy({
      ...base,
      version: 2,
      limits: { ...base.limits, [key]: EXPECTED_BOUNDS[key] - 1 }
    });
    assert.throws(
      () => compileGateFlow(replaceBudget(input, budget)),
      new RegExp(`${key} ${EXPECTED_BOUNDS[key]} exceeds budget limit`)
    );
  }
});

test("rejects stale objective identities, foreign decision codes, and gamed metric directions", () => {
  const input = validCompilationInput();
  // Ported: a flow objective ref whose digest does not match its definition.
  assert.throws(() => compileGateFlow({
    ...input,
    flow: createGateFlowDefinition({
      ...(() => {
        const { flowDigest: _flowDigest, ...base } = input.flow;
        return base;
      })(),
      objectives: [{ ...input.flow.objectives[0], digest: "f".repeat(64) }]
    })
  }), /reference does not match|is missing/);

  // Ported: objectives must target a goal decision code.
  const original = input.objectives[0];
  const { objectiveDigest: _objectiveDigest, ...base } = original;
  const invalidObjective = createGateObjectiveDefinition({ ...base, version: 2, targetDecisionCode: "not-a-goal-code" });
  const flow = replaceFlow(input, { objectives: [gateObjectiveRef(invalidObjective)] }).flow;
  assert.throws(() => compileGateFlow({ ...input, flow, objectives: [invalidObjective] }), /unknown goal decision code/);

  // Ported: metric directions are pinned (false_negative_rate cannot be maximized).
  assert.throws(() => createGateObjectiveDefinition({
    ...base,
    version: 3,
    primary: { metric: "false_negative_rate", direction: "maximize" }
  }), /false_negative_rate must be minimize/);
  // Ported: at least one guardrail is mandatory.
  assert.throws(() => createGateObjectiveDefinition({ ...base, version: 4, guardrails: [] }), /guardrails/);
});

// ── The gate node executor (fake resolver, memory store) ──────────────────

const KNOWN_CONTRACTS = [
  "routed-item.v1",
  "gate-evidence.v1",
  "action-candidate.v1",
  "action-decision.v1",
  "gate-result.v1",
  "model-response.v1",
  "pipeline-node-input.v1"
];

const fakeContracts = () => ({
  knows: (contractId) => KNOWN_CONTRACTS.includes(contractId),
  validate: (contractId, value) => {
    if (!KNOWN_CONTRACTS.includes(contractId)) {
      return { ok: false, issues: [{ message: `unknown contract ${contractId}` }] };
    }
    return { ok: true, value };
  }
});

/** A within-tier receipt (the model tier allows 100 tokens / 11 micro-USD per attempt). */
const withinTierReceipt = (overrides = {}) => ({
  schemaVersion: "usage-receipt.v1",
  trust: "provider_reported",
  observedInputTokens: 80,
  observedOutputTokens: 15,
  chargedTokens: 95,
  observedCostMicroUsd: 5,
  chargedCostMicroUsd: 5,
  durationMs: 40,
  ...overrides
});

const zeroCostUnavailableReceipt = () => ({
  schemaVersion: "usage-receipt.v1",
  trust: "unavailable",
  observedInputTokens: null,
  observedOutputTokens: null,
  chargedTokens: 0,
  observedCostMicroUsd: null,
  chargedCostMicroUsd: 0,
  durationMs: 5
});

/**
 * Registry + resolver fixture. `evidenceOutcome` steers the deterministic
 * entry; `modelResults` maps bindingId → (request) => ModelInvocationResult.
 */
function gateFixture({
  evidenceOutcome = { outcome: "eligible", output: { evidence: true } },
  modelResults = {},
  validatorResult = { outcome: "valid", output: { decisionCode: "no-action" } }
} = {}) {
  const compiled = compileGateFlow(validCompilationInput());
  const modelCalls = [];
  const resolver = {
    resolve: (binding) => ({
      invoke: async (request) => {
        modelCalls.push({ bindingId: binding.bindingId, request });
        const produce = modelResults[binding.bindingId]
          ?? (() => ({ output: { outcome: "candidate", output: { candidate: binding.bindingId } }, usage: withinTierReceipt() }));
        return produce(request);
      }
    })
  };
  const registry = [
    { id: "gate.evidence-check", version: 1, run: async () => evidenceOutcome },
    { id: "gate.decision-validator", version: 1, run: async () => validatorResult }
  ];
  return { compiled, resolver, registry, modelCalls };
}

function makeGateInvoker(fixture, overrides = {}) {
  return createGateNodeInvoker({
    resolver: fixture.resolver,
    flows: [fixture.compiled],
    steps: fixture.registry,
    catalogContracts: fakeContracts(),
    ...overrides
  });
}

const GATE_NODE = (bindingFingerprint) => ({
  nodeId: "gate",
  stage: { id: "triage.gate", version: 1 },
  inputs: [{ slot: "item", source: { kind: "pipeline_input" }, contract: "routed-item.v1" }],
  kind: "gate",
  outputContract: "gate-result.v1",
  capabilities: ["network:model"],
  deliverySemantics: "at_least_once_idempotent",
  bindingFingerprint
});

const invocation = (node, overrides = {}) => ({
  runId: "run-1",
  itemId: "i1",
  node,
  input: { item: "hello" },
  attempt: 1,
  idempotencyKey: digest({ test: "gate-stage-action" }),
  ...overrides
});

test("CLOSED STEP REGISTRY: a flow naming an unregistered implementation is rejected LOUD at construction", () => {
  const fixture = gateFixture();
  // Remove the validator implementation from the registry.
  assert.throws(
    () =>
      createGateNodeInvoker({
        resolver: fixture.resolver,
        flows: [fixture.compiled],
        steps: fixture.registry.filter((entry) => entry.id !== "gate.decision-validator"),
        catalogContracts: fakeContracts()
      }),
    /gate\.decision-validator@1, which is not in the injected step registry \(closed registry — flow data cannot supply code\)/
  );
  // A registry entry cannot be data either — run must be a FUNCTION.
  assert.throws(
    () =>
      createGateNodeInvoker({
        resolver: fixture.resolver,
        flows: [fixture.compiled],
        steps: [...fixture.registry, { id: "sneaky", version: 1, run: "return 42" }],
        catalogContracts: fakeContracts()
      }),
    /run: function/
  );
  // Unknown contracts fail closed at construction too.
  assert.throws(
    () =>
      createGateNodeInvoker({
        resolver: fixture.resolver,
        flows: [fixture.compiled],
        steps: fixture.registry,
        catalogContracts: { knows: (id) => id !== "gate-evidence.v1", validate: (id, value) => ({ ok: true, value }) }
      }),
    /references unknown contract\(s\): gate-evidence\.v1/
  );
});

test("valid_decision path: the flow walks evidence→recall→precision→validator with receipts and budget accounting", async () => {
  const receipts = [];
  const fixture = gateFixture({
    modelResults: {
      "action-recall": () => ({ output: { outcome: "candidate", output: { c: 1 } }, usage: withinTierReceipt() }),
      "action-precision": () => ({ output: { outcome: "agree", output: { c: 2 } }, usage: withinTierReceipt() })
    },
    validatorResult: { outcome: "valid", output: { decisionCode: "requires-action" } }
  });
  const invoker = makeGateInvoker(fixture, { onReceipt: (record) => receipts.push(record), now: () => 1_000 });
  const node = GATE_NODE(fixture.compiled.compiledDigest);

  const result = await invoker.invoke(invocation(node));
  assert.equal(result.schemaVersion, "gate-node-result.v1");
  assert.equal(result.disposition, "valid_decision");
  assert.deepEqual(result.decision, { contract: "action-decision.v1", output: { decisionCode: "requires-action" } });
  assert.equal(result.escalation, undefined);
  assert.deepEqual(result.path, [
    { stepId: "evidence", kind: "deterministic", outcome: "eligible" },
    { stepId: "recall", kind: "model", outcome: "candidate" },
    { stepId: "precision", kind: "model", outcome: "agree" },
    { stepId: "validator", kind: "validator", outcome: "valid" }
  ]);
  assert.deepEqual(result.budgetSpent, {
    pathSteps: 4,
    modelCalls: 2,
    chargedTokens: 190,
    chargedCostMicroUsd: 10,
    elapsedMs: 0
  });
  assert.equal(result.flow.compiledDigest, fixture.compiled.compiledDigest);
  assert.equal(result.certificateDigest, fixture.compiled.terminationCertificate.certificateDigest);

  // Both model steps recorded receipts through the SAME floor, step-attributed.
  assert.deepEqual(receipts.map((record) => record.gateStepId), ["recall", "precision"]);
  assert.equal(receipts[0].nodeId, "gate");
  assert.equal(receipts[0].receipt.trust, "provider_reported");
});

test("human_escalation path emits the escalation record; unknown outcomes and wrong kinds are typed failures", async () => {
  const escalations = [];
  const fixture = gateFixture({ evidenceOutcome: { outcome: "ineligible", output: { evidence: false } } });
  const invoker = makeGateInvoker(fixture, { onEscalation: (record) => escalations.push(record) });
  const node = GATE_NODE(fixture.compiled.compiledDigest);

  const result = await invoker.invoke(invocation(node));
  assert.equal(result.disposition, "human_escalation");
  assert.deepEqual(result.escalation, { reasonCode: "evidence-ineligible", sourceStepId: "evidence", outcomeCode: "ineligible" });
  assert.equal(result.decision, undefined);
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].reasonCode, "evidence-ineligible");
  assert.equal(escalations[0].budgetSpent.modelCalls, 0);

  // A step yielding an UNDECLARED outcome is a typed failure.
  const undeclared = gateFixture({ evidenceOutcome: { outcome: "not-declared", output: {} } });
  await assert.rejects(makeGateInvoker(undeclared).invoke(invocation(node)), (error) => {
    assert.ok(error instanceof PipelineStageError);
    assert.equal(error.code, "gate_step_unknown_outcome");
    return true;
  });

  // Unknown fingerprints and wrong kinds are refused; a fallback chains.
  const gateInvoker = makeGateInvoker(fixture);
  await assert.rejects(gateInvoker.invoke(invocation({ ...node, bindingFingerprint: "f".repeat(64) })), (error) => {
    assert.equal(error.code, "gate_flow_unresolved");
    assert.equal(error.scope, "shard");
    return true;
  });
  const codeNode = { ...node, kind: "code", bindingFingerprint: "none" };
  await assert.rejects(gateInvoker.invoke(invocation(codeNode)), (error) => {
    assert.equal(error.code, "gate_invoker_wrong_kind");
    return true;
  });
  const chained = makeGateInvoker(fixture, { fallback: { invoke: async () => "fallback-output" } });
  assert.equal(await chained.invoke(invocation(codeNode)), "fallback-output");
});

test("THE RECEIPT FLOOR applies to gate model steps: missing and silent-zero receipts are TERMINAL", async () => {
  const node = GATE_NODE(gateFixture().compiled.compiledDigest);

  // Missing receipt.
  const missing = gateFixture({
    modelResults: { "action-recall": () => ({ output: { outcome: "candidate", output: {} } }) }
  });
  await assert.rejects(makeGateInvoker(missing).invoke(invocation(node)), (error) => {
    assert.ok(error instanceof PipelineStageError);
    assert.equal(error.code, "model_receipt_missing");
    assert.equal(error.retryable, false);
    assert.deepEqual(classifyStageFailure(error), { code: "model_receipt_missing", retryable: false, scope: "item" });
    return true;
  });

  // Silent-zero unavailable receipt violates the floor.
  const silentZero = gateFixture({
    modelResults: {
      "action-recall": () => ({ output: { outcome: "candidate", output: {} }, usage: zeroCostUnavailableReceipt() })
    }
  });
  await assert.rejects(makeGateInvoker(silentZero).invoke(invocation(node)), (error) => {
    assert.equal(error.code, "model_receipt_rejected");
    assert.equal(error.retryable, false);
    assert.match(String(error.cause?.message), /at least 1 token/);
    return true;
  });

  // A floored unavailable receipt passes the floor (and the tier ceilings).
  const floored = gateFixture({
    modelResults: {
      "action-recall": () => ({
        output: { outcome: "uncertain", output: { unsure: true } },
        usage: { ...zeroCostUnavailableReceipt(), chargedTokens: 1, chargedCostMicroUsd: 1 }
      }),
      "action-arbiter": () => ({ output: { outcome: "unresolved", output: {} }, usage: withinTierReceipt() })
    }
  });
  const result = await makeGateInvoker(floored).invoke(invocation(node));
  assert.equal(result.disposition, "human_escalation");
  assert.equal(result.escalation.reasonCode, "arbiter-unresolved");
});

test("gate model steps validate their recorded response contract after admitting usage", async () => {
  const receipts = [];
  const fixture = gateFixture();
  const contracts = {
    knows: (contractId) => KNOWN_CONTRACTS.includes(contractId),
    validate: (contractId, value) => {
      if (!KNOWN_CONTRACTS.includes(contractId)) {
        return {
          ok: false,
          issues: [{ message: `unknown contract ${contractId}` }]
        };
      }
      if (
        contractId === "model-response.v1"
        && (
          value === null
          || typeof value !== "object"
          || value.responseAccepted !== true
        )
      ) {
        return {
          ok: false,
          issues: [{
            path: "/responseAccepted",
            message: "responseAccepted must be true"
          }]
        };
      }
      return { ok: true, value };
    }
  };
  const invoker = makeGateInvoker(fixture, {
    catalogContracts: contracts,
    onReceipt: (record) => receipts.push(record)
  });

  await assert.rejects(
    invoker.invoke(invocation(GATE_NODE(fixture.compiled.compiledDigest))),
    (error) => {
      assert.ok(error instanceof PipelineStageError);
      assert.equal(error.code, "model_output_contract_invalid");
      assert.equal(error.retryable, true);
      assert.equal(error.scope, "item");
      assert.match(error.cause.message, /model-response\.v1.*responseAccepted/);
      return true;
    }
  );
  assert.equal(receipts.length, 1, "the completed provider attempt remains receipted");
  assert.equal(receipts[0].gateStepId, "recall");
});

test("gate model-step budget rejection takes precedence over an invalid response contract", async () => {
  const fixture = gateFixture({
    modelResults: {
      "action-recall": () => ({
        output: {
          outcome: "candidate",
          output: { candidate: "invalid-and-over-budget" }
        },
        usage: withinTierReceipt({ chargedTokens: 101 })
      })
    }
  });
  const contracts = {
    knows: (contractId) => KNOWN_CONTRACTS.includes(contractId),
    validate: (contractId, value) => (
      contractId === "model-response.v1"
        ? {
            ok: false,
            issues: [{ message: "invalid model response" }]
          }
        : { ok: true, value }
    )
  };

  await assert.rejects(
    makeGateInvoker(fixture, { catalogContracts: contracts }).invoke(
      invocation(GATE_NODE(fixture.compiled.compiledDigest))
    ),
    (error) => {
      assert.ok(error instanceof PipelineStageError);
      assert.equal(error.code, "gate_budget_exceeded");
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test("runtime budget accounting: a receipt above its tier ceiling terminates the item as gate_budget_exceeded", async () => {
  const node = GATE_NODE(gateFixture().compiled.compiledDigest);
  // 1_000 charged tokens >> the model tier's 100-token per-attempt ceiling.
  const overTier = gateFixture({
    modelResults: {
      "action-recall": () => ({
        output: { outcome: "candidate", output: {} },
        usage: withinTierReceipt({ observedInputTokens: 900, observedOutputTokens: 100, chargedTokens: 1_000 })
      })
    }
  });
  await assert.rejects(makeGateInvoker(overTier).invoke(invocation(node)), (error) => {
    assert.ok(error instanceof PipelineStageError);
    assert.equal(error.code, "gate_budget_exceeded");
    assert.equal(error.retryable, false);
    assert.equal(error.scope, "item");
    assert.match(String(error.cause?.message), /above its tier ceiling 100/);
    return true;
  });
  // Cost ceiling too.
  const overCost = gateFixture({
    modelResults: {
      "action-recall": () => ({
        output: { outcome: "candidate", output: {} },
        usage: withinTierReceipt({ observedCostMicroUsd: 40, chargedCostMicroUsd: 40 })
      })
    }
  });
  await assert.rejects(makeGateInvoker(overCost).invoke(invocation(node)), (error) => {
    assert.equal(error.code, "gate_budget_exceeded");
    assert.match(String(error.cause?.message), /above its tier ceiling 11/);
    return true;
  });
});

// ── End-to-end on the memory store (chained through the model invoker) ────

function e2eSetup(fixtureOptions = {}) {
  const fixture = gateFixture(fixtureOptions);
  const contracts = fakeContracts();
  const catalog = new StageCatalog({
    contracts,
    registrations: [
      {
        descriptor: {
          stageId: "triage.gate",
          version: 1,
          kind: "gate",
          inputs: [{ slot: "item", contract: "routed-item.v1" }],
          outputContract: "gate-result.v1",
          capabilities: ["network:model"],
          deliverySemantics: "at_least_once_idempotent"
        },
        executable: { id: "triage.gate", version: 1 }
      }
    ]
  });
  const definition = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: "item.triage",
    version: 1,
    description: "B5 gate-node end-to-end fixture",
    inputContract: "routed-item.v1",
    nodes: [
      {
        nodeId: "gate",
        stage: { id: "triage.gate", version: 1 },
        inputs: [{ slot: "item", source: { kind: "pipeline_input" } }],
        binding: gateFlowBindingRef(fixture.compiled)
      }
    ],
    outputs: ["gate"]
  });
  const compiledPipeline = compilePipeline(definition, catalog);
  assert.equal(
    compiledPipeline.nodes[0].bindingFingerprint,
    fixture.compiled.compiledDigest,
    "the pipeline compiler stamps the compiled gate flow digest"
  );
  const store = new MemoryPipelineStore();
  const receiptLedger = createModelReceiptLedger();
  const escalationLedger = createGateEscalationLedger();
  const gateInvoker = createGateNodeInvoker({
    resolver: fixture.resolver,
    flows: [fixture.compiled],
    steps: fixture.registry,
    catalogContracts: contracts,
    onReceipt: receiptLedger.onReceipt,
    onEscalation: escalationLedger.onEscalation
  });
  // Prove the B4→B5 fallback chain: model invoker first, gate arm as fallback.
  const invoker = createModelNodeInvoker({
    resolver: fixture.resolver,
    bindings: [],
    catalogContracts: contracts,
    fallback: gateInvoker
  });
  return { fixture, catalog, compiledPipeline, store, receiptLedger, escalationLedger, invoker };
}

async function runE2E(ctx) {
  await ctx.store.createRun({
    run: { runId: "run-1", compiled: ctx.compiledPipeline, createdAt: "2026-07-23T00:00:00.000Z" },
    items: [{ itemId: "i1", ordinal: 1, input: { item: "one" }, inputDigest: digest({ item: "one" }) }],
    shards: [{ shardId: "shard-1", itemIds: ["i1"] }]
  });
  return runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    invoker: ctx.invoker,
    leaseOwner: "w1",
    outboxEventsFor: (context) => [
      ...ctx.receiptLedger.outboxEventsFor(context),
      ...ctx.escalationLedger.outboxEventsFor(context)
    ],
    failureOutboxEventsFor: ctx.receiptLedger.failureOutboxEventsFor
  });
}

test("gate node end-to-end (valid_decision): receipts ride the transactional outbox, no escalation event", async () => {
  const ctx = e2eSetup({
    modelResults: {
      "action-recall": () => ({ output: { outcome: "candidate", output: { c: 1 } }, usage: withinTierReceipt() }),
      "action-precision": () => ({ output: { outcome: "agree", output: { c: 2 } }, usage: withinTierReceipt() })
    },
    validatorResult: { outcome: "valid", output: { decisionCode: "no-action" } }
  });
  const outcome = await runE2E(ctx);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.itemCount, 1);
  assert.equal(outcome.stageExecutionCount, 1);

  // The two gate model-step receipts persisted atomically with the node success,
  // dedupe-keyed PER STEP (one gate attempt, several model calls).
  const receiptEvents = ctx.store.outboxEventRecords.filter((event) => event.eventType === MODEL_USAGE_RECEIPT_EVENT_TYPE);
  assert.deepEqual(receiptEvents.map((event) => event.payload.gateStepId), ["recall", "precision"]);
  for (const event of receiptEvents) {
    assert.match(
      event.dedupeKey,
      new RegExp(`^model-receipt:run-1:i1:gate:1:step:${event.payload.gateStepId}:action:[a-f0-9]{64}:call:[a-f0-9]{64}:evidence:[a-f0-9]{64}$`)
    );
  }
  // No escalation event on the valid path.
  assert.equal(ctx.store.outboxEventRecords.filter((event) => event.eventType === GATE_HUMAN_ESCALATION_EVENT_TYPE).length, 0);
  assert.equal(ctx.escalationLedger.records.length, 0);
});

test("gate node end-to-end (human_escalation): the node SUCCEEDS with the escalation arm and the dedupe-keyed outbox event", async () => {
  const ctx = e2eSetup({ evidenceOutcome: { outcome: "ineligible", output: { evidence: false } } });
  const outcome = await runE2E(ctx);
  // Escalation is a PROVEN TERMINAL, not a failure: the shard completes.
  assert.equal(outcome.status, "completed");
  assert.equal(ctx.store.deadLetterRecords.length, 0);

  const events = ctx.store.outboxEventRecords.filter((event) => event.eventType === GATE_HUMAN_ESCALATION_EVENT_TYPE);
  assert.equal(events.length, 1);
  assert.match(
    events[0].dedupeKey,
    /^gate-escalation:run-1:i1:gate:1:action:[a-f0-9]{64}:evidence:[a-f0-9]{64}$/
  );
  assert.equal(events[0].payload.schemaVersion, "gate-human-escalation-event.v1");
  assert.equal(events[0].payload.runId, "run-1");
  assert.equal(events[0].payload.nodeId, "gate");
  assert.equal(events[0].payload.reasonCode, "evidence-ineligible");
  assert.equal(events[0].payload.sourceStepId, "evidence");
  assert.equal(events[0].payload.flow.id, "item.action-gate-flow");
  assert.equal(events[0].payload.certificateDigest, ctx.fixture.compiled.terminationCertificate.certificateDigest);
});

test("gate node failure persists its model-step receipt while generic escalation remains success-only", async () => {
  const ctx = e2eSetup({
    modelResults: {
      "action-recall": () => ({
        output: { outcome: "candidate", output: {} },
        usage: withinTierReceipt({
          observedInputTokens: 900,
          observedOutputTokens: 100,
          chargedTokens: 1_000
        })
      })
    }
  });
  const outcome = await runE2E(ctx);
  assert.equal(outcome.status, "partial");
  assert.equal(ctx.store.deadLetterRecords[0].error.code, "gate_budget_exceeded");

  const receipts = ctx.store.outboxEventRecords.filter(
    (event) => event.eventType === MODEL_USAGE_RECEIPT_EVENT_TYPE
  );
  assert.deepEqual(receipts.map((event) => [
    event.payload.attempt,
    event.payload.gateStepId
  ]), [[1, "recall"]]);
  assert.match(
    receipts[0].dedupeKey,
    /^model-receipt:run-1:i1:gate:1:step:recall:action:[a-f0-9]{64}:call:[a-f0-9]{64}:evidence:[a-f0-9]{64}$/
  );
  assert.equal(
    ctx.store.outboxEventRecords.filter(
      (event) => event.eventType === GATE_HUMAN_ESCALATION_EVENT_TYPE
    ).length,
    0,
    "generic escalation is a success projection, never failure telemetry"
  );
});

test("gate node end-to-end: a silent-zero receipt in a gate model step terminalizes the item — dead letter, NO events", async () => {
  const ctx = e2eSetup({
    modelResults: {
      "action-recall": () => ({ output: { outcome: "candidate", output: {} }, usage: zeroCostUnavailableReceipt() })
    }
  });
  const outcome = await runE2E(ctx);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.terminalItemCount, 1);
  assert.equal(ctx.store.deadLetterRecords.length, 1);
  assert.equal(ctx.store.deadLetterRecords[0].error.code, "model_receipt_rejected");
  // Nothing rode the outbox — no success was appended.
  assert.equal(ctx.store.outboxEventRecords.length, 0);
});

// ── No self-promotion vocabulary ──────────────────────────────────────────

test("NO SELF-PROMOTION: promotionAuthorized is not representable in the gate module", () => {
  // 1. Source grep: the vocabulary does not exist anywhere in src/gate/.
  const gateDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "gate"
  );
  const files = readdirSync(gateDir).filter((name) => name.endsWith(".ts"));
  assert.deepEqual(new Set(files), new Set(["contracts.ts", "certificate.ts", "compiler.ts", "executor.ts"]));
  for (const file of files) {
    const source = readFileSync(path.join(gateDir, file), "utf8");
    assert.ok(!/promotionAuthorized/i.test(source), `${file} must not mention promotionAuthorized`);
    assert.ok(!/promotion_authorized/i.test(source), `${file} must not mention promotion_authorized`);
  }

  // 2. Shape assertion: strict-keyed objects REJECT the field outright.
  assert.throws(
    () => validateGateFlowTransition({
      kind: "valid_decision",
      sourceStepId: "validator",
      outcomeCode: "valid",
      decisionContract: "action-decision.v1",
      promotionAuthorized: true
    }),
    /unknown key/
  );
  assert.throws(
    () => validateGateStepOutcome({
      code: "valid",
      kind: "success",
      description: "valid",
      promotionAuthorized: true
    }),
    /unknown key/
  );
  // The transition vocabulary is CLOSED: the only terminals are
  // valid_decision and human_escalation — nothing can authorize an action.
  assert.deepEqual([...GATE_TRANSITION_KINDS], ["advance", "internal_escalation", "valid_decision", "human_escalation"]);
  assert.throws(
    () => validateGateFlowTransition({ kind: "self_promotion", sourceStepId: "a", outcomeCode: "b" }),
    /kind: must be one of/
  );

  // 3. A sealed flow cannot smuggle the field either (validation is strict end-to-end).
  const input = validCompilationInput();
  assert.throws(
    () => compileGateFlow({
      ...input,
      flow: { ...input.flow, promotionAuthorized: true }
    }),
    /unknown key/
  );
  // And the compiled result's certificate ref round-trips without any such field.
  const compiled = compileGateFlow(input);
  assert.ok(!JSON.stringify(compiled).toLowerCase().includes("promotionauthorized"));
  assert.deepEqual(gateFlowRef(input.flow), {
    id: "item.action-gate-flow",
    version: 1,
    digest: input.flow.flowDigest
  });
});

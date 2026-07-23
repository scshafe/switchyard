// gate/compiler.ts — compileGateFlow: the static, fail-closed decision-flow
// compiler for kind:"gate" nodes, emitting a digest-sealed CompiledGateFlow
// whose embedded GateTerminationCertificate records exactly what was proven.
//
// PROMOTED from inbox-pipeline/src/decision/compiler.ts, proof for proof:
//   - ACYCLICITY: Kahn topological order over advance/internal_escalation
//     edges (original-index tie-break — deterministic output), LOUD on cycles;
//   - EXHAUSTIVE TERMINALS: every declared step outcome has EXACTLY ONE
//     transition, at least one valid_decision and one human_escalation
//     terminal exist, failure outcomes may only escalate (internally or to a
//     human), and every internally-escalated failure target can REACH a
//     human_escalation terminal (reverse-topological reachability — a complete
//     proof over the already-proven-acyclic graph, not a heuristic);
//   - ESCALATION MONOTONICITY: advance stays on the SAME level ordinal;
//     internal_escalation moves STRICTLY upward;
//   - VALIDATOR-ONLY VALID DECISIONS: a valid_decision terminal must originate
//     from a validator step running the validity policy's EXACT implementation,
//     from a success outcome, emitting (and pinning) the goal's decision
//     contract;
//   - BUDGET-COST BOUNDS: per-step worst-case costs (tier attempts × tokens /
//     cost / timeout; model steps alone consume tokens+cost+calls) accumulate
//     along worst-case paths (longest-path max over the DAG), must stay inside
//     safe-integer accounting, and must fit the budget policy's limits in
//     EVERY dimension;
//   - plus the promoted structural admissions: entry step exists, is the ONE
//     root, and consumes the goal's input contract; every step names a known
//     level and budget tier; non-model steps must use a zero-token zero-cost
//     tier; objectives are exactly the flow's objective refs, target known
//     goal decision codes, and share the flow's goal.
//
// STANDALONE: relative imports only (no npm deps, no zod).
import { digest } from "../contracts/digest.js";
import { validateContractId } from "../contracts/artifact.js";
import { validateModelStageBinding } from "../model/binding.js";
import { assertIdentifier, assertPlainObject, assertSha256Hex, assertStrictKeys, assertVersionedRef, typeName, truncate } from "../internal/guards.js";
import { MAX_GATE_DECISION_CODES, MAX_GATE_LEVEL_ORDINAL, MAX_GATE_OBJECTIVES, MAX_GATE_STEPS, MAX_GATE_STEP_OUTCOMES, MAX_GATE_TRANSITIONS, MIN_GATE_STEP_OUTCOMES, gateBudgetPolicyRef, gateFlowRef, gateGoalRef, gateObjectiveRef, gateReferenceKey, gateValidityPolicyRef, validateGateFlowCompilationInput, validateGateFlowTransition, validateGateStepBudgetTier, validateGateStepOutcome } from "./contracts.js";
import { GATE_FLOW_COMPILER_VERSION, createGateTerminationCertificate, validateGateTerminationCertificate } from "./certificate.js";
export const COMPILED_GATE_FLOW_SCHEMA_VERSION = "compiled-gate-flow.v1";
export { GATE_FLOW_COMPILER_VERSION };
// ── Promoted helpers ──────────────────────────────────────────────────────
function sameReference(left, right) {
    return left.id === right.id && left.version === right.version && left.digest === right.digest;
}
function assertReference(label, expected, actual) {
    if (!sameReference(expected, actual)) {
        throw new Error(`${label} reference does not match the supplied immutable definition`);
    }
}
function transitionKey(transition) {
    return `${transition.sourceStepId} ${transition.outcomeCode}`;
}
function implementationKey(implementation) {
    return `${implementation.id} ${implementation.version} ${implementation.digest}`;
}
function zeroCost() {
    return {
        maximumPathSteps: 0,
        maximumModelCalls: 0,
        maximumAttempts: 0,
        maximumTokens: 0,
        maximumCostMicroUsd: 0,
        maximumElapsedMs: 0
    };
}
function addCosts(left, right) {
    return {
        maximumPathSteps: left.maximumPathSteps + right.maximumPathSteps,
        maximumModelCalls: left.maximumModelCalls + right.maximumModelCalls,
        maximumAttempts: left.maximumAttempts + right.maximumAttempts,
        maximumTokens: left.maximumTokens + right.maximumTokens,
        maximumCostMicroUsd: left.maximumCostMicroUsd + right.maximumCostMicroUsd,
        maximumElapsedMs: left.maximumElapsedMs + right.maximumElapsedMs
    };
}
function maximumCosts(left, right) {
    return {
        maximumPathSteps: Math.max(left.maximumPathSteps, right.maximumPathSteps),
        maximumModelCalls: Math.max(left.maximumModelCalls, right.maximumModelCalls),
        maximumAttempts: Math.max(left.maximumAttempts, right.maximumAttempts),
        maximumTokens: Math.max(left.maximumTokens, right.maximumTokens),
        maximumCostMicroUsd: Math.max(left.maximumCostMicroUsd, right.maximumCostMicroUsd),
        maximumElapsedMs: Math.max(left.maximumElapsedMs, right.maximumElapsedMs)
    };
}
/** Promoted worst-case cost of ONE step under its budget tier. */
function stepCost(step, tier) {
    const isModel = step.kind === "model";
    return {
        maximumPathSteps: 1,
        maximumModelCalls: isModel ? tier.maxAttempts : 0,
        maximumAttempts: tier.maxAttempts,
        maximumTokens: isModel ? tier.maxAttempts * tier.maxTokensPerAttempt : 0,
        maximumCostMicroUsd: isModel ? tier.maxAttempts * tier.maxCostMicroUsdPerAttempt : 0,
        maximumElapsedMs: tier.maxAttempts * tier.timeoutMs
    };
}
function assertSafeCost(cost) {
    for (const [name, value] of Object.entries(cost)) {
        if (!Number.isSafeInteger(value))
            throw new Error(`Gate flow ${name} exceeds safe integer accounting`);
    }
}
function assertWithinBudget(actual, limit) {
    for (const key of Object.keys(limit)) {
        if (actual[key] > limit[key]) {
            throw new Error(`Gate flow ${key} ${actual[key]} exceeds budget limit ${limit[key]}`);
        }
    }
}
/** Promoted Kahn order over advance/internal_escalation edges; LOUD on cycles. */
function topologicalOrder(steps, transitions) {
    const originalIndex = new Map(steps.map((step, index) => [step.stepId, index]));
    const indegree = new Map(steps.map((step) => [step.stepId, 0]));
    const outgoing = new Map(steps.map((step) => [step.stepId, new Set()]));
    for (const transition of transitions) {
        if (transition.kind !== "advance" && transition.kind !== "internal_escalation")
            continue;
        const targets = outgoing.get(transition.sourceStepId);
        if (!targets.has(transition.targetStepId)) {
            targets.add(transition.targetStepId);
            indegree.set(transition.targetStepId, indegree.get(transition.targetStepId) + 1);
        }
    }
    const byId = new Map(steps.map((step) => [step.stepId, step]));
    const ready = [...steps]
        .filter((step) => indegree.get(step.stepId) === 0)
        .sort((left, right) => originalIndex.get(left.stepId) - originalIndex.get(right.stepId));
    const ordered = [];
    while (ready.length > 0) {
        const step = ready.shift();
        ordered.push(step);
        for (const target of outgoing.get(step.stepId)) {
            const remaining = indegree.get(target) - 1;
            indegree.set(target, remaining);
            if (remaining === 0) {
                ready.push(byId.get(target));
                ready.sort((left, right) => originalIndex.get(left.stepId) - originalIndex.get(right.stepId));
            }
        }
    }
    if (ordered.length !== steps.length)
        throw new Error("Gate flow contains a cycle");
    return ordered;
}
/**
 * Promoted failure-fallback reachability: over the (already proven acyclic)
 * graph, reverse-topological evaluation computes EXACTLY which steps can reach
 * a human_escalation terminal; every internally-escalated FAILURE outcome must
 * land on one — a failure may never be routed into a subtree that can only
 * produce valid decisions.
 */
function assertFailureFallbackReachability(orderedSteps, transitions) {
    const outgoing = new Map();
    for (const transition of transitions) {
        const values = outgoing.get(transition.sourceStepId) ?? [];
        values.push(transition);
        outgoing.set(transition.sourceStepId, values);
    }
    const canReachHuman = new Set();
    for (const step of [...orderedSteps].reverse()) {
        if ((outgoing.get(step.stepId) ?? []).some((transition) => transition.kind === "human_escalation" ||
            ((transition.kind === "advance" || transition.kind === "internal_escalation") &&
                canReachHuman.has(transition.targetStepId)))) {
            canReachHuman.add(step.stepId);
        }
    }
    const steps = new Map(orderedSteps.map((step) => [step.stepId, step]));
    for (const transition of transitions) {
        const source = steps.get(transition.sourceStepId);
        const outcome = source.outcomes.find((candidate) => candidate.code === transition.outcomeCode);
        if (outcome.kind === "failure" &&
            transition.kind === "internal_escalation" &&
            !canReachHuman.has(transition.targetStepId)) {
            throw new Error(`Failure outcome ${source.stepId}.${outcome.code} has no reachable human escalation fallback`);
        }
    }
}
/**
 * Promoted worst-case bounds: longest-path (max-cost) accumulation over the
 * DAG in topological order; the terminal maximum across every terminating
 * transition is the flow's worst case. Also proves every step reachable from
 * the entry.
 */
function computeWorstCaseBounds(orderedSteps, transitions, entryStepId, tiers) {
    const incomingMaximum = new Map([[entryStepId, zeroCost()]]);
    const outgoing = new Map();
    for (const transition of transitions) {
        const values = outgoing.get(transition.sourceStepId) ?? [];
        values.push(transition);
        outgoing.set(transition.sourceStepId, values);
    }
    let terminalMaximum = zeroCost();
    for (const step of orderedSteps) {
        const incoming = incomingMaximum.get(step.stepId);
        if (incoming === undefined)
            throw new Error(`Gate flow step ${step.stepId} is unreachable from the entry step`);
        const withStep = addCosts(incoming, stepCost(step, tiers.get(step.budgetTierId)));
        assertSafeCost(withStep);
        for (const transition of outgoing.get(step.stepId) ?? []) {
            if (transition.kind === "advance" || transition.kind === "internal_escalation") {
                incomingMaximum.set(transition.targetStepId, maximumCosts(incomingMaximum.get(transition.targetStepId) ?? zeroCost(), withStep));
            }
            else {
                terminalMaximum = maximumCosts(terminalMaximum, withStep);
            }
        }
    }
    return terminalMaximum;
}
function compiledStep(step, level, budget) {
    const common = {
        stepId: step.stepId,
        level,
        implementation: step.implementation,
        inputContract: step.inputContract,
        outputContract: step.outputContract,
        outcomes: step.outcomes,
        budget
    };
    if (step.kind === "model") {
        return { ...common, kind: step.kind, binding: step.binding, capabilities: ["network:model"] };
    }
    return { ...common, kind: step.kind, capabilities: ["none"] };
}
// ── compileGateFlow ───────────────────────────────────────────────────────
/**
 * Compile a gate flow against its immutable definitions. Every rejection is
 * LOUD; success mints the digest-sealed {@link GateTerminationCertificate} and
 * the digest-sealed {@link CompiledGateFlow} embedding it. Deterministic:
 * identical inputs compile to an identical sealed payload.
 */
export function compileGateFlow(inputRaw) {
    const input = validateGateFlowCompilationInput(inputRaw);
    const { flow, goal, validityPolicy, budgetPolicy } = input;
    const goalReference = gateGoalRef(goal);
    const validityReference = gateValidityPolicyRef(validityPolicy);
    const budgetReference = gateBudgetPolicyRef(budgetPolicy);
    assertReference("Gate flow goal", flow.goal, goalReference);
    assertReference("Gate validity policy goal", validityPolicy.goal, goalReference);
    assertReference("Gate flow validity policy", flow.validityPolicy, validityReference);
    assertReference("Gate flow budget policy", flow.budgetPolicy, budgetReference);
    const objectivesByKey = new Map(input.objectives.map((objective) => [gateReferenceKey(gateObjectiveRef(objective)), objective]));
    if (objectivesByKey.size !== input.objectives.length || objectivesByKey.size !== flow.objectives.length) {
        throw new Error("Compilation input must contain exactly the gate flow objective definitions");
    }
    const objectives = flow.objectives.map((reference) => {
        const objective = objectivesByKey.get(gateReferenceKey(reference));
        if (!objective)
            throw new Error(`Gate flow objective ${reference.id}@${reference.version} is missing`);
        assertReference("Gate flow objective", reference, gateObjectiveRef(objective));
        assertReference(`Gate objective ${objective.id} goal`, objective.goal, goalReference);
        if (!goal.decisionCodes.includes(objective.targetDecisionCode)) {
            throw new Error(`Gate objective ${objective.id} targets an unknown goal decision code`);
        }
        return objective;
    });
    const levels = new Map(flow.levels.map((level) => [level.levelId, level]));
    const tiers = new Map(budgetPolicy.tiers.map((tier) => [tier.tierId, tier]));
    const steps = new Map(flow.steps.map((step) => [step.stepId, step]));
    const entry = steps.get(flow.entryStepId);
    if (!entry)
        throw new Error(`Gate flow entry step ${flow.entryStepId} does not exist`);
    if (entry.inputContract !== goal.inputContract) {
        throw new Error(`Gate flow entry expects ${entry.inputContract}, but goal input is ${goal.inputContract}`);
    }
    for (const step of flow.steps) {
        const level = levels.get(step.levelId);
        if (!level)
            throw new Error(`Gate flow step ${step.stepId} references unknown level ${step.levelId}`);
        const tier = tiers.get(step.budgetTierId);
        if (!tier)
            throw new Error(`Gate flow step ${step.stepId} references unknown budget tier ${step.budgetTierId}`);
        if (step.kind !== "model" && (tier.maxTokensPerAttempt !== 0 || tier.maxCostMicroUsdPerAttempt !== 0)) {
            throw new Error(`Non-model gate step ${step.stepId} must use a zero-token, zero-cost budget tier`);
        }
    }
    const transitionByOutcome = new Map();
    const incoming = new Map(flow.steps.map((step) => [step.stepId, 0]));
    let validTerminalCount = 0;
    let humanTerminalCount = 0;
    for (const transition of flow.transitions) {
        const source = steps.get(transition.sourceStepId);
        if (!source)
            throw new Error(`Gate transition references unknown source step ${transition.sourceStepId}`);
        const outcome = source.outcomes.find((candidate) => candidate.code === transition.outcomeCode);
        if (!outcome) {
            throw new Error(`Gate transition references unknown outcome ${transition.sourceStepId}.${transition.outcomeCode}`);
        }
        const key = transitionKey(transition);
        if (transitionByOutcome.has(key)) {
            throw new Error(`Gate outcome ${transition.sourceStepId}.${transition.outcomeCode} has multiple transitions`);
        }
        transitionByOutcome.set(key, transition);
        if (outcome.kind === "failure" && transition.kind !== "internal_escalation" && transition.kind !== "human_escalation") {
            throw new Error(`Failure outcome ${transition.sourceStepId}.${transition.outcomeCode} must escalate internally or to a human`);
        }
        if (transition.kind === "advance" || transition.kind === "internal_escalation") {
            const target = steps.get(transition.targetStepId);
            if (!target)
                throw new Error(`Gate transition references unknown target step ${transition.targetStepId}`);
            if (source.outputContract !== target.inputContract) {
                throw new Error(`Gate transition ${source.stepId}.${outcome.code} emits ${source.outputContract}, but ${target.stepId} expects ${target.inputContract}`);
            }
            const sourceOrdinal = levels.get(source.levelId).ordinal;
            const targetOrdinal = levels.get(target.levelId).ordinal;
            if (transition.kind === "advance" && sourceOrdinal !== targetOrdinal) {
                throw new Error(`Advance transition ${source.stepId}.${outcome.code} must remain at the same gate level`);
            }
            if (transition.kind === "internal_escalation" && targetOrdinal <= sourceOrdinal) {
                throw new Error(`Internal escalation ${source.stepId}.${outcome.code} must move to a higher gate level`);
            }
            incoming.set(target.stepId, incoming.get(target.stepId) + 1);
        }
        else if (transition.kind === "valid_decision") {
            validTerminalCount += 1;
            if (source.kind !== "validator") {
                throw new Error(`Valid decision transition ${source.stepId}.${outcome.code} must originate from a validator step`);
            }
            if (implementationKey(source.implementation) !== implementationKey(validityPolicy.validatorImplementation)) {
                throw new Error(`Validator step ${source.stepId} does not use the validity policy implementation`);
            }
            if (outcome.kind !== "success") {
                throw new Error(`Valid decision transition ${source.stepId}.${outcome.code} requires a success outcome`);
            }
            if (source.outputContract !== goal.decisionContract) {
                throw new Error(`Validator step ${source.stepId} must emit the goal decision contract ${goal.decisionContract}`);
            }
            if (transition.decisionContract !== goal.decisionContract) {
                throw new Error(`Valid decision transition ${source.stepId}.${outcome.code} must pin the goal decision contract ${goal.decisionContract}`);
            }
        }
        else {
            humanTerminalCount += 1;
        }
    }
    for (const step of flow.steps) {
        for (const outcome of step.outcomes) {
            if (!transitionByOutcome.has(transitionKey({ sourceStepId: step.stepId, outcomeCode: outcome.code }))) {
                throw new Error(`Gate outcome ${step.stepId}.${outcome.code} has no transition`);
            }
        }
    }
    if (transitionByOutcome.size !== flow.steps.reduce((count, step) => count + step.outcomes.length, 0)) {
        throw new Error("Gate flow outcome transitions are not exhaustive and unique");
    }
    if (validTerminalCount === 0)
        throw new Error("Gate flow requires at least one valid decision terminal");
    if (humanTerminalCount === 0)
        throw new Error("Gate flow requires at least one human escalation terminal");
    const roots = flow.steps.filter((step) => incoming.get(step.stepId) === 0);
    if (roots.length !== 1 || roots[0]?.stepId !== flow.entryStepId) {
        throw new Error("Gate flow must have exactly one entry step matching entryStepId");
    }
    const ordered = topologicalOrder(flow.steps, flow.transitions);
    assertFailureFallbackReachability(ordered, flow.transitions);
    const bounds = computeWorstCaseBounds(ordered, flow.transitions, flow.entryStepId, tiers);
    assertWithinBudget(bounds, budgetPolicy.limits);
    const orderedIndex = new Map(ordered.map((step, index) => [step.stepId, index]));
    const outcomeIndex = new Map(ordered.flatMap((step) => step.outcomes.map((outcome, index) => [transitionKey({ sourceStepId: step.stepId, outcomeCode: outcome.code }), index])));
    const transitions = [...flow.transitions].sort((left, right) => orderedIndex.get(left.sourceStepId) - orderedIndex.get(right.sourceStepId) ||
        outcomeIndex.get(transitionKey(left)) - outcomeIndex.get(transitionKey(right)));
    const flowReference = gateFlowRef(flow);
    const objectiveReferences = objectives.map(gateObjectiveRef);
    const terminationCertificate = createGateTerminationCertificate({
        schemaVersion: "gate-termination-certificate.v1",
        compilerVersion: GATE_FLOW_COMPILER_VERSION,
        flow: flowReference,
        goal: goalReference,
        objectives: objectiveReferences,
        validityPolicy: validityReference,
        budgetPolicy: budgetReference,
        proof: {
            entryStepId: flow.entryStepId,
            stepCount: ordered.length,
            transitionCount: transitions.length,
            terminalTransitionCount: validTerminalCount + humanTerminalCount,
            reachableStepCount: ordered.length,
            acyclic: true,
            exhaustiveOutcomes: true,
            humanFallbackForFailureOutcomes: true,
            escalationStrictlyIncreasesLevel: true,
            validDecisionRequiresValidator: true,
            bounds
        }
    });
    const payload = {
        schemaVersion: COMPILED_GATE_FLOW_SCHEMA_VERSION,
        compilerVersion: GATE_FLOW_COMPILER_VERSION,
        flow: flowReference,
        goal: goalReference,
        objectives: objectiveReferences,
        validityPolicy: validityReference,
        budgetPolicy: budgetReference,
        inputContract: goal.inputContract,
        decisionContract: goal.decisionContract,
        decisionCodes: goal.decisionCodes,
        entryStepId: flow.entryStepId,
        steps: ordered.map((step) => compiledStep(step, { levelId: step.levelId, ordinal: levels.get(step.levelId).ordinal }, tiers.get(step.budgetTierId))),
        transitions,
        terminationCertificate
    };
    return { ...payload, compiledDigest: digest(payload) };
}
// ── Sealed compiled-flow validation ───────────────────────────────────────
const COMPILED_STEP_COMMON_KEYS = [
    "kind",
    "stepId",
    "level",
    "implementation",
    "inputContract",
    "outputContract",
    "outcomes",
    "budget",
    "capabilities"
];
const COMPILED_STEP_PLAIN_KEYS = new Set(COMPILED_STEP_COMMON_KEYS);
const COMPILED_STEP_MODEL_KEYS = new Set([...COMPILED_STEP_COMMON_KEYS, "binding"]);
const COMPILED_LEVEL_KEYS = new Set(["levelId", "ordinal"]);
function validateCompiledGateStep(value, label) {
    const raw = assertPlainObject(value, label);
    const kind = raw.kind;
    if (kind !== "deterministic" && kind !== "model" && kind !== "validator") {
        const got = typeof kind === "string" ? JSON.stringify(truncate(kind)) : typeName(kind);
        throw new Error(`${label}: kind must be "deterministic" | "model" | "validator" (got ${got})`);
    }
    assertStrictKeys(raw, kind === "model" ? COMPILED_STEP_MODEL_KEYS : COMPILED_STEP_PLAIN_KEYS, label);
    const stepId = assertIdentifier(raw.stepId, `${label}: stepId`);
    const stepLabel = `${label} ${stepId}`;
    const levelRaw = assertPlainObject(raw.level, `${stepLabel}: level`);
    assertStrictKeys(levelRaw, COMPILED_LEVEL_KEYS, `${stepLabel}: level`);
    const ordinal = levelRaw.ordinal;
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > MAX_GATE_LEVEL_ORDINAL) {
        throw new Error(`${stepLabel}: level.ordinal must be an integer in 0..${MAX_GATE_LEVEL_ORDINAL}`);
    }
    const common = {
        stepId,
        level: { levelId: assertIdentifier(levelRaw.levelId, `${stepLabel}: level.levelId`), ordinal },
        implementation: assertVersionedRef(raw.implementation, `${stepLabel}: implementation`),
        inputContract: validateContractId(raw.inputContract, `${stepLabel}: inputContract`),
        outputContract: validateContractId(raw.outputContract, `${stepLabel}: outputContract`),
        outcomes: (Array.isArray(raw.outcomes) ? raw.outcomes : (() => {
            throw new Error(`${stepLabel}: outcomes must be an array (got ${typeName(raw.outcomes)})`);
        })()).map((outcomeRaw, index) => validateGateStepOutcome(outcomeRaw, `${stepLabel}: outcomes[${index}]`)),
        budget: validateGateStepBudgetTier(raw.budget, `${stepLabel}: budget`),
        capabilities: ["none"]
    };
    if (common.outcomes.length < MIN_GATE_STEP_OUTCOMES || common.outcomes.length > MAX_GATE_STEP_OUTCOMES) {
        throw new Error(`${stepLabel}: outcomes must be an array of ${MIN_GATE_STEP_OUTCOMES}..${MAX_GATE_STEP_OUTCOMES} entries (got ${common.outcomes.length})`);
    }
    const expectedCapability = kind === "model" ? "network:model" : "none";
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length !== 1 || raw.capabilities[0] !== expectedCapability) {
        throw new Error(`${stepLabel}: capabilities must be exactly ["${expectedCapability}"] for kind "${kind}"`);
    }
    if (kind === "model") {
        return { ...common, kind, binding: validateModelStageBinding(raw.binding), capabilities: ["network:model"] };
    }
    return { ...common, kind, capabilities: ["none"] };
}
const COMPILED_FLOW_KEYS = new Set([
    "schemaVersion",
    "compilerVersion",
    "flow",
    "goal",
    "objectives",
    "validityPolicy",
    "budgetPolicy",
    "inputContract",
    "decisionContract",
    "decisionCodes",
    "entryStepId",
    "steps",
    "transitions",
    "terminationCertificate",
    "compiledDigest"
]);
/**
 * LOUD validator for a sealed {@link CompiledGateFlow}: full shape validation
 * (including the embedded certificate's OWN recompute-and-verify), then the
 * compiled digest recompute — tampering anywhere throws "digest mismatch".
 */
export function validateCompiledGateFlow(value) {
    const label = "compiled gate flow";
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, COMPILED_FLOW_KEYS, label);
    if (raw.schemaVersion !== COMPILED_GATE_FLOW_SCHEMA_VERSION) {
        throw new Error(`${label}: schemaVersion must be ${JSON.stringify(COMPILED_GATE_FLOW_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
    }
    if (raw.compilerVersion !== GATE_FLOW_COMPILER_VERSION) {
        throw new Error(`${label}: compilerVersion must be ${JSON.stringify(GATE_FLOW_COMPILER_VERSION)} (got ${typeof raw.compilerVersion === "string" ? JSON.stringify(truncate(raw.compilerVersion)) : typeName(raw.compilerVersion)})`);
    }
    const flow = assertVersionedRef(raw.flow, `${label}: flow`);
    const goal = assertVersionedRef(raw.goal, `${label}: goal`);
    if (!Array.isArray(raw.objectives) || raw.objectives.length < 1 || raw.objectives.length > MAX_GATE_OBJECTIVES) {
        throw new Error(`${label}: objectives must be an array of 1..${MAX_GATE_OBJECTIVES} references (got ${Array.isArray(raw.objectives) ? raw.objectives.length : typeName(raw.objectives)})`);
    }
    const objectives = raw.objectives.map((objectiveRaw, index) => assertVersionedRef(objectiveRaw, `${label}: objectives[${index}]`));
    const validityPolicy = assertVersionedRef(raw.validityPolicy, `${label}: validityPolicy`);
    const budgetPolicy = assertVersionedRef(raw.budgetPolicy, `${label}: budgetPolicy`);
    const inputContract = validateContractId(raw.inputContract, `${label}: inputContract`);
    const decisionContract = validateContractId(raw.decisionContract, `${label}: decisionContract`);
    if (!Array.isArray(raw.decisionCodes) || raw.decisionCodes.length < 1 || raw.decisionCodes.length > MAX_GATE_DECISION_CODES) {
        throw new Error(`${label}: decisionCodes must be an array of 1..${MAX_GATE_DECISION_CODES} codes (got ${Array.isArray(raw.decisionCodes) ? raw.decisionCodes.length : typeName(raw.decisionCodes)})`);
    }
    const decisionCodes = raw.decisionCodes.map((code, index) => assertIdentifier(code, `${label}: decisionCodes[${index}]`));
    const entryStepId = assertIdentifier(raw.entryStepId, `${label}: entryStepId`);
    if (!Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > MAX_GATE_STEPS) {
        throw new Error(`${label}: steps must be an array of 1..${MAX_GATE_STEPS} compiled steps (got ${Array.isArray(raw.steps) ? raw.steps.length : typeName(raw.steps)})`);
    }
    const steps = raw.steps.map((stepRaw, index) => validateCompiledGateStep(stepRaw, `${label}: steps[${index}]`));
    if (!Array.isArray(raw.transitions) || raw.transitions.length < 2 || raw.transitions.length > MAX_GATE_TRANSITIONS) {
        throw new Error(`${label}: transitions must be an array of 2..${MAX_GATE_TRANSITIONS} transitions (got ${Array.isArray(raw.transitions) ? raw.transitions.length : typeName(raw.transitions)})`);
    }
    const transitions = raw.transitions.map((transitionRaw, index) => validateGateFlowTransition(transitionRaw, `${label}: transitions[${index}]`));
    const terminationCertificate = validateGateTerminationCertificate(raw.terminationCertificate);
    const sealed = assertSha256Hex(raw.compiledDigest, `${label}: compiledDigest`);
    const payload = {
        schemaVersion: COMPILED_GATE_FLOW_SCHEMA_VERSION,
        compilerVersion: GATE_FLOW_COMPILER_VERSION,
        flow,
        goal,
        objectives,
        validityPolicy,
        budgetPolicy,
        inputContract,
        decisionContract,
        decisionCodes,
        entryStepId,
        steps,
        transitions,
        terminationCertificate
    };
    const computed = digest(payload);
    if (sealed !== computed) {
        throw new Error(`${label} ${flow.id}@${flow.version}: digest mismatch — sealed ${sealed} != computed ${computed}`);
    }
    return { ...payload, compiledDigest: sealed };
}

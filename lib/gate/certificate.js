// gate/certificate.ts — the GateTerminationCertificate: the digest-sealed
// record of WHAT the gate-flow compiler proved about a flow (acyclicity,
// exhaustive outcome transitions, a human fallback for every failure path,
// strictly-increasing escalation levels, validator-only valid decisions) and
// the worst-case resource bounds the proof computed.
//
// PROMOTED from inbox-pipeline/src/decision/contracts.ts
// (DecisionTerminationProofSchema + DecisionTerminationCertificateSchema): the
// proof FIELDS are promoted one-for-one — the five literal-`true` flags stay
// literal `true` (a certificate whose proof flags are not exactly true cannot
// exist), the counts and bounds keep their promoted semantics, and the
// certificate digest seals the whole payload so ANY tampering (a nudged
// stepCount, a widened bound) is a LOUD "digest mismatch".
//
// The VALIDATOR RECOMPUTES AND VERIFIES: validateGateTerminationCertificate
// re-validates the full shape and recomputes `digest(payload-without-digest)`
// against the sealed certificateDigest — a certificate is never trusted on its
// say-so. Cross-checking a certificate against its COMPILED FLOW is the
// compiled-flow validator's job (gate/compiler.ts validateCompiledGateFlow
// embeds this validator and seals the certificate inside the compiled digest).
//
// STANDALONE: relative imports only (no npm deps, no zod).
import { digest } from "../contracts/digest.js";
import { assertIdentifier, assertPlainObject, assertPositiveInt, assertSha256Hex, assertStrictKeys, assertVersionedRef, typeName, truncate } from "../internal/guards.js";
import { MAX_GATE_OBJECTIVES, validateGateResourceBounds } from "./contracts.js";
export const GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION = "gate-termination-certificate.v1";
/** The ONE compiler these certificates (and compiled flows) may name. */
export const GATE_FLOW_COMPILER_VERSION = "gate-flow-compiler.v1";
const PROOF_KEYS = new Set([
    "entryStepId",
    "stepCount",
    "transitionCount",
    "terminalTransitionCount",
    "reachableStepCount",
    "acyclic",
    "exhaustiveOutcomes",
    "humanFallbackForFailureOutcomes",
    "escalationStrictlyIncreasesLevel",
    "validDecisionRequiresValidator",
    "bounds"
]);
const PROOF_FLAG_KEYS = [
    "acyclic",
    "exhaustiveOutcomes",
    "humanFallbackForFailureOutcomes",
    "escalationStrictlyIncreasesLevel",
    "validDecisionRequiresValidator"
];
export function validateGateTerminationProof(value, label = "gate termination proof") {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, PROOF_KEYS, label);
    const entryStepId = assertIdentifier(raw.entryStepId, `${label}: entryStepId`);
    const stepCount = assertPositiveInt(raw.stepCount, `${label}: stepCount`);
    const transitionCount = assertPositiveInt(raw.transitionCount, `${label}: transitionCount`);
    const terminalTransitionCount = assertPositiveInt(raw.terminalTransitionCount, `${label}: terminalTransitionCount`);
    if (terminalTransitionCount < 2) {
        throw new Error(`${label}: terminalTransitionCount must be >= 2 (at least one valid_decision AND one human_escalation terminal; got ${terminalTransitionCount})`);
    }
    const reachableStepCount = assertPositiveInt(raw.reachableStepCount, `${label}: reachableStepCount`);
    for (const flag of PROOF_FLAG_KEYS) {
        if (raw[flag] !== true) {
            const got = typeof raw[flag] === "string" ? JSON.stringify(truncate(raw[flag])) : typeName(raw[flag]);
            throw new Error(`${label}: ${flag} must be literally true — a flow without this proof has NO certificate (got ${got})`);
        }
    }
    const bounds = validateGateResourceBounds(raw.bounds, `${label}: bounds`);
    return {
        entryStepId,
        stepCount,
        transitionCount,
        terminalTransitionCount,
        reachableStepCount,
        acyclic: true,
        exhaustiveOutcomes: true,
        humanFallbackForFailureOutcomes: true,
        escalationStrictlyIncreasesLevel: true,
        validDecisionRequiresValidator: true,
        bounds
    };
}
const CERTIFICATE_INPUT_KEYS = new Set([
    "schemaVersion",
    "compilerVersion",
    "flow",
    "goal",
    "objectives",
    "validityPolicy",
    "budgetPolicy",
    "proof"
]);
const CERTIFICATE_KEYS = new Set([...CERTIFICATE_INPUT_KEYS, "certificateDigest"]);
function validateCertificateBase(raw, label) {
    if (raw.schemaVersion !== GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION) {
        throw new Error(`${label}: schemaVersion must be ${JSON.stringify(GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
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
    const proof = validateGateTerminationProof(raw.proof, `${label}: proof`);
    return {
        schemaVersion: GATE_TERMINATION_CERTIFICATE_SCHEMA_VERSION,
        compilerVersion: GATE_FLOW_COMPILER_VERSION,
        flow,
        goal,
        objectives,
        validityPolicy,
        budgetPolicy,
        proof
    };
}
/**
 * Seal a certificate payload (compiler-internal — hosts never mint
 * certificates; they receive them inside compiled flows and VALIDATE them).
 */
export function createGateTerminationCertificate(input) {
    const label = "gate termination certificate";
    const raw = assertPlainObject(input, label);
    assertStrictKeys(raw, CERTIFICATE_INPUT_KEYS, label);
    const base = validateCertificateBase(raw, label);
    return { ...base, certificateDigest: digest(base) };
}
/**
 * The recompute-and-verify validator: full shape validation, then
 * `certificateDigest` MUST equal the recomputed canonical digest of the
 * payload — tampering with any field (a count, a flag, a bound, a ref) throws
 * "digest mismatch". Never trust a certificate you did not validate.
 */
export function validateGateTerminationCertificate(value) {
    const label = "gate termination certificate";
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, CERTIFICATE_KEYS, label);
    const base = validateCertificateBase(raw, label);
    const sealed = assertSha256Hex(raw.certificateDigest, `${label}: certificateDigest`);
    const computed = digest(base);
    if (sealed !== computed) {
        throw new Error(`${label} for flow ${base.flow.id}@${base.flow.version}: digest mismatch — sealed ${sealed} != computed ${computed}`);
    }
    return { ...base, certificateDigest: sealed };
}

// store/routing.ts — pure deterministic routing and join arithmetic for N3.
//
// Routing evaluates only the sealed graph predicate language and the sealed
// output artifact supplied by a completed turn. It never executes host code,
// coerces values, reads inherited properties, or mutates graph/store state.
import { validateArtifactEnvelope } from "../contracts/artifact.js";
import { MAX_GRAPH_EDGES, MAX_JOIN_INBOUND_EDGES } from "../graph/definition.js";
import { validateEdge, validateJsonPointer, validateOutcomePredicate } from "../graph/edge.js";
import { assertIdentifier, assertSafePositiveInt, typeName } from "../internal/guards.js";
import { captureCapabilityRecord, captureDenseArrayItems } from "../internal/capability.js";
import { deepFrozenClone } from "../internal/evidence.js";
function decodePointerToken(token) {
    return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}
function ownDataValue(candidate, key) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (descriptor === undefined || !("value" in descriptor)) {
        return Object.freeze({ found: false });
    }
    return Object.freeze({ found: true, value: descriptor.value });
}
/**
 * Resolve an RFC 6901 pointer without consulting prototypes or invoking an
 * accessor. The caller validates the containing artifact before reaching this
 * helper, but descriptor-only traversal keeps the routing primitive safe on
 * its own terms as well.
 */
function resolveJsonPointer(document, pointerRaw) {
    const pointer = validateJsonPointer(pointerRaw, "routing field pointer");
    if (pointer === "")
        return Object.freeze({ found: true, value: document });
    let current = document;
    for (const encodedToken of pointer.slice(1).split("/")) {
        if (current === null || typeof current !== "object") {
            return Object.freeze({ found: false });
        }
        const token = decodePointerToken(encodedToken);
        if (Array.isArray(current)) {
            // RFC 6901 array indexes are canonical decimal tokens. `-` is an append
            // marker in JSON Patch, not a readable JSON Pointer member.
            if (!/^(0|[1-9][0-9]*)$/u.test(token)) {
                return Object.freeze({ found: false });
            }
            const index = Number(token);
            if (!Number.isSafeInteger(index) || index >= current.length) {
                return Object.freeze({ found: false });
            }
            const resolved = ownDataValue(current, token);
            if (!resolved.found)
                return resolved;
            current = resolved.value;
            continue;
        }
        const resolved = ownDataValue(current, token);
        if (!resolved.found)
            return resolved;
        current = resolved.value;
    }
    return Object.freeze({ found: true, value: current });
}
function scalarEquals(actual, expected) {
    // Strict equality is intentional: JSON number 1 does not equal string "1",
    // false does not equal 0, and no routing-time coercion is permitted.
    return actual === expected;
}
function validatedOutputArtifact(outputArtifact) {
    return outputArtifact === undefined
        ? undefined
        : validateArtifactEnvelope(outputArtifact);
}
function validatedOutcome(value) {
    return assertIdentifier(value, "routing outcome");
}
function predicateMatchesValidated(predicate, outcome, outputArtifact) {
    if (Object.hasOwn(predicate, "anyOf")) {
        return predicate.anyOf.includes(outcome);
    }
    const exact = predicate;
    if (exact.outcome !== outcome)
        return false;
    if (!Object.hasOwn(exact, "where"))
        return true;
    if (outputArtifact === undefined)
        return false;
    return exact.where.every((match) => {
        const resolved = resolveJsonPointer(outputArtifact, match.pointer);
        return resolved.found && scalarEquals(resolved.value, match.equals);
    });
}
/** Evaluate one member of the closed outcome-predicate language. */
export function outcomePredicateMatches(predicateRaw, outcomeRaw, outputArtifactRaw) {
    const predicate = validateOutcomePredicate(predicateRaw, "routing predicate");
    const outcome = validatedOutcome(outcomeRaw);
    const outputArtifact = validatedOutputArtifact(outputArtifactRaw);
    return predicateMatchesValidated(predicate, outcome, outputArtifact);
}
/**
 * Return matching edges in authored order. The output artifact is validated
 * once for the whole evaluation. Conditional predicates are false when it is
 * absent; unconditional outcome and anyOf predicates remain eligible.
 */
export function matchingOutcomeEdges(edges, outcomeRaw, outputArtifactRaw) {
    const validatedEdges = captureDenseArrayItems(edges, "routing edges", MAX_GRAPH_EDGES).map((edge, index) => validateEdge(edge, `routing edges[${index}]`));
    const outcome = validatedOutcome(outcomeRaw);
    const outputArtifact = validatedOutputArtifact(outputArtifactRaw);
    const matching = validatedEdges.filter((edge, index) => {
        const predicate = validateOutcomePredicate(edge.when, `routing edges[${index}] ${edge.edgeId}: when`);
        return predicateMatchesValidated(predicate, outcome, outputArtifact);
    });
    return deepFrozenClone(matching, "matching routing edges");
}
function requiredOfferCount(requirementRaw, inboundCount) {
    if (requirementRaw === "all")
        return inboundCount;
    const requirement = captureCapabilityRecord(requirementRaw, ["nOf"], ["nOf"], "join requirement");
    const nOf = assertSafePositiveInt(requirement.nOf, "join requirement.nOf");
    if (nOf > inboundCount) {
        throw new Error(`join requirement.nOf: ${nOf} cannot exceed ${inboundCount} distinct inbound edges`);
    }
    return nOf;
}
function validateJoinEdgeStates(statesRaw) {
    const items = captureDenseArrayItems(statesRaw, "join edge states", MAX_JOIN_INBOUND_EDGES);
    if (items.length < 1) {
        throw new Error("join edge states: must be a non-empty array (got 0)");
    }
    const states = items.map((stateRaw, index) => {
        const label = `join edge states[${index}]`;
        const state = captureCapabilityRecord(stateRaw, ["edgeId", "state"], ["edgeId", "state"], label);
        if (state.state !== "pending"
            && state.state !== "offered"
            && state.state !== "impossible") {
            throw new Error(`${label}.state: must be "pending" | "offered" | "impossible" (got ${typeof state.state === "string" ? JSON.stringify(state.state) : typeName(state.state)})`);
        }
        return {
            edgeId: assertIdentifier(state.edgeId, `${label}.edgeId`),
            state: state.state
        };
    });
    const duplicate = states.find((candidate, index) => states.findIndex((state) => state.edgeId === candidate.edgeId) !== index);
    if (duplicate !== undefined) {
        throw new Error(`join edge states: edge ${duplicate.edgeId} appears more than once; offered/impossible states must be distinct`);
    }
    return deepFrozenClone(states, "join edge states");
}
/** Evaluate all/nOf threshold and future satisfiability over distinct edges. */
export function evaluateJoinThreshold(requirement, statesRaw) {
    const states = validateJoinEdgeStates(statesRaw);
    const required = requiredOfferCount(requirement, states.length);
    const offered = states.filter((edge) => edge.state === "offered").length;
    const impossible = states.filter((edge) => edge.state === "impossible").length;
    const pending = states.length - offered - impossible;
    const thresholdSatisfied = offered >= required;
    const satisfiable = thresholdSatisfied || offered + pending >= required;
    return Object.freeze({
        required,
        offered,
        impossible,
        pending,
        thresholdSatisfied,
        satisfiable,
        unsatisfiable: !satisfiable
    });
}
export function isJoinThresholdSatisfied(requirement, states) {
    return evaluateJoinThreshold(requirement, states).thresholdSatisfied;
}
export function isJoinSatisfiable(requirement, states) {
    return evaluateJoinThreshold(requirement, states).satisfiable;
}

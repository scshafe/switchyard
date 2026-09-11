// graph/diff.ts — identity-based structural differences between sealed graphs.
//
// Promoted from Inbox's graphProposalDiff: the engine owns comparison, while
// consumers own labels and formatting. Both source seals travel with the diff;
// no current registry, presentation, or executable capability is consulted.
import { canonicalJson } from "../contracts/digest.js";
import { validateGraphDefinition } from "./definition.js";
import { predicateOutcomes } from "./edge.js";
/** Only called with engine-constructed records and already-detached values. */
function frozenRecord(value) {
    return Object.freeze(Object.assign(Object.create(null), value));
}
/** Validated optional keys must never consult the ambient object prototype. */
function own(value, key) {
    return Object.hasOwn(value, key) ? value[key] : undefined;
}
function terminalKey(terminal) {
    return `${terminal.nodeId}\u0000${terminal.outcome}`;
}
function missing(from, to) {
    const held = new Set(to);
    return Object.freeze(from.filter((value) => !held.has(value)));
}
function fieldChange(field, from, to) {
    const before = from === undefined ? "undefined" : canonicalJson(from);
    const after = to === undefined ? "undefined" : canonicalJson(to);
    return before === after ? null : frozenRecord({ field, from: before, to: after });
}
function nodeFields(sealed, candidate) {
    const beforeBinding = own(sealed, "binding");
    const afterBinding = own(candidate, "binding");
    return Object.freeze([
        fieldChange("ref", sealed.ref, candidate.ref),
        fieldChange("kind", sealed.kind, candidate.kind),
        fieldChange("input", sealed.input, candidate.input),
        fieldChange("principal.id", sealed.principal.id, candidate.principal.id),
        fieldChange("outcomes.version", sealed.outcomes.version, candidate.outcomes.version),
        fieldChange("outputs", own(sealed, "outputs"), own(candidate, "outputs")),
        fieldChange("binding.bindingId", beforeBinding?.bindingId, afterBinding?.bindingId),
        fieldChange("binding.version", beforeBinding?.version, afterBinding?.version),
        fieldChange("binding.bindingDigest", beforeBinding?.bindingDigest, afterBinding?.bindingDigest),
        fieldChange("configuration", own(sealed, "configuration"), own(candidate, "configuration")),
        fieldChange("turn.leaseMs", sealed.turn.leaseMs, candidate.turn.leaseMs),
        fieldChange("turn.maxAttempts", sealed.turn.maxAttempts, candidate.turn.maxAttempts),
        fieldChange("turn.idempotency", sealed.turn.idempotency, candidate.turn.idempotency),
        fieldChange("turn.retryTaxonomy", sealed.turn.retryTaxonomy, candidate.turn.retryTaxonomy),
        fieldChange("join", own(sealed, "join"), own(candidate, "join"))
    ].filter((change) => change !== null));
}
function edgeFields(sealed, candidate) {
    return Object.freeze([
        fieldChange("from", sealed.from, candidate.from),
        fieldChange("to", sealed.to, candidate.to),
        // Preserve predicate shape: {outcome} and one-outcome {anyOf} differ even
        // though both predicates currently mention the same outcome.
        fieldChange("when", sealed.when, candidate.when)
    ].filter((change) => change !== null));
}
/**
 * Compare two data-valid, digest-sealed graph definitions by node ID, edge ID,
 * and terminal pair. Top-level collection order and node-outcome order do not
 * produce changes; edge target, predicate, and join arrays remain structural.
 * Outcome additions/removals keep their respective source's authored order.
 *
 * Definition validation rejects hostile input and altered seals. Compilation
 * is deliberately separate: a sealed candidate may still need coverage or
 * reachability repairs that a proposal viewer should be able to inspect.
 */
export function graphDefinitionDiff(sealedRaw, candidateRaw) {
    const sealed = validateGraphDefinition(sealedRaw);
    const candidate = validateGraphDefinition(candidateRaw);
    const sealedNodes = new Map(sealed.nodes.map((node) => [node.nodeId, node]));
    const candidateNodes = new Map(candidate.nodes.map((node) => [node.nodeId, node]));
    const nodes = [];
    let unchangedNodes = 0;
    for (const nodeId of [...new Set([...sealedNodes.keys(), ...candidateNodes.keys()])].sort()) {
        const before = sealedNodes.get(nodeId);
        const after = candidateNodes.get(nodeId);
        if (before === undefined && after !== undefined) {
            nodes.push(frozenRecord({
                nodeId, change: "added",
                outcomesAdded: Object.freeze([...after.outcomes.outcomes]),
                outcomesRemoved: Object.freeze([]), fields: Object.freeze([])
            }));
        }
        else if (before !== undefined && after === undefined) {
            nodes.push(frozenRecord({
                nodeId, change: "removed",
                outcomesAdded: Object.freeze([]),
                outcomesRemoved: Object.freeze([...before.outcomes.outcomes]), fields: Object.freeze([])
            }));
        }
        else if (before !== undefined && after !== undefined) {
            const outcomesAdded = missing(after.outcomes.outcomes, before.outcomes.outcomes);
            const outcomesRemoved = missing(before.outcomes.outcomes, after.outcomes.outcomes);
            const fields = nodeFields(before, after);
            if (outcomesAdded.length === 0 && outcomesRemoved.length === 0 && fields.length === 0) {
                unchangedNodes += 1;
            }
            else {
                nodes.push(frozenRecord({ nodeId, change: "changed", outcomesAdded, outcomesRemoved, fields }));
            }
        }
    }
    const sealedEdges = new Map(sealed.edges.map((edge) => [edge.edgeId, edge]));
    const candidateEdges = new Map(candidate.edges.map((edge) => [edge.edgeId, edge]));
    const edges = [];
    let unchangedEdges = 0;
    for (const edgeId of [...new Set([...sealedEdges.keys(), ...candidateEdges.keys()])].sort()) {
        const before = sealedEdges.get(edgeId);
        const after = candidateEdges.get(edgeId);
        if (before === undefined && after !== undefined) {
            edges.push(frozenRecord({
                edgeId, change: "added", from: after.from, to: Object.freeze([...after.to]),
                outcomesAdded: Object.freeze([...predicateOutcomes(after.when)]),
                outcomesRemoved: Object.freeze([]), fields: Object.freeze([])
            }));
        }
        else if (before !== undefined && after === undefined) {
            edges.push(frozenRecord({
                edgeId, change: "removed", from: before.from, to: Object.freeze([...before.to]),
                outcomesAdded: Object.freeze([]),
                outcomesRemoved: Object.freeze([...predicateOutcomes(before.when)]), fields: Object.freeze([])
            }));
        }
        else if (before !== undefined && after !== undefined) {
            const outcomesAdded = missing(predicateOutcomes(after.when), predicateOutcomes(before.when));
            const outcomesRemoved = missing(predicateOutcomes(before.when), predicateOutcomes(after.when));
            const fields = edgeFields(before, after);
            if (outcomesAdded.length === 0 && outcomesRemoved.length === 0 && fields.length === 0) {
                unchangedEdges += 1;
            }
            else {
                edges.push(frozenRecord({
                    edgeId, change: "changed", from: after.from, to: Object.freeze([...after.to]),
                    outcomesAdded, outcomesRemoved, fields
                }));
            }
        }
    }
    const sealedTerminals = new Map(sealed.terminals.map((terminal) => [terminalKey(terminal), terminal]));
    const candidateTerminals = new Map(candidate.terminals.map((terminal) => [terminalKey(terminal), terminal]));
    const terminals = [];
    let unchangedTerminals = 0;
    for (const key of [...new Set([...sealedTerminals.keys(), ...candidateTerminals.keys()])].sort()) {
        const before = sealedTerminals.get(key);
        const after = candidateTerminals.get(key);
        if (before !== undefined && after !== undefined) {
            unchangedTerminals += 1;
            continue;
        }
        const terminal = after ?? before;
        if (terminal !== undefined) {
            terminals.push(frozenRecord({
                nodeId: terminal.nodeId, outcome: terminal.outcome,
                change: after === undefined ? "removed" : "added"
            }));
        }
    }
    const description = fieldChange("description", sealed.description, candidate.description);
    const entry = fieldChange("entry", sealed.entry, candidate.entry);
    return frozenRecord({
        schemaVersion: "mission-pipeline-graph-definition-diff.v1",
        sealed: frozenRecord({ graphId: sealed.graphId, version: sealed.version, digest: sealed.graphDigest }),
        candidate: frozenRecord({ graphId: candidate.graphId, version: candidate.version, digest: candidate.graphDigest }),
        sameFamily: sealed.graphId === candidate.graphId,
        description, entry,
        nodes: Object.freeze(nodes), edges: Object.freeze(edges), terminals: Object.freeze(terminals),
        unchanged: frozenRecord({ nodes: unchangedNodes, edges: unchangedEdges, terminals: unchangedTerminals }),
        empty: nodes.length === 0 && edges.length === 0 && terminals.length === 0
            && description === null && entry === null
    });
}

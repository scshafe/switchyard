// graph/budget.ts — worst-case turn budget and cycle report for a sealed graph.
//
// The compiler admits cycles (a legal v2 structure), and `turn.maxAttempts`
// bounds one queued occurrence, not a unit's whole journey. This helper
// answers the question a goal designer and an evaluation harness both ask:
// how many turns, and how many model attempts, can one unit consume in the
// worst case? The bound assumes every edge may fire; mutually exclusive
// outcomes and conditional `where` arms are not modelled, so it is an upper
// bound, never an estimate. A cyclic graph has no bound and says so.
//
// The occurrence arithmetic mirrors settlement exactly: admission queues the
// entry once; one source settlement creates one occurrence per distinct
// ordinary target regardless of how many edges match; a join queues at most
// once per unit (DESIGN §10.2).
import { compileGraph } from "./compile.js";
/** Prototype-free frozen record: identifier "constructor" must be ordinary data. */
function frozenRecord(entries) {
    const record = Object.create(null);
    for (const [key, value] of entries) {
        Object.defineProperty(record, key, {
            configurable: false,
            enumerable: true,
            writable: false,
            value
        });
    }
    return Object.freeze(record);
}
/** Every (edge, target) pair leaving a node, in authored edge and target order. */
function arcsFrom(compiled, nodeId) {
    const arcs = [];
    for (const edge of compiled.outboundByNode[nodeId] ?? []) {
        for (const to of edge.to)
            arcs.push({ edgeId: edge.edgeId, from: edge.from, to });
    }
    return arcs;
}
/**
 * Iterative depth-first walk from the entry. An arc whose target is still on
 * the walk stack closes a cycle; every such arc is reported so a reader can
 * see each loop the sealed graph contains.
 */
function findCycleEdges(compiled) {
    const state = new Map();
    const cycleEdges = [];
    const stack = [
        { nodeId: compiled.entry, arcs: arcsFrom(compiled, compiled.entry), next: 0 }
    ];
    state.set(compiled.entry, "active");
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.next >= frame.arcs.length) {
            state.set(frame.nodeId, "done");
            stack.pop();
            continue;
        }
        const arc = frame.arcs[frame.next];
        frame.next += 1;
        const seen = state.get(arc.to);
        if (seen === "active") {
            cycleEdges.push(Object.freeze({ edgeId: arc.edgeId, from: arc.from, to: arc.to }));
            continue;
        }
        if (seen === "done")
            continue;
        state.set(arc.to, "active");
        stack.push({ nodeId: arc.to, arcs: arcsFrom(compiled, arc.to), next: 0 });
    }
    return Object.freeze(cycleEdges);
}
/** Topological order of an acyclic compiled graph, entry first, authored tie order. */
function topologicalOrder(compiled) {
    const remaining = new Map();
    for (const node of compiled.nodes)
        remaining.set(node.nodeId, 0);
    for (const node of compiled.nodes) {
        const sources = new Set();
        for (const edge of compiled.inboundByNode[node.nodeId] ?? [])
            sources.add(edge.from);
        remaining.set(node.nodeId, sources.size);
    }
    const order = [];
    const ready = compiled.nodes
        .filter((node) => remaining.get(node.nodeId) === 0)
        .map((node) => node.nodeId);
    while (ready.length > 0) {
        const nodeId = ready.shift();
        order.push(nodeId);
        const targets = new Set();
        for (const arc of arcsFrom(compiled, nodeId))
            targets.add(arc.to);
        for (const target of compiled.nodes.map((node) => node.nodeId)) {
            if (!targets.has(target))
                continue;
            const left = remaining.get(target) - 1;
            remaining.set(target, left);
            if (left === 0)
                ready.push(target);
        }
    }
    if (order.length !== compiled.nodes.length) {
        throw new Error("graph turn budget: topological order is incomplete for an acyclic graph");
    }
    return order;
}
/**
 * Worst-case turn budget for a sealed graph definition. Validation is the
 * compiler's: an unsealed, tampered, or incomplete definition fails here
 * exactly as it would at publication.
 */
export function graphTurnBudget(definitionRaw) {
    const compiled = compileGraph(definitionRaw);
    const cycleEdges = findCycleEdges(compiled);
    const acyclic = cycleEdges.length === 0;
    const depth = new Map();
    const occurrences = new Map();
    if (acyclic) {
        for (const nodeId of topologicalOrder(compiled)) {
            const node = compiled.nodesById[nodeId];
            if (nodeId === compiled.entry) {
                depth.set(nodeId, 0);
                occurrences.set(nodeId, 1);
                continue;
            }
            const sources = new Set();
            for (const edge of compiled.inboundByNode[nodeId] ?? [])
                sources.add(edge.from);
            let longest = 0;
            let arrivals = 0;
            for (const source of sources) {
                longest = Math.max(longest, depth.get(source) + 1);
                arrivals += occurrences.get(source);
            }
            depth.set(nodeId, longest);
            // A join queues at most once; an ordinary target queues once per source
            // settlement that reaches it, however many edges that settlement matches.
            occurrences.set(nodeId, node.join === undefined ? arrivals : 1);
        }
    }
    const turnsByKind = new Map();
    let totalTurns = 0;
    let deepest = 0;
    const nodes = frozenRecord(compiled.nodes.map((node) => {
        const nodeDepth = acyclic ? depth.get(node.nodeId) : null;
        const maxOccurrences = acyclic ? occurrences.get(node.nodeId) : null;
        const nodeTurns = maxOccurrences === null ? null : maxOccurrences * node.turn.maxAttempts;
        if (nodeTurns !== null) {
            totalTurns += nodeTurns;
            turnsByKind.set(node.kind, (turnsByKind.get(node.kind) ?? 0) + nodeTurns);
        }
        if (nodeDepth !== null)
            deepest = Math.max(deepest, nodeDepth);
        return [node.nodeId, Object.freeze({
                nodeId: node.nodeId,
                kind: node.kind,
                join: node.join !== undefined,
                maxAttempts: node.turn.maxAttempts,
                depth: nodeDepth,
                maxOccurrences,
                maxTurns: nodeTurns
            })];
    }));
    const kindTotal = (kind) => acyclic ? (turnsByKind.get(kind) ?? 0) : null;
    return Object.freeze({
        graph: compiled.graph,
        acyclic,
        cycleEdges,
        nodes,
        maxDepth: acyclic ? deepest : null,
        maxTurns: acyclic ? totalTurns : null,
        maxTurnsByKind: Object.freeze({
            code: kindTotal("code"),
            model: kindTotal("model"),
            agent: kindTotal("agent"),
            human: kindTotal("human"),
            callback: kindTotal("callback")
        })
    });
}

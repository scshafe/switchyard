// graph/compile.ts — compile a sealed v2 graph to frozen executor indexes.
import { declaredNodeOutput, declaredNodeOutputs, graphDefinitionRef, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID, validateGraphDefinition } from "./definition.js";
import { isUnconditionalOutcomePredicate, predicateOutcomes } from "./edge.js";
function pairKey(nodeId, outcome) {
    return `${nodeId}\u0000${outcome}`;
}
function refKey(node) {
    return `${node.ref.id}\u0000${node.ref.version}`;
}
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
/** Declared outputs compare as maps: same outcomes, same contracts, any order. */
export function sameDeclaredOutputs(left, right) {
    if (left === undefined || right === undefined)
        return left === right;
    const leftKeys = Object.keys(left);
    if (leftKeys.length !== Object.keys(right).length)
        return false;
    return leftKeys.every((outcome) => Object.hasOwn(right, outcome) && right[outcome] === left[outcome]);
}
function validateBindingRules(node) {
    if (node.principal.id === MISSION_PIPELINE_ENGINE_PRINCIPAL_ID) {
        throw new Error(`Graph node ${node.nodeId} cannot use reserved engine principal ${MISSION_PIPELINE_ENGINE_PRINCIPAL_ID}`);
    }
    const binding = Object.hasOwn(node, "binding") ? node.binding : undefined;
    if (node.kind === "model" && binding === undefined) {
        throw new Error(`Graph model node ${node.nodeId} requires a model binding`);
    }
    if (node.kind !== "model" && binding !== undefined) {
        throw new Error(`Graph ${node.kind} node ${node.nodeId} does not accept a binding`);
    }
}
/**
 * Compile a sealed graph into authored-order indexes. Semantic validation is
 * deliberately kept in this function so every store/executor consumes the
 * same accepted graph language.
 */
export function compileGraph(definitionRaw) {
    const definition = validateGraphDefinition(definitionRaw);
    const nodesById = frozenRecord(definition.nodes.map((node) => [node.nodeId, node]));
    const edgesById = frozenRecord(definition.edges.map((edge) => [edge.edgeId, edge]));
    const inboundByNode = frozenRecord(definition.nodes.map((node) => [
        node.nodeId,
        Object.freeze(definition.edges.filter((edge) => edge.to.includes(node.nodeId)))
    ]));
    const outboundByNode = frozenRecord(definition.nodes.map((node) => [
        node.nodeId,
        Object.freeze(definition.edges.filter((edge) => edge.from === node.nodeId))
    ]));
    if (nodesById[definition.entry] === undefined) {
        throw new Error(`Graph entry references unknown node ${definition.entry}`);
    }
    // References and predicate vocabularies. Outcomes are checked against the
    // exact source node — there is no graph-wide/default vocabulary.
    for (const edge of definition.edges) {
        const source = nodesById[edge.from];
        if (source === undefined) {
            throw new Error(`Graph edge ${edge.edgeId} references unknown source node ${edge.from}`);
        }
        for (const target of edge.to) {
            const targetNode = nodesById[target];
            if (targetNode === undefined) {
                throw new Error(`Graph edge ${edge.edgeId} references unknown target node ${target}`);
            }
            if (predicateOutcomes(edge.when).includes("join_unsatisfiable")
                && targetNode.input !== JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT) {
                throw new Error(`Graph edge ${edge.edgeId} routes join_unsatisfiable to node ${target}, which requires ${JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT} as its input contract (got ${targetNode.input})`);
            }
        }
        const declared = new Set(source.outcomes.outcomes);
        for (const outcome of predicateOutcomes(edge.when)) {
            if (!declared.has(outcome)) {
                throw new Error(`Graph edge ${edge.edgeId} from node ${edge.from} references undeclared outcome ${JSON.stringify(outcome)}`);
            }
            // A declared output contract must be accepted by every node this edge
            // queues, joins included. Settlement checks the same equality on the
            // actual artifact; proving it here keeps a mismatch out of publication.
            const emitted = declaredNodeOutput(source, outcome);
            if (emitted === undefined)
                continue;
            for (const target of edge.to) {
                const targetNode = nodesById[target];
                if (targetNode.input !== emitted) {
                    throw new Error(`Graph edge ${edge.edgeId} carries outcome ${JSON.stringify(outcome)} from node ${edge.from} as ${emitted}, but target node ${target} accepts ${targetNode.input}`);
                }
            }
        }
    }
    const terminalPairs = new Set();
    for (const terminal of definition.terminals) {
        const node = nodesById[terminal.nodeId];
        if (node === undefined) {
            throw new Error(`Graph terminal references unknown node ${terminal.nodeId} for outcome ${JSON.stringify(terminal.outcome)}`);
        }
        if (!node.outcomes.outcomes.includes(terminal.outcome)) {
            throw new Error(`Graph terminal for node ${terminal.nodeId} references undeclared outcome ${JSON.stringify(terminal.outcome)}`);
        }
        terminalPairs.add(pairKey(terminal.nodeId, terminal.outcome));
    }
    for (const node of definition.nodes) {
        validateBindingRules(node);
        const join = Object.hasOwn(node, "join") ? node.join : undefined;
        if (join === undefined && node.outcomes.outcomes.includes("join_unsatisfiable")) {
            throw new Error(`Graph non-join node ${node.nodeId} cannot declare engine-reserved outcome "join_unsatisfiable"`);
        }
        if (node.nodeId === definition.entry && join !== undefined) {
            throw new Error(`Graph entry node ${node.nodeId} cannot declare a join; admission queues entry without an inbound edge offer`);
        }
        if (join !== undefined && !node.outcomes.outcomes.includes("join_unsatisfiable")) {
            throw new Error(`Join node ${node.nodeId} must declare outcome "join_unsatisfiable"`);
        }
    }
    // A node ref identifies one definition signature. Principal, binding,
    // configuration, turn, nodeId, and join are graph-instance configuration;
    // dispatch kind, input contract, outcome vocabulary, and declared output
    // contracts are definition-bound. Pure compilation proves this within a
    // graph; publish stores enforce it across graphs.
    const definitionByRef = new Map();
    for (const node of definition.nodes) {
        const key = refKey(node);
        const existing = definitionByRef.get(key);
        if (existing === undefined) {
            definitionByRef.set(key, node);
            continue;
        }
        if (existing.kind !== node.kind) {
            throw new Error(`Node definition ${node.ref.id}@${node.ref.version} is reused with a different kind; change the node version`);
        }
        if (existing.input !== node.input) {
            throw new Error(`Node definition ${node.ref.id}@${node.ref.version} is reused with a different input contract; change the node version`);
        }
        const existingOutcomes = new Set(existing.outcomes.outcomes);
        if (existingOutcomes.size !== node.outcomes.outcomes.length
            || node.outcomes.outcomes.some((outcome) => !existingOutcomes.has(outcome))) {
            throw new Error(`Node definition ${node.ref.id}@${node.ref.version} is reused with a different outcome vocabulary; outcome changes require a new node version`);
        }
        if (!sameDeclaredOutputs(declaredNodeOutputs(existing), declaredNodeOutputs(node))) {
            throw new Error(`Node definition ${node.ref.id}@${node.ref.version} is reused with different output contracts; change the node version`);
        }
    }
    // A join declaration is the exact stable identity set of edges that target
    // it. Exactness keeps N3 progress unambiguous: no unnamed offer can arrive.
    for (const node of definition.nodes) {
        const join = Object.hasOwn(node, "join") ? node.join : undefined;
        if (join === undefined)
            continue;
        const actualInbound = inboundByNode[node.nodeId] ?? [];
        const actualIds = new Set(actualInbound.map((edge) => edge.edgeId));
        for (const edgeId of join.inbound) {
            const edge = edgesById[edgeId];
            if (edge === undefined) {
                throw new Error(`Join node ${node.nodeId} declares unknown edge ${edgeId}`);
            }
            if (!edge.to.includes(node.nodeId)) {
                throw new Error(`Join node ${node.nodeId} declares edge ${edgeId}, but that edge does not target ${node.nodeId}`);
            }
        }
        for (const edge of actualInbound) {
            if (!join.inbound.includes(edge.edgeId)) {
                throw new Error(`Join node ${node.nodeId} omits actual inbound edge ${edge.edgeId}`);
            }
        }
        if (join.inbound.length !== actualIds.size) {
            throw new Error(`Join node ${node.nodeId} inbound declaration must equal its actual inbound-edge set`);
        }
        if (join.require !== "all"
            && join.require.nOf > join.inbound.length) {
            throw new Error(`Join node ${node.nodeId} requires ${join.require.nOf}-of-${join.inbound.length}, but nOf cannot exceed declared inbound edges`);
        }
    }
    // Terminal is an outcome property with no successors. Mixing terminal and
    // routed semantics for one source outcome would make settlement ambiguous.
    for (const edge of definition.edges) {
        for (const outcome of predicateOutcomes(edge.when)) {
            if (terminalPairs.has(pairKey(edge.from, outcome))) {
                throw new Error(`Graph node ${edge.from} outcome ${JSON.stringify(outcome)} is both terminal and routed by edge ${edge.edgeId}`);
            }
        }
    }
    // Conditional where-arms are additive: because their field test can be
    // false, only an unconditional route or explicit terminal proves coverage.
    const unconditionalPairs = new Set();
    for (const edge of definition.edges) {
        if (!isUnconditionalOutcomePredicate(edge.when))
            continue;
        for (const outcome of predicateOutcomes(edge.when)) {
            unconditionalPairs.add(pairKey(edge.from, outcome));
        }
    }
    for (const node of definition.nodes) {
        for (const outcome of node.outcomes.outcomes) {
            const key = pairKey(node.nodeId, outcome);
            if (!unconditionalPairs.has(key) && !terminalPairs.has(key)) {
                throw new Error(`Graph node ${node.nodeId} outcome ${JSON.stringify(outcome)} is uncovered: declare an unconditional edge or terminal`);
            }
        }
    }
    // Structural reachability only. Cycles are legal v2 graph structure; no v1
    // whole-DAG traversal/topological rule is inherited.
    const reachable = new Set();
    const pending = [definition.entry];
    while (pending.length > 0) {
        const nodeId = pending.shift();
        if (reachable.has(nodeId))
            continue;
        reachable.add(nodeId);
        for (const edge of outboundByNode[nodeId] ?? []) {
            for (const target of edge.to) {
                if (!reachable.has(target))
                    pending.push(target);
            }
        }
    }
    for (const node of definition.nodes) {
        if (!reachable.has(node.nodeId)) {
            throw new Error(`Graph node ${node.nodeId} is unreachable from entry ${definition.entry}`);
        }
    }
    // Every definition component/ref is already a detached deep-frozen snapshot;
    // the newly derived arrays and prototype-free records are frozen above.
    return Object.freeze({
        graph: graphDefinitionRef(definition),
        entry: definition.entry,
        nodes: definition.nodes,
        edges: definition.edges,
        terminals: definition.terminals,
        nodesById,
        edgesById,
        inboundByNode,
        outboundByNode
    });
}

import { canonicalJson, digest } from "mission-pipeline/contracts/digest";
import { captureCapabilityRecord } from "mission-pipeline/internal/capability";
import { deepFrozenClone, snapshotBoundedValidationData } from "mission-pipeline/internal/evidence";
import { assertIdentifier, assertSafePositiveInt, assertSha256Hex } from "mission-pipeline/internal/guards";
import { compileGraph } from "mission-pipeline/graph/compile";
import { GRAPH_DISPLAY_SCHEMA_VERSION, projectGraphDisplay } from "mission-pipeline/graph/display";
import { JOIN_INPUT_ARTIFACT_CONTRACT, NODE_TURN_IDEMPOTENCY, NODE_TURN_RETRY_TAXONOMY, validateMissionPipelineNode } from "mission-pipeline/graph/definition";
import { validateGoalManifest } from "mission-pipeline/graph/goals";
import { PIPELINE_PRESENTATION_SCHEMA_VERSION } from "./types.js";
const own = (value, key) => Object.hasOwn(value, key);
const pairKey = (nodeId, outcome) => `${nodeId}\u0000${outcome}`;
const tupleKey = (terminal) => pairKey(terminal.nodeId, terminal.outcome);
/** Internal: callers must budget unknown input before cloning it recursively. */
export function frozenData(value) {
    const convert = (candidate) => {
        if (candidate === null || typeof candidate !== "object")
            return candidate;
        if (Array.isArray(candidate))
            return Object.freeze(candidate.map(convert));
        const record = Object.create(null);
        for (const [key, field] of Object.entries(candidate))
            record[key] = convert(field);
        return Object.freeze(record);
    };
    return convert(deepFrozenClone(value, "pipeline data"));
}
function snapshot(value, label) {
    // Fan-out expands authored edges into several arrows. This is a separate
    // SDK admission budget, not the engine's smaller graph-definition budget.
    return frozenData(snapshotBoundedValidationData(value, label, {
        maxDepth: 24, maxValues: 1_000_000, maxStringCodeUnits: 33_554_432
    }));
}
function record(value, keys, required, label) {
    return captureCapabilityRecord(value, keys, required, label);
}
function dictionary(value, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be a record`);
    return record(value, Object.keys(value), [], label);
}
function list(value, label, max = 65_536, min = 0) {
    if (!Array.isArray(value) || value.length < min || value.length > max)
        throw new Error(`${label} must be an array of ${min}..${max} items`);
    return value;
}
function words(value, label) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 8_192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} must be non-empty bounded text without control characters`);
    }
    return value;
}
function optionalWords(raw, keys, label) {
    for (const key of keys)
        if (own(raw, key))
            words(raw[key], `${label}.${key}`);
}
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`${label} must be unique`);
}
function identifiers(value, label, max = 2_048, min = 0) {
    const result = list(value, label, max, min).map((item, index) => assertIdentifier(item, `${label}[${index}]`));
    unique(result, label);
    return result;
}
function bool(value, label) {
    if (typeof value !== "boolean")
        throw new Error(`${label} must be boolean`);
}
function terminal(value, label) {
    const raw = record(value, ["nodeId", "outcome"], ["nodeId", "outcome"], label);
    return { nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`), outcome: assertIdentifier(raw.outcome, `${label}.outcome`) };
}
function rows(value, label) {
    list(value, label, 64).forEach((item, index) => {
        const row = record(item, ["label", "value"], ["label", "value"], `${label}[${index}]`);
        words(row.label, `${label}[${index}].label`);
        words(row.value, `${label}[${index}].value`);
    });
}
function projectionData(value) {
    const raw = record(snapshot(value, "projection"), ["schemaVersion", "graph", "entry", "nodes", "arrows", "terminals", "joins"], ["schemaVersion", "graph", "entry", "nodes", "arrows", "terminals", "joins"], "projection");
    if (raw.schemaVersion !== GRAPH_DISPLAY_SCHEMA_VERSION)
        throw new Error(`projection.schemaVersion must be ${GRAPH_DISPLAY_SCHEMA_VERSION}`);
    const graph = record(raw.graph, ["id", "version", "digest"], ["id", "version", "digest"], "projection.graph");
    assertIdentifier(graph.id, "projection.graph.id");
    assertSafePositiveInt(graph.version, "projection.graph.version");
    assertSha256Hex(graph.digest, "projection.graph.digest");
    const entry = assertIdentifier(raw.entry, "projection.entry");
    const nodes = list(raw.nodes, "projection.nodes", 256, 1).map((value, index) => {
        const label = `projection.nodes[${index}]`;
        const node = record(value, ["nodeId", "kind", "ref", "input", "outcomes", "outputs", "binding", "configuration", "join", "maxAttempts", "depth", "marks"], ["nodeId", "kind", "ref", "input", "outcomes", "maxAttempts", "depth", "marks"], label);
        const ref = record(node.ref, ["id", "version"], ["id", "version"], `${label}.ref`);
        // Reuse the engine's node-field validation. These synthetic principal/turn
        // fields are never rendered or retained and prove no source authenticity.
        const validatedNode = validateMissionPipelineNode({
            nodeId: node.nodeId, kind: node.kind, ref, input: node.input,
            outcomes: { version: ref.version, outcomes: node.outcomes },
            ...Object.fromEntries(["outputs", "binding", "configuration", "join"].filter((key) => own(node, key)).map((key) => [key, node[key]])),
            principal: { id: "graphpaper.validation" },
            turn: { idempotency: NODE_TURN_IDEMPOTENCY, retryTaxonomy: NODE_TURN_RETRY_TAXONOMY, leaseMs: 1, maxAttempts: node.maxAttempts }
        }, label);
        if (validatedNode.join?.compose === "envelope" && validatedNode.input !== JOIN_INPUT_ARTIFACT_CONTRACT)
            throw new Error(`${label}: envelope join requires ${JOIN_INPUT_ARTIFACT_CONTRACT}`);
        if (typeof node.depth !== "number" || !Number.isSafeInteger(node.depth) || node.depth < 0 || node.depth > 255)
            throw new Error(`${label}.depth must be an integer in 0..255`);
        bool(node.marks, `${label}.marks`);
        return node;
    });
    unique(nodes.map((node) => node.nodeId), "projection node IDs");
    const byNode = new Map(nodes.map((node) => [node.nodeId, node]));
    if (!byNode.has(entry))
        throw new Error("projection.entry must name a node");
    const declared = (nodeId, outcome) => byNode.get(nodeId)?.outcomes?.includes(outcome) === true;
    const routed = new Set();
    const arrows = list(raw.arrows, "projection.arrows").map((value, index) => {
        const label = `projection.arrows[${index}]`;
        const arrow = record(value, ["from", "to", "outcomes", "edgeIds", "conditional", "fanOut"], ["from", "to", "outcomes", "edgeIds", "conditional", "fanOut"], label);
        const from = assertIdentifier(arrow.from, `${label}.from`);
        const to = assertIdentifier(arrow.to, `${label}.to`);
        if (!byNode.has(from) || !byNode.has(to))
            throw new Error(`${label} names an unknown node`);
        const outcomes = identifiers(arrow.outcomes, `${label}.outcomes`, 64, 1);
        for (const outcome of outcomes) {
            if (!declared(from, outcome))
                throw new Error(`${label} names an undeclared outcome ${outcome}`);
            routed.add(pairKey(from, outcome));
        }
        const edgeIds = identifiers(arrow.edgeIds, `${label}.edgeIds`, 2_048, 1);
        bool(arrow.conditional, `${label}.conditional`);
        const forks = list(arrow.fanOut, `${label}.fanOut`, 2_048).map((value, index) => {
            const forkLabel = `${label}.fanOut[${index}]`;
            const fork = record(value, ["edgeId", "coTargets", "outcomes"], ["edgeId", "coTargets"], forkLabel);
            const edgeId = assertIdentifier(fork.edgeId, `${forkLabel}.edgeId`);
            if (!edgeIds.includes(edgeId))
                throw new Error(`${forkLabel} edge is not a contributor`);
            const targets = identifiers(fork.coTargets, `${forkLabel}.coTargets`, 63, 1);
            if (targets.some((target) => target === to || !byNode.has(target)))
                throw new Error(`${forkLabel} has invalid co-targets`);
            if (own(fork, "outcomes") && identifiers(fork.outcomes, `${forkLabel}.outcomes`, 64, 1).some((outcome) => !outcomes.includes(outcome))) {
                throw new Error(`${forkLabel} names an outcome outside its arrow`);
            }
            return edgeId;
        });
        unique(forks, `${label}.fanOut edge IDs`);
        return arrow;
    });
    unique(arrows.map((arrow) => pairKey(arrow.from, arrow.to)), "projection arrow pairs");
    const byEdge = new Map();
    for (const arrow of arrows) {
        const forks = new Map(arrow.fanOut.map((fork) => [fork.edgeId, fork]));
        for (const edgeId of arrow.edgeIds) {
            let contributions = byEdge.get(edgeId);
            if (contributions === undefined) {
                contributions = [];
                byEdge.set(edgeId, contributions);
            }
            contributions.push({ arrow, fork: forks.get(edgeId) });
        }
    }
    if (byEdge.size > 2_048)
        throw new Error("projection has too many contributing edges");
    for (const [edgeId, contributions] of byEdge) {
        if (new Set(contributions.map(({ arrow }) => arrow.from)).size !== 1)
            throw new Error(`projection edge ${edgeId} has inconsistent sources`);
        if (contributions.length > 64)
            throw new Error(`projection edge ${edgeId} has too many targets`);
        const targets = contributions.map(({ arrow }) => arrow.to);
        let outcomeKey;
        for (const { arrow, fork } of contributions) {
            if (contributions.length === 1) {
                if (fork !== undefined)
                    throw new Error(`projection edge ${edgeId} has fan-out without matching contributions`);
                continue;
            }
            if (fork === undefined || canonicalJson([...fork.coTargets].sort()) !== canonicalJson(targets.filter((target) => target !== arrow.to).sort())) {
                throw new Error(`projection edge ${edgeId} has inconsistent fan-out co-targets`);
            }
            const key = fork.outcomes === undefined ? "absent" : canonicalJson(fork.outcomes);
            if (outcomeKey !== undefined && outcomeKey !== key)
                throw new Error(`projection edge ${edgeId} has inconsistent fan-out outcomes`);
            outcomeKey = key;
        }
    }
    const terminals = list(raw.terminals, "projection.terminals", 1_024).map((item, index) => terminal(item, `projection.terminals[${index}]`));
    unique(terminals.map(tupleKey), "projection terminals");
    const terminalKeys = new Set(terminals.map(tupleKey));
    for (const end of terminals) {
        if (!declared(end.nodeId, end.outcome))
            throw new Error("projection terminal names an undeclared node/outcome");
        if (routed.has(tupleKey(end)))
            throw new Error("projection outcome cannot be both routed and terminal");
    }
    for (const node of nodes)
        for (const outcome of node.outcomes) {
            const key = pairKey(node.nodeId, outcome);
            if (!routed.has(key) && !terminalKeys.has(key))
                throw new Error(`projection has an unrouted outcome ${node.nodeId}:${outcome}`);
        }
    const joins = list(raw.joins, "projection.joins", 256).map((value, index) => {
        const label = `projection.joins[${index}]`;
        const join = record(value, ["nodeId", "require", "inbound", "compose"], ["nodeId", "require", "inbound"], label);
        const nodeId = assertIdentifier(join.nodeId, `${label}.nodeId`);
        const node = byNode.get(nodeId);
        if (node?.join === undefined || canonicalJson(node.join) !== canonicalJson({ require: join.require, inbound: join.inbound,
            ...(own(join, "compose") ? { compose: join.compose } : {}) }))
            throw new Error(`${label} disagrees with its node join`);
        const inbound = identifiers(join.inbound, `${label}.inbound`, 256, 1);
        const actual = [...new Set(arrows.filter((arrow) => arrow.to === nodeId).flatMap((arrow) => arrow.edgeIds))];
        if (canonicalJson([...inbound].sort()) !== canonicalJson(actual.sort()))
            throw new Error(`${label} disagrees with inbound edges`);
        return nodeId;
    });
    unique(joins, "projection join nodes");
    if (nodes.some((node) => own(node, "join") && !joins.includes(node.nodeId)))
        throw new Error("projection is missing a node join");
    return raw;
}
function presentationData(value) {
    const raw = record(snapshot(value, "presentation"), ["schemaVersion", "title", "subtitle", "id", "description", "unitNoun", "publication", "nodes", "arrows", "endpoints", "terminals", "goals"], ["schemaVersion", "title", "nodes", "endpoints", "terminals"], "presentation");
    if (raw.schemaVersion !== PIPELINE_PRESENTATION_SCHEMA_VERSION)
        throw new Error(`presentation.schemaVersion must be ${PIPELINE_PRESENTATION_SCHEMA_VERSION}`);
    words(raw.title, "presentation.title");
    optionalWords(raw, ["subtitle", "description", "unitNoun"], "presentation");
    if (own(raw, "id"))
        assertIdentifier(raw.id, "presentation.id");
    if (own(raw, "publication") && raw.publication !== "source" && raw.publication !== "published")
        throw new Error("presentation.publication must be source or published");
    for (const [id, value] of Object.entries(dictionary(raw.nodes, "presentation.nodes"))) {
        assertIdentifier(id, "presentation node ID");
        const label = `presentation.nodes.${id}`;
        const node = record(value, ["name", "summary", "question", "rows", "model"], ["name"], label);
        words(node.name, `${label}.name`);
        optionalWords(node, ["summary", "question"], label);
        if (own(node, "rows"))
            rows(node.rows, `${label}.rows`);
        if (own(node, "model")) {
            const model = record(node.model, ["bindingDigest", "name"], ["bindingDigest", "name"], `${label}.model`);
            assertSha256Hex(model.bindingDigest, `${label}.model.bindingDigest`);
            words(model.name, `${label}.model.name`);
        }
    }
    if (own(raw, "arrows"))
        for (const [key, value] of Object.entries(dictionary(raw.arrows, "presentation.arrows"))) {
            const parts = key.split("->");
            if (parts.length !== 2)
                throw new Error("presentation arrow keys must be from->to pairs");
            parts.forEach((part) => assertIdentifier(part, "presentation arrow node ID"));
            list(value, `presentation.arrows.${key}`, 64, 1).forEach((value, index) => {
                const label = `presentation.arrows.${key}[${index}]`;
                const group = record(value, ["outcomes", "label", "note"], ["outcomes"], label);
                identifiers(group.outcomes, `${label}.outcomes`, 64, 1);
                optionalWords(group, ["label", "note"], label);
            });
        }
    for (const kind of ["endpoints", "terminals"]) {
        list(raw[kind], `presentation.${kind}`, 1_280).forEach((value, index) => {
            const label = `presentation.${kind}[${index}]`;
            const endpoint = kind === "endpoints";
            const claims = endpoint ? "exits" : "ends";
            const sink = record(value, endpoint ? ["id", "name", "system", "summary", "exits", "waits", "kind", "via", "outboxEventTypes", "rows"] : ["id", "name", "summary", "ends"], ["id", "name", claims], label);
            assertIdentifier(sink.id, `${label}.id`);
            words(sink.name, `${label}.name`);
            optionalWords(sink, endpoint ? ["system", "summary", "kind", "via"] : ["summary"], label);
            list(sink[claims], `${label}.${claims}`, 1_024).forEach((item, index) => terminal(item, `${label}.${claims}[${index}]`));
            if (own(sink, "waits"))
                identifiers(sink.waits, `${label}.waits`, 256);
            if (own(sink, "rows"))
                rows(sink.rows, `${label}.rows`);
            if (own(sink, "outboxEventTypes"))
                list(sink.outboxEventTypes, `${label}.outboxEventTypes`, 64).forEach((item) => words(item, `${label}.outboxEventTypes`));
        });
    }
    if (own(raw, "goals"))
        for (const [id, value] of Object.entries(dictionary(raw.goals, "presentation.goals"))) {
            assertIdentifier(id, "presentation goal ID");
            const goal = record(value, ["name", "members"], ["name"], `presentation.goals.${id}`);
            words(goal.name, `presentation.goals.${id}.name`);
            if (own(goal, "members"))
                identifiers(goal.members, `presentation.goals.${id}.members`, 256, 1);
        }
    return raw;
}
function check(projectionRaw, presentationRaw, optionsRaw) {
    const options = record(optionsRaw, ["definition", "goalManifest"], [], "presentation options");
    const projection = projectionData(projectionRaw);
    const presentation = presentationData(presentationRaw);
    const problems = [];
    if (own(options, "definition")) {
        const expected = projectGraphDisplay(compileGraph(options.definition));
        if (canonicalJson(expected) !== canonicalJson(projection))
            throw new Error("projection does not match the sealed definition (graph identity or structural data mismatch)");
    }
    if (own(options, "goalManifest") && !own(options, "definition"))
        throw new Error("goalManifest requires a sealed definition");
    const manifest = own(options, "goalManifest") ? validateGoalManifest(options.definition, options.goalManifest) : undefined;
    const nodes = new Map(projection.nodes.map((node) => [node.nodeId, node]));
    for (const node of projection.nodes)
        if (!Object.hasOwn(presentation.nodes, node.nodeId))
            problems.push(`missing presentation for node ${node.nodeId}`);
    for (const [id, words] of Object.entries(presentation.nodes)) {
        const node = nodes.get(id);
        if (node === undefined)
            problems.push(`presentation names unknown node ${id}`);
        if (words.model !== undefined && (node?.binding === undefined || words.model.bindingDigest !== node.binding.bindingDigest))
            problems.push(`model name for ${id} requires the exact binding digest`);
    }
    const arrows = new Map(projection.arrows.map((arrow) => [`${arrow.from}->${arrow.to}`, arrow]));
    for (const [key, groups] of Object.entries(presentation.arrows ?? {})) {
        const arrow = arrows.get(key);
        if (arrow === undefined) {
            problems.push(`presentation names unknown arrow ${key}`);
            continue;
        }
        const covered = groups.flatMap((group) => group.outcomes);
        if (covered.length !== new Set(covered).size || canonicalJson([...covered].sort()) !== canonicalJson([...arrow.outcomes].sort())) {
            problems.push(`arrow groups for ${key} must partition its outcomes exactly once`);
        }
    }
    const declaredTerminals = new Set(projection.terminals.map(tupleKey));
    const claimed = new Set();
    const claim = (end, label) => {
        const key = tupleKey(end);
        if (!declaredTerminals.has(key))
            problems.push(`${label} claims undeclared terminal ${end.nodeId}:${end.outcome}`);
        if (claimed.has(key))
            problems.push(`duplicate terminal claim ${end.nodeId}:${end.outcome}`);
        claimed.add(key);
    };
    for (const [kind, sinks] of [["endpoint", presentation.endpoints], ["terminal", presentation.terminals]]) {
        const ids = new Set();
        for (const sink of sinks) {
            if (ids.has(sink.id))
                problems.push(`duplicate ${kind} ID ${sink.id}`);
            ids.add(sink.id);
        }
    }
    for (const endpoint of presentation.endpoints) {
        for (const end of endpoint.exits)
            claim(end, `endpoint ${endpoint.id}`);
        for (const nodeId of endpoint.waits ?? []) {
            if (nodes.get(nodeId)?.kind !== "human")
                problems.push(`endpoint ${endpoint.id} wait must name a human node: ${nodeId}`);
            if (endpoint.exits.some((end) => end.nodeId === nodeId))
                problems.push(`endpoint ${endpoint.id} cannot claim both an exit and a wait from ${nodeId}`);
        }
    }
    for (const sink of presentation.terminals)
        for (const end of sink.ends)
            claim(end, `terminal ${sink.id}`);
    for (const [id, words] of Object.entries(presentation.goals ?? {})) {
        const goal = manifest?.goals.find((goal) => goal.goalId === id);
        if (goal === undefined)
            problems.push(`presentation goal ${id} requires a matching validated goal manifest`);
        else if (words.members !== undefined && canonicalJson([...words.members].sort()) !== canonicalJson([...goal.members].sort()))
            problems.push(`presentation goal ${id} members must equal the goal manifest`);
    }
    const unclaimed = projection.terminals.filter((end) => !claimed.has(tupleKey(end)));
    return { projection, presentation, problems, unclaimed, presentationDigest: digest(presentation) };
}
/**
 * Return coverage diagnostics; malformed or hostile data throws. Unclaimed
 * terminals are diagnostics, but buildPipelineDiagram draws explicit fallbacks.
 * Without options.definition this checks shape/coverage, not source authenticity.
 */
export function validatePresentation(projection, presentation, options = {}) {
    const checked = check(projection, presentation, options);
    return frozenData([...checked.problems, ...checked.unclaimed.map((end) => `unclaimed terminal ${end.nodeId}:${end.outcome}`)]);
}
/** Internal descriptor-safe admission; no caller field is read before capture. */
export function prepareDiagramInput(value) {
    const raw = record(value, ["projection", "presentation", "definition", "goalManifest", "historical"], ["projection", "presentation"], "pipeline diagram input");
    if (own(raw, "historical"))
        bool(raw.historical, "historical");
    const checked = check(raw.projection, raw.presentation, Object.fromEntries(["definition", "goalManifest"].filter((key) => own(raw, key)).map((key) => [key, raw[key]])));
    if (checked.problems.length > 0)
        throw new Error(`invalid presentation: ${checked.problems.join("; ")}`);
    return { ...checked, historical: raw.historical === true };
}

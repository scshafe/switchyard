import { PIPELINE_DIAGRAM_SCHEMA_VERSION } from "./types.js";
const MAX_VALUES = 1_000_000;
const MAX_TEXT = 33_554_432;
const KINDS = ["code", "model", "human", "agent", "callback"];
const own = (value, key) => Object.hasOwn(value, key);
/**
 * Browser capability capture. Live objects are trusted host inputs: browsers
 * cannot detect Proxies, so reflection may run their traps. For untrusted
 * model/details data, accept JSON text and parse it inside this module instead.
 * The Node adapter first uses the engine's Proxy-safe snapshot helpers.
 */
export function captureViewerRecord(value, allowed, required, label) {
    if (value === null || typeof value !== "object" || (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype))
        throw new Error(`${label} must be a plain data record`);
    const result = Object.create(null);
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
        if (typeof key !== "string" || !allowed.includes(key))
            throw new Error(`${label} has an unknown key`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!("value" in descriptor) || !descriptor.enumerable)
            throw new Error(`${label}.${key} must be an enumerable data property`);
        result[key] = descriptor.value;
    }
    for (const key of required)
        if (!own(result, key))
            throw new Error(`${label}.${key} is required`);
    return Object.freeze(result);
}
/** Descriptor-only, bounded JSON snapshot for trusted browser objects/parsed JSON. */
export function snapshotViewerData(value, label = "viewer data") {
    let values = 0;
    let text = 0;
    const ancestors = new Set();
    const countText = (value) => {
        text += value.length;
        if (text > MAX_TEXT)
            throw new Error(`${label} exceeds the string budget`);
    };
    const visit = (value, depth) => {
        if (++values > MAX_VALUES || depth > 24)
            throw new Error(`${label} exceeds the value/depth budget`);
        if (typeof value === "string") {
            countText(value);
            return value;
        }
        if (value === null || typeof value === "boolean")
            return value;
        if (typeof value === "number" && Number.isFinite(value))
            return Object.is(value, -0) ? 0 : value;
        if (typeof value !== "object" || ancestors.has(value))
            throw new Error(`${label} must be acyclic plain JSON data`);
        const proto = Object.getPrototypeOf(value);
        if (Array.isArray(value) ? proto !== Array.prototype : proto !== null && proto !== Object.prototype)
            throw new Error(`${label} must be plain JSON data`);
        ancestors.add(value);
        try {
            if (Array.isArray(value)) {
                const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
                if (!Number.isSafeInteger(length) || length < 0 || length + values > MAX_VALUES)
                    throw new Error(`${label} exceeds the array budget`);
                const keys = Reflect.ownKeys(value);
                if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))))
                    throw new Error(`${label} requires dense arrays without extra keys`);
                return Object.freeze(Array.from({ length }, (_, index) => {
                    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
                        throw new Error(`${label} requires enumerable data array entries`);
                    return visit(descriptor.value, depth + 1);
                }));
            }
            const keys = Reflect.ownKeys(value);
            if (keys.length + values > MAX_VALUES)
                throw new Error(`${label} exceeds the record budget`);
            const result = Object.create(null);
            for (const key of keys) {
                if (typeof key !== "string")
                    throw new Error(`${label} cannot contain symbol keys`);
                countText(key);
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!("value" in descriptor) || !descriptor.enumerable)
                    throw new Error(`${label} requires enumerable data properties`);
                result[key] = visit(descriptor.value, depth + 1);
            }
            return Object.freeze(result);
        }
        finally {
            ancestors.delete(value);
        }
    };
    return visit(value, 0);
}
function data(value, label) {
    if (typeof value === "string") {
        if (value.length > MAX_TEXT)
            throw new Error(`${label} JSON exceeds the text budget`);
        value = JSON.parse(value);
    }
    return snapshotViewerData(value, label);
}
const record = captureViewerRecord;
function text(value, label, max = MAX_TEXT) {
    if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
        throw new Error(`${label} must be bounded text`);
    return value;
}
function id(value, label) {
    const result = text(value, label, 1_024);
    if (!/^[a-z0-9][a-z0-9._:~>\-]*$/.test(result))
        throw new Error(`${label} must be a bounded display ID`);
    return result;
}
function identifier(value, label) {
    const result = text(value, label, 160);
    if (!/^[a-z0-9][a-z0-9._:-]*$/.test(result))
        throw new Error(`${label} must be an engine identifier`);
    return result;
}
function contract(value, label) {
    if (typeof value !== "string" || value.length > 160 || !/^[a-z0-9][a-z0-9._-]*\.v[1-9][0-9]*$/.test(value))
        throw new Error(`${label} must be a contract ID`);
}
function integer(value, label, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${label} must be a bounded integer`);
    return value;
}
function digest(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        throw new Error(`${label} must be a lowercase SHA256 digest`);
}
function oneOf(value, choices, label) {
    if (typeof value !== "string" || !choices.includes(value))
        throw new Error(`${label} has an unsupported value`);
}
function list(value, label, max = 65_536) {
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${label} must be a bounded array`);
    return value;
}
function strings(value, label, max = 65_536) {
    return list(value, label, max).map((value) => text(value, label));
}
function unique(values, label) {
    if (new Set(values).size !== values.length)
        throw new Error(`${label} must be unique`);
}
function graph(value) {
    const raw = record(value, ["id", "version", "digest"], ["id", "version", "digest"], "graph identity");
    identifier(raw.id, "graph.id");
    integer(raw.version, "graph.version");
    digest(raw.digest, "graph.digest");
    return raw;
}
function sameGraph(a, b) {
    return a.id === b.id && a.version === b.version && a.digest === b.digest;
}
function pair(value) {
    const raw = record(value, ["nodeId", "outcome"], ["nodeId", "outcome"], "terminal pair");
    identifier(raw.nodeId, "terminal.nodeId");
    identifier(raw.outcome, "terminal.outcome");
    return `${raw.nodeId}:${raw.outcome}`;
}
/** Static SDK models only, not arbitrary graphpaper models or execution evidence. */
export function validateStaticModel(value) {
    const raw = record(data(value, "viewer model"), ["id", "title", "kind", "description", "nodes", "edges", "metadata", "lifecycle"], ["id", "title", "kind", "description", "nodes", "edges", "metadata"], "viewer model");
    id(raw.id, "model.id");
    text(raw.title, "model.title");
    text(raw.description, "model.description");
    oneOf(raw.kind, ["process"], "model.kind");
    const metadata = record(raw.metadata, ["graphId", "graphVersion", "graphDigest", "publication", "highlighted", "unclaimedTerminals", "pipeline"], ["graphId", "graphVersion", "graphDigest", "publication", "highlighted", "unclaimedTerminals", "pipeline"], "model.metadata");
    const pipeline = record(metadata.pipeline, ["schemaVersion", "graph", "mode", "presentationDigest", "unclaimedTerminals"], ["schemaVersion", "graph", "mode", "presentationDigest", "unclaimedTerminals"], "pipeline metadata");
    oneOf(pipeline.schemaVersion, [PIPELINE_DIAGRAM_SCHEMA_VERSION], "pipeline.schemaVersion");
    oneOf(pipeline.mode, ["static"], "pipeline.mode");
    const identity = graph(pipeline.graph);
    digest(pipeline.presentationDigest, "presentationDigest");
    if (metadata.graphId !== identity.id || metadata.graphVersion !== identity.version || metadata.graphDigest !== identity.digest || metadata.highlighted !== false)
        throw new Error("model metadata contradicts static graph identity");
    oneOf(metadata.publication, ["source", "published"], "publication");
    const unclaimed = list(pipeline.unclaimedTerminals, "unclaimed terminals", 1_024).map(pair);
    const legacy = strings(metadata.unclaimedTerminals, "unclaimed terminal labels", 1_024);
    if (unclaimed.length !== legacy.length || unclaimed.some((value, index) => value !== legacy[index]))
        throw new Error("unclaimed terminal metadata disagrees");
    if (own(raw, "lifecycle")) {
        const lifecycle = record(raw.lifecycle, ["state", "label"], ["state", "label"], "lifecycle");
        oneOf(lifecycle.state, ["historical"], "lifecycle.state");
        text(lifecycle.label, "lifecycle.label");
    }
    const nodeIds = list(raw.nodes, "model.nodes", 3_840).map((value) => {
        const node = record(value, ["id", "type", "title", "subtitle", "description", "rows", "visibleRows", "badges", "metadata"], ["id", "type", "title", "metadata"], "model node");
        const nodeId = id(node.id, "node.id");
        text(node.title, "node.title");
        oneOf(node.type, [...KINDS, "endpoint", "terminal"], "node.type");
        for (const key of ["subtitle", "description"])
            if (own(node, key))
                text(node[key], `node.${key}`);
        if (own(node, "visibleRows"))
            integer(node.visibleRows, "visibleRows", 0, 128);
        if (own(node, "rows"))
            for (const value of list(node.rows, "node.rows", 128)) {
                const row = record(value, ["label", "value"], ["label", "value"], "node row");
                text(row.label, "row.label");
                text(row.value, "row.value");
            }
        if (own(node, "badges"))
            for (const value of list(node.badges, "node.badges", 64)) {
                const badge = record(value, ["label", "tone"], ["label", "tone"], "node badge");
                text(badge.label, "badge.label");
                oneOf(badge.tone, ["info"], "badge.tone");
            }
        if (node.type === "endpoint") {
            const meta = record(node.metadata, ["endpointId", "sink", "outboxEventTypes"], ["endpointId", "sink"], "endpoint metadata");
            identifier(meta.endpointId, "endpointId");
            oneOf(meta.sink, ["endpoint"], "endpoint sink");
            if (own(meta, "outboxEventTypes"))
                strings(meta.outboxEventTypes, "outboxEventTypes", 64);
        }
        else if (node.type === "terminal") {
            const meta = record(node.metadata, ["terminalId", "sink", "ends", "unpresented"], ["sink", "ends"], "terminal metadata");
            oneOf(meta.sink, ["terminal"], "terminal sink");
            strings(meta.ends, "terminal ends", 1_024);
            if (own(meta, "terminalId"))
                identifier(meta.terminalId, "terminalId");
            if (own(meta, "unpresented") && meta.unpresented !== true)
                throw new Error("unpresented must be true when present");
        }
        else {
            const meta = record(node.metadata, ["nodeId", "role", "kind", "rank", "marks", "join"], ["nodeId", "role", "kind", "rank"], "node metadata");
            identifier(meta.nodeId, "nodeId");
            integer(meta.rank, "rank", 1, 256);
            if (meta.nodeId !== nodeId || meta.role !== node.type || meta.kind !== node.type)
                throw new Error("node metadata contradicts its identity/kind");
            if (own(meta, "marks"))
                strings(meta.marks, "node marks", 64).forEach((value) => identifier(value, "mark"));
            if (own(meta, "join")) {
                const join = record(meta.join, ["require", "inbound", "compose"], ["require", "inbound"], "join metadata");
                if (own(join, "compose"))
                    oneOf(join.compose, ["select", "envelope"], "join compose");
                const inbound = strings(join.inbound, "join inbound", 256);
                unique(inbound, "join inbound");
                if (inbound.length === 0)
                    throw new Error("join inbound must be nonempty");
                inbound.forEach((value) => identifier(value, "join edge"));
                if (join.require !== "all") {
                    const threshold = record(join.require, ["nOf"], ["nOf"], "join threshold");
                    integer(threshold.nOf, "join nOf", 1, inbound.length);
                }
            }
        }
        return nodeId;
    });
    if (nodeIds.length === 0)
        throw new Error("viewer model must have nodes");
    unique(nodeIds, "node IDs");
    const known = new Set(nodeIds);
    const edgeIds = list(raw.edges, "model.edges", 131_072).map((value) => {
        const edge = record(value, ["id", "from", "to", "type", "label", "description"], ["id", "from", "to", "type", "label", "description"], "model edge");
        const edgeId = id(edge.id, "edge.id");
        if (!known.has(id(edge.from, "edge.from")) || !known.has(id(edge.to, "edge.to")))
            throw new Error("model edge names a missing node");
        oneOf(edge.type, ["outcome", "exit", "join"], "edge.type");
        text(edge.label, "edge.label");
        text(edge.description, "edge.description");
        return edgeId;
    });
    unique(edgeIds, "edge IDs");
    return raw;
}
/** Flat injected-layout data. Node callers must reject Proxies before this boundary. */
export function validateStaticLayoutResult(value, expectedNodeIds) {
    const label = "pipeline layout result";
    const result = snapshotViewerData(value, label);
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const coordinate = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
    const point = (value) => {
        if (!object(value) || !coordinate(value.x) || !coordinate(value.y))
            throw new Error(`${label} requires complete finite edge points`);
    };
    if (!object(result) || !Array.isArray(result.children) || result.children.length !== expectedNodeIds.length)
        throw new Error(`${label} must cover every model node`);
    const remaining = new Set(expectedNodeIds);
    for (const child of result.children) {
        if (!object(child) || typeof child.id !== "string" || !remaining.delete(child.id))
            throw new Error(`${label} contains missing, duplicate, or unknown node IDs`);
        if ((child.children !== undefined && (!Array.isArray(child.children) || child.children.length !== 0))
            || (child.width !== undefined && (typeof child.width !== "number" || child.width <= 0))
            || (child.height !== undefined && (typeof child.height !== "number" || child.height <= 0)))
            throw new Error(`${label} must contain flat nodes with positive sizes`);
    }
    if (result.edges !== undefined) {
        if (!Array.isArray(result.edges))
            throw new Error(`${label} edges must be an array`);
        for (const edge of result.edges) {
            if (!object(edge))
                throw new Error(`${label} edges must be data records`);
            if (edge.sections === undefined)
                continue;
            if (!Array.isArray(edge.sections))
                throw new Error(`${label} sections must be an array`);
            for (const section of edge.sections) {
                if (!object(section))
                    throw new Error(`${label} sections must be data records`);
                point(section.startPoint);
                point(section.endPoint);
                if (section.bendPoints !== undefined) {
                    if (!Array.isArray(section.bendPoints))
                        throw new Error(`${label} bend points must be an array`);
                    section.bendPoints.forEach(point);
                }
            }
        }
    }
    const pending = [result];
    while (pending.length > 0) {
        const candidate = pending.pop();
        if (candidate === null || typeof candidate !== "object")
            continue;
        for (const [key, field] of Object.entries(candidate)) {
            if (["x", "y", "width", "height"].includes(key)
                && (!coordinate(field) || ((key === "width" || key === "height") && field < 0)))
                throw new Error(`${label} contains invalid geometry`);
            if (field !== null && typeof field === "object")
                pending.push(field);
        }
    }
    return result;
}
/** Validate bounded provider data for one exact picked structural node. */
export function validateNodeDetails(value, expectedGraph, expectedNodeId) {
    const raw = record(data(value, "node details"), ["graph", "nodeId", "sealed", "outputs", "model", "implementation", "question"], ["graph", "nodeId", "sealed"], "node details");
    const identity = graph(raw.graph);
    identifier(raw.nodeId, "details.nodeId");
    if (!sameGraph(identity, expectedGraph) || raw.nodeId !== expectedNodeId)
        throw new Error("node details identity mismatch");
    const sealed = record(raw.sealed, ["ref", "kind", "input", "outcomes", "maxAttempts", "leaseMs", "binding"], ["ref", "kind", "input", "outcomes", "maxAttempts", "leaseMs"], "sealed details");
    const ref = record(sealed.ref, ["id", "version"], ["id", "version"], "sealed ref");
    identifier(ref.id, "ref.id");
    integer(ref.version, "ref.version");
    oneOf(sealed.kind, KINDS, "sealed.kind");
    contract(sealed.input, "sealed.input");
    const outcomes = strings(sealed.outcomes, "sealed.outcomes", 64);
    unique(outcomes, "sealed outcomes");
    if (outcomes.length === 0)
        throw new Error("sealed outcomes must be nonempty");
    outcomes.forEach((value) => identifier(value, "outcome"));
    integer(sealed.maxAttempts, "maxAttempts", 1, 10);
    integer(sealed.leaseMs, "leaseMs", 1, 86_400_000);
    if (own(sealed, "binding")) {
        const binding = record(sealed.binding, ["kind", "bindingId", "version", "bindingDigest"], ["kind", "bindingId", "version", "bindingDigest"], "binding");
        oneOf(binding.kind, ["model"], "binding.kind");
        identifier(binding.bindingId, "bindingId");
        integer(binding.version, "binding.version");
        digest(binding.bindingDigest, "bindingDigest");
        if (sealed.kind !== "model")
            throw new Error("only model details may have a model binding");
    }
    else if (sealed.kind === "model")
        throw new Error("model details require a binding");
    if (own(raw, "outputs")) {
        const covered = list(raw.outputs, "details.outputs", 64).map((value) => {
            const output = record(value, ["outcome", "contractId"], ["outcome", "contractId"], "output detail");
            const outcome = identifier(output.outcome, "output outcome");
            contract(output.contractId, "output contract");
            if (!outcomes.includes(outcome))
                throw new Error("output details name an undeclared outcome");
            return outcome;
        });
        unique(covered, "output outcomes");
    }
    if (own(raw, "model")) {
        if (sealed.kind !== "model")
            throw new Error("model details require a model node");
        const model = record(raw.model, ["name", "id", "version", "providerId", "parameters", "prompt"], ["name", "id", "version", "parameters", "prompt"], "model details");
        text(model.name, "model.name", 8_192);
        identifier(model.id, "model.id");
        integer(model.version, "model.version");
        if (own(model, "providerId"))
            identifier(model.providerId, "providerId");
        if (model.parameters === null || typeof model.parameters !== "object" || Array.isArray(model.parameters))
            throw new Error("model parameters must be a record");
        const keys = Object.keys(model.parameters);
        if (keys.length > 128)
            throw new Error("too many model parameters");
        const parameters = record(model.parameters, keys, [], "model parameters");
        for (const [key, value] of Object.entries(parameters)) {
            text(key, "parameter name", 160);
            if (typeof value === "string")
                text(value, "parameter value", 8_192);
            else if (typeof value !== "number" || !Number.isFinite(value))
                throw new Error("parameter values must be text or finite numbers");
        }
        const prompt = record(model.prompt, ["digest", "systemPrompt", "withheld"], [], "prompt");
        if (own(prompt, "withheld")) {
            if (Object.keys(prompt).length !== 1)
                throw new Error("prompt must be displayed or withheld, never both");
            text(prompt.withheld, "prompt withheld reason", 8_192);
        }
        else {
            if (Object.keys(prompt).length !== 2)
                throw new Error("prompt digest and systemPrompt are required");
            digest(prompt.digest, "prompt.digest");
            text(prompt.systemPrompt, "systemPrompt", 262_144);
        }
    }
    if (own(raw, "implementation")) {
        const implementation = record(raw.implementation, ["body", "port", "dispatch"], ["body", "port"], "implementation");
        for (const key of ["body", "port"]) {
            const reference = record(implementation[key], ["module", "symbol"], ["module", "symbol"], `implementation.${key}`);
            text(reference.module, "implementation module", 8_192);
            text(reference.symbol, "implementation symbol", 8_192);
        }
        if (own(implementation, "dispatch"))
            text(implementation.dispatch, "implementation dispatch", 8_192);
    }
    if (own(raw, "question"))
        text(raw.question, "question", 8_192);
    return raw;
}

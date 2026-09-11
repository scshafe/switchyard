// graph/definition.ts — the digest-sealed, data-only v2 node graph contract.
//
// It contains no executable code, provider data, credentials, storage handles,
// or host paths.
import { validateContractId } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import { assertIdentifier, assertPlainObject, assertPositiveInt, assertRequiredKeys, assertSafePositiveInt, assertSha256Hex, assertStrictKeys, typeName } from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { validateEdge } from "./edge.js";
import { snapshotGraphValidationData } from "./limits.js";
import { validateOutcomeVocabulary } from "./outcome.js";
export const MISSION_PIPELINE_NODE_KINDS = [
    "code",
    "model",
    "agent",
    "human",
    "callback"
];
/** Engine-only identity; authored nodes can never claim synthetic authority. */
export const MISSION_PIPELINE_ENGINE_PRINCIPAL_ID = "mission_pipeline.engine";
/** Output contract emitted by an engine-synthesized unsatisfiable join. */
export const JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT = "mission-pipeline.join-unsatisfiable.v1";
/** Input contract synthesized for an opt-in composing join. */
export const JOIN_INPUT_ARTIFACT_CONTRACT = "mission-pipeline.join-input.v1";
export const NODE_TURN_IDEMPOTENCY = "per (unitId, nodeId, attemptNumber)";
export const NODE_TURN_RETRY_TAXONOMY = "retryable vs terminal, as v1 durable-stage";
export const MAX_GRAPH_NODES = 256;
export const MAX_GRAPH_EDGES = 2_048;
export const MAX_GRAPH_TERMINALS = 1_024;
export const MAX_GRAPH_DESCRIPTION_LENGTH = 1_000;
export const MAX_JOIN_INBOUND_EDGES = 256;
export const MAX_NODE_TURN_LEASE_MS = 86_400_000;
export const MAX_NODE_TURN_ATTEMPTS = 10;
const DRAFT_KEYS = new Set([
    "graphId",
    "version",
    "description",
    "entry",
    "nodes",
    "edges",
    "terminals"
]);
const SEALED_KEYS = new Set([...DRAFT_KEYS, "graphDigest"]);
const NODE_KEYS = new Set([
    "nodeId",
    "ref",
    "kind",
    "input",
    "outcomes",
    "outputs",
    "principal",
    "binding",
    "configuration",
    "turn",
    "join"
]);
const NODE_REQUIRED_KEYS = new Set([
    "nodeId",
    "ref",
    "kind",
    "input",
    "outcomes",
    "principal",
    "turn"
]);
const NODE_REF_KEYS = new Set(["id", "version"]);
const PRINCIPAL_REF_KEYS = new Set(["id"]);
const BINDING_REF_KEYS = new Set(["kind", "bindingId", "version", "bindingDigest"]);
const CONFIGURATION_REF_KEYS = new Set(["id", "version", "digest"]);
const TURN_KEYS = new Set(["idempotency", "leaseMs", "maxAttempts", "retryTaxonomy"]);
const JOIN_KEYS = new Set(["inbound", "require", "compose"]);
const JOIN_REQUIRED_KEYS = new Set(["inbound", "require"]);
const N_OF_KEYS = new Set(["nOf"]);
const TERMINAL_KEYS = new Set(["nodeId", "outcome"]);
function validateNodeRef(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, NODE_REF_KEYS, label);
    assertRequiredKeys(raw, NODE_REF_KEYS, label);
    return {
        id: assertIdentifier(raw.id, `${label}.id`),
        version: assertSafePositiveInt(raw.version, `${label}.version`)
    };
}
function validatePrincipalRef(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, PRINCIPAL_REF_KEYS, label);
    assertRequiredKeys(raw, PRINCIPAL_REF_KEYS, label);
    return { id: assertIdentifier(raw.id, `${label}.id`) };
}
export function validateMissionPipelineNodeBindingRef(value, label = "node binding") {
    value = snapshotGraphValidationData(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, BINDING_REF_KEYS, label);
    assertRequiredKeys(raw, BINDING_REF_KEYS, label);
    if (raw.kind !== "model") {
        throw new Error(`${label}: kind must be "model" (got ${typeof raw.kind === "string" ? JSON.stringify(raw.kind) : typeName(raw.kind)})`);
    }
    return deepFrozenClone({
        kind: "model",
        bindingId: assertIdentifier(raw.bindingId, `${label}.bindingId`),
        version: assertSafePositiveInt(raw.version, `${label}.version`),
        bindingDigest: assertSha256Hex(raw.bindingDigest, `${label}.bindingDigest`)
    }, label);
}
/** Validate, detach, and freeze a node configuration ref. */
export function validateMissionPipelineNodeConfigurationRef(value, label = "node configuration") {
    value = snapshotGraphValidationData(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, CONFIGURATION_REF_KEYS, label);
    assertRequiredKeys(raw, CONFIGURATION_REF_KEYS, label);
    return deepFrozenClone({
        id: assertIdentifier(raw.id, `${label}.id`),
        version: assertSafePositiveInt(raw.version, `${label}.version`),
        digest: assertSha256Hex(raw.digest, `${label}.digest`)
    }, label);
}
/**
 * Declared output contracts keyed by outcome. Every key must be one of the
 * node's declared outcomes; the engine-reserved `join_unsatisfiable` always
 * carries the reserved contract and cannot be declared.
 */
function validateNodeOutputs(value, outcomes, label) {
    const raw = assertPlainObject(value, label);
    const keys = Object.keys(raw);
    if (keys.length === 0) {
        throw new Error(`${label}: must declare at least one outcome (omit the key instead)`);
    }
    const declared = new Set(outcomes);
    const outputs = {};
    for (const key of keys) {
        const outcome = assertIdentifier(key, `${label} outcome`);
        if (outcome === "join_unsatisfiable") {
            throw new Error(`${label}: engine-reserved outcome "join_unsatisfiable" always carries ${JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT} and cannot be declared`);
        }
        if (!declared.has(outcome)) {
            throw new Error(`${label}: outcome ${JSON.stringify(outcome)} is not declared by this node`);
        }
        outputs[outcome] = validateContractId(raw[outcome], `${label}.${outcome}`);
    }
    return deepFrozenClone(outputs, label);
}
function assertBoundedPositiveInt(value, maximum, label) {
    const result = assertPositiveInt(value, label);
    if (!Number.isSafeInteger(result) || result > maximum) {
        throw new Error(`${label}: must be an integer in 1..${maximum} (got ${String(result)})`);
    }
    return result;
}
function validateTurn(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, TURN_KEYS, label);
    assertRequiredKeys(raw, TURN_KEYS, label);
    if (raw.idempotency !== NODE_TURN_IDEMPOTENCY) {
        throw new Error(`${label}.idempotency: must be ${JSON.stringify(NODE_TURN_IDEMPOTENCY)}`);
    }
    if (raw.retryTaxonomy !== NODE_TURN_RETRY_TAXONOMY) {
        throw new Error(`${label}.retryTaxonomy: must be ${JSON.stringify(NODE_TURN_RETRY_TAXONOMY)}`);
    }
    return {
        idempotency: NODE_TURN_IDEMPOTENCY,
        leaseMs: assertBoundedPositiveInt(raw.leaseMs, MAX_NODE_TURN_LEASE_MS, `${label}.leaseMs`),
        maxAttempts: assertBoundedPositiveInt(raw.maxAttempts, MAX_NODE_TURN_ATTEMPTS, `${label}.maxAttempts`),
        retryTaxonomy: NODE_TURN_RETRY_TAXONOMY
    };
}
function validateJoinRequirement(value, label) {
    if (value === "all")
        return "all";
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, N_OF_KEYS, label);
    assertRequiredKeys(raw, N_OF_KEYS, label);
    return {
        nOf: assertBoundedPositiveInt(raw.nOf, MAX_JOIN_INBOUND_EDGES, `${label}.nOf`)
    };
}
function validateJoin(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, JOIN_KEYS, label);
    assertRequiredKeys(raw, JOIN_REQUIRED_KEYS, label);
    if (!Array.isArray(raw.inbound)
        || raw.inbound.length < 1
        || raw.inbound.length > MAX_JOIN_INBOUND_EDGES) {
        throw new Error(`${label}.inbound: must be an array of 1..${MAX_JOIN_INBOUND_EDGES} edge IDs (got ${Array.isArray(raw.inbound) ? raw.inbound.length : typeName(raw.inbound)})`);
    }
    const inbound = raw.inbound.map((edgeId, index) => assertIdentifier(edgeId, `${label}.inbound[${index}]`));
    if (new Set(inbound).size !== inbound.length) {
        throw new Error(`${label}.inbound: edge IDs must be unique`);
    }
    if (Object.hasOwn(raw, "compose") && raw.compose !== "select" && raw.compose !== "envelope") {
        throw new Error(`${label}.compose: must be "select" | "envelope" (omit the key for selection)`);
    }
    return {
        inbound,
        require: validateJoinRequirement(raw.require, `${label}.require`),
        ...(Object.hasOwn(raw, "compose") ? { compose: raw.compose } : {})
    };
}
/** Validate one v2 node contract without resolving graph-level references. */
export function validateMissionPipelineNode(value, label = "mission pipeline node") {
    value = snapshotGraphValidationData(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, NODE_KEYS, label);
    assertRequiredKeys(raw, NODE_REQUIRED_KEYS, label);
    const nodeId = assertIdentifier(raw.nodeId, `${label}: nodeId`);
    const nodeLabel = `${label} ${nodeId}`;
    const ref = validateNodeRef(raw.ref, `${nodeLabel}: ref`);
    if (typeof raw.kind !== "string"
        || !MISSION_PIPELINE_NODE_KINDS.includes(raw.kind)) {
        throw new Error(`${nodeLabel}: kind must be one of ${MISSION_PIPELINE_NODE_KINDS.map((kind) => JSON.stringify(kind)).join(" | ")} (got ${typeof raw.kind === "string" ? JSON.stringify(raw.kind) : typeName(raw.kind)})`);
    }
    const kind = raw.kind;
    const input = validateContractId(raw.input, `${nodeLabel}: input`);
    const outcomes = validateOutcomeVocabulary(raw.outcomes, `${nodeLabel}: outcomes`);
    if (outcomes.version !== ref.version) {
        throw new Error(`${nodeLabel}: outcome vocabulary version ${outcomes.version} must equal node ref version ${ref.version} (outcome changes require a new node version)`);
    }
    let outputs;
    if (Object.hasOwn(raw, "outputs")) {
        if (raw.outputs === undefined) {
            throw new Error(`${nodeLabel}: outputs is present but undefined (omit the key instead)`);
        }
        outputs = validateNodeOutputs(raw.outputs, outcomes.outcomes, `${nodeLabel}: outputs`);
    }
    let binding;
    if (Object.hasOwn(raw, "binding")) {
        if (raw.binding === undefined) {
            throw new Error(`${nodeLabel}: binding is present but undefined (omit the key instead)`);
        }
        binding = validateMissionPipelineNodeBindingRef(raw.binding, `${nodeLabel}: binding`);
    }
    let configuration;
    if (Object.hasOwn(raw, "configuration")) {
        if (raw.configuration === undefined) {
            throw new Error(`${nodeLabel}: configuration is present but undefined (omit the key instead)`);
        }
        configuration = validateMissionPipelineNodeConfigurationRef(raw.configuration, `${nodeLabel}: configuration`);
    }
    let join;
    if (Object.hasOwn(raw, "join")) {
        if (raw.join === undefined) {
            throw new Error(`${nodeLabel}: join is present but undefined (omit the key instead)`);
        }
        join = validateJoin(raw.join, `${nodeLabel}: join`);
    }
    return deepFrozenClone({
        nodeId,
        ref,
        kind,
        input,
        outcomes,
        ...(outputs === undefined ? {} : { outputs }),
        principal: validatePrincipalRef(raw.principal, `${nodeLabel}: principal`),
        ...(binding === undefined ? {} : { binding }),
        ...(configuration === undefined ? {} : { configuration }),
        turn: validateTurn(raw.turn, `${nodeLabel}: turn`),
        ...(join === undefined ? {} : { join })
    }, nodeLabel);
}
/** Declared outputs of a validated node, or undefined when none are declared. */
export function declaredNodeOutputs(node) {
    return Object.hasOwn(node, "outputs") ? node.outputs : undefined;
}
/** The contract a validated node declares for one outcome, or undefined when undeclared. */
export function declaredNodeOutput(node, outcome) {
    const outputs = declaredNodeOutputs(node);
    return outputs !== undefined && Object.hasOwn(outputs, outcome) ? outputs[outcome] : undefined;
}
function validateTerminal(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, TERMINAL_KEYS, label);
    assertRequiredKeys(raw, TERMINAL_KEYS, label);
    return {
        nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
        outcome: assertIdentifier(raw.outcome, `${label}.outcome`)
    };
}
function validateDefinitionBase(raw, label) {
    const graphId = assertIdentifier(raw.graphId, `${label}: graphId`);
    const version = assertSafePositiveInt(raw.version, `${label}: version`);
    if (typeof raw.description !== "string") {
        throw new Error(`${label}: description must be a string (got ${typeName(raw.description)})`);
    }
    const description = raw.description.trim();
    if (description.length < 1 || description.length > MAX_GRAPH_DESCRIPTION_LENGTH) {
        throw new Error(`${label}: description must be 1..${MAX_GRAPH_DESCRIPTION_LENGTH} characters after trimming (got ${description.length})`);
    }
    const entry = assertIdentifier(raw.entry, `${label}: entry`);
    if (!Array.isArray(raw.nodes)
        || raw.nodes.length < 1
        || raw.nodes.length > MAX_GRAPH_NODES) {
        throw new Error(`${label}: nodes must be an array of 1..${MAX_GRAPH_NODES} nodes (got ${Array.isArray(raw.nodes) ? raw.nodes.length : typeName(raw.nodes)})`);
    }
    const nodes = raw.nodes.map((node, index) => validateMissionPipelineNode(node, `${label}: nodes[${index}]`));
    if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
        throw new Error(`${label}: node IDs must be unique`);
    }
    if (!Array.isArray(raw.edges)
        || raw.edges.length > MAX_GRAPH_EDGES) {
        throw new Error(`${label}: edges must be an array of 0..${MAX_GRAPH_EDGES} edges (got ${Array.isArray(raw.edges) ? raw.edges.length : typeName(raw.edges)})`);
    }
    const edges = raw.edges.map((edge, index) => validateEdge(edge, `${label}: edges[${index}]`));
    if (new Set(edges.map((edge) => edge.edgeId)).size !== edges.length) {
        throw new Error(`${label}: edge IDs must be unique`);
    }
    if (!Array.isArray(raw.terminals)
        || raw.terminals.length > MAX_GRAPH_TERMINALS) {
        throw new Error(`${label}: terminals must be an array of 0..${MAX_GRAPH_TERMINALS} node outcomes (got ${Array.isArray(raw.terminals) ? raw.terminals.length : typeName(raw.terminals)})`);
    }
    const terminals = raw.terminals.map((terminal, index) => validateTerminal(terminal, `${label}: terminals[${index}]`));
    const terminalKeys = terminals.map(({ nodeId, outcome }) => `${nodeId}\u0000${outcome}`);
    if (new Set(terminalKeys).size !== terminalKeys.length) {
        throw new Error(`${label}: terminal node/outcome pairs must be unique`);
    }
    return { graphId, version, description, entry, nodes, edges, terminals };
}
/** Validate and seal a graph draft with canonical-JSON SHA-256. */
export function createGraphDefinition(input) {
    const label = "graph definition";
    input = snapshotGraphValidationData(input, label);
    const raw = assertPlainObject(input, label);
    assertStrictKeys(raw, DRAFT_KEYS, label);
    assertRequiredKeys(raw, DRAFT_KEYS, label);
    const base = validateDefinitionBase(raw, label);
    return deepFrozenClone({ ...base, graphDigest: digest(base) }, label);
}
/** Validate a sealed graph and recompute its digest fail-closed. */
export function validateGraphDefinition(value) {
    const label = "graph definition";
    value = snapshotGraphValidationData(value, label);
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, SEALED_KEYS, label);
    assertRequiredKeys(raw, SEALED_KEYS, label);
    const base = validateDefinitionBase(raw, label);
    const sealed = assertSha256Hex(raw.graphDigest, `${label}: graphDigest`);
    const computed = digest(base);
    if (sealed !== computed) {
        throw new Error(`${label} ${base.graphId}@${base.version}: digest mismatch — sealed ${sealed} != computed ${computed}`);
    }
    return deepFrozenClone({ ...base, graphDigest: sealed }, label);
}
export function graphDefinitionRef(value) {
    const definition = validateGraphDefinition(value);
    return deepFrozenClone({ id: definition.graphId, version: definition.version, digest: definition.graphDigest }, "graph definition ref");
}

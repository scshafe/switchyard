// graph/definition.ts — the digest-sealed, data-only v2 node graph contract.
//
// It contains no executable code, provider data, credentials, storage handles,
// or host paths.

import { validateContractId, type ContractId } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import {
  assertIdentifier,
  assertPlainObject,
  assertPositiveInt,
  assertRequiredKeys,
  assertSafePositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  typeName
} from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { validateEdge, type Edge } from "./edge.js";
import { snapshotGraphValidationData } from "./limits.js";
import { validateOutcomeVocabulary, type OutcomeVocabulary } from "./outcome.js";

export const MISSION_PIPELINE_NODE_KINDS = [
  "code",
  "model",
  "agent",
  "human",
  "callback"
] as const;
export type MissionPipelineNodeKind = (typeof MISSION_PIPELINE_NODE_KINDS)[number];

/** Engine-only identity; authored nodes can never claim synthetic authority. */
export const MISSION_PIPELINE_ENGINE_PRINCIPAL_ID =
  "mission_pipeline.engine" as const;
/** Output contract emitted by an engine-synthesized unsatisfiable join. */
export const JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT =
  "mission-pipeline.join-unsatisfiable.v1" as const;
/** Input contract synthesized for an opt-in composing join. */
export const JOIN_INPUT_ARTIFACT_CONTRACT =
  "mission-pipeline.join-input.v1" as const;

export const NODE_TURN_IDEMPOTENCY = "per (unitId, nodeId, attemptNumber)" as const;
export const NODE_TURN_RETRY_TAXONOMY = "retryable vs terminal, as v1 durable-stage" as const;
export const MAX_GRAPH_NODES = 256;
export const MAX_GRAPH_EDGES = 2_048;
export const MAX_GRAPH_TERMINALS = 1_024;
export const MAX_GRAPH_DESCRIPTION_LENGTH = 1_000;
export const MAX_JOIN_INBOUND_EDGES = 256;
export const MAX_NODE_TURN_LEASE_MS = 86_400_000;
export const MAX_NODE_TURN_ATTEMPTS = 10;

export interface MissionPipelineNodeRef {
  readonly id: string;
  readonly version: number;
}

/** Opaque least-authority identity. Hosts resolve it; graphs never carry secrets. */
export interface PrincipalRef {
  readonly id: string;
}

export interface MissionPipelineNodeBindingRef {
  readonly kind: "model";
  readonly bindingId: string;
  readonly version: number;
  readonly bindingDigest: string;
}

export interface MissionPipelineNodeTurn {
  readonly idempotency: typeof NODE_TURN_IDEMPOTENCY;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryTaxonomy: typeof NODE_TURN_RETRY_TAXONOMY;
}

export type JoinRequirement = "all" | { readonly nOf: number };

export interface MissionPipelineJoin {
  /** Stable edge IDs; compileGraph requires exact equality with actual inbound edges. */
  readonly inbound: readonly string[];
  readonly require: JoinRequirement;
  /** Omitted/select preserves one-artifact selection; envelope embeds accepted branch inputs. */
  readonly compose?: "select" | "envelope";
}

/**
 * Content-addressed identity of the host-side configuration a node body runs
 * under (a policy table, a threshold set, a code revision). The host resolves
 * it; the engine seals it into the graph digest and the node execution
 * fingerprint, so a policy change is a visible identity change instead of a
 * silent drift behind an unchanged attempt key.
 */
export interface MissionPipelineNodeConfigurationRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

export interface MissionPipelineNode {
  readonly nodeId: string;
  readonly ref: MissionPipelineNodeRef;
  readonly kind: MissionPipelineNodeKind;
  readonly input: ContractId;
  readonly outcomes: OutcomeVocabulary;
  /**
   * The contract this node's body emits per declared outcome. An outcome that
   * emits no output artifact carries its input forward, so its entry equals
   * `input`. Omitted outcomes are undeclared: nothing is checked for them.
   * Declared entries are checked at compile time against every edge target
   * and at completion time against the returned artifact.
   */
  readonly outputs?: Readonly<Record<string, ContractId>>;
  readonly principal: PrincipalRef;
  readonly binding?: MissionPipelineNodeBindingRef;
  readonly configuration?: MissionPipelineNodeConfigurationRef;
  readonly turn: MissionPipelineNodeTurn;
  readonly join?: MissionPipelineJoin;
}

export interface TerminalOutcome {
  readonly nodeId: string;
  readonly outcome: string;
}

export interface GraphDefinitionDraft {
  readonly graphId: string;
  readonly version: number;
  readonly description: string;
  readonly entry: string;
  readonly nodes: readonly MissionPipelineNode[];
  readonly edges: readonly Edge[];
  readonly terminals: readonly TerminalOutcome[];
}

export interface GraphDefinition {
  readonly graphId: string;
  readonly version: number;
  readonly description: string;
  readonly entry: string;
  readonly nodes: readonly MissionPipelineNode[];
  readonly edges: readonly Edge[];
  readonly terminals: readonly TerminalOutcome[];
  readonly graphDigest: string;
}

export interface GraphDefinitionRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

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

function validateNodeRef(value: unknown, label: string): MissionPipelineNodeRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, NODE_REF_KEYS, label);
  assertRequiredKeys(raw, NODE_REF_KEYS, label);
  return {
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`)
  };
}

function validatePrincipalRef(value: unknown, label: string): PrincipalRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, PRINCIPAL_REF_KEYS, label);
  assertRequiredKeys(raw, PRINCIPAL_REF_KEYS, label);
  return { id: assertIdentifier(raw.id, `${label}.id`) };
}

export function validateMissionPipelineNodeBindingRef(
  value: unknown,
  label = "node binding"
): MissionPipelineNodeBindingRef {
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BINDING_REF_KEYS, label);
  assertRequiredKeys(raw, BINDING_REF_KEYS, label);
  if (raw.kind !== "model") {
    throw new Error(`${label}: kind must be "model" (got ${typeof raw.kind === "string" ? JSON.stringify(raw.kind) : typeName(raw.kind)})`);
  }
  return deepFrozenClone(
    {
      kind: "model" as const,
      bindingId: assertIdentifier(raw.bindingId, `${label}.bindingId`),
      version: assertSafePositiveInt(raw.version, `${label}.version`),
      bindingDigest: assertSha256Hex(raw.bindingDigest, `${label}.bindingDigest`)
    },
    label
  );
}

/** Validate, detach, and freeze a node configuration ref. */
export function validateMissionPipelineNodeConfigurationRef(
  value: unknown,
  label = "node configuration"
): MissionPipelineNodeConfigurationRef {
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, CONFIGURATION_REF_KEYS, label);
  assertRequiredKeys(raw, CONFIGURATION_REF_KEYS, label);
  return deepFrozenClone(
    {
      id: assertIdentifier(raw.id, `${label}.id`),
      version: assertSafePositiveInt(raw.version, `${label}.version`),
      digest: assertSha256Hex(raw.digest, `${label}.digest`)
    },
    label
  );
}

/**
 * Declared output contracts keyed by outcome. Every key must be one of the
 * node's declared outcomes; the engine-reserved `join_unsatisfiable` always
 * carries the reserved contract and cannot be declared.
 */
function validateNodeOutputs(
  value: unknown,
  outcomes: readonly string[],
  label: string
): Readonly<Record<string, ContractId>> {
  const raw = assertPlainObject(value, label);
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    throw new Error(`${label}: must declare at least one outcome (omit the key instead)`);
  }
  const declared = new Set(outcomes);
  const outputs: Record<string, ContractId> = {};
  for (const key of keys) {
    const outcome = assertIdentifier(key, `${label} outcome`);
    if (outcome === "join_unsatisfiable") {
      throw new Error(
        `${label}: engine-reserved outcome "join_unsatisfiable" always carries ${JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT} and cannot be declared`
      );
    }
    if (!declared.has(outcome)) {
      throw new Error(`${label}: outcome ${JSON.stringify(outcome)} is not declared by this node`);
    }
    outputs[outcome] = validateContractId(raw[outcome], `${label}.${outcome}`);
  }
  return deepFrozenClone(outputs, label);
}

function assertBoundedPositiveInt(
  value: unknown,
  maximum: number,
  label: string
): number {
  const result = assertPositiveInt(value, label);
  if (!Number.isSafeInteger(result) || result > maximum) {
    throw new Error(`${label}: must be an integer in 1..${maximum} (got ${String(result)})`);
  }
  return result;
}

function validateTurn(value: unknown, label: string): MissionPipelineNodeTurn {
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
    maxAttempts: assertBoundedPositiveInt(
      raw.maxAttempts,
      MAX_NODE_TURN_ATTEMPTS,
      `${label}.maxAttempts`
    ),
    retryTaxonomy: NODE_TURN_RETRY_TAXONOMY
  };
}

function validateJoinRequirement(value: unknown, label: string): JoinRequirement {
  if (value === "all") return "all";
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, N_OF_KEYS, label);
  assertRequiredKeys(raw, N_OF_KEYS, label);
  return {
    nOf: assertBoundedPositiveInt(raw.nOf, MAX_JOIN_INBOUND_EDGES, `${label}.nOf`)
  };
}

function validateJoin(value: unknown, label: string): MissionPipelineJoin {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, JOIN_KEYS, label);
  assertRequiredKeys(raw, JOIN_REQUIRED_KEYS, label);
  if (
    !Array.isArray(raw.inbound)
    || raw.inbound.length < 1
    || raw.inbound.length > MAX_JOIN_INBOUND_EDGES
  ) {
    throw new Error(
      `${label}.inbound: must be an array of 1..${MAX_JOIN_INBOUND_EDGES} edge IDs (got ${Array.isArray(raw.inbound) ? raw.inbound.length : typeName(raw.inbound)})`
    );
  }
  const inbound = raw.inbound.map((edgeId, index) =>
    assertIdentifier(edgeId, `${label}.inbound[${index}]`)
  );
  if (new Set(inbound).size !== inbound.length) {
    throw new Error(`${label}.inbound: edge IDs must be unique`);
  }
  if (Object.hasOwn(raw, "compose") && raw.compose !== "select" && raw.compose !== "envelope") {
    throw new Error(`${label}.compose: must be "select" | "envelope" (omit the key for selection)`);
  }
  return {
    inbound,
    require: validateJoinRequirement(raw.require, `${label}.require`),
    ...(Object.hasOwn(raw, "compose") ? { compose: raw.compose as "select" | "envelope" } : {})
  };
}

/** Validate one v2 node contract without resolving graph-level references. */
export function validateMissionPipelineNode(
  value: unknown,
  label = "mission pipeline node"
): MissionPipelineNode {
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, NODE_KEYS, label);
  assertRequiredKeys(raw, NODE_REQUIRED_KEYS, label);
  const nodeId = assertIdentifier(raw.nodeId, `${label}: nodeId`);
  const nodeLabel = `${label} ${nodeId}`;
  const ref = validateNodeRef(raw.ref, `${nodeLabel}: ref`);
  if (
    typeof raw.kind !== "string"
    || !(MISSION_PIPELINE_NODE_KINDS as readonly string[]).includes(raw.kind)
  ) {
    throw new Error(
      `${nodeLabel}: kind must be one of ${MISSION_PIPELINE_NODE_KINDS.map((kind) => JSON.stringify(kind)).join(" | ")} (got ${typeof raw.kind === "string" ? JSON.stringify(raw.kind) : typeName(raw.kind)})`
    );
  }
  const kind = raw.kind as MissionPipelineNodeKind;
  const input = validateContractId(raw.input, `${nodeLabel}: input`);
  const outcomes = validateOutcomeVocabulary(raw.outcomes, `${nodeLabel}: outcomes`);
  if (outcomes.version !== ref.version) {
    throw new Error(
      `${nodeLabel}: outcome vocabulary version ${outcomes.version} must equal node ref version ${ref.version} (outcome changes require a new node version)`
    );
  }
  let outputs: Readonly<Record<string, ContractId>> | undefined;
  if (Object.hasOwn(raw, "outputs")) {
    if (raw.outputs === undefined) {
      throw new Error(`${nodeLabel}: outputs is present but undefined (omit the key instead)`);
    }
    outputs = validateNodeOutputs(raw.outputs, outcomes.outcomes, `${nodeLabel}: outputs`);
  }
  let binding: MissionPipelineNodeBindingRef | undefined;
  if (Object.hasOwn(raw, "binding")) {
    if (raw.binding === undefined) {
      throw new Error(`${nodeLabel}: binding is present but undefined (omit the key instead)`);
    }
    binding = validateMissionPipelineNodeBindingRef(raw.binding, `${nodeLabel}: binding`);
  }
  let configuration: MissionPipelineNodeConfigurationRef | undefined;
  if (Object.hasOwn(raw, "configuration")) {
    if (raw.configuration === undefined) {
      throw new Error(`${nodeLabel}: configuration is present but undefined (omit the key instead)`);
    }
    configuration = validateMissionPipelineNodeConfigurationRef(
      raw.configuration,
      `${nodeLabel}: configuration`
    );
  }
  let join: MissionPipelineJoin | undefined;
  if (Object.hasOwn(raw, "join")) {
    if (raw.join === undefined) {
      throw new Error(`${nodeLabel}: join is present but undefined (omit the key instead)`);
    }
    join = validateJoin(raw.join, `${nodeLabel}: join`);
  }
  return deepFrozenClone(
    {
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
    },
    nodeLabel
  );
}

/** Declared outputs of a validated node, or undefined when none are declared. */
export function declaredNodeOutputs(
  node: MissionPipelineNode
): Readonly<Record<string, ContractId>> | undefined {
  return Object.hasOwn(node, "outputs") ? node.outputs : undefined;
}

/** The contract a validated node declares for one outcome, or undefined when undeclared. */
export function declaredNodeOutput(
  node: MissionPipelineNode,
  outcome: string
): ContractId | undefined {
  const outputs = declaredNodeOutputs(node);
  return outputs !== undefined && Object.hasOwn(outputs, outcome) ? outputs[outcome] : undefined;
}

function validateTerminal(value: unknown, label: string): TerminalOutcome {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, TERMINAL_KEYS, label);
  assertRequiredKeys(raw, TERMINAL_KEYS, label);
  return {
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    outcome: assertIdentifier(raw.outcome, `${label}.outcome`)
  };
}

function validateDefinitionBase(
  raw: Record<string, unknown>,
  label: string
): Omit<GraphDefinition, "graphDigest"> {
  const graphId = assertIdentifier(raw.graphId, `${label}: graphId`);
  const version = assertSafePositiveInt(raw.version, `${label}: version`);
  if (typeof raw.description !== "string") {
    throw new Error(`${label}: description must be a string (got ${typeName(raw.description)})`);
  }
  const description = raw.description.trim();
  if (description.length < 1 || description.length > MAX_GRAPH_DESCRIPTION_LENGTH) {
    throw new Error(
      `${label}: description must be 1..${MAX_GRAPH_DESCRIPTION_LENGTH} characters after trimming (got ${description.length})`
    );
  }
  const entry = assertIdentifier(raw.entry, `${label}: entry`);
  if (
    !Array.isArray(raw.nodes)
    || raw.nodes.length < 1
    || raw.nodes.length > MAX_GRAPH_NODES
  ) {
    throw new Error(
      `${label}: nodes must be an array of 1..${MAX_GRAPH_NODES} nodes (got ${Array.isArray(raw.nodes) ? raw.nodes.length : typeName(raw.nodes)})`
    );
  }
  const nodes = raw.nodes.map((node, index) =>
    validateMissionPipelineNode(node, `${label}: nodes[${index}]`)
  );
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
    throw new Error(`${label}: node IDs must be unique`);
  }
  if (
    !Array.isArray(raw.edges)
    || raw.edges.length > MAX_GRAPH_EDGES
  ) {
    throw new Error(
      `${label}: edges must be an array of 0..${MAX_GRAPH_EDGES} edges (got ${Array.isArray(raw.edges) ? raw.edges.length : typeName(raw.edges)})`
    );
  }
  const edges = raw.edges.map((edge, index) => validateEdge(edge, `${label}: edges[${index}]`));
  if (new Set(edges.map((edge) => edge.edgeId)).size !== edges.length) {
    throw new Error(`${label}: edge IDs must be unique`);
  }
  if (
    !Array.isArray(raw.terminals)
    || raw.terminals.length > MAX_GRAPH_TERMINALS
  ) {
    throw new Error(
      `${label}: terminals must be an array of 0..${MAX_GRAPH_TERMINALS} node outcomes (got ${Array.isArray(raw.terminals) ? raw.terminals.length : typeName(raw.terminals)})`
    );
  }
  const terminals = raw.terminals.map((terminal, index) =>
    validateTerminal(terminal, `${label}: terminals[${index}]`)
  );
  const terminalKeys = terminals.map(({ nodeId, outcome }) => `${nodeId}\u0000${outcome}`);
  if (new Set(terminalKeys).size !== terminalKeys.length) {
    throw new Error(`${label}: terminal node/outcome pairs must be unique`);
  }
  return { graphId, version, description, entry, nodes, edges, terminals };
}

/** Validate and seal a graph draft with canonical-JSON SHA-256. */
export function createGraphDefinition(input: unknown): GraphDefinition {
  const label = "graph definition";
  input = snapshotGraphValidationData(input, label);
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, DRAFT_KEYS, label);
  assertRequiredKeys(raw, DRAFT_KEYS, label);
  const base = validateDefinitionBase(raw, label);
  return deepFrozenClone({ ...base, graphDigest: digest(base) }, label);
}

/** Validate a sealed graph and recompute its digest fail-closed. */
export function validateGraphDefinition(value: unknown): GraphDefinition {
  const label = "graph definition";
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, SEALED_KEYS, label);
  assertRequiredKeys(raw, SEALED_KEYS, label);
  const base = validateDefinitionBase(raw, label);
  const sealed = assertSha256Hex(raw.graphDigest, `${label}: graphDigest`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(
      `${label} ${base.graphId}@${base.version}: digest mismatch — sealed ${sealed} != computed ${computed}`
    );
  }
  return deepFrozenClone({ ...base, graphDigest: sealed }, label);
}

export function graphDefinitionRef(value: unknown): GraphDefinitionRef {
  const definition = validateGraphDefinition(value);
  return deepFrozenClone(
    { id: definition.graphId, version: definition.version, digest: definition.graphDigest },
    "graph definition ref"
  );
}

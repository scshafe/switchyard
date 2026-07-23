// definition.ts — PipelineDefinition / PipelineNode: the digest-sealed,
// data-only description of a pipeline DAG.
//
// PROMOTED from inbox-pipeline/src/runtime/contracts.ts (PipelineNodeSchema,
// PipelineDefinitionSchema, createPipelineDefinition, pipelineDefinitionRef —
// including the sealing rule `definitionDigest = digest(payload-without-digest)`
// and the promoted uniqueness rules), DE-ZOD-ED to plain TS types +
// hand-written LOUD validators. Schema-first source:
// schemas/pipeline-definition.v2.schema.json (v2 because the node shape
// changed in promotion — see below).
//
// A definition names REGISTERED stage ids/versions, named input slots, and
// contract versions — never module paths, never DB-supplied code. Digests are
// computed over canonical JSON (contracts/digest.ts), so a definition's
// identity is stable under key permutation.
//
// DEVIATION from the inbox v1 shape (the reason this is …v2): a node no longer
// embeds the FULL ModelStageBinding / HierarchicalDecisionFlowBinding payloads
// (those sealed payloads are owned by the B4 model module and the B5 decision
// module). Instead a node carries ONE optional content-addressed
// {@link PipelineNodeBindingRef} `{ kind, bindingId, version, bindingDigest }`
// — the run snapshot resolves the published binding while proving this exact
// digest (the same portable-ref principle the inbox contracts documented for
// decision flows). This also collapses the inbox's two mutually-exclusive
// optional fields (binding / decisionFlow) into one kind-tagged field.
//
// STANDALONE: relative imports only (no npm deps, no zod).

import { digest } from "./contracts/digest.js";
import { validateContractId, type ContractId } from "./contracts/artifact.js";
import {
  assertIdentifier,
  assertPlainObject,
  assertPositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  typeName,
  truncate
} from "./internal/guards.js";

export const PIPELINE_DEFINITION_SCHEMA_VERSION = "pipeline-definition.v2";
export const MAX_PIPELINE_NODES = 64;
export const MAX_PIPELINE_OUTPUTS = 16;
export const MAX_NODE_INPUTS = 16;
export const MAX_DESCRIPTION_LENGTH = 1_000;

/** Where a node input's artifact comes from: the pipeline input or another node's output. */
export type PipelineNodeInputSource =
  | { kind: "pipeline_input" }
  | { kind: "node_output"; nodeId: string };

export interface PipelineNodeInput {
  slot: string;
  source: PipelineNodeInputSource;
}

/** The binding kinds a node may reference (never "none" — unbound nodes omit the field). */
export const PIPELINE_NODE_BINDING_KINDS = ["model", "decision"] as const;
export type PipelineNodeBindingKind = (typeof PIPELINE_NODE_BINDING_KINDS)[number];

/**
 * Content-addressed reference from a pipeline node to a published,
 * digest-sealed binding (model-stage binding — B4; decision-flow binding —
 * B5). `bindingDigest` is the sealed payload's canonical-JSON digest; the
 * compiler stamps it into the compiled node as `bindingFingerprint`, so a
 * binding change changes the pipeline identity.
 */
export interface PipelineNodeBindingRef {
  kind: PipelineNodeBindingKind;
  bindingId: string;
  version: number;
  bindingDigest: string;
}

export interface PipelineNode {
  nodeId: string;
  stage: { id: string; version: number };
  inputs: PipelineNodeInput[];
  binding?: PipelineNodeBindingRef;
}

/** What callers hand to {@link createPipelineDefinition} (no digest yet). */
export interface PipelineDefinitionDraft {
  schemaVersion: typeof PIPELINE_DEFINITION_SCHEMA_VERSION;
  pipelineId: string;
  version: number;
  description: string;
  inputContract: string;
  nodes: readonly PipelineNode[];
  outputs: readonly string[];
}

/** The digest-sealed pipeline definition. */
export interface PipelineDefinition {
  schemaVersion: typeof PIPELINE_DEFINITION_SCHEMA_VERSION;
  pipelineId: string;
  version: number;
  description: string;
  inputContract: ContractId;
  nodes: PipelineNode[];
  outputs: string[];
  definitionDigest: string;
}

/** Promoted `{ id, version, digest }` reference to a definition. */
export interface PipelineDefinitionRef {
  id: string;
  version: number;
  digest: string;
}

const DRAFT_KEYS = new Set(["schemaVersion", "pipelineId", "version", "description", "inputContract", "nodes", "outputs"]);
const SEALED_KEYS = new Set([...DRAFT_KEYS, "definitionDigest"]);
const NODE_KEYS = new Set(["nodeId", "stage", "inputs", "binding"]);
const NODE_STAGE_KEYS = new Set(["id", "version"]);
const SOURCE_PIPELINE_INPUT_KEYS = new Set(["kind"]);
const SOURCE_NODE_OUTPUT_KEYS = new Set(["kind", "nodeId"]);
const BINDING_REF_KEYS = new Set(["kind", "bindingId", "version", "bindingDigest"]);

/** LOUD validator for a node input source (exported for compiled-shape reuse). */
export function validatePipelineNodeInputSource(value: unknown, label: string): PipelineNodeInputSource {
  const raw = assertPlainObject(value, label);
  if (raw.kind === "pipeline_input") {
    assertStrictKeys(raw, SOURCE_PIPELINE_INPUT_KEYS, label);
    return { kind: "pipeline_input" };
  }
  if (raw.kind === "node_output") {
    assertStrictKeys(raw, SOURCE_NODE_OUTPUT_KEYS, label);
    return { kind: "node_output", nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`) };
  }
  const got = typeof raw.kind === "string" ? JSON.stringify(truncate(raw.kind)) : typeName(raw.kind);
  throw new Error(`${label}: source kind must be "pipeline_input" | "node_output" (got ${got})`);
}

function validateBindingRef(value: unknown, label: string): PipelineNodeBindingRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BINDING_REF_KEYS, label);
  if (raw.kind !== "model" && raw.kind !== "decision") {
    const got = typeof raw.kind === "string" ? JSON.stringify(truncate(raw.kind)) : typeName(raw.kind);
    throw new Error(`${label}: binding kind must be "model" | "decision" (got ${got})`);
  }
  return {
    kind: raw.kind,
    bindingId: assertIdentifier(raw.bindingId, `${label}.bindingId`),
    version: assertPositiveInt(raw.version, `${label}.version`),
    bindingDigest: assertSha256Hex(raw.bindingDigest, `${label}.bindingDigest`)
  };
}

/** LOUD validator for one {@link PipelineNode}. */
export function validatePipelineNode(value: unknown, label = "pipeline node"): PipelineNode {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, NODE_KEYS, label);
  const nodeId = assertIdentifier(raw.nodeId, `${label}: nodeId`);
  const nodeLabel = `${label} ${nodeId}`;

  const stageRaw = assertPlainObject(raw.stage, `${nodeLabel}: stage`);
  assertStrictKeys(stageRaw, NODE_STAGE_KEYS, `${nodeLabel}: stage`);
  const stage = {
    id: assertIdentifier(stageRaw.id, `${nodeLabel}: stage.id`),
    version: assertPositiveInt(stageRaw.version, `${nodeLabel}: stage.version`)
  };

  if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > MAX_NODE_INPUTS) {
    throw new Error(
      `${nodeLabel}: inputs must be an array of 1..${MAX_NODE_INPUTS} slot bindings (got ${Array.isArray(raw.inputs) ? raw.inputs.length : typeName(raw.inputs)})`
    );
  }
  const inputs: PipelineNodeInput[] = raw.inputs.map((inputRaw, index) => {
    const inputLabel = `${nodeLabel}: inputs[${index}]`;
    const inputObject = assertPlainObject(inputRaw, inputLabel);
    assertStrictKeys(inputObject, new Set(["slot", "source"]), inputLabel);
    return {
      slot: assertIdentifier(inputObject.slot, `${inputLabel}.slot`),
      source: validatePipelineNodeInputSource(inputObject.source, `${inputLabel}.source`)
    };
  });
  if (new Set(inputs.map((input) => input.slot)).size !== inputs.length) {
    throw new Error(`${nodeLabel}: input slots must be unique`);
  }

  const node: PipelineNode = { nodeId, stage, inputs };
  if ("binding" in raw) {
    if (raw.binding === undefined) {
      throw new Error(`${nodeLabel}: binding is present but undefined (omit the key instead)`);
    }
    node.binding = validateBindingRef(raw.binding, `${nodeLabel}: binding`);
  }
  return node;
}

/**
 * Validates the digest-free base of a definition and returns the NORMALIZED
 * payload the digest is computed over (description trimmed — the promoted
 * `z.string().trim()` behavior; node/binding objects freshly rebuilt so no
 * unknown keys can leak into the digest).
 */
function validateDefinitionBase(raw: Record<string, unknown>, label: string): Omit<PipelineDefinition, "definitionDigest"> {
  if (raw.schemaVersion !== PIPELINE_DEFINITION_SCHEMA_VERSION) {
    throw new Error(
      `${label}: schemaVersion must be ${JSON.stringify(PIPELINE_DEFINITION_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`
    );
  }
  const pipelineId = assertIdentifier(raw.pipelineId, `${label}: pipelineId`);
  const version = assertPositiveInt(raw.version, `${label}: version`);
  if (typeof raw.description !== "string") {
    throw new Error(`${label}: description must be a string (got ${typeName(raw.description)})`);
  }
  const description = raw.description.trim();
  if (description.length < 1 || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`${label}: description must be 1..${MAX_DESCRIPTION_LENGTH} chars after trimming (got ${description.length})`);
  }
  const inputContract = validateContractId(raw.inputContract, `${label}: inputContract`);

  if (!Array.isArray(raw.nodes) || raw.nodes.length < 1 || raw.nodes.length > MAX_PIPELINE_NODES) {
    throw new Error(
      `${label}: nodes must be an array of 1..${MAX_PIPELINE_NODES} pipeline nodes (got ${Array.isArray(raw.nodes) ? raw.nodes.length : typeName(raw.nodes)})`
    );
  }
  const nodes = raw.nodes.map((nodeRaw, index) => validatePipelineNode(nodeRaw, `${label}: nodes[${index}]`));
  if (new Set(nodes.map((node) => node.nodeId)).size !== nodes.length) {
    throw new Error(`${label}: pipeline node IDs must be unique`);
  }

  if (!Array.isArray(raw.outputs) || raw.outputs.length < 1 || raw.outputs.length > MAX_PIPELINE_OUTPUTS) {
    throw new Error(
      `${label}: outputs must be an array of 1..${MAX_PIPELINE_OUTPUTS} node IDs (got ${Array.isArray(raw.outputs) ? raw.outputs.length : typeName(raw.outputs)})`
    );
  }
  const outputs = raw.outputs.map((output, index) => assertIdentifier(output, `${label}: outputs[${index}]`));
  if (new Set(outputs).size !== outputs.length) {
    throw new Error(`${label}: pipeline output node IDs must be unique`);
  }

  return {
    schemaVersion: PIPELINE_DEFINITION_SCHEMA_VERSION,
    pipelineId,
    version,
    description,
    inputContract,
    nodes,
    outputs
  };
}

/**
 * Seal a draft into a {@link PipelineDefinition}: validate LOUDLY, then stamp
 * `definitionDigest = digest(normalized-base)`. The digest is stable under key
 * permutation of the input (canonical JSON sorts keys).
 */
export function createPipelineDefinition(input: unknown): PipelineDefinition {
  const label = "pipeline definition";
  const raw = assertPlainObject(input, label);
  assertStrictKeys(raw, DRAFT_KEYS, label);
  const base = validateDefinitionBase(raw, label);
  return { ...base, definitionDigest: digest(base) };
}

/**
 * LOUD validator for a SEALED definition: full shape validation plus digest
 * recompute — tampering with any field throws "digest mismatch" (the promoted
 * fail-closed sealing semantics).
 */
export function validatePipelineDefinition(value: unknown): PipelineDefinition {
  const label = "pipeline definition";
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, SEALED_KEYS, label);
  const base = validateDefinitionBase(raw, label);
  const sealed = assertSha256Hex(raw.definitionDigest, `${label}: definitionDigest`);
  const computed = digest(base);
  if (sealed !== computed) {
    throw new Error(
      `${label} ${base.pipelineId}@${base.version}: digest mismatch — sealed ${sealed} != computed ${computed}`
    );
  }
  return { ...base, definitionDigest: sealed };
}

/** Promoted projection of a sealed definition to its `{ id, version, digest }` ref. */
export function pipelineDefinitionRef(definitionRaw: unknown): PipelineDefinitionRef {
  const definition = validatePipelineDefinition(definitionRaw);
  return { id: definition.pipelineId, version: definition.version, digest: definition.definitionDigest };
}

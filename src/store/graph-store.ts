// store/graph-store.ts — the immutable v2 graph-publication port.
//
// Published graphs are append-only evidence. A graph identity is the pair
// `(graphId, version)` and may be replayed only with the identical digest.
// Loads require the full digest-bearing reference so a stale or substituted
// definition cannot be mistaken for the graph a unit pinned at admission.

import type { ContractId } from "../contracts/artifact.js";
import {
  declaredNodeOutputs,
  validateSwitchyardNode,
  type GraphDefinition,
  type GraphDefinitionRef,
  type SwitchyardNode,
  type SwitchyardNodeKind
} from "../graph/definition.js";
import {
  assertIdentifier,
  assertSafePositiveInt,
  assertSha256Hex
} from "../internal/guards.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { deepFrozenClone } from "../internal/evidence.js";

const GRAPH_REF_KEYS = new Set(["id", "version", "digest"]);

/** Definition-bound meaning of one `(node ref id, version)`. */
export interface NodeDefinitionSignature {
  readonly kind: SwitchyardNodeKind;
  readonly input: ContractId;
  /** Set semantics, represented in canonical lexical order. */
  readonly outcomes: readonly string[];
  /**
   * Declared output contracts by outcome, in canonical lexical key order;
   * present only when the node declares any. A ref/version that declares
   * outputs in one graph and not in another names two definitions.
   */
  readonly outputs?: Readonly<Record<string, ContractId>>;
}

/** Validate, detach, and freeze a digest-bearing graph reference. */
export function validateGraphDefinitionRef(
  value: unknown,
  label = "graph definition ref"
): GraphDefinitionRef {
  const keys = [...GRAPH_REF_KEYS];
  const raw = captureCapabilityRecord(value, keys, keys, label);
  return deepFrozenClone(
    {
      id: assertIdentifier(raw.id, `${label}.id`),
      version: assertSafePositiveInt(raw.version, `${label}.version`),
      digest: assertSha256Hex(raw.digest, `${label}.digest`)
    },
    label
  );
}

/** Canonical signature used by every GraphStore implementation. */
export function nodeDefinitionSignature(
  node: SwitchyardNode
): NodeDefinitionSignature {
  const validated = validateSwitchyardNode(node, "node definition signature input");
  const outputs = declaredNodeOutputs(validated);
  return deepFrozenClone(
    {
      kind: validated.kind,
      input: validated.input,
      outcomes: [...validated.outcomes.outcomes].sort(),
      ...(outputs === undefined
        ? {}
        : {
            outputs: Object.fromEntries(
              Object.keys(outputs).sort().map((outcome) => [outcome, outputs[outcome]])
            )
          })
    },
    `node definition ${validated.ref.id}@${validated.ref.version} signature`
  );
}

/** Field-by-field signature comparison every GraphStore implementation must apply. */
export function nodeDefinitionSignatureConflict(
  published: NodeDefinitionSignature,
  requested: NodeDefinitionSignature
): NodeDefinitionConflictField | undefined {
  if (published.kind !== requested.kind) return "kind";
  if (published.input !== requested.input) return "input contract";
  if (
    published.outcomes.length !== requested.outcomes.length
    || published.outcomes.some((outcome, index) => outcome !== requested.outcomes[index])
  ) {
    return "outcome vocabulary";
  }
  const publishedOutputs = Object.hasOwn(published, "outputs") ? published.outputs : undefined;
  const requestedOutputs = Object.hasOwn(requested, "outputs") ? requested.outputs : undefined;
  if (publishedOutputs === undefined || requestedOutputs === undefined) {
    return publishedOutputs === requestedOutputs ? undefined : "output contracts";
  }
  const publishedKeys = Object.keys(publishedOutputs);
  if (
    publishedKeys.length !== Object.keys(requestedOutputs).length
    || publishedKeys.some((outcome) =>
      !Object.hasOwn(requestedOutputs, outcome) || requestedOutputs[outcome] !== publishedOutputs[outcome]
    )
  ) {
    return "output contracts";
  }
  return undefined;
}

/** A sealed graph failed semantic compilation before publication. */
export class GraphPublicationValidationError extends Error {
  readonly code = "graph_publication_invalid";
  readonly graphId: string;
  readonly graphVersion: number;

  constructor(graphId: string, graphVersion: number, detail: string, cause: unknown) {
    super(
      `publishGraph: graph ${graphId}@${graphVersion} rejected before publication: ${detail}`,
      { cause }
    );
    this.name = "GraphPublicationValidationError";
    this.graphId = graphId;
    this.graphVersion = graphVersion;
    Object.freeze(this);
  }
}

/** A graph identity was already sealed to a different digest. */
export class GraphPublicationConflictError extends Error {
  readonly code = "graph_publication_conflict";
  readonly graphId: string;
  readonly graphVersion: number;
  readonly publishedDigest: string;
  readonly requestedDigest: string;

  constructor(
    graphId: string,
    graphVersion: number,
    publishedDigest: string,
    requestedDigest: string
  ) {
    super(
      `publishGraph: graph ${graphId}@${graphVersion} is already published with digest ${publishedDigest}; requested digest ${requestedDigest} conflicts with immutable evidence`
    );
    this.name = "GraphPublicationConflictError";
    this.graphId = graphId;
    this.graphVersion = graphVersion;
    this.publishedDigest = publishedDigest;
    this.requestedDigest = requestedDigest;
    Object.freeze(this);
  }
}

/** A load named an existing graph identity but supplied the wrong digest. */
export class GraphLoadDigestConflictError extends Error {
  readonly code = "graph_load_digest_conflict";
  readonly graphId: string;
  readonly graphVersion: number;
  readonly publishedDigest: string;
  readonly requestedDigest: string;

  constructor(
    graphId: string,
    graphVersion: number,
    publishedDigest: string,
    requestedDigest: string
  ) {
    super(
      `loadGraph: graph ${graphId}@${graphVersion} is published with digest ${publishedDigest}; requested digest ${requestedDigest} conflicts with the sealed graph`
    );
    this.name = "GraphLoadDigestConflictError";
    this.graphId = graphId;
    this.graphVersion = graphVersion;
    this.publishedDigest = publishedDigest;
    this.requestedDigest = requestedDigest;
    Object.freeze(this);
  }
}

export type NodeDefinitionConflictField =
  | "kind"
  | "input contract"
  | "outcome vocabulary"
  | "output contracts";

/** One node ref/version was given a different definition-bound meaning. */
export class NodeDefinitionPublicationConflictError extends Error {
  readonly code = "node_definition_publication_conflict";
  readonly nodeRefId: string;
  readonly nodeRefVersion: number;
  readonly field: NodeDefinitionConflictField;
  readonly publishedBy: GraphDefinitionRef;
  readonly requestedBy: GraphDefinitionRef;

  constructor(input: {
    readonly nodeRefId: string;
    readonly nodeRefVersion: number;
    readonly field: NodeDefinitionConflictField;
    readonly publishedBy: GraphDefinitionRef;
    readonly requestedBy: GraphDefinitionRef;
  }) {
    super(
      `publishGraph: node definition ${input.nodeRefId}@${input.nodeRefVersion} conflicts in ${input.field}; first published by graph ${input.publishedBy.id}@${input.publishedBy.version} (${input.publishedBy.digest}), requested by graph ${input.requestedBy.id}@${input.requestedBy.version} (${input.requestedBy.digest}); change the node version`
    );
    this.name = "NodeDefinitionPublicationConflictError";
    this.nodeRefId = input.nodeRefId;
    this.nodeRefVersion = input.nodeRefVersion;
    this.field = input.field;
    this.publishedBy = deepFrozenClone(input.publishedBy, "published node definition graph ref");
    this.requestedBy = deepFrozenClone(input.requestedBy, "requested node definition graph ref");
    Object.freeze(this);
  }
}

/**
 * Host-neutral append-only graph store. Implementations MUST validate and
 * compile before publication, make graph + node-signature writes atomic, and
 * revalidate the sealed graph on every load.
 */
export interface GraphStore {
  publishGraph(graph: GraphDefinition): Promise<void>;
  loadGraph(ref: GraphDefinitionRef): Promise<GraphDefinition | undefined>;
}

// store/memory-graph-store.ts — executable in-memory GraphStore specification.

import { compileGraph } from "../graph/compile.js";
import {
  graphDefinitionRef,
  validateGraphDefinition,
  type GraphDefinition,
  type GraphDefinitionRef
} from "../graph/definition.js";
import {
  GraphLoadDigestConflictError,
  GraphPublicationConflictError,
  GraphPublicationValidationError,
  NodeDefinitionPublicationConflictError,
  nodeDefinitionSignature,
  validateGraphDefinitionRef,
  type GraphStore,
  type NodeDefinitionConflictField,
  type NodeDefinitionSignature
} from "./graph-store.js";

interface PublishedNodeDefinition {
  readonly signature: NodeDefinitionSignature;
  readonly graph: GraphDefinitionRef;
}

function graphKey(id: string, version: number): string {
  return `${id}\u0000${version}`;
}

function nodeRefKey(id: string, version: number): string {
  return `${id}\u0000${version}`;
}

function firstSignatureConflict(
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
  return undefined;
}

function trustedErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "graph compilation failed";
}

/**
 * Memory GraphStore used as the N3 conformance oracle. Methods contain no
 * awaits after validation, so graph evidence and the node-signature registry
 * become visible together or not at all.
 */
export class MemoryGraphStore implements GraphStore {
  readonly #graphs = new Map<string, GraphDefinition>();
  readonly #nodeDefinitions = new Map<string, PublishedNodeDefinition>();

  async publishGraph(graphRaw: GraphDefinition): Promise<void> {
    const graph = validateGraphDefinition(graphRaw);
    try {
      compileGraph(graph);
    } catch (error) {
      throw new GraphPublicationValidationError(
        graph.graphId,
        graph.version,
        trustedErrorMessage(error),
        error
      );
    }

    const graphRef = graphDefinitionRef(graph);
    const identity = graphKey(graph.graphId, graph.version);
    const existingGraph = this.#graphs.get(identity);
    if (existingGraph !== undefined) {
      if (existingGraph.graphDigest !== graph.graphDigest) {
        throw new GraphPublicationConflictError(
          graph.graphId,
          graph.version,
          existingGraph.graphDigest,
          graph.graphDigest
        );
      }
      return;
    }

    // Validate every cross-graph definition identity before mutating either
    // registry. A conflict cannot leak an unrelated signature from this graph.
    const signatures = new Map<string, PublishedNodeDefinition>();
    for (const node of graph.nodes) {
      const key = nodeRefKey(node.ref.id, node.ref.version);
      const requested = nodeDefinitionSignature(node);
      const published = this.#nodeDefinitions.get(key);
      if (published !== undefined) {
        const field = firstSignatureConflict(published.signature, requested);
        if (field !== undefined) {
          throw new NodeDefinitionPublicationConflictError({
            nodeRefId: node.ref.id,
            nodeRefVersion: node.ref.version,
            field,
            publishedBy: published.graph,
            requestedBy: graphRef
          });
        }
        continue;
      }
      signatures.set(key, { signature: requested, graph: graphRef });
    }

    // Atomic append in the memory implementation: no fallible work follows.
    this.#graphs.set(identity, graph);
    for (const [key, definition] of signatures) {
      this.#nodeDefinitions.set(key, definition);
    }
  }

  async loadGraph(refRaw: GraphDefinitionRef): Promise<GraphDefinition | undefined> {
    const ref = validateGraphDefinitionRef(refRaw, "loadGraph graph ref");
    const stored = this.#graphs.get(graphKey(ref.id, ref.version));
    if (stored === undefined) return undefined;

    // Revalidate both the canonical digest seal and semantic compilation on
    // every read. A durable adapter must apply the same fail-closed rule.
    const graph = validateGraphDefinition(stored);
    try {
      compileGraph(graph);
    } catch (error) {
      throw new GraphPublicationValidationError(
        graph.graphId,
        graph.version,
        trustedErrorMessage(error),
        error
      );
    }
    if (graph.graphDigest !== ref.digest) {
      throw new GraphLoadDigestConflictError(
        ref.id,
        ref.version,
        graph.graphDigest,
        ref.digest
      );
    }
    return graph;
  }
}

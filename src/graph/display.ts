// graph/display.ts — structural display data, without consumer presentation.

import type { ContractId } from "../contracts/artifact.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { requireCompiledGraph, type CompiledGraph } from "./compile.js";
import type {
  GraphDefinitionRef,
  JoinRequirement,
  SwitchyardJoin,
  SwitchyardNode,
  SwitchyardNodeBindingRef,
  SwitchyardNodeConfigurationRef,
  SwitchyardNodeKind,
  SwitchyardNodeRef,
  TerminalOutcome
} from "./definition.js";
import { isUnconditionalOutcomePredicate, predicateOutcomes } from "./edge.js";

export const GRAPH_DISPLAY_SCHEMA_VERSION = "mission-pipeline-graph-display.v1" as const;

export interface GraphDisplayNode {
  readonly nodeId: string;
  readonly kind: SwitchyardNodeKind;
  readonly ref: SwitchyardNodeRef;
  readonly input: ContractId;
  readonly outcomes: readonly string[];
  readonly outputs?: Readonly<Record<string, ContractId>>;
  readonly binding?: SwitchyardNodeBindingRef;
  readonly configuration?: SwitchyardNodeConfigurationRef;
  readonly join?: SwitchyardJoin;
  readonly maxAttempts: number;
  /** Longest path from entry in a DAG; shortest BFS depth for all nodes if cyclic. */
  readonly depth: number;
  /** At least two outcomes, identical guaranteed successors, and no terminals. */
  readonly marks: boolean;
}

export interface GraphDisplayArrow {
  readonly from: string;
  readonly to: string;
  /** Distinct outcomes, in first contributing predicate order. */
  readonly outcomes: readonly string[];
  /** All contributing edges, in authored order. */
  readonly edgeIds: readonly string[];
  /** At least one contributing edge has a where arm; not an execution result. */
  readonly conditional: boolean;
  /** One entry per contributing multi-target edge; co-targets in authored order. */
  readonly fanOut: readonly {
    readonly edgeId: string;
    readonly coTargets: readonly string[];
    /** Outcomes belonging to this edge, before merging; absent in older v1 projections. */
    readonly outcomes?: readonly string[];
  }[];
}

export interface GraphDisplayJoin {
  readonly nodeId: string;
  readonly require: JoinRequirement;
  readonly inbound: readonly string[];
}

export interface GraphDisplayProjection {
  readonly schemaVersion: typeof GRAPH_DISPLAY_SCHEMA_VERSION;
  readonly graph: GraphDefinitionRef;
  readonly entry: string;
  readonly nodes: readonly GraphDisplayNode[];
  /** One arrow per (from, to) pair, in first edge/target encounter order. */
  readonly arrows: readonly GraphDisplayArrow[];
  readonly terminals: readonly TerminalOutcome[];
  readonly joins: readonly GraphDisplayJoin[];
}

/** Convert already validated JSON to frozen records with no inherited fields. */
function prototypeFree<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(prototypeFree)) as T;
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, field] of Object.entries(value)) record[key] = prototypeFree(field);
  return Object.freeze(record) as T;
}

function nodeDepths(compiled: CompiledGraph): ReadonlyMap<string, number> {
  const targets = new Map<string, Set<string>>();
  const remaining = new Map(compiled.nodes.map((node) => [node.nodeId, 0]));
  for (const edge of compiled.edges) {
    let successors = targets.get(edge.from);
    if (successors === undefined) {
      successors = new Set();
      targets.set(edge.from, successors);
    }
    for (const to of edge.to) {
      if (successors.has(to)) continue;
      successors.add(to);
      remaining.set(to, remaining.get(to)! + 1);
    }
  }
  const depth = new Map([[compiled.entry, 0]]);
  const ready = compiled.nodes.filter((node) => remaining.get(node.nodeId) === 0)
    .map((node) => node.nodeId);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const from = ready[index];
    visited += 1;
    for (const to of targets.get(from) ?? []) {
      depth.set(to, Math.max(depth.get(to) ?? 0, depth.get(from)! + 1));
      const left = remaining.get(to)! - 1;
      remaining.set(to, left);
      if (left === 0) ready.push(to);
    }
  }
  if (visited === compiled.nodes.length) return depth;

  // A cycle makes longest depth unbounded. Recompute the whole graph with
  // BFS, so a finite DAG prefix and the cyclic suffix use the same convention.
  depth.clear();
  depth.set(compiled.entry, 0);
  const pending = [compiled.entry];
  for (let index = 0; index < pending.length; index += 1) {
    const from = pending[index];
    for (const to of targets.get(from) ?? []) {
      if (depth.has(to)) continue;
      depth.set(to, depth.get(from)! + 1);
      pending.push(to);
    }
  }
  return depth;
}

function markingNode(compiled: CompiledGraph, node: SwitchyardNode): boolean {
  if (node.outcomes.outcomes.length < 2
    || compiled.terminals.some((terminal) => terminal.nodeId === node.nodeId)) return false;
  const guaranteed = new Map(node.outcomes.outcomes.map((outcome) => [outcome, new Set<string>()]));
  const possible = new Set<string>();
  for (const edge of compiled.outboundByNode[node.nodeId]) {
    for (const to of edge.to) possible.add(to);
    if (!isUnconditionalOutcomePredicate(edge.when)) continue;
    for (const outcome of predicateOutcomes(edge.when)) {
      for (const to of edge.to) guaranteed.get(outcome)!.add(to);
    }
  }
  // Every possible target must be guaranteed for every outcome. A conditional
  // extra successor is branching even if all outcomes mention that same target.
  return possible.size > 0 && [...guaranteed.values()].every((successors) =>
    successors.size === possible.size && [...possible].every((to) => successors.has(to))
  );
}

/**
 * Project this package instance's compileGraph result. CompiledGraph omits
 * description, so arbitrary copies cannot prove their graph digest; transport
 * the sealed GraphDefinition and compile it again instead. Rejection performs
 * no property reads on unrecognized input, including Proxies and accessors.
 *
 * Output is detached, deeply frozen JSON with prototype-free records. Nodes,
 * terminals, and joins retain authored order. This describes possible topology,
 * never runtime readiness, delivery, or a unit's observed path.
 */
export function projectGraphDisplay(compiled: CompiledGraph): GraphDisplayProjection {
  compiled = requireCompiledGraph(compiled);
  const depth = nodeDepths(compiled);
  interface Arrow {
    from: string;
    to: string;
    outcomes: string[];
    edgeIds: string[];
    conditional: boolean;
    fanOut: { edgeId: string; coTargets: string[]; outcomes: string[] }[];
  }
  const arrows = new Map<string, Arrow>();
  for (const edge of compiled.edges) {
    for (const to of edge.to) {
      const key = `${edge.from}\u0000${to}`;
      let arrow = arrows.get(key);
      if (arrow === undefined) {
        arrow = { from: edge.from, to, outcomes: [], edgeIds: [], conditional: false, fanOut: [] };
        arrows.set(key, arrow);
      }
      for (const outcome of predicateOutcomes(edge.when)) {
        if (!arrow.outcomes.includes(outcome)) arrow.outcomes.push(outcome);
      }
      arrow.edgeIds.push(edge.edgeId);
      arrow.conditional ||= !isUnconditionalOutcomePredicate(edge.when);
      if (edge.to.length > 1) {
        arrow.fanOut.push({
          edgeId: edge.edgeId,
          coTargets: edge.to.filter((target) => target !== to),
          outcomes: [...predicateOutcomes(edge.when)]
        });
      }
    }
  }
  const projection: GraphDisplayProjection = {
    schemaVersion: GRAPH_DISPLAY_SCHEMA_VERSION,
    graph: compiled.graph,
    entry: compiled.entry,
    nodes: compiled.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      ref: node.ref,
      input: node.input,
      outcomes: node.outcomes.outcomes,
      ...(Object.hasOwn(node, "outputs") ? { outputs: node.outputs } : {}),
      ...(Object.hasOwn(node, "binding") ? { binding: node.binding } : {}),
      ...(Object.hasOwn(node, "configuration") ? { configuration: node.configuration } : {}),
      ...(Object.hasOwn(node, "join") ? { join: node.join } : {}),
      maxAttempts: node.turn.maxAttempts,
      depth: depth.get(node.nodeId)!,
      marks: markingNode(compiled, node)
    })),
    arrows: [...arrows.values()],
    terminals: compiled.terminals,
    joins: compiled.nodes.filter((node) => Object.hasOwn(node, "join")).map((node) => ({
      nodeId: node.nodeId,
      require: node.join!.require,
      inbound: node.join!.inbound
    }))
  };
  return prototypeFree(deepFrozenClone(projection, "graph display projection"));
}

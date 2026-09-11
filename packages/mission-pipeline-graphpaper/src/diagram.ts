import type { DiagramEdge, DiagramModel, DiagramNode } from "graphpaper";
import type { GraphDisplayArrow } from "mission-pipeline/graph/display";
import { PIPELINE_DIAGRAM_SCHEMA_VERSION, type BuildPipelineDiagramInput, type PipelineDiagramMetadata } from "./types.js";
import { frozenData, prepareDiagramInput } from "./validation.js";

/** Retain readable IDs when available, without aliasing authored node names. */
function idAllocator(initial: readonly string[] = []): (preferred: string) => string {
  const used = new Set(initial);
  return (preferred) => {
    let id = preferred;
    for (let suffix = 1; used.has(id); suffix += 1) id = `${preferred}~${suffix}`;
    used.add(id);
    return id;
  };
}

function outcomeLabel(
  covered: readonly string[],
  declared: readonly string[],
  siblings: readonly (readonly string[])[],
  conditional: boolean
): string {
  if (!conditional && declared.length > 0 && declared.every((outcome) => covered.includes(outcome))) return "always";
  const joined = covered.join(" | ");
  if (covered.length <= 2 && joined.length <= 24) return joined;
  const taken = new Set(siblings.flat());
  const rest = declared.filter((outcome) => !taken.has(outcome));
  if (!conditional && rest.length === covered.length && rest.every((outcome) => covered.includes(outcome))) return "otherwise";
  if (covered.length <= 2) return joined;
  return `${covered.slice(0, 2).join(" | ")} +${covered.length - 2}`;
}

/**
 * Build a static, immutable graphpaper model. Structure comes from the engine;
 * presentation words and any external wait connections come from the caller.
 * No runtime execution, delivery, or readiness state is inferred here.
 */
export function buildPipelineDiagram(input: BuildPipelineDiagramInput): DiagramModel {
  const { projection, presentation, historical, unclaimed, presentationDigest } = prepareDiagramInput(input);
  const unitNoun = presentation.unitNoun ?? "unit";
  const unitArticle = /^[aeiou]/i.test(unitNoun) && unitNoun !== "unit" ? "an" : "a";
  const shown = (nodeId: string) => presentation.nodes[nodeId]!;
  const graphNodes = new Map(projection.nodes.map((node) => [node.nodeId, node]));
  const joins = new Map(projection.joins.map((join) => [join.nodeId, join]));
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const allocateNodeId = idAllocator(projection.nodes.map((node) => node.nodeId));
  const allocateEdgeId = idAllocator();
  const endpointIds = new Map(presentation.endpoints.map((endpoint) => [endpoint.id, allocateNodeId(`endpoint:${endpoint.id}`)]));
  const terminalIds = new Map(presentation.terminals.map((terminal) => [terminal.id, allocateNodeId(`terminal:${terminal.id}`)]));
  const unclaimedIds = unclaimed.map((terminal) => allocateNodeId(`terminal:${terminal.nodeId}-${terminal.outcome}`));

  for (const node of projection.nodes) {
    const words = shown(node.nodeId);
    const rank = node.depth + 1;
    const vocabulary = node.outcomes.join(" | ");
    const join = joins.get(node.nodeId);
    nodes.push({
      id: node.nodeId,
      type: node.kind,
      title: `${words.name} (${rank})`,
      ...(node.marks ? { visibleRows: 1 } : {}),
      ...(join === undefined ? {} : {
        badges: [{
          label: join.require === "all" ? "join · all" : `join · ${join.require.nOf} of ${join.inbound.length}`,
          tone: "info"
        }]
      }),
      ...(words.summary === undefined ? {} : { description: words.summary }),
      rows: [
        ...(node.marks ? [{ label: "marks", value: vocabulary }] : []),
        { label: "depth", value: String(rank) },
        ...(node.marks ? [] : [{ label: "outcomes", value: vocabulary }]),
        ...(words.model === undefined
          ? node.binding === undefined ? [] : [{ label: "binding", value: `${node.binding.bindingId}@${node.binding.version}` }]
          : [{ label: "model", value: words.model.name }]),
        ...(words.question === undefined ? [] : [{ label: "question", value: words.question }]),
        ...(words.rows ?? []),
        { label: "ref", value: `${node.ref.id}@${node.ref.version}` }
      ],
      metadata: {
        nodeId: node.nodeId,
        role: node.kind,
        kind: node.kind,
        rank,
        ...(node.marks ? { marks: [...node.outcomes] } : {}),
        ...(join === undefined ? {} : { join: { require: join.require, inbound: [...join.inbound] } })
      }
    });
  }

  const arrowsBySource = new Map<string, GraphDisplayArrow[]>();
  for (const arrow of projection.arrows) {
    let outbound = arrowsBySource.get(arrow.from);
    if (outbound === undefined) {
      outbound = [];
      arrowsBySource.set(arrow.from, outbound);
    }
    outbound.push(arrow);
  }
  const arrowsFrom = (nodeId: string): readonly GraphDisplayArrow[] => arrowsBySource.get(nodeId) ?? [];
  const exitsByNode = new Map<string, string[][]>();
  for (const terminal of projection.terminals) {
    const exits = exitsByNode.get(terminal.nodeId) ?? [];
    exits.push([terminal.outcome]);
    exitsByNode.set(terminal.nodeId, exits);
  }

  const forkClause = (arrow: GraphDisplayArrow): string => {
    const forks = new Map<string, { coTargets: readonly string[]; outcomes: string[]; edgesWithoutOutcomes: string[] }>();
    for (const fork of arrow.fanOut) {
      const key = JSON.stringify(fork.coTargets);
      let group = forks.get(key);
      if (group === undefined) {
        group = { coTargets: fork.coTargets, outcomes: [], edgesWithoutOutcomes: [] };
        forks.set(key, group);
      }
      if (fork.outcomes === undefined) group.edgesWithoutOutcomes.push(fork.edgeId);
      else for (const outcome of fork.outcomes) if (!group.outcomes.includes(outcome)) group.outcomes.push(outcome);
    }
    return [...forks.values()].map((fork) => {
      const names = fork.coTargets.map((nodeId) => `the ${shown(nodeId).name}`).join(" and ");
      let clause = "";
      if (fork.outcomes.length > 0) {
        clause = fork.outcomes.length < arrow.outcomes.length
          ? `, and on ${fork.outcomes.join(" or ")} the same ${unitNoun} also goes to ${names}`
          : `, and the same ${unitNoun} also goes to ${names}`;
      }
      if (fork.edgesWithoutOutcomes.length > 0) {
        clause += `; contributing ${fork.edgesWithoutOutcomes.length === 1 ? "edge" : "edges"} ${fork.edgesWithoutOutcomes.join(", ")} also ${fork.edgesWithoutOutcomes.length === 1 ? "targets" : "target"} ${names}`;
      }
      return clause;
    }).join("");
  };

  for (const arrow of projection.arrows) {
    const node = graphNodes.get(arrow.from)!;
    const declared = node.outcomes;
    const covered = [...arrow.outcomes].sort((left, right) => declared.indexOf(left) - declared.indexOf(right));
    const key = `${arrow.from}->${arrow.to}`;
    const siblings = [
      ...arrowsFrom(arrow.from).filter((other) => other !== arrow).map((other) => other.outcomes),
      ...(exitsByNode.get(arrow.from) ?? [])
    ];
    const join = joins.get(arrow.to);
    const joinsInbound = join !== undefined && arrow.edgeIds.some((edgeId) => join.inbound.includes(edgeId));
    const appendArrow = (id: string, outcomes: readonly string[], label: string, note?: string): void => {
      const description = note ?? `${shown(arrow.from).name} settles ${label === "always" && !arrow.conditional ? "any outcome" : outcomes.join(" or ")} → ${shown(arrow.to).name}`
        + (node.marks ? `; the mark rides along in the ${unitNoun} record` : "")
        + forkClause(arrow);
      edges.push({
        id: allocateEdgeId(id),
        from: arrow.from,
        to: arrow.to,
        type: joinsInbound ? "join" : "outcome",
        label,
        description: description + (arrow.conditional ? "; conditional routing: a contributing edge also requires its predicate" : "")
      });
    };
    const groups = presentation.arrows?.[key];
    if (groups !== undefined) {
      for (const group of groups) {
        appendArrow(
          groups.length === 1 ? key : `${key}:${group.outcomes[0]}`,
          group.outcomes,
          group.label ?? outcomeLabel(group.outcomes, declared, siblings, arrow.conditional),
          group.note
        );
      }
    } else if (declared.every((outcome) => covered.includes(outcome)) && declared.length <= 3 && arrowsFrom(arrow.from).length === 1) {
      for (const outcome of declared) appendArrow(`${key}:${outcome}`, [outcome], outcome);
    } else {
      appendArrow(key, covered, outcomeLabel(covered, declared, siblings, arrow.conditional));
    }
  }

  const exitEdge = (from: string, to: string, outcome: string, description: string): void => {
    edges.push({ id: allocateEdgeId(`${from}->${to}`), from, to, type: "exit", label: outcome, description });
  };
  for (const endpoint of presentation.endpoints) {
    const id = endpointIds.get(endpoint.id)!;
    for (const exit of endpoint.exits) {
      exitEdge(exit.nodeId, id, exit.outcome, `${shown(exit.nodeId).name} settles ${exit.outcome} → ${endpoint.name}${endpoint.via === undefined ? "" : ` (${endpoint.via})`}`);
    }
  }
  for (const endpoint of presentation.endpoints) {
    const id = endpointIds.get(endpoint.id)!;
    for (const from of endpoint.waits ?? []) {
      // An explicit exit already connects this source to the endpoint.
      if (endpoint.exits.some((exit) => exit.nodeId === from)) continue;
      edges.push({
        id: allocateEdgeId(`${from}->${id}`),
        from,
        to: id,
        type: "exit",
        label: "flag for a person",
        description: `${shown(from).name} queues a bounded decision → ${endpoint.name}${endpoint.via === undefined ? "" : ` (${endpoint.via})`}`
      });
    }
  }
  for (const terminal of presentation.terminals) {
    for (const end of terminal.ends) {
      exitEdge(end.nodeId, terminalIds.get(terminal.id)!, end.outcome, `${shown(end.nodeId).name} settles ${end.outcome} → ${terminal.name}${terminal.summary === undefined ? "" : `: ${terminal.summary}`}`);
    }
  }
  for (let index = 0; index < unclaimed.length; index += 1) {
    const terminal = unclaimed[index]!;
    exitEdge(terminal.nodeId, unclaimedIds[index]!, terminal.outcome, `${shown(terminal.nodeId).name} settles ${terminal.outcome} (unpresented terminal)`);
  }

  for (const endpoint of presentation.endpoints) {
    const fromNodeIds = [...new Set([...endpoint.exits.map((exit) => exit.nodeId), ...(endpoint.waits ?? [])])];
    nodes.push({
      id: endpointIds.get(endpoint.id)!,
      type: "endpoint",
      title: endpoint.name,
      ...(endpoint.system === undefined ? {} : { subtitle: endpoint.system }),
      ...(endpoint.summary === undefined ? {} : { description: endpoint.summary }),
      rows: [
        ...(endpoint.kind === undefined ? [] : [{ label: "kind", value: endpoint.kind }]),
        { label: "fed by", value: fromNodeIds.map((nodeId) => shown(nodeId).name).join(", ") },
        ...(endpoint.rows ?? []),
        ...(endpoint.via === undefined ? [] : [{ label: "via", value: endpoint.via }])
      ],
      metadata: {
        endpointId: endpoint.id,
        sink: "endpoint",
        ...(endpoint.outboxEventTypes === undefined ? {} : { outboxEventTypes: [...endpoint.outboxEventTypes] })
      }
    });
  }
  for (const terminal of presentation.terminals) {
    nodes.push({
      id: terminalIds.get(terminal.id)!,
      type: "terminal",
      title: terminal.name,
      subtitle: "ends here",
      ...(terminal.summary === undefined ? {} : { description: terminal.summary }),
      rows: [{ label: "ends", value: terminal.ends.map((end) => `${shown(end.nodeId).name}: ${end.outcome}`).join(", ") }],
      metadata: { terminalId: terminal.id, sink: "terminal", ends: terminal.ends.map((end) => `${end.nodeId}:${end.outcome}`) }
    });
  }
  for (let index = 0; index < unclaimed.length; index += 1) {
    const terminal = unclaimed[index]!;
    nodes.push({
      id: unclaimedIds[index]!,
      type: "terminal",
      title: `${shown(terminal.nodeId).name}: ${terminal.outcome}`,
      subtitle: "unpresented terminal",
      description: "The graph declares this terminal but the presentation table does not name it yet.",
      metadata: { sink: "terminal", unpresented: true, ends: [`${terminal.nodeId}:${terminal.outcome}`] }
    });
  }

  return frozenData({
    id: presentation.id ?? projection.graph.id,
    title: `${presentation.title} · ${projection.graph.id} v${projection.graph.version}`,
    kind: "process",
    description: presentation.description ?? `${presentation.subtitle ?? ""} Each arrow carries the decision that takes ${unitArticle} ${unitNoun} down it; dashed exits are where its journey ends.`,
    nodes,
    edges,
    ...(historical ? { lifecycle: { state: "historical", label: "Historical" } } : {}),
    metadata: {
      graphId: projection.graph.id,
      graphVersion: projection.graph.version,
      graphDigest: projection.graph.digest,
      publication: presentation.publication ?? "source",
      highlighted: false,
      // Legacy display strings; all identity checks use structured pairs.
      unclaimedTerminals: unclaimed.map((terminal) => `${terminal.nodeId}:${terminal.outcome}`),
      pipeline: {
        schemaVersion: PIPELINE_DIAGRAM_SCHEMA_VERSION,
        graph: projection.graph,
        mode: "static",
        presentationDigest,
        unclaimedTerminals: unclaimed
      } satisfies PipelineDiagramMetadata
    }
  });
}

// graph/diff.ts — identity-based structural differences between sealed graphs.
//
// Promoted from Inbox's graphProposalDiff: the engine owns comparison, while
// consumers own labels and formatting. Both source seals travel with the diff;
// no current registry, presentation, or executable capability is consulted.

import { canonicalJson } from "../contracts/digest.js";
import {
  validateGraphDefinition,
  type SwitchyardNode,
  type TerminalOutcome
} from "./definition.js";
import { predicateOutcomes, type Edge } from "./edge.js";

export type GraphChangeKind = "added" | "removed" | "changed";

/** Machine field path and canonical JSON values; `undefined` means absent. */
export interface GraphFieldChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface GraphNodeDiff {
  readonly nodeId: string;
  readonly change: GraphChangeKind;
  readonly outcomesAdded: readonly string[];
  readonly outcomesRemoved: readonly string[];
  readonly fields: readonly GraphFieldChange[];
}

export interface GraphEdgeDiff {
  readonly edgeId: string;
  readonly change: GraphChangeKind;
  /** Candidate endpoints for changed/added edges, source endpoints for removed edges. */
  readonly from: string;
  readonly to: readonly string[];
  readonly outcomesAdded: readonly string[];
  readonly outcomesRemoved: readonly string[];
  readonly fields: readonly GraphFieldChange[];
}

export interface GraphTerminalDiff {
  readonly nodeId: string;
  readonly outcome: string;
  readonly change: "added" | "removed";
}

export interface GraphDefinitionDiff {
  readonly schemaVersion: "switchyard-graph-definition-diff.v1";
  readonly sealed: Readonly<{ graphId: string; version: number; digest: string }>;
  readonly candidate: Readonly<{ graphId: string; version: number; digest: string }>;
  readonly sameFamily: boolean;
  readonly description: GraphFieldChange | null;
  readonly entry: GraphFieldChange | null;
  readonly nodes: readonly GraphNodeDiff[];
  readonly edges: readonly GraphEdgeDiff[];
  readonly terminals: readonly GraphTerminalDiff[];
  readonly unchanged: Readonly<{ nodes: number; edges: number; terminals: number }>;
  /** No structural changes; graph identity/version/digest alone do not affect this flag. */
  readonly empty: boolean;
}

/** Only called with engine-constructed records and already-detached values. */
function frozenRecord<T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, value));
}

/** Validated optional keys must never consult the ambient object prototype. */
function own<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function terminalKey(terminal: TerminalOutcome): string {
  return `${terminal.nodeId}\u0000${terminal.outcome}`;
}

function missing(from: readonly string[], to: readonly string[]): readonly string[] {
  const held = new Set(to);
  return Object.freeze(from.filter((value) => !held.has(value)));
}

function fieldChange(field: string, from: unknown, to: unknown): GraphFieldChange | null {
  const before = from === undefined ? "undefined" : canonicalJson(from);
  const after = to === undefined ? "undefined" : canonicalJson(to);
  return before === after ? null : frozenRecord({ field, from: before, to: after });
}

function nodeFields(sealed: SwitchyardNode, candidate: SwitchyardNode): readonly GraphFieldChange[] {
  const beforeBinding = own(sealed, "binding");
  const afterBinding = own(candidate, "binding");
  return Object.freeze([
    fieldChange("ref", sealed.ref, candidate.ref),
    fieldChange("kind", sealed.kind, candidate.kind),
    fieldChange("input", sealed.input, candidate.input),
    fieldChange("principal.id", sealed.principal.id, candidate.principal.id),
    fieldChange("outcomes.version", sealed.outcomes.version, candidate.outcomes.version),
    fieldChange("outputs", own(sealed, "outputs"), own(candidate, "outputs")),
    fieldChange("binding.bindingId", beforeBinding?.bindingId, afterBinding?.bindingId),
    fieldChange("binding.version", beforeBinding?.version, afterBinding?.version),
    fieldChange("binding.bindingDigest", beforeBinding?.bindingDigest, afterBinding?.bindingDigest),
    fieldChange("configuration", own(sealed, "configuration"), own(candidate, "configuration")),
    fieldChange("turn.leaseMs", sealed.turn.leaseMs, candidate.turn.leaseMs),
    fieldChange("turn.maxAttempts", sealed.turn.maxAttempts, candidate.turn.maxAttempts),
    fieldChange("turn.idempotency", sealed.turn.idempotency, candidate.turn.idempotency),
    fieldChange("turn.retryTaxonomy", sealed.turn.retryTaxonomy, candidate.turn.retryTaxonomy),
    fieldChange("join", own(sealed, "join"), own(candidate, "join"))
  ].filter((change): change is GraphFieldChange => change !== null));
}

function edgeFields(sealed: Edge, candidate: Edge): readonly GraphFieldChange[] {
  return Object.freeze([
    fieldChange("from", sealed.from, candidate.from),
    fieldChange("to", sealed.to, candidate.to),
    // Preserve predicate shape: {outcome} and one-outcome {anyOf} differ even
    // though both predicates currently mention the same outcome.
    fieldChange("when", sealed.when, candidate.when)
  ].filter((change): change is GraphFieldChange => change !== null));
}

/**
 * Compare two data-valid, digest-sealed graph definitions by node ID, edge ID,
 * and terminal pair. Top-level collection order and node-outcome order do not
 * produce changes; edge target, predicate, and join arrays remain structural.
 * Outcome additions/removals keep their respective source's authored order.
 *
 * Definition validation rejects hostile input and altered seals. Compilation
 * is deliberately separate: a sealed candidate may still need coverage or
 * reachability repairs that a proposal viewer should be able to inspect.
 */
export function graphDefinitionDiff(sealedRaw: unknown, candidateRaw: unknown): GraphDefinitionDiff {
  const sealed = validateGraphDefinition(sealedRaw);
  const candidate = validateGraphDefinition(candidateRaw);
  const sealedNodes = new Map(sealed.nodes.map((node) => [node.nodeId, node]));
  const candidateNodes = new Map(candidate.nodes.map((node) => [node.nodeId, node]));
  const nodes: GraphNodeDiff[] = [];
  let unchangedNodes = 0;
  for (const nodeId of [...new Set([...sealedNodes.keys(), ...candidateNodes.keys()])].sort()) {
    const before = sealedNodes.get(nodeId);
    const after = candidateNodes.get(nodeId);
    if (before === undefined && after !== undefined) {
      nodes.push(frozenRecord({
        nodeId, change: "added" as const,
        outcomesAdded: Object.freeze([...after.outcomes.outcomes]),
        outcomesRemoved: Object.freeze([]), fields: Object.freeze([])
      }));
    } else if (before !== undefined && after === undefined) {
      nodes.push(frozenRecord({
        nodeId, change: "removed" as const,
        outcomesAdded: Object.freeze([]),
        outcomesRemoved: Object.freeze([...before.outcomes.outcomes]), fields: Object.freeze([])
      }));
    } else if (before !== undefined && after !== undefined) {
      const outcomesAdded = missing(after.outcomes.outcomes, before.outcomes.outcomes);
      const outcomesRemoved = missing(before.outcomes.outcomes, after.outcomes.outcomes);
      const fields = nodeFields(before, after);
      if (outcomesAdded.length === 0 && outcomesRemoved.length === 0 && fields.length === 0) {
        unchangedNodes += 1;
      } else {
        nodes.push(frozenRecord({ nodeId, change: "changed" as const, outcomesAdded, outcomesRemoved, fields }));
      }
    }
  }

  const sealedEdges = new Map(sealed.edges.map((edge) => [edge.edgeId, edge]));
  const candidateEdges = new Map(candidate.edges.map((edge) => [edge.edgeId, edge]));
  const edges: GraphEdgeDiff[] = [];
  let unchangedEdges = 0;
  for (const edgeId of [...new Set([...sealedEdges.keys(), ...candidateEdges.keys()])].sort()) {
    const before = sealedEdges.get(edgeId);
    const after = candidateEdges.get(edgeId);
    if (before === undefined && after !== undefined) {
      edges.push(frozenRecord({
        edgeId, change: "added" as const, from: after.from, to: Object.freeze([...after.to]),
        outcomesAdded: Object.freeze([...predicateOutcomes(after.when)]),
        outcomesRemoved: Object.freeze([]), fields: Object.freeze([])
      }));
    } else if (before !== undefined && after === undefined) {
      edges.push(frozenRecord({
        edgeId, change: "removed" as const, from: before.from, to: Object.freeze([...before.to]),
        outcomesAdded: Object.freeze([]),
        outcomesRemoved: Object.freeze([...predicateOutcomes(before.when)]), fields: Object.freeze([])
      }));
    } else if (before !== undefined && after !== undefined) {
      const outcomesAdded = missing(predicateOutcomes(after.when), predicateOutcomes(before.when));
      const outcomesRemoved = missing(predicateOutcomes(before.when), predicateOutcomes(after.when));
      const fields = edgeFields(before, after);
      if (outcomesAdded.length === 0 && outcomesRemoved.length === 0 && fields.length === 0) {
        unchangedEdges += 1;
      } else {
        edges.push(frozenRecord({
          edgeId, change: "changed" as const, from: after.from, to: Object.freeze([...after.to]),
          outcomesAdded, outcomesRemoved, fields
        }));
      }
    }
  }

  const sealedTerminals = new Map(sealed.terminals.map((terminal) => [terminalKey(terminal), terminal]));
  const candidateTerminals = new Map(candidate.terminals.map((terminal) => [terminalKey(terminal), terminal]));
  const terminals: GraphTerminalDiff[] = [];
  let unchangedTerminals = 0;
  for (const key of [...new Set([...sealedTerminals.keys(), ...candidateTerminals.keys()])].sort()) {
    const before = sealedTerminals.get(key);
    const after = candidateTerminals.get(key);
    if (before !== undefined && after !== undefined) {
      unchangedTerminals += 1;
      continue;
    }
    const terminal = after ?? before;
    if (terminal !== undefined) {
      terminals.push(frozenRecord({
        nodeId: terminal.nodeId, outcome: terminal.outcome,
        change: after === undefined ? "removed" as const : "added" as const
      }));
    }
  }

  const description = fieldChange("description", sealed.description, candidate.description);
  const entry = fieldChange("entry", sealed.entry, candidate.entry);
  return frozenRecord({
    schemaVersion: "switchyard-graph-definition-diff.v1" as const,
    sealed: frozenRecord({ graphId: sealed.graphId, version: sealed.version, digest: sealed.graphDigest }),
    candidate: frozenRecord({ graphId: candidate.graphId, version: candidate.version, digest: candidate.graphDigest }),
    sameFamily: sealed.graphId === candidate.graphId,
    description, entry,
    nodes: Object.freeze(nodes), edges: Object.freeze(edges), terminals: Object.freeze(terminals),
    unchanged: frozenRecord({ nodes: unchangedNodes, edges: unchangedEdges, terminals: unchangedTerminals }),
    empty: nodes.length === 0 && edges.length === 0 && terminals.length === 0
      && description === null && entry === null
  });
}

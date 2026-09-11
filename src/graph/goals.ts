// graph/goals.ts — a non-executable goal manifest validated against a sealed graph.
//
// A goal is one logical objective made of member nodes. A unit enters it at
// one member, runs through it as one thread, and leaves it exactly once
// through a declared resolution: `resolved` when the members decided by
// themselves, `escalated` when they handed the decision to something outside
// the goal, usually a person. The engine has nodes, edges, terminals, and
// joins; it has no goal concept and never reads this document. The manifest
// is companion evidence: it pins the exact graph it describes, carries its own
// digest, and moves no graph digest.
//
// Validation is structural and fail-closed. From the compiled graph alone it
// proves that every unit entering a goal closes it exactly once: members are
// disjoint across goals; the goal is entered only at its entry; every member
// outcome either stays inside, to exactly one member, or closes the goal, to
// outside nodes or a graph terminal; the member subgraph is acyclic; and no
// path after a resolution returns to the goal. A goal that fans out inside
// itself is refused, because one unit at two members could close twice.

import { digest } from "../contracts/digest.js";
import { deepFrozenClone } from "../internal/evidence.js";
import {
  assertEnum,
  assertIdentifier,
  assertPlainObject,
  assertRequiredKeys,
  assertSafePositiveInt,
  assertSha256Hex,
  assertStrictKeys,
  typeName
} from "../internal/guards.js";
import { compileGraph, type CompiledGraph } from "./compile.js";
import { MAX_GRAPH_NODES, type GraphDefinitionRef } from "./definition.js";
import { predicateOutcomes } from "./edge.js";
import { snapshotGraphValidationData } from "./limits.js";

export const GOAL_MANIFEST_SCHEMA_VERSION = "mission-pipeline-goal-manifest.v1" as const;
export const GOAL_RESOLUTION_KINDS = ["resolved", "escalated"] as const;
export type GoalResolutionKind = (typeof GOAL_RESOLUTION_KINDS)[number];

/** Members are disjoint and non-empty, so a graph holds at most one goal per node. */
export const MAX_GOAL_MANIFEST_GOALS = MAX_GRAPH_NODES;
export const MAX_GOAL_MEMBERS = MAX_GRAPH_NODES;
export const MAX_GOAL_RESOLUTIONS = 1_024;

/** One (member, outcome) pair that closes the goal. */
export interface GoalResolution {
  readonly nodeId: string;
  readonly outcome: string;
  readonly kind: GoalResolutionKind;
}

export interface GoalDefinition {
  readonly goalId: string;
  /** The only member a unit may enter the goal at. */
  readonly entry: string;
  /** Member node ids in authored order; disjoint across goals. */
  readonly members: readonly string[];
  readonly resolutions: readonly GoalResolution[];
}

export interface GoalManifestDraft {
  readonly schemaVersion: typeof GOAL_MANIFEST_SCHEMA_VERSION;
  readonly goals: readonly GoalDefinition[];
}

export interface GoalManifest extends GoalManifestDraft {
  /** The exact sealed graph this manifest describes. */
  readonly graph: GraphDefinitionRef;
  /** Canonical-JSON SHA-256 of `{ schemaVersion, graph, goals }`. */
  readonly manifestDigest: string;
}

const DRAFT_KEYS = new Set(["schemaVersion", "goals"]);
const MANIFEST_KEYS = new Set([...DRAFT_KEYS, "graph", "manifestDigest"]);
const GOAL_KEYS = new Set(["goalId", "entry", "members", "resolutions"]);
const RESOLUTION_KEYS = new Set(["nodeId", "outcome", "kind"]);
const GRAPH_REF_KEYS = new Set(["id", "version", "digest"]);

function pairKey(nodeId: string, outcome: string): string {
  return `${nodeId}\u0000${outcome}`;
}

function pairLabel(nodeId: string, outcome: string): string {
  return `${nodeId}:${outcome}`;
}

function assertBoundedArray(value: unknown, min: number, max: number, label: string, noun: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(
      `${label}: must be an array of ${min}..${max} ${noun} (got ${Array.isArray(value) ? value.length : typeName(value)})`
    );
  }
  return value;
}

function validateResolution(value: unknown, label: string): GoalResolution {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, RESOLUTION_KEYS, label);
  assertRequiredKeys(raw, RESOLUTION_KEYS, label);
  return {
    nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
    outcome: assertIdentifier(raw.outcome, `${label}.outcome`),
    kind: assertEnum(raw.kind, GOAL_RESOLUTION_KINDS, `${label}.kind`)
  };
}

function validateGoal(value: unknown, label: string): GoalDefinition {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, GOAL_KEYS, label);
  assertRequiredKeys(raw, GOAL_KEYS, label);
  const goalId = assertIdentifier(raw.goalId, `${label}.goalId`);
  const entry = assertIdentifier(raw.entry, `${label}.entry`);
  const members = assertBoundedArray(raw.members, 1, MAX_GOAL_MEMBERS, `${label}.members`, "node ids")
    .map((member, index) => assertIdentifier(member, `${label}.members[${index}]`));
  if (new Set(members).size !== members.length) {
    throw new Error(`${label}.members: node ids must be unique`);
  }
  const resolutions = assertBoundedArray(raw.resolutions, 1, MAX_GOAL_RESOLUTIONS, `${label}.resolutions`, "resolutions")
    .map((resolution, index) => validateResolution(resolution, `${label}.resolutions[${index}]`));
  const keys = resolutions.map((resolution) => pairKey(resolution.nodeId, resolution.outcome));
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label}.resolutions: node/outcome pairs must be unique`);
  }
  return { goalId, entry, members, resolutions };
}

function validateGoals(value: unknown, label: string): readonly GoalDefinition[] {
  const goals = assertBoundedArray(value, 1, MAX_GOAL_MANIFEST_GOALS, `${label}: goals`, "goals")
    .map((goal, index) => validateGoal(goal, `${label}: goals[${index}]`));
  if (new Set(goals.map((goal) => goal.goalId)).size !== goals.length) {
    throw new Error(`${label}: goal IDs must be unique`);
  }
  return goals;
}

function validateGraphRef(value: unknown, label: string): GraphDefinitionRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, GRAPH_REF_KEYS, label);
  assertRequiredKeys(raw, GRAPH_REF_KEYS, label);
  return {
    id: assertIdentifier(raw.id, `${label}.id`),
    version: assertSafePositiveInt(raw.version, `${label}.version`),
    digest: assertSha256Hex(raw.digest, `${label}.digest`)
  };
}

function validateSchemaVersion(value: unknown, label: string): typeof GOAL_MANIFEST_SCHEMA_VERSION {
  if (value !== GOAL_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `${label}: schemaVersion must be ${JSON.stringify(GOAL_MANIFEST_SCHEMA_VERSION)} (got ${typeof value === "string" ? JSON.stringify(value) : typeName(value)})`
    );
  }
  return GOAL_MANIFEST_SCHEMA_VERSION;
}

function manifestDigest(manifest: Omit<GoalManifest, "manifestDigest">): string {
  return digest({ schemaVersion: manifest.schemaVersion, graph: manifest.graph, goals: manifest.goals });
}

/**
 * Validate a sealed manifest document on its own: strict shape, identifier
 * grammar, and a recomputed digest. This proves the document is unchanged
 * since it was sealed, not that it describes any graph; use
 * `validateGoalManifest` with the graph definition for that.
 */
export function validateGoalManifestDocument(value: unknown): GoalManifest {
  const label = "goal manifest";
  value = snapshotGraphValidationData(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, MANIFEST_KEYS, label);
  assertRequiredKeys(raw, MANIFEST_KEYS, label);
  const base = {
    schemaVersion: validateSchemaVersion(raw.schemaVersion, label),
    graph: validateGraphRef(raw.graph, `${label}: graph`),
    goals: validateGoals(raw.goals, label)
  };
  const sealed = assertSha256Hex(raw.manifestDigest, `${label}: manifestDigest`);
  const computed = manifestDigest(base);
  if (sealed !== computed) {
    throw new Error(`${label}: manifestDigest mismatch — sealed ${sealed} != computed ${computed}`);
  }
  return deepFrozenClone({ ...base, manifestDigest: sealed }, label);
}

interface Arc {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
}

/** Every (edge, target) pair leaving a node, in authored edge and target order. */
function arcsFrom(compiled: CompiledGraph, nodeId: string): readonly Arc[] {
  const arcs: Arc[] = [];
  for (const edge of compiled.outboundByNode[nodeId] ?? []) {
    for (const to of edge.to) arcs.push({ edgeId: edge.edgeId, from: edge.from, to });
  }
  return arcs;
}

/** Arcs leaving a node for one outcome; conditional arms count, since they may fire. */
function arcsForOutcome(compiled: CompiledGraph, nodeId: string, outcome: string): readonly Arc[] {
  const arcs: Arc[] = [];
  for (const edge of compiled.outboundByNode[nodeId] ?? []) {
    if (!predicateOutcomes(edge.when).includes(outcome)) continue;
    for (const to of edge.to) arcs.push({ edgeId: edge.edgeId, from: edge.from, to });
  }
  return arcs;
}

function checkGoal(compiled: CompiledGraph, goal: GoalDefinition, label: string): void {
  const inside = new Set(goal.members);
  const resolutionByPair = new Map<string, GoalResolution>();
  for (const resolution of goal.resolutions) {
    const shown = pairLabel(resolution.nodeId, resolution.outcome);
    if (!inside.has(resolution.nodeId)) {
      throw new Error(`${label}: resolution ${shown} names a node that is not a member`);
    }
    const node = compiled.nodesById[resolution.nodeId]!;
    if (!node.outcomes.outcomes.includes(resolution.outcome)) {
      throw new Error(`${label}: resolution ${shown} is not a declared outcome of ${resolution.nodeId}`);
    }
    resolutionByPair.set(pairKey(resolution.nodeId, resolution.outcome), resolution);
  }
  if (!inside.has(goal.entry)) {
    throw new Error(`${label}: entry ${goal.entry} is not a member`);
  }

  // One way in: admission and every edge from outside land on the entry.
  if (inside.has(compiled.entry) && compiled.entry !== goal.entry) {
    throw new Error(
      `${label}: graph entry ${compiled.entry} is a member, so it must be the goal entry (got ${goal.entry})`
    );
  }
  for (const member of goal.members) {
    if (member === goal.entry) continue;
    for (const edge of compiled.inboundByNode[member] ?? []) {
      if (inside.has(edge.from)) continue;
      throw new Error(
        `${label}: edge ${edge.edgeId} enters member ${member} from ${edge.from} outside the goal; a goal is entered only at its entry ${goal.entry}`
      );
    }
  }

  // Every member outcome either continues inside, to exactly one member, or
  // closes the goal through a declared resolution. The compiler already
  // proved each outcome is routed or terminal, never both.
  const insideArcs: Arc[] = [];
  const exits: Arc[] = [];
  const terminalPairs = new Set(
    compiled.terminals.map((terminal) => pairKey(terminal.nodeId, terminal.outcome))
  );
  for (const member of goal.members) {
    const node = compiled.nodesById[member]!;
    for (const outcome of node.outcomes.outcomes) {
      const shown = pairLabel(member, outcome);
      const arcs = arcsForOutcome(compiled, member, outcome);
      const resolution = resolutionByPair.get(pairKey(member, outcome));
      if (resolution !== undefined) {
        for (const arc of arcs) {
          if (inside.has(arc.to)) {
            throw new Error(
              `${label}: resolution ${shown} continues inside the goal by edge ${arc.edgeId} to member ${arc.to}`
            );
          }
          exits.push(arc);
        }
        continue;
      }
      if (terminalPairs.has(pairKey(member, outcome))) {
        throw new Error(`${label}: member outcome ${shown} is a graph terminal but not a declared resolution`);
      }
      for (const arc of arcs) {
        if (!inside.has(arc.to)) {
          throw new Error(
            `${label}: member outcome ${shown} leaves the goal by edge ${arc.edgeId} to ${arc.to} without a declared resolution`
          );
        }
      }
      const targets = [...new Set(arcs.map((arc) => arc.to))];
      if (targets.length > 1) {
        throw new Error(
          `${label}: member outcome ${shown} fans out inside the goal to ${targets.join(", ")}; a goal runs as one thread`
        );
      }
      for (const arc of arcs) insideArcs.push(arc);
    }
  }

  // The member subgraph is acyclic and every member is reachable from the entry.
  const state = new Map<string, "active" | "done">();
  const stack: { readonly nodeId: string; readonly arcs: readonly Arc[]; next: number }[] = [
    { nodeId: goal.entry, arcs: insideArcs.filter((arc) => arc.from === goal.entry), next: 0 }
  ];
  state.set(goal.entry, "active");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.next >= frame.arcs.length) {
      state.set(frame.nodeId, "done");
      stack.pop();
      continue;
    }
    const arc = frame.arcs[frame.next]!;
    frame.next += 1;
    const seen = state.get(arc.to);
    if (seen === "active") {
      throw new Error(`${label}: edge ${arc.edgeId} from ${arc.from} to ${arc.to} closes a cycle inside the goal`);
    }
    if (seen === "done") continue;
    state.set(arc.to, "active");
    stack.push({ nodeId: arc.to, arcs: insideArcs.filter((candidate) => candidate.from === arc.to), next: 0 });
  }
  for (const member of goal.members) {
    if (!state.has(member)) {
      throw new Error(`${label}: member ${member} is not reachable from entry ${goal.entry} inside the goal`);
    }
  }

  // Closing is final: nothing reachable from a resolution exit re-enters the goal.
  const visited = new Set<string>();
  const pending = exits.map((arc) => arc.to);
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const arc of arcsFrom(compiled, nodeId)) {
      if (inside.has(arc.to)) {
        throw new Error(
          `${label}: the goal can be re-entered after closing: edge ${arc.edgeId} from ${arc.from} reaches member ${arc.to}`
        );
      }
      pending.push(arc.to);
    }
  }

  for (const kind of GOAL_RESOLUTION_KINDS) {
    if (!goal.resolutions.some((resolution) => resolution.kind === kind)) {
      throw new Error(`${label}: declares no ${kind} resolution`);
    }
  }
}

function checkGoals(compiled: CompiledGraph, goals: readonly GoalDefinition[], label: string): void {
  const membership = new Map<string, string>();
  goals.forEach((goal, index) => {
    const goalLabel = `${label}: goals[${index}] (${goal.goalId})`;
    for (const member of goal.members) {
      if (compiled.nodesById[member] === undefined) {
        throw new Error(
          `${goalLabel}: member ${member} is not a node of ${compiled.graph.id}@${compiled.graph.version}`
        );
      }
      const owner = membership.get(member);
      if (owner !== undefined) {
        throw new Error(`${goalLabel}: member ${member} already belongs to goal ${owner}`);
      }
      membership.set(member, goal.goalId);
    }
  });
  goals.forEach((goal, index) => {
    checkGoal(compiled, goal, `${label}: goals[${index}] (${goal.goalId})`);
  });
}

/**
 * Validate a draft against a sealed graph definition and seal it. The graph
 * ref is taken from the definition, so a manifest can never name a graph it
 * was not checked against; re-seal the same draft whenever the graph digest
 * moves.
 */
export function createGoalManifest(definitionRaw: unknown, draftRaw: unknown): GoalManifest {
  const label = "goal manifest";
  const compiled = compileGraph(definitionRaw);
  const draft = snapshotGraphValidationData(draftRaw, label);
  const raw = assertPlainObject(draft, label);
  assertStrictKeys(raw, DRAFT_KEYS, label);
  assertRequiredKeys(raw, DRAFT_KEYS, label);
  const base = {
    schemaVersion: validateSchemaVersion(raw.schemaVersion, label),
    graph: compiled.graph,
    goals: validateGoals(raw.goals, label)
  };
  checkGoals(compiled, base.goals, label);
  return deepFrozenClone({ ...base, manifestDigest: manifestDigest(base) }, label);
}

/**
 * Validate a sealed manifest against the sealed graph it claims to describe:
 * the document check, exact graph identity (id, version, digest), and every
 * structural rule. Compilation is the compiler's, so a tampered definition
 * fails here as it would at publication.
 */
export function validateGoalManifest(definitionRaw: unknown, manifestRaw: unknown): GoalManifest {
  const label = "goal manifest";
  const compiled = compileGraph(definitionRaw);
  const manifest = validateGoalManifestDocument(manifestRaw);
  const claimed = manifest.graph;
  const actual = compiled.graph;
  if (claimed.id !== actual.id || claimed.version !== actual.version || claimed.digest !== actual.digest) {
    throw new Error(
      `${label}: graph mismatch — manifest describes ${claimed.id}@${claimed.version} ${claimed.digest}, definition is ${actual.id}@${actual.version} ${actual.digest}`
    );
  }
  checkGoals(compiled, manifest.goals, label);
  return manifest;
}

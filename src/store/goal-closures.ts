// store/goal-closures.ts — how one unit fared against a goal manifest.
//
// A goal manifest (graph/goals) proves statically that a unit entering a goal
// closes it exactly once. This projection reports what one unit actually did,
// from its unit-path projection alone: which goals it never entered, which it
// is still inside, which ended in a dead letter, and which resolution closed
// the rest, with the turns and model usage spent inside each goal. It is the
// evaluation harness's counting primitive and the frontend's goal overlay.
//
// It fails closed on identity: the manifest must be a sealed document, and it
// must describe the exact graph (id, version, digest) the unit ran on. It does
// not re-validate the manifest against the graph; do that once at publication
// with `validateGoalManifest`.

import type { GraphDefinitionRef } from "../graph/definition.js";
import {
  validateGoalManifestDocument,
  type GoalManifest,
  type GoalResolution
} from "../graph/goals.js";
import { typeName } from "../internal/guards.js";
import {
  UNIT_PATH_SCHEMA_VERSION,
  type UnitPathJoin,
  type UnitPathNode,
  type UnitPathProjection,
  type UnitPathUsage
} from "./unit-path.js";

export const GOAL_CLOSURES_SCHEMA_VERSION = "switchyard-goal-closures.v1" as const;

export type GoalClosureStatus = "unentered" | "open" | "dead" | "closed";

export interface GoalClosure {
  readonly goalId: string;
  readonly status: GoalClosureStatus;
  /** The resolution that closed the goal; present exactly when `status` is `closed`. */
  readonly resolution?: GoalResolution;
  /** Members with a queued occurrence that has not settled or died. */
  readonly openMembers: readonly string[];
  /** Members whose occurrence was dead-lettered. */
  readonly deadMembers: readonly string[];
  /** Attempts made at member nodes, settled and failed alike. */
  readonly turns: number;
  /** Usage receipts charged at member nodes. */
  readonly usage: UnitPathUsage;
}

export interface GoalClosureProjection {
  readonly schemaVersion: typeof GOAL_CLOSURES_SCHEMA_VERSION;
  readonly unitId: string;
  readonly graph: GraphDefinitionRef;
  readonly manifestDigest: string;
  readonly goals: Readonly<Record<string, GoalClosure>>;
}

/** Prototype-free frozen record: identifier "constructor" must be ordinary data. */
function frozenRecord<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value
    });
  }
  return Object.freeze(record);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertPath(value: unknown, label: string): UnitPathProjection {
  if (!isRecord(value)) {
    throw new Error(`${label}: unit path must be a projection object (got ${typeName(value)})`);
  }
  if (value.schemaVersion !== UNIT_PATH_SCHEMA_VERSION) {
    throw new Error(
      `${label}: unit path schemaVersion must be ${JSON.stringify(UNIT_PATH_SCHEMA_VERSION)} (got ${typeof value.schemaVersion === "string" ? JSON.stringify(value.schemaVersion) : typeName(value.schemaVersion)})`
    );
  }
  if (typeof value.unitId !== "string" || value.unitId.length === 0) {
    throw new Error(`${label}: unit path unitId must be a non-empty string`);
  }
  if (!isRecord(value.graph) || !isRecord(value.nodes) || !isRecord(value.joins)) {
    throw new Error(`${label}: unit path must carry graph, nodes, and joins records`);
  }
  return value as unknown as UnitPathProjection;
}

function sameGraph(left: GraphDefinitionRef, right: GraphDefinitionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function addUsage(total: { receipts: number; chargedTokens: number; chargedCostMicroUsd: number }, usage: UnitPathUsage, label: string): void {
  for (const field of ["receipts", "chargedTokens", "chargedCostMicroUsd"] as const) {
    const amount = usage[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`${label}: usage.${field} must be a non-negative finite number`);
    }
    total[field] += amount;
  }
}

function closureOf(
  manifest: GoalManifest,
  goalIndex: number,
  path: UnitPathProjection,
  label: string
): GoalClosure {
  const goal = manifest.goals[goalIndex]!;
  const goalLabel = `${label}: goal ${goal.goalId}`;
  const resolutionByPair = new Map<string, GoalResolution>();
  for (const resolution of goal.resolutions) {
    resolutionByPair.set(`${resolution.nodeId} ${resolution.outcome}`, resolution);
  }

  let entered = false;
  const openMembers: string[] = [];
  const deadMembers: string[] = [];
  const closures: GoalResolution[] = [];
  const usage = { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 };
  let turns = 0;

  for (const member of goal.members) {
    const memberLabel = `${goalLabel}: member ${member}`;
    const nodePath: UnitPathNode | undefined = Object.hasOwn(path.nodes, member) ? path.nodes[member] : undefined;
    if (nodePath !== undefined) {
      if (!isRecord(nodePath) || !Array.isArray(nodePath.occurrences) || !Array.isArray(nodePath.outcomes) || !isRecord(nodePath.usage)) {
        throw new Error(`${memberLabel}: unit path node must carry occurrences, outcomes, and usage`);
      }
      entered = true;
      let open = false;
      let dead = false;
      for (const occurrence of nodePath.occurrences) {
        if (!isRecord(occurrence) || typeof occurrence.attempts !== "number" || !Number.isInteger(occurrence.attempts) || occurrence.attempts < 0) {
          throw new Error(`${memberLabel}: unit path occurrence must carry an integer attempt count`);
        }
        turns += occurrence.attempts;
        if (occurrence.state === "open") open = true;
        else if (occurrence.state === "dead") dead = true;
        else if (occurrence.state !== "settled") {
          throw new Error(`${memberLabel}: unit path occurrence state must be open, settled, or dead`);
        }
      }
      if (open) openMembers.push(member);
      if (dead) deadMembers.push(member);
      for (const outcome of nodePath.outcomes) {
        if (typeof outcome !== "string") {
          throw new Error(`${memberLabel}: unit path outcomes must be strings`);
        }
        const resolution = resolutionByPair.get(`${member} ${outcome}`);
        if (resolution !== undefined) closures.push(resolution);
      }
      addUsage(usage, nodePath.usage, memberLabel);
    }
    // A join's synthesized outcome settles no occurrence; the join record carries it.
    const join: UnitPathJoin | undefined = Object.hasOwn(path.joins, member) ? path.joins[member] : undefined;
    if (join !== undefined && isRecord(join) && join.status === "unsatisfiable") {
      entered = true;
      const resolution = resolutionByPair.get(`${member} join_unsatisfiable`);
      if (resolution !== undefined) closures.push(resolution);
    }
  }

  if (closures.length > 1) {
    throw new Error(
      `${goalLabel} closed ${closures.length} times in unit ${path.unitId} (${closures.map((closure) => `${closure.nodeId}:${closure.outcome}`).join(", ")}); the manifest does not describe this journey's graph`
    );
  }
  const status: GoalClosureStatus = closures.length === 1
    ? "closed"
    : !entered
      ? "unentered"
      : deadMembers.length > 0 && openMembers.length === 0
        ? "dead"
        : "open";
  return Object.freeze({
    goalId: goal.goalId,
    status,
    ...(closures.length === 1 ? { resolution: closures[0]! } : {}),
    openMembers: Object.freeze(openMembers),
    deadMembers: Object.freeze(deadMembers),
    turns,
    usage: Object.freeze(usage)
  });
}

/**
 * Project one unit's path onto a sealed goal manifest. The manifest document
 * is re-validated (shape and digest) and must describe the exact graph the
 * path was recorded against; a unit-path projection is taken as produced by
 * `projectUnitPath`.
 */
export function projectGoalClosures(manifestRaw: unknown, pathRaw: unknown): GoalClosureProjection {
  const label = "goal closures";
  const manifest = validateGoalManifestDocument(manifestRaw);
  const path = assertPath(pathRaw, label);
  if (!sameGraph(manifest.graph, path.graph)) {
    throw new Error(
      `${label}: graph mismatch — manifest describes ${manifest.graph.id}@${manifest.graph.version} ${manifest.graph.digest}, unit ${path.unitId} ran on ${path.graph.id}@${path.graph.version} ${path.graph.digest}`
    );
  }
  const goals = frozenRecord(
    manifest.goals.map((goal, index) => [goal.goalId, closureOf(manifest, index, path, label)] as const)
  );
  return Object.freeze({
    schemaVersion: GOAL_CLOSURES_SCHEMA_VERSION,
    unitId: path.unitId,
    graph: manifest.graph,
    manifestDigest: manifest.manifestDigest,
    goals
  });
}

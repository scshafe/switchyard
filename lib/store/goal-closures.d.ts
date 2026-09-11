import type { GraphDefinitionRef } from "../graph/definition.js";
import { type GoalResolution } from "../graph/goals.js";
import { type UnitPathUsage } from "./unit-path.js";
export declare const GOAL_CLOSURES_SCHEMA_VERSION: "mission-pipeline-goal-closures.v1";
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
/**
 * Project one unit's path onto a sealed goal manifest. The manifest document
 * is re-validated (shape and digest) and must describe the exact graph the
 * path was recorded against; a unit-path projection is taken as produced by
 * `projectUnitPath`.
 */
export declare function projectGoalClosures(manifestRaw: unknown, pathRaw: unknown): GoalClosureProjection;

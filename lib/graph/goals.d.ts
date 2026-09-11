import { type GraphDefinitionRef } from "./definition.js";
export declare const GOAL_MANIFEST_SCHEMA_VERSION: "mission-pipeline-goal-manifest.v1";
export declare const GOAL_RESOLUTION_KINDS: readonly ["resolved", "escalated"];
export type GoalResolutionKind = (typeof GOAL_RESOLUTION_KINDS)[number];
/** Members are disjoint and non-empty, so a graph holds at most one goal per node. */
export declare const MAX_GOAL_MANIFEST_GOALS = 256;
export declare const MAX_GOAL_MEMBERS = 256;
export declare const MAX_GOAL_RESOLUTIONS = 1024;
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
/**
 * Validate a sealed manifest document on its own: strict shape, identifier
 * grammar, and a recomputed digest. This proves the document is unchanged
 * since it was sealed, not that it describes any graph; use
 * `validateGoalManifest` with the graph definition for that.
 */
export declare function validateGoalManifestDocument(value: unknown): GoalManifest;
/**
 * Validate a draft against a sealed graph definition and seal it. The graph
 * ref is taken from the definition, so a manifest can never name a graph it
 * was not checked against; re-seal the same draft whenever the graph digest
 * moves.
 */
export declare function createGoalManifest(definitionRaw: unknown, draftRaw: unknown): GoalManifest;
/**
 * Validate a sealed manifest against the sealed graph it claims to describe:
 * the document check, exact graph identity (id, version, digest), and every
 * structural rule. Compilation is the compiler's, so a tampered definition
 * fails here as it would at publication.
 */
export declare function validateGoalManifest(definitionRaw: unknown, manifestRaw: unknown): GoalManifest;

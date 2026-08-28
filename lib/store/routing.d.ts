import { type ArtifactEnvelope } from "../contracts/artifact.js";
import { type JoinRequirement } from "../graph/definition.js";
import { type Edge } from "../graph/edge.js";
/** One declared inbound edge's mutually exclusive progress state. */
export interface JoinEdgeState {
    readonly edgeId: string;
    readonly state: "pending" | "offered" | "impossible";
}
/** Pure threshold result; persistence decides whether a join has already fired. */
export interface JoinThresholdEvaluation {
    readonly required: number;
    readonly offered: number;
    readonly impossible: number;
    readonly pending: number;
    readonly thresholdSatisfied: boolean;
    readonly satisfiable: boolean;
    readonly unsatisfiable: boolean;
}
/** Evaluate one member of the closed outcome-predicate language. */
export declare function outcomePredicateMatches(predicateRaw: unknown, outcomeRaw: unknown, outputArtifactRaw?: ArtifactEnvelope): boolean;
/**
 * Return matching edges in authored order. The output artifact is validated
 * once for the whole evaluation. Conditional predicates are false when it is
 * absent; unconditional outcome and anyOf predicates remain eligible.
 */
export declare function matchingOutcomeEdges(edges: readonly Edge[], outcomeRaw: unknown, outputArtifactRaw?: ArtifactEnvelope): readonly Edge[];
/** Evaluate all/nOf threshold and future satisfiability over distinct edges. */
export declare function evaluateJoinThreshold(requirement: JoinRequirement, statesRaw: readonly JoinEdgeState[]): JoinThresholdEvaluation;
export declare function isJoinThresholdSatisfied(requirement: JoinRequirement, states: readonly JoinEdgeState[]): boolean;
export declare function isJoinSatisfiable(requirement: JoinRequirement, states: readonly JoinEdgeState[]): boolean;

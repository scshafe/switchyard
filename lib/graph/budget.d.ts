import type { GraphDefinitionRef, MissionPipelineNodeKind } from "./definition.js";
export interface GraphCycleEdge {
    readonly edgeId: string;
    readonly from: string;
    readonly to: string;
}
export interface GraphTurnBudgetNode {
    readonly nodeId: string;
    readonly kind: MissionPipelineNodeKind;
    readonly join: boolean;
    readonly maxAttempts: number;
    /** Longest path from the entry, in edges; null when the graph is cyclic. */
    readonly depth: number | null;
    /** Worst-case queue occurrences for one unit; null when the graph is cyclic. */
    readonly maxOccurrences: number | null;
    /** `maxOccurrences * maxAttempts`; null when the graph is cyclic. */
    readonly maxTurns: number | null;
}
export type GraphTurnBudgetByKind = Readonly<Record<MissionPipelineNodeKind, number | null>>;
export interface GraphTurnBudget {
    readonly graph: GraphDefinitionRef;
    readonly acyclic: boolean;
    /** Back edges found by a depth-first walk from the entry, in authored order. */
    readonly cycleEdges: readonly GraphCycleEdge[];
    readonly nodes: Readonly<Record<string, GraphTurnBudgetNode>>;
    readonly maxDepth: number | null;
    readonly maxTurns: number | null;
    readonly maxTurnsByKind: GraphTurnBudgetByKind;
}
/**
 * Worst-case turn budget for a sealed graph definition. Validation is the
 * compiler's: an unsealed, tampered, or incomplete definition fails here
 * exactly as it would at publication.
 */
export declare function graphTurnBudget(definitionRaw: unknown): GraphTurnBudget;

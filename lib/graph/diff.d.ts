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
    readonly schemaVersion: "mission-pipeline-graph-definition-diff.v1";
    readonly sealed: Readonly<{
        graphId: string;
        version: number;
        digest: string;
    }>;
    readonly candidate: Readonly<{
        graphId: string;
        version: number;
        digest: string;
    }>;
    readonly sameFamily: boolean;
    readonly description: GraphFieldChange | null;
    readonly entry: GraphFieldChange | null;
    readonly nodes: readonly GraphNodeDiff[];
    readonly edges: readonly GraphEdgeDiff[];
    readonly terminals: readonly GraphTerminalDiff[];
    readonly unchanged: Readonly<{
        nodes: number;
        edges: number;
        terminals: number;
    }>;
    /** No structural changes; graph identity/version/digest alone do not affect this flag. */
    readonly empty: boolean;
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
export declare function graphDefinitionDiff(sealedRaw: unknown, candidateRaw: unknown): GraphDefinitionDiff;

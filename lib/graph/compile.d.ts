import { type GraphDefinitionRef, type MissionPipelineNode, type TerminalOutcome } from "./definition.js";
import { type Edge } from "./edge.js";
export interface CompiledGraph {
    readonly graph: GraphDefinitionRef;
    readonly entry: string;
    readonly nodes: readonly MissionPipelineNode[];
    readonly edges: readonly Edge[];
    readonly terminals: readonly TerminalOutcome[];
    readonly nodesById: Readonly<Record<string, MissionPipelineNode>>;
    readonly edgesById: Readonly<Record<string, Edge>>;
    readonly inboundByNode: Readonly<Record<string, readonly Edge[]>>;
    readonly outboundByNode: Readonly<Record<string, readonly Edge[]>>;
}
/**
 * Compile a sealed graph into authored-order indexes. Semantic validation is
 * deliberately kept in this function so every store/executor consumes the
 * same accepted graph language.
 */
export declare function compileGraph(definitionRaw: unknown): CompiledGraph;

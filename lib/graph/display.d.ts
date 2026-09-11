import type { ContractId } from "../contracts/artifact.js";
import { type CompiledGraph } from "./compile.js";
import type { GraphDefinitionRef, JoinRequirement, MissionPipelineJoin, MissionPipelineNodeBindingRef, MissionPipelineNodeConfigurationRef, MissionPipelineNodeKind, MissionPipelineNodeRef, TerminalOutcome } from "./definition.js";
export declare const GRAPH_DISPLAY_SCHEMA_VERSION: "mission-pipeline-graph-display.v1";
export interface GraphDisplayNode {
    readonly nodeId: string;
    readonly kind: MissionPipelineNodeKind;
    readonly ref: MissionPipelineNodeRef;
    readonly input: ContractId;
    readonly outcomes: readonly string[];
    readonly outputs?: Readonly<Record<string, ContractId>>;
    readonly binding?: MissionPipelineNodeBindingRef;
    readonly configuration?: MissionPipelineNodeConfigurationRef;
    readonly join?: MissionPipelineJoin;
    readonly maxAttempts: number;
    /** Longest path from entry in a DAG; shortest BFS depth for all nodes if cyclic. */
    readonly depth: number;
    /** At least two outcomes, identical guaranteed successors, and no terminals. */
    readonly marks: boolean;
}
export interface GraphDisplayArrow {
    readonly from: string;
    readonly to: string;
    /** Distinct outcomes, in first contributing predicate order. */
    readonly outcomes: readonly string[];
    /** All contributing edges, in authored order. */
    readonly edgeIds: readonly string[];
    /** At least one contributing edge has a where arm; not an execution result. */
    readonly conditional: boolean;
    /** One entry per contributing multi-target edge; co-targets in authored order. */
    readonly fanOut: readonly {
        readonly edgeId: string;
        readonly coTargets: readonly string[];
        /** Outcomes belonging to this edge, before merging; absent in older v1 projections. */
        readonly outcomes?: readonly string[];
    }[];
}
export interface GraphDisplayJoin {
    readonly nodeId: string;
    readonly require: JoinRequirement;
    readonly inbound: readonly string[];
}
export interface GraphDisplayProjection {
    readonly schemaVersion: typeof GRAPH_DISPLAY_SCHEMA_VERSION;
    readonly graph: GraphDefinitionRef;
    readonly entry: string;
    readonly nodes: readonly GraphDisplayNode[];
    /** One arrow per (from, to) pair, in first edge/target encounter order. */
    readonly arrows: readonly GraphDisplayArrow[];
    readonly terminals: readonly TerminalOutcome[];
    readonly joins: readonly GraphDisplayJoin[];
}
/**
 * Project this package instance's compileGraph result. CompiledGraph omits
 * description, so arbitrary copies cannot prove their graph digest; transport
 * the sealed GraphDefinition and compile it again instead. Rejection performs
 * no property reads on unrecognized input, including Proxies and accessors.
 *
 * Output is detached, deeply frozen JSON with prototype-free records. Nodes,
 * terminals, and joins retain authored order. This describes possible topology,
 * never runtime readiness, delivery, or a unit's observed path.
 */
export declare function projectGraphDisplay(compiled: CompiledGraph): GraphDisplayProjection;

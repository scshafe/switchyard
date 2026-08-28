import { type ContractId } from "../contracts/artifact.js";
import { type Edge } from "./edge.js";
import { type OutcomeVocabulary } from "./outcome.js";
export declare const MISSION_PIPELINE_NODE_KINDS: readonly ["code", "model", "agent", "human", "callback"];
export type MissionPipelineNodeKind = (typeof MISSION_PIPELINE_NODE_KINDS)[number];
/** Engine-only identity; authored nodes can never claim synthetic authority. */
export declare const MISSION_PIPELINE_ENGINE_PRINCIPAL_ID: "mission_pipeline.engine";
/** Output contract emitted by an engine-synthesized unsatisfiable join. */
export declare const JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT: "mission-pipeline.join-unsatisfiable.v1";
export declare const NODE_TURN_IDEMPOTENCY: "per (unitId, nodeId, attemptNumber)";
export declare const NODE_TURN_RETRY_TAXONOMY: "retryable vs terminal, as v1 durable-stage";
export declare const MAX_GRAPH_NODES = 256;
export declare const MAX_GRAPH_EDGES = 2048;
export declare const MAX_GRAPH_TERMINALS = 1024;
export declare const MAX_GRAPH_DESCRIPTION_LENGTH = 1000;
export declare const MAX_JOIN_INBOUND_EDGES = 256;
export declare const MAX_NODE_TURN_LEASE_MS = 86400000;
export declare const MAX_NODE_TURN_ATTEMPTS = 10;
export interface MissionPipelineNodeRef {
    readonly id: string;
    readonly version: number;
}
/** Opaque least-authority identity. Hosts resolve it; graphs never carry secrets. */
export interface PrincipalRef {
    readonly id: string;
}
export interface MissionPipelineNodeBindingRef {
    readonly kind: "model";
    readonly bindingId: string;
    readonly version: number;
    readonly bindingDigest: string;
}
export interface MissionPipelineNodeTurn {
    readonly idempotency: typeof NODE_TURN_IDEMPOTENCY;
    readonly leaseMs: number;
    readonly maxAttempts: number;
    readonly retryTaxonomy: typeof NODE_TURN_RETRY_TAXONOMY;
}
export type JoinRequirement = "all" | {
    readonly nOf: number;
};
export interface MissionPipelineJoin {
    /** Stable edge IDs; compileGraph requires exact equality with actual inbound edges. */
    readonly inbound: readonly string[];
    readonly require: JoinRequirement;
}
export interface MissionPipelineNode {
    readonly nodeId: string;
    readonly ref: MissionPipelineNodeRef;
    readonly kind: MissionPipelineNodeKind;
    readonly input: ContractId;
    readonly outcomes: OutcomeVocabulary;
    readonly principal: PrincipalRef;
    readonly binding?: MissionPipelineNodeBindingRef;
    readonly turn: MissionPipelineNodeTurn;
    readonly join?: MissionPipelineJoin;
}
export interface TerminalOutcome {
    readonly nodeId: string;
    readonly outcome: string;
}
export interface GraphDefinitionDraft {
    readonly graphId: string;
    readonly version: number;
    readonly description: string;
    readonly entry: string;
    readonly nodes: readonly MissionPipelineNode[];
    readonly edges: readonly Edge[];
    readonly terminals: readonly TerminalOutcome[];
}
export interface GraphDefinition {
    readonly graphId: string;
    readonly version: number;
    readonly description: string;
    readonly entry: string;
    readonly nodes: readonly MissionPipelineNode[];
    readonly edges: readonly Edge[];
    readonly terminals: readonly TerminalOutcome[];
    readonly graphDigest: string;
}
export interface GraphDefinitionRef {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
}
export declare function validateMissionPipelineNodeBindingRef(value: unknown, label?: string): MissionPipelineNodeBindingRef;
/** Validate one v2 node contract without resolving graph-level references. */
export declare function validateMissionPipelineNode(value: unknown, label?: string): MissionPipelineNode;
/** Validate and seal a graph draft with canonical-JSON SHA-256. */
export declare function createGraphDefinition(input: unknown): GraphDefinition;
/** Validate a sealed graph and recompute its digest fail-closed. */
export declare function validateGraphDefinition(value: unknown): GraphDefinition;
export declare function graphDefinitionRef(value: unknown): GraphDefinitionRef;

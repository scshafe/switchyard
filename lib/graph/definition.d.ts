import { type ContractId } from "../contracts/artifact.js";
import { type Edge } from "./edge.js";
import { type OutcomeVocabulary } from "./outcome.js";
export declare const MISSION_PIPELINE_NODE_KINDS: readonly ["code", "model", "agent", "human", "callback"];
export type MissionPipelineNodeKind = (typeof MISSION_PIPELINE_NODE_KINDS)[number];
/** Engine-only identity; authored nodes can never claim synthetic authority. */
export declare const MISSION_PIPELINE_ENGINE_PRINCIPAL_ID: "mission_pipeline.engine";
/** Output contract emitted by an engine-synthesized unsatisfiable join. */
export declare const JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT: "mission-pipeline.join-unsatisfiable.v1";
/** Input contract synthesized for an opt-in composing join. */
export declare const JOIN_INPUT_ARTIFACT_CONTRACT: "mission-pipeline.join-input.v1";
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
    /** Omitted/select preserves one-artifact selection; envelope embeds accepted branch inputs. */
    readonly compose?: "select" | "envelope";
}
/**
 * Content-addressed identity of the host-side configuration a node body runs
 * under (a policy table, a threshold set, a code revision). The host resolves
 * it; the engine seals it into the graph digest and the node execution
 * fingerprint, so a policy change is a visible identity change instead of a
 * silent drift behind an unchanged attempt key.
 */
export interface MissionPipelineNodeConfigurationRef {
    readonly id: string;
    readonly version: number;
    readonly digest: string;
}
export interface MissionPipelineNode {
    readonly nodeId: string;
    readonly ref: MissionPipelineNodeRef;
    readonly kind: MissionPipelineNodeKind;
    readonly input: ContractId;
    readonly outcomes: OutcomeVocabulary;
    /**
     * The contract this node's body emits per declared outcome. An outcome that
     * emits no output artifact carries its input forward, so its entry equals
     * `input`. Omitted outcomes are undeclared: nothing is checked for them.
     * Declared entries are checked at compile time against every edge target
     * and at completion time against the returned artifact.
     */
    readonly outputs?: Readonly<Record<string, ContractId>>;
    readonly principal: PrincipalRef;
    readonly binding?: MissionPipelineNodeBindingRef;
    readonly configuration?: MissionPipelineNodeConfigurationRef;
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
/** Validate, detach, and freeze a node configuration ref. */
export declare function validateMissionPipelineNodeConfigurationRef(value: unknown, label?: string): MissionPipelineNodeConfigurationRef;
/** Validate one v2 node contract without resolving graph-level references. */
export declare function validateMissionPipelineNode(value: unknown, label?: string): MissionPipelineNode;
/** Declared outputs of a validated node, or undefined when none are declared. */
export declare function declaredNodeOutputs(node: MissionPipelineNode): Readonly<Record<string, ContractId>> | undefined;
/** The contract a validated node declares for one outcome, or undefined when undeclared. */
export declare function declaredNodeOutput(node: MissionPipelineNode, outcome: string): ContractId | undefined;
/** Validate and seal a graph draft with canonical-JSON SHA-256. */
export declare function createGraphDefinition(input: unknown): GraphDefinition;
/** Validate a sealed graph and recompute its digest fail-closed. */
export declare function validateGraphDefinition(value: unknown): GraphDefinition;
export declare function graphDefinitionRef(value: unknown): GraphDefinitionRef;

import type { ContractId } from "../contracts/artifact.js";
import { type GraphDefinition, type GraphDefinitionRef, type MissionPipelineNode, type MissionPipelineNodeKind } from "../graph/definition.js";
/** Definition-bound meaning of one `(node ref id, version)`. */
export interface NodeDefinitionSignature {
    readonly kind: MissionPipelineNodeKind;
    readonly input: ContractId;
    /** Set semantics, represented in canonical lexical order. */
    readonly outcomes: readonly string[];
    /**
     * Declared output contracts by outcome, in canonical lexical key order;
     * present only when the node declares any. A ref/version that declares
     * outputs in one graph and not in another names two definitions.
     */
    readonly outputs?: Readonly<Record<string, ContractId>>;
}
/** Validate, detach, and freeze a digest-bearing graph reference. */
export declare function validateGraphDefinitionRef(value: unknown, label?: string): GraphDefinitionRef;
/** Canonical signature used by every GraphStore implementation. */
export declare function nodeDefinitionSignature(node: MissionPipelineNode): NodeDefinitionSignature;
/** Field-by-field signature comparison every GraphStore implementation must apply. */
export declare function nodeDefinitionSignatureConflict(published: NodeDefinitionSignature, requested: NodeDefinitionSignature): NodeDefinitionConflictField | undefined;
/** A sealed graph failed semantic compilation before publication. */
export declare class GraphPublicationValidationError extends Error {
    readonly code = "graph_publication_invalid";
    readonly graphId: string;
    readonly graphVersion: number;
    constructor(graphId: string, graphVersion: number, detail: string, cause: unknown);
}
/** A graph identity was already sealed to a different digest. */
export declare class GraphPublicationConflictError extends Error {
    readonly code = "graph_publication_conflict";
    readonly graphId: string;
    readonly graphVersion: number;
    readonly publishedDigest: string;
    readonly requestedDigest: string;
    constructor(graphId: string, graphVersion: number, publishedDigest: string, requestedDigest: string);
}
/** A load named an existing graph identity but supplied the wrong digest. */
export declare class GraphLoadDigestConflictError extends Error {
    readonly code = "graph_load_digest_conflict";
    readonly graphId: string;
    readonly graphVersion: number;
    readonly publishedDigest: string;
    readonly requestedDigest: string;
    constructor(graphId: string, graphVersion: number, publishedDigest: string, requestedDigest: string);
}
export type NodeDefinitionConflictField = "kind" | "input contract" | "outcome vocabulary" | "output contracts";
/** One node ref/version was given a different definition-bound meaning. */
export declare class NodeDefinitionPublicationConflictError extends Error {
    readonly code = "node_definition_publication_conflict";
    readonly nodeRefId: string;
    readonly nodeRefVersion: number;
    readonly field: NodeDefinitionConflictField;
    readonly publishedBy: GraphDefinitionRef;
    readonly requestedBy: GraphDefinitionRef;
    constructor(input: {
        readonly nodeRefId: string;
        readonly nodeRefVersion: number;
        readonly field: NodeDefinitionConflictField;
        readonly publishedBy: GraphDefinitionRef;
        readonly requestedBy: GraphDefinitionRef;
    });
}
/**
 * Host-neutral append-only graph store. Implementations MUST validate and
 * compile before publication, make graph + node-signature writes atomic, and
 * revalidate the sealed graph on every load.
 */
export interface GraphStore {
    publishGraph(graph: GraphDefinition): Promise<void>;
    loadGraph(ref: GraphDefinitionRef): Promise<GraphDefinition | undefined>;
}

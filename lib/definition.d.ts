import { type ContractId } from "./contracts/artifact.js";
export declare const PIPELINE_DEFINITION_SCHEMA_VERSION = "pipeline-definition.v2";
export declare const MAX_PIPELINE_NODES = 64;
export declare const MAX_PIPELINE_OUTPUTS = 16;
export declare const MAX_NODE_INPUTS = 16;
export declare const MAX_DESCRIPTION_LENGTH = 1000;
/** Where a node input's artifact comes from: the pipeline input or another node's output. */
export type PipelineNodeInputSource = {
    kind: "pipeline_input";
} | {
    kind: "node_output";
    nodeId: string;
};
export interface PipelineNodeInput {
    slot: string;
    source: PipelineNodeInputSource;
}
/** The binding kinds a node may reference (never "none" — unbound nodes omit the field). */
export declare const PIPELINE_NODE_BINDING_KINDS: readonly ["model", "decision"];
export type PipelineNodeBindingKind = (typeof PIPELINE_NODE_BINDING_KINDS)[number];
/**
 * Content-addressed reference from a pipeline node to a published,
 * digest-sealed binding (model-stage binding — B4; decision-flow binding —
 * B5). `bindingDigest` is the sealed payload's canonical-JSON digest; the
 * compiler stamps it into the compiled node as `bindingFingerprint`, so a
 * binding change changes the pipeline identity.
 */
export interface PipelineNodeBindingRef {
    kind: PipelineNodeBindingKind;
    bindingId: string;
    version: number;
    bindingDigest: string;
}
export interface PipelineNode {
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    inputs: PipelineNodeInput[];
    binding?: PipelineNodeBindingRef;
}
/** What callers hand to {@link createPipelineDefinition} (no digest yet). */
export interface PipelineDefinitionDraft {
    schemaVersion: typeof PIPELINE_DEFINITION_SCHEMA_VERSION;
    pipelineId: string;
    version: number;
    description: string;
    inputContract: string;
    nodes: readonly PipelineNode[];
    outputs: readonly string[];
}
/** The digest-sealed pipeline definition. */
export interface PipelineDefinition {
    schemaVersion: typeof PIPELINE_DEFINITION_SCHEMA_VERSION;
    pipelineId: string;
    version: number;
    description: string;
    inputContract: ContractId;
    nodes: PipelineNode[];
    outputs: string[];
    definitionDigest: string;
}
/** Promoted `{ id, version, digest }` reference to a definition. */
export interface PipelineDefinitionRef {
    id: string;
    version: number;
    digest: string;
}
/** LOUD validator for a node input source (exported for compiled-shape reuse). */
export declare function validatePipelineNodeInputSource(value: unknown, label: string): PipelineNodeInputSource;
/** LOUD validator for one {@link PipelineNode}. */
export declare function validatePipelineNode(value: unknown, label?: string): PipelineNode;
/**
 * Seal a draft into a {@link PipelineDefinition}: validate LOUDLY, then stamp
 * `definitionDigest = digest(normalized-base)`. The digest is stable under key
 * permutation of the input (canonical JSON sorts keys).
 */
export declare function createPipelineDefinition(input: unknown): PipelineDefinition;
/**
 * LOUD validator for a SEALED definition: full shape validation plus digest
 * recompute — tampering with any field throws "digest mismatch" (the promoted
 * fail-closed sealing semantics).
 */
export declare function validatePipelineDefinition(value: unknown): PipelineDefinition;
/** Promoted projection of a sealed definition to its `{ id, version, digest }` ref. */
export declare function pipelineDefinitionRef(definitionRaw: unknown): PipelineDefinitionRef;

import { type ContractId } from "./contracts/artifact.js";
import { type PipelineDefinitionRef, type PipelineNodeInputSource } from "./definition.js";
import type { StageCatalog } from "./catalog.js";
import { type DeliverySemantics, type StageKind } from "./node.js";
export declare const COMPILED_PIPELINE_SCHEMA_VERSION = "compiled-pipeline.v2";
export declare const PIPELINE_COMPILER_VERSION = "mission-pipeline-compiler.v1";
export interface CompiledPipelineNodeInput {
    slot: string;
    source: PipelineNodeInputSource;
    /** The resolved contract this slot receives (pipeline input or producer output). */
    contract: ContractId;
}
export interface CompiledPipelineNode {
    nodeId: string;
    stage: {
        id: string;
        version: number;
    };
    inputs: CompiledPipelineNodeInput[];
    kind: StageKind;
    outputContract: ContractId;
    capabilities: string[];
    deliverySemantics: DeliverySemantics;
    /** The node's binding digest, or "none" for unbound nodes (promoted attribution). */
    bindingFingerprint: string;
    configurationFingerprint?: string;
}
export interface CompiledPipeline {
    schemaVersion: typeof COMPILED_PIPELINE_SCHEMA_VERSION;
    compilerVersion: typeof PIPELINE_COMPILER_VERSION;
    pipeline: PipelineDefinitionRef;
    inputContract: ContractId;
    /** Nodes in deterministic topological order (Kahn, original-index tie-break). */
    nodes: CompiledPipelineNode[];
    outputs: string[];
    compiledDigest: string;
}
/**
 * Compile a digest-sealed definition against a catalog into a digest-sealed
 * {@link CompiledPipeline}. Fails LOUD (in this order) on: invalid/tampered
 * definition; pipeline inputContract unknown to the ContractValidator; unknown
 * stages; descriptor-without-executable (NEW, compile-time parity); binding
 * kind violations; slot-set mismatches; per-slot contract mismatches; unknown
 * source nodes; unknown output nodes; gate nodes that are not terminal
 * pipeline outputs; and dependency cycles.
 */
export declare function compilePipeline(definitionRaw: unknown, catalog: StageCatalog): CompiledPipeline;
export declare function validateCompiledPipelineNode(value: unknown, label?: string): CompiledPipelineNode;
/**
 * LOUD validator for a sealed {@link CompiledPipeline} (used by B3 to verify
 * store round-trips): full shape validation plus digest recompute — any
 * tampering throws "digest mismatch".
 */
export declare function validateCompiledPipeline(value: unknown): CompiledPipeline;

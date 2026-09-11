import { type WorkerNodeTurnContext } from "../execute/ports.js";
import { type CompiledPrompt } from "../prompt/compiler.js";
import { type ModelStageBinding } from "./binding.js";
import type { ArtifactRef } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import { type MissionPipelineNodeBindingRef, type MissionPipelineNodeRef } from "../graph/definition.js";
/**
 * The pre-1.1.0 request shape. It names a run, an item, a stage, and one
 * attempt counter, none of which a v2 node turn has; hosts that still speak
 * it keep working, and removing it is a major.
 */
export interface ModelInvocationRequest {
    readonly runId: string;
    readonly itemId: string;
    readonly nodeId: string;
    readonly stage: {
        readonly id: string;
        readonly version: number;
    };
    readonly attempt: number;
    readonly idempotencyKey: string;
    readonly input: unknown;
    readonly binding: ModelStageBinding;
}
/** What a resolved binding receives for one physical call of a v2 node turn. */
export interface ModelTurnInvocationRequest {
    readonly unitId: string;
    /** Durable identity of the queued occurrence this attempt belongs to. */
    readonly queueId: string;
    readonly nodeId: string;
    readonly nodeRef: MissionPipelineNodeRef;
    readonly attemptNumber: number;
    /** 1-based retry ordinal within this queue occurrence. */
    readonly attemptIndex: number;
    /** The sealed attempt identity the journey records for this turn. */
    readonly idempotencyKey: string;
    /** Content identity of the input; `input` is its validated payload. */
    readonly inputArtifact: ArtifactRef;
    readonly input: unknown;
    /** The sealed binding the node's binding ref names, proven by digest. */
    readonly binding: ModelStageBinding;
}
export type AnyModelInvocationRequest = ModelInvocationRequest | ModelTurnInvocationRequest;
/** One completed physical call with its mandatory usage evidence. */
export interface ModelInvocationResult {
    readonly output: unknown;
    readonly usage: UsageReceipt;
}
export interface ResolvedModelBinding {
    invoke(request: AnyModelInvocationRequest, signal?: AbortSignal): Promise<ModelInvocationResult>;
    readonly compiledPrompt?: CompiledPrompt;
}
/** The three things a ModelNodePort holds, plus the sealed binding it published. */
export interface ModelTurnInvocationFields {
    readonly context: WorkerNodeTurnContext;
    readonly input: unknown;
    readonly bindingRef: MissionPipelineNodeBindingRef;
    readonly binding: ModelStageBinding;
}
/**
 * Build the v2 request from what a ModelNodePort received. The context is
 * re-snapshotted, so a forged or partial context fails here; the binding ref
 * is the sealed node's, and the binding must be the exact sealed payload that
 * ref names (`resolveModelBindingRef`), so a request can never carry a
 * binding the graph did not pin. `input` is passed through untouched: it is
 * the payload the engine already validated.
 */
export declare function modelTurnInvocationRequest(fieldsRaw: unknown): ModelTurnInvocationRequest;
/** Hosts resolve an exact sealed binding without granting engine credentials. */
export interface ModelBindingResolver {
    resolve(binding: ModelStageBinding): ResolvedModelBinding | Promise<ResolvedModelBinding>;
}
/**
 * Snapshot a resolver capability and prove any prompt it surfaces is the exact
 * digest-sealed prompt named by the binding. The returned wrapper retains only
 * the captured invoke capability and validated prompt data.
 */
export declare function verifyResolvedModelBinding(resolvedRaw: unknown, bindingRaw: ModelStageBinding): ResolvedModelBinding;

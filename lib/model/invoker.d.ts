import { type CompiledPrompt } from "../prompt/compiler.js";
import { type ModelStageBinding } from "./binding.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
/** What the resolved host receives for one physical model call. */
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
/** One completed physical call with its mandatory usage evidence. */
export interface ModelInvocationResult {
    readonly output: unknown;
    readonly usage: UsageReceipt;
}
export interface ResolvedModelBinding {
    invoke(request: ModelInvocationRequest, signal?: AbortSignal): Promise<ModelInvocationResult>;
    readonly compiledPrompt?: CompiledPrompt;
}
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

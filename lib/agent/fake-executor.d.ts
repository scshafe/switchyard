import type { AgentStepExecutor } from "./executor-port.js";
import { type AgentStepRequest, type AgentStepResult } from "./step.js";
import { type UsageReceipt } from "../contracts/usage-receipt.js";
/** A convenience provider_reported receipt for happy-path tests. */
export declare function fakeUsageReceipt(overrides?: Partial<UsageReceipt>): UsageReceipt;
export type FakeAgentHandler = (request: AgentStepRequest, signal?: AbortSignal) => AgentStepResult | Promise<AgentStepResult>;
export interface FakeAgentStepExecutorOptions {
    /** Per-stageId handler; falls back to `default` then to a completed echo. */
    handlers?: Record<string, FakeAgentHandler>;
    default?: FakeAgentHandler;
    /** Observe every request (assertion hook). */
    onRequest?: (request: AgentStepRequest, signal?: AbortSignal) => void;
}
/** Build a scriptable fake. With no handlers it echoes the input artifacts'
 *  refs as a trivial completed output with one provider_reported receipt. */
export declare function createFakeAgentStepExecutor(options?: FakeAgentStepExecutorOptions): AgentStepExecutor;

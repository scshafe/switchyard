// agent/fake-executor.ts — a scriptable AgentStepExecutor for hermetic tests
// (mission-pipeline's own suite and any host's). It never reaches a provider;
// it returns whatever the script dictates, so tests exercise the invoker's
// routing/receipt/deadline behavior deterministically.
//
// STANDALONE: relative imports + node: only.

import type { AgentStepExecutor } from "./executor-port.js";
import {
  AGENT_STEP_RESULT_SCHEMA_VERSION,
  type AgentStepRequest,
  type AgentStepResult
} from "./step.js";
import { USAGE_RECEIPT_SCHEMA_VERSION, type UsageReceipt } from "../contracts/usage-receipt.js";

/** A convenience provider_reported receipt for happy-path tests. */
export function fakeUsageReceipt(overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    schemaVersion: USAGE_RECEIPT_SCHEMA_VERSION,
    trust: "provider_reported",
    observedInputTokens: 100,
    observedOutputTokens: 50,
    chargedTokens: 150,
    observedCostMicroUsd: 1200,
    chargedCostMicroUsd: 1200,
    durationMs: 42,
    ...overrides
  };
}

export type FakeAgentHandler = (
  request: AgentStepRequest,
  signal?: AbortSignal
) => AgentStepResult | Promise<AgentStepResult>;

export interface FakeAgentStepExecutorOptions {
  /** Per-stageId handler; falls back to `default` then to a completed echo. */
  handlers?: Record<string, FakeAgentHandler>;
  default?: FakeAgentHandler;
  /** Observe every request (assertion hook). */
  onRequest?: (request: AgentStepRequest, signal?: AbortSignal) => void;
}

/** Build a scriptable fake. With no handlers it echoes the input artifacts'
 *  refs as a trivial completed output with one provider_reported receipt. */
export function createFakeAgentStepExecutor(options: FakeAgentStepExecutorOptions = {}): AgentStepExecutor {
  return {
    async execute(request: AgentStepRequest, signal?: AbortSignal): Promise<AgentStepResult> {
      options.onRequest?.(request, signal);
      const handler = options.handlers?.[request.stage.stageId] ?? options.default;
      if (handler) return handler(request, signal);
      return {
        schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
        status: "completed",
        output: { echoedFrom: request.stage.stageId, inputArtifacts: request.brief.inputArtifacts },
        usage: [fakeUsageReceipt()]
      };
    }
  };
}

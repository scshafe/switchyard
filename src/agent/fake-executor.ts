// agent/fake-executor.ts — a scriptable AgentStepExecutor for hermetic tests
// (mission-pipeline's own suite and any host's). It never reaches a provider;
// it returns whatever the script dictates, so tests exercise the invoker's
// routing/receipt/deadline behavior deterministically.
//
// STANDALONE: relative imports + node: only.

import { types as nodeTypes } from "node:util";

import type { AgentStepExecutor } from "./executor-port.js";
import {
  AGENT_STEP_RESULT_SCHEMA_VERSION,
  type AgentStepRequest,
  type AgentStepResult
} from "./step.js";
import { USAGE_RECEIPT_SCHEMA_VERSION, type UsageReceipt } from "../contracts/usage-receipt.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { deepFrozenClone } from "../internal/evidence.js";

/** A convenience provider_reported receipt for happy-path tests. */
export function fakeUsageReceipt(overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  overrides = deepFrozenClone(overrides, "fake usage receipt overrides");
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
  options = captureCapabilityRecord(
    options,
    ["handlers", "default", "onRequest"],
    [],
    "fake agent executor options"
  ) as unknown as FakeAgentStepExecutorOptions;
  const defaultHandler = options.default;
  if (defaultHandler !== undefined && typeof defaultHandler !== "function") {
    throw new Error("fake agent executor options.default must be a function");
  }
  const onRequest = options.onRequest;
  if (onRequest !== undefined && typeof onRequest !== "function") {
    throw new Error("fake agent executor options.onRequest must be a function");
  }
  const handlers = new Map<string, FakeAgentHandler>();
  if (options.handlers !== undefined) {
    const raw = options.handlers;
    if (
      raw === null
      || typeof raw !== "object"
      || nodeTypes.isProxy(raw)
      || (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null)
    ) {
      throw new Error("fake agent executor handlers must be a plain non-Proxy data object");
    }
    for (const key of Reflect.ownKeys(Object.getOwnPropertyDescriptors(raw))) {
      if (typeof key !== "string") {
        throw new Error("fake agent executor handlers must not contain symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
      if (!("value" in descriptor) || descriptor.enumerable !== true || typeof descriptor.value !== "function") {
        throw new Error(`fake agent executor handler ${key} must be an enumerable data-property function`);
      }
      handlers.set(key, descriptor.value);
    }
  }
  return {
    async execute(request: AgentStepRequest, signal?: AbortSignal): Promise<AgentStepResult> {
      onRequest?.(request, signal);
      const handler = handlers.get(request.stage.stageId) ?? defaultHandler;
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

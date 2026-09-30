// agent/executor-port.ts — the host-owned executor seam for a v2 agent node.
//
// Switchyard owns and validates the request/result contracts. An EAL or
// other host adapter implements this single-turn capability and enforces that
// the requested environment is a subset of the bound environment's grants.

import type {
  AgentStepBudget,
  AgentStepRequest,
  AgentStepResult
} from "./step.js";
import type { ContractId } from "../contracts/artifact.js";

export interface AgentStepExecutor {
  execute(
    request: AgentStepRequest,
    signal?: AbortSignal
  ): Promise<AgentStepResult>;
}

/** Closed host registration material for one versioned agent node body. */
export interface AgentStepSpec {
  readonly stage: { readonly id: string; readonly version: number };
  readonly instructions: string;
  readonly environment: Readonly<Record<string, unknown>>;
  readonly deadlineMs: number;
  readonly budget?: AgentStepBudget;
  readonly inputContract?: ContractId;
}

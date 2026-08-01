// agent/step.ts — the FROZEN agent-step contract (mission-restructure B6).
//
// mission-pipeline OWNS this contract (design critique finding 3): an agent
// node is one turn of an EAL-executed agent — a brief + input artifacts + an
// environment descriptor in, a typed artifact out. The frozen sources live at
// schemas/agent-step-{request,result}.v1.schema.json; these runtime types +
// LOUD validators are pinned to them by test/mission-pipeline-agent-step.test.mjs.
//
// Two design rulings are load-bearing here:
//   - `usage` is a REQUIRED ARRAY of usage-receipt.v1 (never a single optional
//     receipt) — the array shape is what fixes the silent-zero drift both the
//     inbox and the JobTrack side carried; each element is floor-validated by
//     validateUsageReceipt. It may be EMPTY only for status infra_error (the
//     invocation never usably reached a provider).
//   - `environment` carries the descriptor the step REQUIRES. mission-pipeline
//     is a DATA CARRIER for it (structural validation only) — the fail-closed
//     "requested descriptor ⊆ what the bound environment grants" assertion is
//     the EAL adapter's job (A5), never this package's (the machine-ignorance
//     boundary: the pipeline engine must not reason about environment posture).
//
// STANDALONE: relative imports + node: only.

import {
  assertPlainObject,
  assertStrictKeys,
  assertIdentifier,
  typeName,
  truncate
} from "../internal/guards.js";
import { deepFrozenClone } from "../internal/evidence.js";
import { validateContractId, validateArtifactRef, type ArtifactRef, type ContractId } from "../contracts/artifact.js";
import { validateUsageReceipt, type UsageReceipt } from "../contracts/usage-receipt.js";

export const AGENT_STEP_REQUEST_SCHEMA_VERSION = "agent-step-request.v1";
export const AGENT_STEP_RESULT_SCHEMA_VERSION = "agent-step-result.v1";

export const AGENT_STEP_STATUSES = ["completed", "failed", "timed_out", "infra_error"] as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];

export const AGENT_STEP_BOUNDS = Object.freeze({
  instructionsMaxLength: 100000,
  inputArtifactsMaxItems: 64,
  idempotencyKeyMaxLength: 512,
  deadlineMsMin: 1,
  deadlineMsMax: 86400000,
  usageMaxItems: 256,
  failureKindMaxLength: 160,
  failureDetailMaxLength: 8000,
  budgetMaxTokens: 10000000,
  budgetMaxCostMicroUsd: 100000000000,
  budgetMaxElapsedMs: 86400000
});

export interface AgentStepStageRef {
  stageId: string;
  version: number;
}

export interface AgentStepBrief {
  instructions: string;
  inputArtifacts: ArtifactRef[];
  outputContract: ContractId;
}

export interface AgentStepBudget {
  maxTokens?: number;
  maxCostMicroUsd?: number;
  maxElapsedMs?: number;
}

export interface AgentStepRequest {
  schemaVersion: typeof AGENT_STEP_REQUEST_SCHEMA_VERSION;
  stage: AgentStepStageRef;
  /** The environment-descriptor.v1 the step REQUIRES. Structurally validated
   *  (an object with the required descriptor keys); NOT interpreted here. */
  environment: Record<string, unknown>;
  brief: AgentStepBrief;
  idempotencyKey: string;
  budget?: AgentStepBudget;
  deadlineMs: number;
}

export interface AgentStepFailure {
  kind: string;
  detail: string;
}

export interface AgentStepResult {
  schemaVersion: typeof AGENT_STEP_RESULT_SCHEMA_VERSION;
  status: AgentStepStatus;
  /** Present exactly for status "completed". */
  output?: unknown;
  /** REQUIRED array; may be empty ONLY for status "infra_error". */
  usage: UsageReceipt[];
  failure?: AgentStepFailure;
}

// The required descriptor keys (from environment-descriptor.v1). We assert the
// carrier is an object naming these — never the closed capability semantics.
const DESCRIPTOR_REQUIRED_KEYS = ["schemaVersion", "network", "capabilities", "mounts", "secretRefs", "io"] as const;

const REQUEST_KEYS = new Set(["schemaVersion", "stage", "environment", "brief", "idempotencyKey", "budget", "deadlineMs"]);
const STAGE_KEYS = new Set(["stageId", "version"]);
const BRIEF_KEYS = new Set(["instructions", "inputArtifacts", "outputContract"]);
const BUDGET_KEYS = new Set(["maxTokens", "maxCostMicroUsd", "maxElapsedMs"]);
const RESULT_KEYS = new Set(["schemaVersion", "status", "output", "usage", "failure"]);
const FAILURE_KEYS = new Set(["kind", "detail"]);

function assertString(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${label}: must be a string of length ${min}..${max} (got ${typeName(value)}${typeof value === "string" ? ` length ${value.length}` : ""})`);
  }
  return value;
}

function assertBoundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}: must be an integer in ${min}..${max} (got ${typeName(value) === "number" ? String(value) : typeName(value)})`);
  }
  return value;
}

function validateStageRef(value: unknown, label: string): AgentStepStageRef {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, STAGE_KEYS, label);
  return {
    stageId: assertIdentifier(raw.stageId, `${label}.stageId`),
    version: assertBoundedInt(raw.version, 1, 1000000, `${label}.version`)
  };
}

/** Structural descriptor check: an object naming the environment-descriptor.v1
 *  required keys. Deliberately NOT a capability validator — the EAL owns that. */
function validateEnvironmentCarrier(value: unknown, label: string): Record<string, unknown> {
  const raw = assertPlainObject(value, label);
  for (const key of DESCRIPTOR_REQUIRED_KEYS) {
    if (!(key in raw)) {
      throw new Error(`${label}: not an environment-descriptor.v1 value — missing required key ${JSON.stringify(key)}`);
    }
  }
  if (raw.schemaVersion !== "environment-descriptor.v1") {
    throw new Error(`${label}: schemaVersion must be "environment-descriptor.v1" (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
  }
  return raw;
}

function validateBrief(value: unknown, label: string): AgentStepBrief {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BRIEF_KEYS, label);
  const instructions = assertString(raw.instructions, 1, AGENT_STEP_BOUNDS.instructionsMaxLength, `${label}.instructions`);
  if (!Array.isArray(raw.inputArtifacts)) {
    throw new Error(`${label}.inputArtifacts: must be an array (got ${typeName(raw.inputArtifacts)})`);
  }
  if (raw.inputArtifacts.length > AGENT_STEP_BOUNDS.inputArtifactsMaxItems) {
    throw new Error(`${label}.inputArtifacts: at most ${AGENT_STEP_BOUNDS.inputArtifactsMaxItems} artifacts (got ${raw.inputArtifacts.length})`);
  }
  const inputArtifacts = raw.inputArtifacts.map((ref, i) => validateArtifactRef(ref));
  return {
    instructions,
    inputArtifacts,
    outputContract: validateContractId(raw.outputContract, `${label}.outputContract`)
  };
}

function validateBudget(value: unknown, label: string): AgentStepBudget {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, BUDGET_KEYS, label);
  const out: AgentStepBudget = {};
  if (raw.maxTokens !== undefined) out.maxTokens = assertBoundedInt(raw.maxTokens, 0, AGENT_STEP_BOUNDS.budgetMaxTokens, `${label}.maxTokens`);
  if (raw.maxCostMicroUsd !== undefined) out.maxCostMicroUsd = assertBoundedInt(raw.maxCostMicroUsd, 0, AGENT_STEP_BOUNDS.budgetMaxCostMicroUsd, `${label}.maxCostMicroUsd`);
  if (raw.maxElapsedMs !== undefined) out.maxElapsedMs = assertBoundedInt(raw.maxElapsedMs, 1, AGENT_STEP_BOUNDS.budgetMaxElapsedMs, `${label}.maxElapsedMs`);
  return out;
}

/** LOUD validator for a frozen agent-step-request.v1. Returns a fresh value. */
export function validateAgentStepRequest(value: unknown): AgentStepRequest {
  const label = "agent-step request";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, REQUEST_KEYS, label);
  if (raw.schemaVersion !== AGENT_STEP_REQUEST_SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion must be ${JSON.stringify(AGENT_STEP_REQUEST_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
  }
  const request: AgentStepRequest = {
    schemaVersion: AGENT_STEP_REQUEST_SCHEMA_VERSION,
    stage: validateStageRef(raw.stage, `${label}.stage`),
    environment: validateEnvironmentCarrier(raw.environment, `${label}.environment`),
    brief: validateBrief(raw.brief, `${label}.brief`),
    idempotencyKey: assertString(raw.idempotencyKey, 1, AGENT_STEP_BOUNDS.idempotencyKeyMaxLength, `${label}.idempotencyKey`),
    deadlineMs: assertBoundedInt(raw.deadlineMs, AGENT_STEP_BOUNDS.deadlineMsMin, AGENT_STEP_BOUNDS.deadlineMsMax, `${label}.deadlineMs`)
  };
  if (raw.budget !== undefined) request.budget = validateBudget(raw.budget, `${label}.budget`);
  return request;
}

function validateFailure(value: unknown, label: string): AgentStepFailure {
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, FAILURE_KEYS, label);
  return {
    kind: assertString(raw.kind, 1, AGENT_STEP_BOUNDS.failureKindMaxLength, `${label}.kind`),
    detail: assertString(raw.detail, 0, AGENT_STEP_BOUNDS.failureDetailMaxLength, `${label}.detail`)
  };
}

/**
 * LOUD validator for a frozen agent-step-result.v1: the status/output coupling
 * (completed ⇔ output present), the required usage array with the non-silent-
 * zero floor on every element, and the empty-usage-only-for-infra_error rule.
 */
export function validateAgentStepResult(value: unknown): AgentStepResult {
  const label = "agent-step result";
  value = deepFrozenClone(value, label);
  const raw = assertPlainObject(value, label);
  assertStrictKeys(raw, RESULT_KEYS, label);
  if (raw.schemaVersion !== AGENT_STEP_RESULT_SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion must be ${JSON.stringify(AGENT_STEP_RESULT_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
  }
  if (typeof raw.status !== "string" || !(AGENT_STEP_STATUSES as readonly string[]).includes(raw.status)) {
    throw new Error(`${label}.status: must be one of ${AGENT_STEP_STATUSES.join("|")} (got ${typeName(raw.status)})`);
  }
  const status = raw.status as AgentStepStatus;
  const hasOutput = "output" in raw;
  if (status === "completed" && !hasOutput) {
    throw new Error(`${label}: status "completed" requires an output payload`);
  }
  if (status !== "completed" && hasOutput) {
    throw new Error(`${label}: status "${status}" must not carry an output (output is for completed steps only)`);
  }
  if (!Array.isArray(raw.usage)) {
    throw new Error(`${label}.usage: must be an array of usage-receipt.v1 (got ${typeName(raw.usage)})`);
  }
  if (raw.usage.length > AGENT_STEP_BOUNDS.usageMaxItems) {
    throw new Error(`${label}.usage: at most ${AGENT_STEP_BOUNDS.usageMaxItems} receipts (got ${raw.usage.length})`);
  }
  if (raw.usage.length === 0 && status !== "infra_error") {
    throw new Error(`${label}: usage may be empty ONLY for status "infra_error" (status "${status}" reached a provider and must record receipts — the non-silent-zero rule)`);
  }
  const usage = raw.usage.map((receipt, i) => validateUsageReceipt(receipt));
  const result: AgentStepResult = { schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status, usage };
  if (hasOutput) result.output = raw.output;
  if (raw.failure !== undefined) result.failure = validateFailure(raw.failure, `${label}.failure`);
  return result;
}

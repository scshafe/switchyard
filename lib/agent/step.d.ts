import { type ArtifactRef, type ContractId } from "../contracts/artifact.js";
import { type UsageReceipt } from "../contracts/usage-receipt.js";
export declare const AGENT_STEP_REQUEST_SCHEMA_VERSION = "agent-step-request.v1";
export declare const AGENT_STEP_RESULT_SCHEMA_VERSION = "agent-step-result.v1";
export declare const AGENT_STEP_STATUSES: readonly ["completed", "failed", "timed_out", "infra_error"];
export type AgentStepStatus = (typeof AGENT_STEP_STATUSES)[number];
export declare const AGENT_STEP_BOUNDS: Readonly<{
    instructionsMaxLength: 100000;
    inputArtifactsMaxItems: 64;
    idempotencyKeyMaxLength: 512;
    deadlineMsMin: 1;
    deadlineMsMax: 86400000;
    usageMaxItems: 256;
    failureKindMaxLength: 160;
    failureDetailMaxLength: 8000;
    budgetMaxTokens: 10000000;
    budgetMaxCostMicroUsd: 100000000000;
    budgetMaxElapsedMs: 86400000;
}>;
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
/** LOUD validator for a frozen agent-step-request.v1. Returns a fresh value. */
export declare function validateAgentStepRequest(value: unknown): AgentStepRequest;
/**
 * LOUD validator for a frozen agent-step-result.v1: the status/output coupling
 * (completed ⇔ output present), the required usage array with the non-silent-
 * zero floor on every element, and the empty-usage-only-for-infra_error rule.
 */
export declare function validateAgentStepResult(value: unknown): AgentStepResult;

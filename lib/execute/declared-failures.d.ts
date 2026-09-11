import { type ArtifactEnvelope } from "../contracts/artifact.js";
import { type UsageReceipt } from "../contracts/usage-receipt.js";
import { type MissionPipelineNodeBindingRef } from "../graph/definition.js";
import { type ExecutionFailure } from "./failure.js";
import { type AgentNodePort, type AgentNodeTurnCompletion, type CodeNodePort, type ModelNodePort, type ModelNodeTurnCompletion, type UnmeteredNodeTurnCompletion, type WorkerNodeTurnContext } from "./ports.js";
export type DeclaredFailurePortKind = "code" | "model" | "agent";
export type DeclaredFailureOperation = "code_run" | "model_invoke" | "agent_submit" | "agent_await";
export type DeclaredFailureAdmission = "unknown" | "not_admitted" | "admitted";
/** Invocation-local capability, supplied as the port's trailing argument. */
export interface DeclaredFailureEvidenceCapture {
    /** Explicit host knowledge only. An admitted invocation cannot be downgraded. */
    readonly setAdmission: (admission: DeclaredFailureAdmission) => void;
    /** Append one validated receipt (at most one for model, 256 for agent). */
    readonly recordUsage: (receipt: UsageReceipt) => void;
    /** Pending/interrupted work must remain unresolved, even with a typed error. */
    readonly markUnresolved: () => void;
}
export interface DeclaredFailureEvidence {
    readonly admission: DeclaredFailureAdmission;
    readonly usage: readonly UsageReceipt[];
}
/** Detached policy input. The error object itself never grants evidence. */
export interface DeclaredFailureInvocation {
    readonly kind: DeclaredFailurePortKind;
    readonly operation: DeclaredFailureOperation;
    readonly input: unknown;
    readonly context: WorkerNodeTurnContext;
    readonly binding?: MissionPipelineNodeBindingRef;
    readonly failure: ExecutionFailure;
    readonly evidence: DeclaredFailureEvidence;
}
export interface DeclaredFailureCodePort {
    readonly run: (input: unknown, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<UnmeteredNodeTurnCompletion>;
}
export interface DeclaredFailureModelPort {
    readonly invoke: (input: unknown, binding: MissionPipelineNodeBindingRef, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<ModelNodeTurnCompletion>;
}
export interface DeclaredFailureAgentPort {
    readonly submitTurnIntent: (input: unknown, context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<void>;
    readonly awaitSettledResult: (context: WorkerNodeTurnContext, evidence: DeclaredFailureEvidenceCapture) => Promise<AgentNodeTurnCompletion>;
}
export interface DeclaredFailureOptions<K extends DeclaredFailurePortKind> {
    readonly kind: K;
    readonly outcomes: Readonly<Record<string, string>>;
    readonly artifact: (invocation: DeclaredFailureInvocation) => ArtifactEnvelope | Promise<ArtifactEnvelope>;
}
export interface DeclaredFailureCodeOptions extends DeclaredFailureOptions<"code"> {
    readonly receipt?: never;
}
export interface DeclaredFailureModelOptions extends DeclaredFailureOptions<"model"> {
    /** Used only when no validated receipt was captured. No receipt is synthesized by the helper. */
    readonly receipt: (invocation: DeclaredFailureInvocation) => readonly [UsageReceipt] | Promise<readonly [UsageReceipt]>;
}
export interface DeclaredFailureAgentOptions extends DeclaredFailureOptions<"agent"> {
    /** Used only when no receipts were captured; omission explicitly permits an empty collection. */
    readonly receipt?: (invocation: DeclaredFailureInvocation) => readonly UsageReceipt[] | Promise<readonly UsageReceipt[]>;
}
/** @internal Exact-attempt lookup used by the runner. No public error usage is trusted. */
export declare function declaredFailureRecoveryUsage(error: unknown, nodeId: string, idempotencyKey: string): readonly UsageReceipt[] | undefined;
export declare function withDeclaredFailureOutcomes(port: DeclaredFailureCodePort, options: DeclaredFailureCodeOptions): CodeNodePort;
export declare function withDeclaredFailureOutcomes(port: DeclaredFailureModelPort, options: DeclaredFailureModelOptions): ModelNodePort;
export declare function withDeclaredFailureOutcomes(port: DeclaredFailureAgentPort, options: DeclaredFailureAgentOptions): AgentNodePort;

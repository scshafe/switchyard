import type { ArtifactEnvelope } from "../contracts/artifact.js";
import type { UsageReceipt } from "../contracts/usage-receipt.js";
import { type MissionPipelineNode, type MissionPipelineNodeRef } from "../graph/definition.js";
import { type AgentNodePort, type CodeNodePort, type ModelNodePort, type NodeTurnCompletion, type WorkerNodeTurnContext } from "./ports.js";
export declare const NODE_EXECUTION_CONFIGURATION_FINGERPRINT: "default";
export interface NodeTurnIdempotencyInput {
    readonly unitId: string;
    readonly nodeId: string;
    readonly attemptNumber: number;
    readonly nodeRef: MissionPipelineNodeRef;
    readonly fingerprint: string;
    readonly inputDigest: string;
    readonly executionIdentityDigest?: string;
}
/**
 * The exact below-N0 fingerprint formula recorded in the phase plan. The
 * configuration slot was sealed as the constant `"default"` before 1.1.0; a
 * node that declares a configuration ref fills it with that ref's digest, and
 * a node that declares none is byte-identical to before.
 */
export declare function nodeExecutionFingerprint(nodeRaw: unknown): string;
/**
 * Stable physical-attempt identity. Field names and optional-field omission are
 * binding: changing any included coordinate changes the digest.
 */
export declare function nodeTurnIdempotencyKey(inputRaw: unknown): string;
/** Conflict seal for one validated completion under one attempt key. */
export declare function nodeTurnCompletionDigest(completionRaw: unknown): string;
/**
 * Receipt evidence captured by a branded result error for this exact physical
 * attempt. A real brand replayed from another node/attempt carries no
 * authority here.
 */
export declare function nodeTurnResultErrorUsage(value: unknown, nodeId: string, idempotencyKey: string): readonly UsageReceipt[] | undefined;
/** A worker claim exposed a human/callback wait to an executable worker. */
export declare class WorkerNodeKindError extends Error {
    readonly code = "worker_node_kind_rejected";
    readonly nodeId: string;
    constructor(nodeId: string, kind: string);
}
export type NodeTurnInvocationUncertainOperation = "agent_submit" | "agent_await";
export interface NodeTurnInvocationUncertain {
    readonly code: "node_turn_invocation_uncertain";
    readonly operation: NodeTurnInvocationUncertainOperation;
}
/** Brand check used at the runner boundary; safe for hostile thrown Proxies. */
export declare function isNodeTurnInvocationUncertainError(value: unknown, nodeId?: string, idempotencyKey?: string): value is NodeTurnInvocationUncertain;
export interface WorkerNodePorts {
    readonly code?: CodeNodePort;
    readonly model?: ModelNodePort;
    readonly agent?: AgentNodePort;
}
export interface ExecuteNodeTurnAttemptInput {
    readonly node: MissionPipelineNode;
    readonly context: WorkerNodeTurnContext;
    readonly inputArtifact: ArtifactEnvelope;
    readonly ports: WorkerNodePorts;
    readonly executionIdentityDigest?: string;
}
/**
 * Invoke exactly one worker-executable node attempt. Human and callback nodes
 * are rejected before any capability lookup or invocation.
 */
export declare function executeNodeTurnAttempt(inputRaw: ExecuteNodeTurnAttemptInput): Promise<NodeTurnCompletion>;

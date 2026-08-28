import { type ArtifactEnvelope, type ArtifactRef } from "../contracts/artifact.js";
import { type UsageReceipt } from "../contracts/usage-receipt.js";
import { type GraphDefinitionRef, type MissionPipelineNode, type MissionPipelineNodeBindingRef, type MissionPipelineNodeKind, type MissionPipelineNodeRef } from "../graph/definition.js";
export declare const MAX_AGENT_TURN_USAGE_RECEIPTS = 256;
export declare const ENGINE_JOIN_UNSATISFIABLE_OUTCOME: "join_unsatisfiable";
/** Minimal immutable attempt context visible to a worker-side node body. */
export interface WorkerNodeTurnContext {
    readonly graph: GraphDefinitionRef;
    /** Durable identity of this particular queued occurrence. */
    readonly queueId: string;
    readonly unitId: string;
    readonly nodeId: string;
    readonly nodeRef: MissionPipelineNodeRef;
    readonly attemptNumber: number;
    /** 1-based retry ordinal within this queue occurrence. */
    readonly attemptIndex: number;
    readonly idempotencyKey: string;
    /** Content identity only; the validated payload is the port's first argument. */
    readonly inputArtifact: ArtifactRef;
    readonly signal?: AbortSignal;
}
/** Canonical ordinary host completion. Routing remains engine-owned. */
export interface NodeTurnCompletion {
    readonly outcome: string;
    readonly outputArtifact?: ArtifactEnvelope;
    readonly usage?: readonly UsageReceipt[];
}
export interface UnmeteredNodeTurnCompletion extends NodeTurnCompletion {
    readonly usage?: never;
}
export interface ModelNodeTurnCompletion extends NodeTurnCompletion {
    /** A model turn records exactly one validated receipt. */
    readonly usage: readonly [UsageReceipt];
}
export interface AgentNodeTurnCompletion extends NodeTurnCompletion {
    /** Agent receipt collection is explicit and bounded; omission means none. */
    readonly usage?: readonly UsageReceipt[];
}
export type NodePortCompletion<K extends MissionPipelineNodeKind> = K extends "model" ? ModelNodeTurnCompletion : K extends "agent" ? AgentNodeTurnCompletion : UnmeteredNodeTurnCompletion;
/**
 * Opaque two-stage completion snapshot. `usage` is validated first so a turn
 * executor can durably collect billable evidence before it validates the
 * ordinary outcome/artifact fields. Callers cannot forge a trusted snapshot.
 */
export interface NodeTurnCompletionSnapshot {
    readonly value: Readonly<Record<string, unknown>>;
    readonly usage: readonly UsageReceipt[];
    readonly hasUsage: boolean;
}
/** Base typed failure carrying every receipt validated before ordinary output failed. */
export declare class NodeTurnCompletionError extends Error {
    readonly usage: readonly UsageReceipt[];
    constructor(name: string, message: string, usage: readonly UsageReceipt[], cause: unknown);
}
/** Descriptor/detachment failure after receipt-first extraction. */
export declare class NodeTurnCompletionSnapshotError extends NodeTurnCompletionError {
    constructor(message: string, usage: readonly UsageReceipt[], cause: unknown);
}
/** Outcome/artifact/node-contract failure after receipt-first extraction. */
export declare class NodeTurnCompletionValidationError extends NodeTurnCompletionError {
    constructor(message: string, usage: readonly UsageReceipt[], cause: unknown);
}
/**
 * Descriptor-safely snapshot an untrusted port result exactly once, then
 * extract and validate usage before any outcome or artifact interpretation.
 */
export declare function snapshotNodeTurnCompletion(value: unknown, label?: string): NodeTurnCompletionSnapshot;
/**
 * Validate an ordinary host result against the exact node contract.
 * `join_unsatisfiable` is engine-produced and can never be claimed by a host
 * body. Extra routing/spawn/timer keys fail under the closed result shape.
 */
export declare function validateNodeTurnCompletion<K extends MissionPipelineNodeKind>(nodeRaw: MissionPipelineNode & {
    readonly kind: K;
}, value: unknown | NodeTurnCompletionSnapshot, label?: string): NodePortCompletion<K>;
/** Alias emphasizing that the validated value came from a host port. */
export declare const snapshotNodePortResult: typeof validateNodeTurnCompletion;
/** Capture a caller-owned worker context without invoking accessors. */
export declare function snapshotWorkerNodeTurnContext(value: unknown, label?: string): WorkerNodeTurnContext;
/** In-process body; adapters can pass `input` directly to an existing Stage.run. */
export interface CodeNodePort {
    readonly run: (input: unknown, context: WorkerNodeTurnContext) => Promise<UnmeteredNodeTurnCompletion>;
}
/** Provider-facing model attempt; binding resolution and journaling stay host-side. */
export interface ModelNodePort {
    readonly invoke: (input: unknown, binding: MissionPipelineNodeBindingRef, context: WorkerNodeTurnContext) => Promise<ModelNodeTurnCompletion>;
}
/** Structural asynchronous agent turn port; the stable context keys both calls. */
export interface AgentNodePort {
    readonly submitTurnIntent: (input: unknown, context: WorkerNodeTurnContext) => Promise<void>;
    readonly awaitSettledResult: (context: WorkerNodeTurnContext) => Promise<AgentNodeTurnCompletion>;
}
/** Audit attribution only. It is deliberately not an authorization grant. */
export interface NodeTurnActorAttribution {
    readonly actorId: string;
}
export interface HumanNodeDecision {
    readonly queueId: string;
    readonly unitId: string;
    readonly nodeId: string;
    readonly outcome: string;
    readonly outputArtifact?: ArtifactEnvelope;
    readonly actor: NodeTurnActorAttribution;
}
export interface CallbackNodeEvent {
    readonly queueId: string;
    readonly unitId: string;
    readonly nodeId: string;
    readonly outcome: string;
    readonly outputArtifact: ArtifactEnvelope;
    readonly actor: NodeTurnActorAttribution;
}
/**
 * Human and callback implementations receive authenticated authority as a
 * separate host-owned capability argument. A caller-authored actorId is only
 * journey attribution and can never satisfy the principal check by itself.
 */
export interface HumanNodePort<TAuthenticatedPrincipal = unknown> {
    readonly recordDecision: (decision: HumanNodeDecision, authenticatedPrincipal: TAuthenticatedPrincipal) => Promise<void>;
}
export interface CallbackNodePort<TAuthenticatedPrincipal = unknown> {
    readonly admitEvent: (event: CallbackNodeEvent, authenticatedPrincipal: TAuthenticatedPrincipal) => Promise<void>;
}

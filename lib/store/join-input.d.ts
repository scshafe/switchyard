import { type ArtifactEnvelope } from "../contracts/artifact.js";
import { JOIN_INPUT_ARTIFACT_CONTRACT, type GraphDefinitionRef, type JoinRequirement, type MissionPipelineNodeConfigurationRef, type MissionPipelineNodeRef } from "../graph/definition.js";
export interface JoinInputAcceptedOffer {
    readonly edgeId: string;
    readonly sourceNodeId: string;
    readonly sourceNodeRef: MissionPipelineNodeRef;
    readonly sourceConfiguration?: MissionPipelineNodeConfigurationRef;
    /** Absent only for an engine-authored join_unsatisfiable source. */
    readonly sourceQueueId?: string;
    readonly sourceEvidenceDigest: string;
    readonly offeredAt: string;
    readonly artifact: ArtifactEnvelope;
}
export interface JoinInputPayload {
    readonly schemaVersion: typeof JOIN_INPUT_ARTIFACT_CONTRACT;
    readonly unitId: string;
    readonly graph: GraphDefinitionRef;
    readonly nodeId: string;
    readonly nodeRef: MissionPipelineNodeRef;
    readonly configuration?: MissionPipelineNodeConfigurationRef;
    readonly require: JoinRequirement;
    /** Only accepted offers, in the graph's sealed join.inbound order. */
    readonly accepted: readonly JoinInputAcceptedOffer[];
}
export interface CreateJoinInputArtifactInput {
    readonly unitId: string;
    readonly nodeId: string;
    readonly accepted: readonly Omit<JoinInputAcceptedOffer, "sourceNodeRef" | "sourceConfiguration">[];
}
/**
 * Construct from accepted evidence supplied by a store, deriving every graph
 * identity. This validates document identity; a store must also prove each
 * source queue/evidence digest is retained and actually offered that artifact.
 */
export declare function createJoinInputArtifact(definition: unknown, input: CreateJoinInputArtifactInput): ArtifactEnvelope & {
    readonly payload: JoinInputPayload;
};
/** Validate shape, seal, embedded payloads, order, and exact graph identities. */
export declare function validateJoinInputArtifact(definition: unknown, value: unknown): ArtifactEnvelope & {
    readonly payload: JoinInputPayload;
};

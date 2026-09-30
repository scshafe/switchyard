// Opt-in, engine-authored aggregation input. Payloads are embedded so a join
// body needs no store capability. Target queue ids are deliberately absent:
// identical accepted evidence has the same identity in either arrival order.

import {
  createArtifactEnvelope,
  validateArtifactEnvelope,
  type ArtifactEnvelope
} from "../contracts/artifact.js";
import { canonicalJson } from "../contracts/digest.js";
import { compileGraph } from "../graph/compile.js";
import {
  JOIN_INPUT_ARTIFACT_CONTRACT,
  JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
  MAX_JOIN_INBOUND_EDGES,
  type GraphDefinitionRef,
  type JoinRequirement,
  type SwitchyardNodeConfigurationRef,
  type SwitchyardNodeRef
} from "../graph/definition.js";
import { captureCapabilityRecord, captureDenseArrayItems } from "../internal/capability.js";
import {
  assertEvidenceString,
  snapshotBoundedValidationData
} from "../internal/evidence.js";
import { assertIdentifier, assertSha256Hex } from "../internal/guards.js";
import { outcomePredicateMatches } from "./routing.js";

export interface JoinInputAcceptedOffer {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly sourceNodeRef: SwitchyardNodeRef;
  readonly sourceConfiguration?: SwitchyardNodeConfigurationRef;
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
  readonly nodeRef: SwitchyardNodeRef;
  readonly configuration?: SwitchyardNodeConfigurationRef;
  readonly require: JoinRequirement;
  /** Only accepted offers, in the graph's sealed join.inbound order. */
  readonly accepted: readonly JoinInputAcceptedOffer[];
}

export interface CreateJoinInputArtifactInput {
  readonly unitId: string;
  readonly nodeId: string;
  readonly accepted: readonly Omit<JoinInputAcceptedOffer, "sourceNodeRef" | "sourceConfiguration">[];
}

/** The aggregate envelope shares the ordinary artifact budget, not one per leg. */
const JOIN_INPUT_LIMITS = Object.freeze({
  maxDepth: 64,
  maxValues: 250_000,
  maxStringCodeUnits: 16_777_216
});

const OFFER_KEYS = [
  "edgeId", "sourceNodeId", "sourceQueueId", "sourceEvidenceDigest", "offeredAt", "artifact"
] as const;
const PAYLOAD_KEYS = [
  "schemaVersion", "unitId", "graph", "nodeId", "nodeRef", "configuration", "require", "accepted"
] as const;

function offeredAt(value: unknown, label: string): string {
  const result = assertEvidenceString(value, label);
  const epoch = Date.parse(result);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== result) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return result;
}

/** Called only after bounded descriptor-safe artifact validation. */
function publicSnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(publicSnapshot)) as T;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) result[key] = publicSnapshot(child);
  return Object.freeze(result) as T;
}

/**
 * Construct from accepted evidence supplied by a store, deriving every graph
 * identity. This validates document identity; a store must also prove each
 * source queue/evidence digest is retained and actually offered that artifact.
 */
export function createJoinInputArtifact(
  definition: unknown,
  input: CreateJoinInputArtifactInput
): ArtifactEnvelope & { readonly payload: JoinInputPayload } {
  const compiled = compileGraph(definition);
  const label = "join input";
  const snapshot = snapshotBoundedValidationData(input, label, JOIN_INPUT_LIMITS);
  const raw = captureCapabilityRecord(snapshot, ["unitId", "nodeId", "accepted"], ["unitId", "nodeId", "accepted"], label);
  const unitId = assertEvidenceString(raw.unitId, `${label}.unitId`);
  const nodeId = assertIdentifier(raw.nodeId, `${label}.nodeId`);
  const node = compiled.nodesById[nodeId];
  if (node?.join?.compose !== "envelope" || node.input !== JOIN_INPUT_ARTIFACT_CONTRACT) {
    throw new Error(`${label}: node ${nodeId} is not an envelope join`);
  }
  const items = captureDenseArrayItems(raw.accepted, `${label}.accepted`, MAX_JOIN_INBOUND_EDGES);
  const required = node.join.require === "all" ? node.join.inbound.length : node.join.require.nOf;
  if (items.length < required || items.length > node.join.inbound.length) {
    throw new Error(`${label}.accepted does not satisfy the sealed join requirement`);
  }
  const byEdge = new Map<string, JoinInputAcceptedOffer>();
  items.forEach((item, index) => {
    const itemLabel = `${label}.accepted[${index}]`;
    const offer = captureCapabilityRecord(item, OFFER_KEYS, OFFER_KEYS.filter((key) => key !== "sourceQueueId"), itemLabel);
    const edgeId = assertIdentifier(offer.edgeId, `${itemLabel}.edgeId`);
    const sourceNodeId = assertIdentifier(offer.sourceNodeId, `${itemLabel}.sourceNodeId`);
    const edge = compiled.edgesById[edgeId];
    const source = compiled.nodesById[sourceNodeId];
    if (!node.join!.inbound.includes(edgeId) || edge?.from !== sourceNodeId || source === undefined) {
      throw new Error(`${itemLabel}: source edge/node conflicts with sealed join inbound`);
    }
    if (byEdge.has(edgeId)) throw new Error(`${itemLabel}: duplicate accepted edge ${edgeId}`);
    const artifact = validateArtifactEnvelope(offer.artifact);
    const sourceQueueId = Object.hasOwn(offer, "sourceQueueId")
      ? assertEvidenceString(offer.sourceQueueId, `${itemLabel}.sourceQueueId`)
      : undefined;
    if (sourceQueueId === undefined && (
      source.join === undefined
      || artifact.contractId !== JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT
      || !outcomePredicateMatches(edge.when, "join_unsatisfiable", artifact)
    )) {
      throw new Error(`${itemLabel}.sourceQueueId is required for an ordinary source turn`);
    }
    if (sourceQueueId === undefined) {
      const synthetic = captureCapabilityRecord(
        artifact.payload,
        ["schemaVersion", "unitId", "graph", "nodeId", "require", "accepted", "impossible", "causeEvidenceDigest", "resolvedAt"],
        ["schemaVersion", "unitId", "graph", "nodeId", "require", "accepted", "impossible", "causeEvidenceDigest", "resolvedAt"],
        `${itemLabel}.artifact.payload`
      );
      if (
        synthetic.schemaVersion !== JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT
        || synthetic.unitId !== unitId
        || synthetic.nodeId !== sourceNodeId
        || canonicalJson(synthetic.graph) !== canonicalJson(compiled.graph)
        || canonicalJson(synthetic.require) !== canonicalJson(source.join!.require)
        || synthetic.resolvedAt !== offer.offeredAt
      ) {
        throw new Error(`${itemLabel}: synthetic artifact identity conflicts with source unit/graph/join`);
      }
    }
    byEdge.set(edgeId, {
      edgeId,
      sourceNodeId,
      sourceNodeRef: source.ref,
      ...(source.configuration === undefined ? {} : { sourceConfiguration: source.configuration }),
      ...(sourceQueueId === undefined ? {} : { sourceQueueId }),
      sourceEvidenceDigest: assertSha256Hex(offer.sourceEvidenceDigest, `${itemLabel}.sourceEvidenceDigest`),
      offeredAt: offeredAt(offer.offeredAt, `${itemLabel}.offeredAt`),
      artifact
    });
  });
  const payload: JoinInputPayload = {
    schemaVersion: JOIN_INPUT_ARTIFACT_CONTRACT,
    unitId,
    graph: compiled.graph,
    nodeId,
    nodeRef: node.ref,
    ...(node.configuration === undefined ? {} : { configuration: node.configuration }),
    require: node.join.require,
    accepted: node.join.inbound.flatMap((edgeId) => {
      const offer = byEdge.get(edgeId);
      return offer === undefined ? [] : [offer];
    })
  };
  return publicSnapshot(validateArtifactEnvelope(createArtifactEnvelope(JOIN_INPUT_ARTIFACT_CONTRACT, payload))) as ArtifactEnvelope & { readonly payload: JoinInputPayload };
}

/** Validate shape, seal, embedded payloads, order, and exact graph identities. */
export function validateJoinInputArtifact(
  definition: unknown,
  value: unknown
): ArtifactEnvelope & { readonly payload: JoinInputPayload } {
  const artifact = validateArtifactEnvelope(value);
  if (artifact.contractId !== JOIN_INPUT_ARTIFACT_CONTRACT) {
    throw new Error(`join input artifact: expected ${JOIN_INPUT_ARTIFACT_CONTRACT}`);
  }
  const raw = captureCapabilityRecord(artifact.payload, PAYLOAD_KEYS, PAYLOAD_KEYS.filter((key) => key !== "configuration"), "join input payload");
  const accepted = captureDenseArrayItems(raw.accepted, "join input payload.accepted", MAX_JOIN_INBOUND_EDGES)
    .map((item, index) => {
      const offer = captureCapabilityRecord(
        item,
        [...OFFER_KEYS, "sourceNodeRef", "sourceConfiguration"],
        [...OFFER_KEYS.filter((key) => key !== "sourceQueueId"), "sourceNodeRef"],
        `join input payload.accepted[${index}]`
      );
      return Object.fromEntries(OFFER_KEYS.filter((key) => Object.hasOwn(offer, key)).map((key) => [key, offer[key]]));
    });
  const expected = createJoinInputArtifact(definition, { unitId: raw.unitId, nodeId: raw.nodeId, accepted } as unknown as CreateJoinInputArtifactInput);
  if (canonicalJson(raw) !== canonicalJson(expected.payload)) {
    throw new Error("join input payload: identity, provenance, or sealed inbound order mismatch");
  }
  return publicSnapshot(artifact) as ArtifactEnvelope & { readonly payload: JoinInputPayload };
}

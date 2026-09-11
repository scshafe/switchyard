// store/graph-store.ts — the immutable v2 graph-publication port.
//
// Published graphs are append-only evidence. A graph identity is the pair
// `(graphId, version)` and may be replayed only with the identical digest.
// Loads require the full digest-bearing reference so a stale or substituted
// definition cannot be mistaken for the graph a unit pinned at admission.
import { declaredNodeOutputs, validateMissionPipelineNode } from "../graph/definition.js";
import { assertIdentifier, assertSafePositiveInt, assertSha256Hex } from "../internal/guards.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { deepFrozenClone } from "../internal/evidence.js";
const GRAPH_REF_KEYS = new Set(["id", "version", "digest"]);
/** Validate, detach, and freeze a digest-bearing graph reference. */
export function validateGraphDefinitionRef(value, label = "graph definition ref") {
    const keys = [...GRAPH_REF_KEYS];
    const raw = captureCapabilityRecord(value, keys, keys, label);
    return deepFrozenClone({
        id: assertIdentifier(raw.id, `${label}.id`),
        version: assertSafePositiveInt(raw.version, `${label}.version`),
        digest: assertSha256Hex(raw.digest, `${label}.digest`)
    }, label);
}
/** Canonical signature used by every GraphStore implementation. */
export function nodeDefinitionSignature(node) {
    const validated = validateMissionPipelineNode(node, "node definition signature input");
    const outputs = declaredNodeOutputs(validated);
    return deepFrozenClone({
        kind: validated.kind,
        input: validated.input,
        outcomes: [...validated.outcomes.outcomes].sort(),
        ...(outputs === undefined
            ? {}
            : {
                outputs: Object.fromEntries(Object.keys(outputs).sort().map((outcome) => [outcome, outputs[outcome]]))
            })
    }, `node definition ${validated.ref.id}@${validated.ref.version} signature`);
}
/** Field-by-field signature comparison every GraphStore implementation must apply. */
export function nodeDefinitionSignatureConflict(published, requested) {
    if (published.kind !== requested.kind)
        return "kind";
    if (published.input !== requested.input)
        return "input contract";
    if (published.outcomes.length !== requested.outcomes.length
        || published.outcomes.some((outcome, index) => outcome !== requested.outcomes[index])) {
        return "outcome vocabulary";
    }
    const publishedOutputs = Object.hasOwn(published, "outputs") ? published.outputs : undefined;
    const requestedOutputs = Object.hasOwn(requested, "outputs") ? requested.outputs : undefined;
    if (publishedOutputs === undefined || requestedOutputs === undefined) {
        return publishedOutputs === requestedOutputs ? undefined : "output contracts";
    }
    const publishedKeys = Object.keys(publishedOutputs);
    if (publishedKeys.length !== Object.keys(requestedOutputs).length
        || publishedKeys.some((outcome) => !Object.hasOwn(requestedOutputs, outcome) || requestedOutputs[outcome] !== publishedOutputs[outcome])) {
        return "output contracts";
    }
    return undefined;
}
/** A sealed graph failed semantic compilation before publication. */
export class GraphPublicationValidationError extends Error {
    code = "graph_publication_invalid";
    graphId;
    graphVersion;
    constructor(graphId, graphVersion, detail, cause) {
        super(`publishGraph: graph ${graphId}@${graphVersion} rejected before publication: ${detail}`, { cause });
        this.name = "GraphPublicationValidationError";
        this.graphId = graphId;
        this.graphVersion = graphVersion;
        Object.freeze(this);
    }
}
/** A graph identity was already sealed to a different digest. */
export class GraphPublicationConflictError extends Error {
    code = "graph_publication_conflict";
    graphId;
    graphVersion;
    publishedDigest;
    requestedDigest;
    constructor(graphId, graphVersion, publishedDigest, requestedDigest) {
        super(`publishGraph: graph ${graphId}@${graphVersion} is already published with digest ${publishedDigest}; requested digest ${requestedDigest} conflicts with immutable evidence`);
        this.name = "GraphPublicationConflictError";
        this.graphId = graphId;
        this.graphVersion = graphVersion;
        this.publishedDigest = publishedDigest;
        this.requestedDigest = requestedDigest;
        Object.freeze(this);
    }
}
/** A load named an existing graph identity but supplied the wrong digest. */
export class GraphLoadDigestConflictError extends Error {
    code = "graph_load_digest_conflict";
    graphId;
    graphVersion;
    publishedDigest;
    requestedDigest;
    constructor(graphId, graphVersion, publishedDigest, requestedDigest) {
        super(`loadGraph: graph ${graphId}@${graphVersion} is published with digest ${publishedDigest}; requested digest ${requestedDigest} conflicts with the sealed graph`);
        this.name = "GraphLoadDigestConflictError";
        this.graphId = graphId;
        this.graphVersion = graphVersion;
        this.publishedDigest = publishedDigest;
        this.requestedDigest = requestedDigest;
        Object.freeze(this);
    }
}
/** One node ref/version was given a different definition-bound meaning. */
export class NodeDefinitionPublicationConflictError extends Error {
    code = "node_definition_publication_conflict";
    nodeRefId;
    nodeRefVersion;
    field;
    publishedBy;
    requestedBy;
    constructor(input) {
        super(`publishGraph: node definition ${input.nodeRefId}@${input.nodeRefVersion} conflicts in ${input.field}; first published by graph ${input.publishedBy.id}@${input.publishedBy.version} (${input.publishedBy.digest}), requested by graph ${input.requestedBy.id}@${input.requestedBy.version} (${input.requestedBy.digest}); change the node version`);
        this.name = "NodeDefinitionPublicationConflictError";
        this.nodeRefId = input.nodeRefId;
        this.nodeRefVersion = input.nodeRefVersion;
        this.field = input.field;
        this.publishedBy = deepFrozenClone(input.publishedBy, "published node definition graph ref");
        this.requestedBy = deepFrozenClone(input.requestedBy, "requested node definition graph ref");
        Object.freeze(this);
    }
}

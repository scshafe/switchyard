// execute/ports.ts — strict host ports for one v2 node turn.
//
// These are capability seams, not implementations. Mission Pipeline supplies
// a minimal, frozen context and an already contract-validated input payload;
// hosts bind the code/model/agent bodies and the authenticated human/callback
// completion paths. No port receives graph routing, store, lease-token,
// credential, unit-admission, timer, or unit-spawning authority.
import { types as nodeTypes } from "node:util";
import { snapshotArtifactValidationData, validateArtifactEnvelope, validateArtifactRef } from "../contracts/artifact.js";
import { validateUsageReceipt } from "../contracts/usage-receipt.js";
import {} from "../graph/definition.js";
import { snapshotGraphValidationData } from "../graph/limits.js";
import { assertIdentifier, assertPlainObject, assertRequiredKeys, assertSafePositiveInt, assertSha256Hex, assertStrictKeys, isPlainObject, typeName } from "../internal/guards.js";
import { assertEvidenceString, deepFrozenClone } from "../internal/evidence.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { validateMissionPipelineNode } from "../graph/definition.js";
export const MAX_AGENT_TURN_USAGE_RECEIPTS = 256;
export const ENGINE_JOIN_UNSATISFIABLE_OUTCOME = "join_unsatisfiable";
const completionSnapshots = new WeakSet();
const COMPLETION_KEYS = new Set(["outcome", "outputArtifact", "usage"]);
const COMPLETION_REQUIRED_KEYS = new Set(["outcome"]);
/** Base typed failure carrying every receipt validated before ordinary output failed. */
export class NodeTurnCompletionError extends Error {
    usage;
    constructor(name, message, usage, cause) {
        super(message, { cause });
        this.name = name;
        // Subclasses that expose this as trusted evidence validate it before
        // branding. Do not iterate caller-owned input in this base constructor.
        this.usage = usage;
    }
}
/** Descriptor/detachment failure after receipt-first extraction. */
export class NodeTurnCompletionSnapshotError extends NodeTurnCompletionError {
    constructor(message, usage, cause) {
        super("NodeTurnCompletionSnapshotError", message, usage, cause);
    }
}
/** Outcome/artifact/node-contract failure after receipt-first extraction. */
export class NodeTurnCompletionValidationError extends NodeTurnCompletionError {
    constructor(message, usage, cause) {
        super("NodeTurnCompletionValidationError", message, usage, cause);
    }
}
function safeValidationMessage(error, fallback) {
    if (error === null
        || (typeof error !== "object" && typeof error !== "function")
        || nodeTypes.isProxy(error))
        return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor !== undefined
        && "value" in descriptor
        && typeof descriptor.value === "string"
        ? descriptor.value
        : fallback;
}
function snapshotUsageReceipts(value, label) {
    const accepted = [];
    try {
        if (!Array.isArray(value)
            || nodeTypes.isProxy(value)
            || Object.getPrototypeOf(value) !== Array.prototype) {
            throw new Error(`${label}: must be a plain non-Proxy dense array of usage-receipt.v1`);
        }
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (lengthDescriptor === undefined
            || !("value" in lengthDescriptor)
            || typeof lengthDescriptor.value !== "number"
            || !Number.isSafeInteger(lengthDescriptor.value)
            || lengthDescriptor.value < 0) {
            throw new Error(`${label}.length must be a non-negative safe-integer data property`);
        }
        const length = lengthDescriptor.value;
        if (length > MAX_AGENT_TURN_USAGE_RECEIPTS) {
            throw new Error(`${label}: at most ${MAX_AGENT_TURN_USAGE_RECEIPTS} receipts are allowed (got ${length})`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (let index = 0; index < length; index += 1) {
            const descriptor = Object.hasOwn(descriptors, String(index))
                ? descriptors[String(index)]
                : undefined;
            if (descriptor === undefined
                || !("value" in descriptor)
                || descriptor.enumerable !== true) {
                throw new Error(`${label}[${index}] must be an enumerable data property`);
            }
            accepted.push(deepFrozenClone(validateUsageReceipt(descriptor.value), `${label}[${index}]`));
        }
        const allowedKeys = new Set([
            "length",
            ...Array.from({ length }, (_, index) => String(index))
        ]);
        const extras = Reflect.ownKeys(descriptors).filter((key) => typeof key !== "string" || !allowedKeys.has(key));
        if (extras.length > 0) {
            throw new Error(`${label} must be dense and have no unsupported extra keys`);
        }
        return Object.freeze(accepted);
    }
    catch (error) {
        Object.freeze(accepted);
        throw new NodeTurnCompletionSnapshotError(safeValidationMessage(error, `${label}: usage snapshot failed`), accepted, error);
    }
}
/**
 * Descriptor-safely snapshot an untrusted port result exactly once, then
 * extract and validate usage before any outcome or artifact interpretation.
 */
export function snapshotNodeTurnCompletion(value, label = "node turn completion") {
    if (value === null
        || typeof value !== "object"
        || nodeTypes.isProxy(value)
        || !isPlainObject(value)) {
        throw new Error(`${label}: must be a plain non-Proxy object (got ${typeName(value)})`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    const usageDescriptor = Object.hasOwn(descriptors, "usage")
        ? descriptors.usage
        : undefined;
    const hasUsage = usageDescriptor !== undefined;
    let usage = Object.freeze([]);
    if (hasUsage) {
        if (!("value" in usageDescriptor) || usageDescriptor.enumerable !== true) {
            throw new NodeTurnCompletionSnapshotError(`${label}.usage must be an enumerable data property`, usage, undefined);
        }
        usage = snapshotUsageReceipts(usageDescriptor.value, `${label}.usage`);
    }
    try {
        for (const key of descriptorKeys) {
            if (typeof key !== "string") {
                throw new Error(`${label} has symbol keys`);
            }
            const descriptor = descriptors[key];
            if (!("value" in descriptor) || descriptor.enumerable !== true) {
                throw new Error(`${label}.${key} must be an enumerable data property`);
            }
        }
        const unknown = descriptorKeys.filter((key) => typeof key === "string" && !COMPLETION_KEYS.has(key));
        if (unknown.length > 0) {
            throw new Error(`${label}: unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")} (strict object — allowed: ${[...COMPLETION_KEYS].join(", ")})`);
        }
        // Missing required/optional fields must stay missing even if ambient
        // Object.prototype has been poisoned by unrelated host code.
        const raw = Object.create(null);
        const outcomeDescriptor = Object.hasOwn(descriptors, "outcome")
            ? descriptors.outcome
            : undefined;
        if (outcomeDescriptor !== undefined) {
            Object.defineProperty(raw, "outcome", {
                configurable: false,
                enumerable: true,
                writable: false,
                value: snapshotGraphValidationData(outcomeDescriptor.value, `${label}.outcome`)
            });
        }
        const outputArtifactDescriptor = Object.hasOwn(descriptors, "outputArtifact")
            ? descriptors.outputArtifact
            : undefined;
        if (outputArtifactDescriptor !== undefined) {
            Object.defineProperty(raw, "outputArtifact", {
                configurable: false,
                enumerable: true,
                writable: false,
                // Artifact envelopes own their wider hostile-data budget. Reusing the
                // graph snapshot budget here would silently narrow that public contract.
                value: snapshotArtifactValidationData(outputArtifactDescriptor.value, `${label}.outputArtifact`)
            });
        }
        if (hasUsage) {
            Object.defineProperty(raw, "usage", {
                configurable: false,
                enumerable: true,
                writable: false,
                value: usage
            });
        }
        Object.freeze(raw);
        const result = Object.freeze({ value: raw, usage, hasUsage });
        completionSnapshots.add(result);
        return result;
    }
    catch (error) {
        throw new NodeTurnCompletionSnapshotError(safeValidationMessage(error, `${label}: completion snapshot failed`), usage, error);
    }
}
function asCompletionSnapshot(value, label) {
    if (value !== null
        && typeof value === "object"
        && completionSnapshots.has(value)) {
        return value;
    }
    return snapshotNodeTurnCompletion(value, label);
}
/**
 * Validate an ordinary host result against the exact node contract.
 * `join_unsatisfiable` is engine-produced and can never be claimed by a host
 * body. Extra routing/spawn/timer keys fail under the closed result shape.
 */
export function validateNodeTurnCompletion(nodeRaw, value, label = "node turn completion") {
    const completion = asCompletionSnapshot(value, label);
    try {
        const node = validateMissionPipelineNode(nodeRaw, `${label}: node`);
        const raw = completion.value;
        assertStrictKeys(raw, COMPLETION_KEYS, label);
        assertRequiredKeys(raw, COMPLETION_REQUIRED_KEYS, label);
        if (node.kind === "model") {
            if (!completion.hasUsage || completion.usage.length !== 1) {
                throw new Error(`${label}: model node ${node.nodeId} must return exactly one usage receipt (got ${completion.hasUsage ? completion.usage.length : "none"})`);
            }
        }
        else if (node.kind === "agent") {
            // Explicit 0..256 collection is admitted and already validated above.
        }
        else if (completion.hasUsage) {
            throw new Error(`${label}: ${node.kind} node ${node.nodeId} must not return usage receipts`);
        }
        const outcome = assertIdentifier(raw.outcome, `${label}: outcome`);
        if (outcome === ENGINE_JOIN_UNSATISFIABLE_OUTCOME) {
            throw new Error(`${label}: node ${node.nodeId} outcome ${JSON.stringify(outcome)} is engine-reserved and cannot be returned by a host port`);
        }
        if (!node.outcomes.outcomes.includes(outcome)) {
            throw new Error(`${label}: node ${node.nodeId} returned undeclared outcome ${JSON.stringify(outcome)}`);
        }
        let outputArtifact;
        if (Object.hasOwn(raw, "outputArtifact")) {
            if (raw.outputArtifact === undefined) {
                throw new Error(`${label}.outputArtifact is present but undefined (omit the key instead)`);
            }
            outputArtifact = validateArtifactEnvelope(raw.outputArtifact);
        }
        return deepFrozenClone({
            outcome,
            ...(outputArtifact === undefined ? {} : { outputArtifact }),
            ...(completion.hasUsage ? { usage: completion.usage } : {})
        }, label);
    }
    catch (error) {
        if (error instanceof NodeTurnCompletionError)
            throw error;
        throw new NodeTurnCompletionValidationError(safeValidationMessage(error, `${label}: completion validation failed`), completion.usage, error);
    }
}
/** Alias emphasizing that the validated value came from a host port. */
export const snapshotNodePortResult = validateNodeTurnCompletion;
const CONTEXT_KEYS = [
    "graph",
    "queueId",
    "unitId",
    "nodeId",
    "nodeRef",
    "attemptNumber",
    "attemptIndex",
    "idempotencyKey",
    "inputArtifact",
    "signal"
];
const CONTEXT_REQUIRED_KEYS = CONTEXT_KEYS.filter((key) => key !== "signal");
const GRAPH_REF_KEYS = new Set(["id", "version", "digest"]);
const NODE_REF_KEYS = new Set(["id", "version"]);
function frozenNullRecord(value) {
    return Object.freeze(Object.assign(Object.create(null), value));
}
function snapshotGraphRef(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, GRAPH_REF_KEYS, label);
    assertRequiredKeys(raw, GRAPH_REF_KEYS, label);
    return frozenNullRecord({
        id: assertIdentifier(raw.id, `${label}.id`),
        version: assertSafePositiveInt(raw.version, `${label}.version`),
        digest: assertSha256Hex(raw.digest, `${label}.digest`)
    });
}
function snapshotNodeRef(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, NODE_REF_KEYS, label);
    assertRequiredKeys(raw, NODE_REF_KEYS, label);
    return frozenNullRecord({
        id: assertIdentifier(raw.id, `${label}.id`),
        version: assertSafePositiveInt(raw.version, `${label}.version`)
    });
}
/** Capture a caller-owned worker context without invoking accessors. */
export function snapshotWorkerNodeTurnContext(value, label = "worker node turn context") {
    const raw = captureCapabilityRecord(value, CONTEXT_KEYS, CONTEXT_REQUIRED_KEYS, label);
    const signal = raw.signal;
    if (signal !== undefined
        && (signal === null
            || typeof signal !== "object"
            || nodeTypes.isProxy(signal)
            || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) {
        throw new Error(`${label}.signal must be a non-Proxy AbortSignal`);
    }
    const validatedInputArtifact = validateArtifactRef(raw.inputArtifact);
    const inputArtifact = frozenNullRecord({
        contractId: validatedInputArtifact.contractId,
        digest: validatedInputArtifact.digest,
        ...(Object.hasOwn(validatedInputArtifact, "bytes")
            ? { bytes: validatedInputArtifact.bytes }
            : {})
    });
    const context = frozenNullRecord({
        graph: snapshotGraphRef(raw.graph, `${label}.graph`),
        queueId: assertEvidenceString(raw.queueId, `${label}.queueId`),
        unitId: assertEvidenceString(raw.unitId, `${label}.unitId`),
        nodeId: assertIdentifier(raw.nodeId, `${label}.nodeId`),
        nodeRef: snapshotNodeRef(raw.nodeRef, `${label}.nodeRef`),
        attemptNumber: assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`),
        attemptIndex: assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`),
        idempotencyKey: assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`),
        inputArtifact,
        ...(signal === undefined ? {} : { signal: signal })
    });
    return context;
}

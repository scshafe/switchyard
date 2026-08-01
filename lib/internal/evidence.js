/** Internal validation/snapshot helpers for in-memory evidence ledgers. */
import { types as nodeTypes } from "node:util";
export function assertEvidenceString(value, label) {
    if (typeof value !== "string"
        || value.length < 1
        || value.length > 512
        || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`${label} must be a non-empty bounded string without control characters`);
    }
    return value;
}
export function assertEvidenceDigest(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 digest`);
    }
    return value;
}
export function assertEvidenceAttemptIdentity(value, label) {
    assertEvidenceString(value.runId, `${label}.runId`);
    assertEvidenceString(value.itemId, `${label}.itemId`);
    assertEvidenceString(value.nodeId, `${label}.nodeId`);
    if (value.stage === null
        || typeof value.stage !== "object"
        || Array.isArray(value.stage)) {
        throw new Error(`${label}.stage must be an object`);
    }
    const stage = value.stage;
    assertEvidenceString(stage.id, `${label}.stage.id`);
    if (!Number.isInteger(stage.version) || stage.version < 1) {
        throw new Error(`${label}.stage.version must be a positive integer`);
    }
    if (!Number.isInteger(value.attempt) || value.attempt < 1) {
        throw new Error(`${label}.attempt must be a positive integer`);
    }
    assertEvidenceDigest(value.idempotencyKey, `${label}.idempotencyKey`);
}
export function deepFrozenClone(value, label) {
    const ancestors = new WeakSet();
    const clone = (candidate, path) => {
        if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean")
            return candidate;
        if (typeof candidate === "number") {
            if (!Number.isFinite(candidate))
                throw new Error(`${path} number must be finite`);
            return candidate;
        }
        if (typeof candidate !== "object" || nodeTypes.isProxy(candidate) || ancestors.has(candidate)) {
            throw new Error(`${path} must contain only acyclic plain JSON data`);
        }
        ancestors.add(candidate);
        try {
            const descriptors = Object.getOwnPropertyDescriptors(candidate);
            if (Array.isArray(candidate)) {
                if (Object.getPrototypeOf(candidate) !== Array.prototype)
                    throw new Error(`${path} must be a plain array`);
                const lengthDescriptor = descriptors.length;
                if (lengthDescriptor === undefined
                    || !("value" in lengthDescriptor)
                    || typeof lengthDescriptor.value !== "number"
                    || !Number.isInteger(lengthDescriptor.value)
                    || lengthDescriptor.value < 0)
                    throw new Error(`${path}.length must be a data property`);
                const length = lengthDescriptor.value;
                const keys = Reflect.ownKeys(descriptors);
                if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))
                    || keys.length !== length + 1)
                    throw new Error(`${path} must be a dense array without extra keys`);
                return Object.freeze(Array.from({ length }, (_, index) => {
                    const descriptor = descriptors[String(index)];
                    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
                        throw new Error(`${path}[${index}] must be an enumerable data property`);
                    }
                    return clone(descriptor.value, `${path}[${index}]`);
                }));
            }
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype !== Object.prototype && prototype !== null)
                throw new Error(`${path} must be a plain data object`);
            const snapshot = {};
            for (const key of Reflect.ownKeys(descriptors)) {
                if (typeof key !== "string")
                    throw new Error(`${path} has symbol keys`);
                const descriptor = descriptors[key];
                if (!("value" in descriptor) || descriptor.enumerable !== true) {
                    throw new Error(`${path}.${key} must be an enumerable data property`);
                }
                Object.defineProperty(snapshot, key, {
                    configurable: false,
                    enumerable: true,
                    writable: false,
                    value: clone(descriptor.value, `${path}.${key}`)
                });
            }
            return Object.freeze(snapshot);
        }
        finally {
            ancestors.delete(candidate);
        }
    };
    return clone(value, label);
}

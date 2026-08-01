/** Internal validation/snapshot helpers for in-memory evidence ledgers. */

import { types as nodeTypes } from "node:util";

import { captureCapabilityRecord } from "./capability.js";

export function assertEvidenceString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty bounded string without control characters`);
  }
  return value;
}

export function assertEvidenceDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertEvidenceAttemptIdentity(
  value: {
    runId?: unknown;
    itemId?: unknown;
    nodeId?: unknown;
    stage?: unknown;
    attempt?: unknown;
    idempotencyKey?: unknown;
  },
  label: string
): void {
  const snapshot = deepFrozenClone(value, label);
  assertEvidenceString(snapshot.runId, `${label}.runId`);
  assertEvidenceString(snapshot.itemId, `${label}.itemId`);
  assertEvidenceString(snapshot.nodeId, `${label}.nodeId`);
  if (
    snapshot.stage === null
    || typeof snapshot.stage !== "object"
    || Array.isArray(snapshot.stage)
  ) {
    throw new Error(`${label}.stage must be an object`);
  }
  const stage = snapshot.stage as { id?: unknown; version?: unknown };
  assertEvidenceString(stage.id, `${label}.stage.id`);
  if (!Number.isInteger(stage.version) || (stage.version as number) < 1) {
    throw new Error(`${label}.stage.version must be a positive integer`);
  }
  if (!Number.isInteger(snapshot.attempt) || (snapshot.attempt as number) < 1) {
    throw new Error(`${label}.attempt must be a positive integer`);
  }
  assertEvidenceDigest(snapshot.idempotencyKey, `${label}.idempotencyKey`);
}

export interface EvidenceOutboxAttemptIdentity {
  readonly runId: string;
  readonly itemId: string;
  readonly nodeId: string;
  readonly stage: Readonly<{ id: string; version: number }>;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

/**
 * Capture an outbox-hook context once. `output` is deliberately admitted but
 * ignored: evidence selection is identity-only and must never inspect a
 * caller-owned output payload or invoke one of its accessors.
 */
export function snapshotEvidenceOutboxContext(
  value: unknown,
  label: string
): EvidenceOutboxAttemptIdentity {
  const fields = captureCapabilityRecord(
    value,
    [
      "runId",
      "node",
      "itemId",
      "output",
      "attempt",
      "idempotencyKey",
      "errorCode",
      "retryable",
      "scope",
      "terminal"
    ],
    ["runId", "node", "itemId", "attempt", "idempotencyKey"],
    label
  );
  const node = deepFrozenClone(fields.node, `${label}.node`) as {
    nodeId?: unknown;
    stage?: unknown;
  };
  const snapshot = deepFrozenClone(
    {
      runId: fields.runId,
      itemId: fields.itemId,
      nodeId: node.nodeId,
      stage: node.stage,
      attempt: fields.attempt,
      idempotencyKey: fields.idempotencyKey
    },
    label
  ) as EvidenceOutboxAttemptIdentity;
  assertEvidenceAttemptIdentity(snapshot, label);
  return snapshot;
}

export function deepFrozenClone<T>(value: T, label: string): T {
  const ancestors = new WeakSet<object>();
  const clone = (candidate: unknown, path: string): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error(`${path} number must be finite`);
      return candidate;
    }
    if (typeof candidate !== "object" || nodeTypes.isProxy(candidate) || ancestors.has(candidate)) {
      throw new Error(`${path} must contain only acyclic plain JSON data`);
    }
    ancestors.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) throw new Error(`${path} must be a plain array`);
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) throw new Error(`${path}.length must be a data property`);
        const length = lengthDescriptor.value;
        const keys = Reflect.ownKeys(descriptors);
        if (
          keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))
          || keys.length !== length + 1
        ) throw new Error(`${path} must be a dense array without extra keys`);
        return Object.freeze(Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
            throw new Error(`${path}[${index}] must be an enumerable data property`);
          }
          return clone(descriptor.value, `${path}[${index}]`);
        }));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain data object`);
      const snapshot: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new Error(`${path} has symbol keys`);
        const descriptor = descriptors[key]!;
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
    } finally {
      ancestors.delete(candidate);
    }
  };
  return clone(value, label) as T;
}

/**
 * Descriptor-first validation snapshot that preserves invalid leaf values so
 * public validators can retain their precise legacy diagnostics. Plain
 * containers are detached/frozen; accessors, Proxies, symbols, sparse arrays,
 * and cycles are still rejected before application validation reads them.
 */
export function snapshotValidationData<T>(value: T, label: string): T {
  const ancestors = new WeakSet<object>();
  const snapshot = (candidate: unknown, path: string): unknown => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (nodeTypes.isProxy(candidate)) {
      throw new Error(`${path} must not contain Proxies`);
    }
    if (ancestors.has(candidate)) {
      throw new Error(`${path} must not be cyclic`);
    }
    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) return candidate;
      ancestors.add(candidate);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as Record<
          string,
          PropertyDescriptor
        >;
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) {
          throw new Error(`${path}.length must be a data property`);
        }
        const length = lengthDescriptor.value;
        const keys = Reflect.ownKeys(descriptors);
        if (
          keys.some((key) =>
            typeof key !== "string"
            || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
          )
          || keys.length !== length + 1
        ) {
          throw new Error(`${path} must be a dense array without extra keys`);
        }
        return Object.freeze(Array.from({ length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined
            || !("value" in descriptor)
            || descriptor.enumerable !== true
          ) {
            throw new Error(`${path}[${index}] must be an enumerable data property`);
          }
          return snapshot(descriptor.value, `${path}[${index}]`);
        }));
      } finally {
        ancestors.delete(candidate);
      }
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) return candidate;
    ancestors.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const result: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new Error(`${path} has symbol keys`);
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || descriptor.enumerable !== true) {
          throw new Error(`${path}.${key} must be an enumerable data property`);
        }
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: snapshot(descriptor.value, `${path}.${key}`)
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(candidate);
    }
  };
  return snapshot(value, label) as T;
}

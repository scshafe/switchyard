/** Capture a capability method once without invoking accessors or retaining a mutable code pointer. */

import { types as nodeTypes } from "node:util";

export function captureCapabilityRecord(
  target: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (
    target === null
    || typeof target !== "object"
    || nodeTypes.isProxy(target)
    || (
      Object.getPrototypeOf(target) !== Object.prototype
      && Object.getPrototypeOf(target) !== null
    )
  ) {
    throw new Error(`${label} must be a plain non-Proxy data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(target);
  const allowed = new Set(allowedKeys);
  // A null prototype is part of the security boundary. Callers intentionally
  // read optional fields from this snapshot, so Object.prototype must never be
  // able to manufacture a capability or alter digest input through inheritance.
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(
        `${label}: unknown key(s) ${typeof key === "string" ? JSON.stringify(key) : String(key)}`
      );
    }
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(captured, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value
    });
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(captured, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
  return Object.freeze(captured);
}

export function captureDenseArrayItems(
  value: unknown,
  label: string,
  maximumLength = Number.MAX_SAFE_INTEGER
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} must be a plain non-Proxy array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    throw new Error(`${label}.length must be a data property`);
  }
  const length = lengthDescriptor.value;
  if (
    !Number.isSafeInteger(maximumLength)
    || maximumLength < 0
    || length > maximumLength
  ) {
    throw new Error(`${label} must contain at most ${maximumLength} items (got ${length})`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
    )
    || keys.length !== length + 1
  ) {
    throw new Error(`${label} must be dense and have no extra keys`);
  }
  return Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  }));
}

export function captureCapabilityDataProperty(
  target: unknown,
  key: string,
  label: string
): unknown {
  if (
    target === null
    || (typeof target !== "object" && typeof target !== "function")
    || nodeTypes.isProxy(target)
  ) {
    throw new Error(`${label} must be a non-Proxy capability object`);
  }
  let cursor: object | null = target as object;
  while (cursor !== null) {
    // Class prototypes are valid capability carriers; ambient intrinsic roots
    // are not. Accepting Object.prototype/Function.prototype would let global
    // prototype poisoning manufacture any missing authority method.
    if (cursor === Object.prototype || cursor === Function.prototype) {
      return undefined;
    }
    if (nodeTypes.isProxy(cursor)) {
      throw new Error(`${label} prototype chain must not contain a Proxy`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) {
        throw new Error(`${label}.${key} must be a data property`);
      }
      return descriptor.value;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return undefined;
}

export function captureCapabilityMethod(
  target: unknown,
  key: string,
  label: string
): (...args: any[]) => any {
  const method = captureCapabilityDataProperty(target, key, label);
  if (typeof method !== "function") {
    throw new Error(`${label}.${key} must be a data-property function`);
  }
  return (...args: any[]) => method.apply(target, args);
}

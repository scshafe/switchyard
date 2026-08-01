/** Capture a capability method once without invoking accessors or retaining a mutable code pointer. */

import { types as nodeTypes } from "node:util";

export function captureDenseArrayItems(
  value: unknown,
  label: string
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new Error(`${label} must be a plain non-Proxy array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
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
    throw new Error(`${label}.length must be a data property`);
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

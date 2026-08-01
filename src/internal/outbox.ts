import { types as nodeTypes } from "node:util";

import type { OutboxEventInput, OutboxEvents } from "../store.js";

export interface CapturedOutboxEvents {
  readonly events: readonly OutboxEventInput[];
  readonly acknowledge?: () => void;
}

/**
 * Capture an outbox batch descriptor-first. Retry-safe batches may expose one
 * hardened acknowledgement hook; every other extra key, accessor, Proxy, or
 * exotic array is rejected before event data crosses an async boundary.
 */
export function captureOutboxEvents(
  value: OutboxEvents,
  label: string
): CapturedOutboxEvents {
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
  const acknowledgeDescriptor = descriptors.acknowledge;
  const hasAcknowledge = acknowledgeDescriptor !== undefined;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string"
      || (
        key !== "length"
        && key !== "acknowledge"
        && !/^(0|[1-9][0-9]*)$/.test(key)
      )
    )
    || keys.length !== length + 1 + (hasAcknowledge ? 1 : 0)
  ) {
    throw new Error(`${label} must be dense and have no unsupported extra keys`);
  }
  let acknowledge: (() => void) | undefined;
  if (acknowledgeDescriptor !== undefined) {
    if (
      !("value" in acknowledgeDescriptor)
      || typeof acknowledgeDescriptor.value !== "function"
      || acknowledgeDescriptor.enumerable !== false
      || acknowledgeDescriptor.configurable !== false
      || acknowledgeDescriptor.writable !== false
    ) {
      throw new Error(
        `${label}.acknowledge must be a non-enumerable, non-configurable, non-writable data-property function`
      );
    }
    const method = acknowledgeDescriptor.value as () => void;
    acknowledge = () => Reflect.apply(method, value, []);
  }
  const events = Object.freeze(Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new Error(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value as OutboxEventInput;
  }));
  return Object.freeze({
    events,
    ...(acknowledge === undefined ? {} : { acknowledge })
  });
}

import type {
  OutboxEventInput,
  OutboxEvents,
  RetrySafeOutboxEvents
} from "../store.js";
import { captureOutboxEvents } from "../internal/outbox.js";

/**
 * Build an array-compatible, non-destructive outbox peek. The durable executor
 * calls `acknowledge` only after the enclosing stage append succeeds.
 */
export function createRetrySafeOutboxEvents(
  events: readonly OutboxEventInput[],
  acknowledge: () => void
): RetrySafeOutboxEvents {
  const captured = captureOutboxEvents(events, "outbox events");
  if (captured.acknowledge !== undefined) {
    throw new Error(
      "outbox events already have an acknowledge hook; use combineOutboxEvents"
    );
  }
  if (typeof acknowledge !== "function") {
    throw new Error("acknowledge must be a function");
  }
  const batch = [...captured.events] as OutboxEventInput[] & {
    acknowledge(): void;
  };
  Object.defineProperty(batch, "acknowledge", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: acknowledge
  });
  return batch;
}

/**
 * Compose event sources without losing acknowledgement hooks. Consumers
 * combining model, agent, gate, and projection ledgers should use this helper
 * instead of a bare array spread.
 */
export function combineOutboxEvents(
  ...sources: readonly OutboxEvents[]
): RetrySafeOutboxEvents {
  const captured = sources.map((source, index) =>
    captureOutboxEvents(source, `outbox source[${index}]`)
  );
  return createRetrySafeOutboxEvents(
    captured.flatMap((source) => [...source.events]),
    () => {
      for (const source of captured) {
        try {
          source.acknowledge?.();
        } catch {
          // Each source is independent. One broken in-memory acknowledgement
          // must not prevent the remaining committed batches from advancing.
        }
      }
    }
  );
}

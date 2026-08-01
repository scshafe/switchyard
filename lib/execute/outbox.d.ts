import type { OutboxEventInput, OutboxEvents, RetrySafeOutboxEvents } from "../store.js";
/**
 * Build an array-compatible, non-destructive outbox peek. The durable executor
 * calls `acknowledge` only after the enclosing stage append succeeds.
 */
export declare function createRetrySafeOutboxEvents(events: readonly OutboxEventInput[], acknowledge: () => void): RetrySafeOutboxEvents;
/**
 * Compose event sources without losing acknowledgement hooks. Consumers
 * combining model, agent, gate, and projection ledgers should use this helper
 * instead of a bare array spread.
 */
export declare function combineOutboxEvents(...sources: readonly OutboxEvents[]): RetrySafeOutboxEvents;

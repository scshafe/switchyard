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
export declare function captureOutboxEvents(value: OutboxEvents, label: string): CapturedOutboxEvents;

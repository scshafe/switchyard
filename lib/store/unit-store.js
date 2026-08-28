// store/unit-store.ts — durable v2 MissionPipelineUnit / journey store port.
//
// This is the host-neutral contract implemented by the N3 memory executable
// specification and, in N4, by the consumer-owned Postgres adapter. The
// successful position-changing operation is settleTurn: journey evidence,
// artifacts, deterministic routing, join progress, successor queues, outbox,
// and lease release commit together. Terminal failure has the analogous
// atomic failure/dead-letter/join-resolution boundary.
//
// APPEND-ONLY: unit headers, queue occurrences, attempt reservations, cached
// completions, failures, journey records, artifacts, join evidence, outbox,
// and dead letters are immutable once appended. Only fenced leases and the
// fairness cursor are mutable coordination state. Queue rows are a retained,
// rebuildable projection; conclusion is derived from journey evidence.
import { JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID } from "../graph/definition.js";
import { turnOutboxEventDigest } from "../execute/unit-runner.js";
export { MAX_NODE_TURN_FAILURE_MESSAGE_LENGTH, nodeTurnFailureDigest, nodeTurnSettlementDigest, validateNodeTurnFailureMessage } from "../execute/turn-evidence.js";
export const MISSION_PIPELINE_UNIT_SCHEMA_VERSION = "mission-pipeline-unit.v2";
export { JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID };
export const MAX_UNIT_STORE_LIST_LIMIT = 10_000;
/** Stable logical transaction checkpoints shared by memory and PG testkits. */
export const SETTLE_TRANSACTION_CHECKPOINTS = Object.freeze([
    "journey_append",
    "artifact_retain",
    "edge_evaluation",
    "join_progress",
    "successor_enqueue",
    "outbox_append",
    "lease_release",
    "post_commit_reply"
]);
export function unitOutboxEventDigest(event) {
    return turnOutboxEventDigest(event);
}

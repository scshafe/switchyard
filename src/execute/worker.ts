// execute/worker.ts — a ready-made polling worker loop.
//
// `runNextUnitTurns` claims and settles one homogeneous batch for one
// principal. Every host then writes the same loop around it: find the
// principals that run code, model and agent nodes, claim for each in turn,
// report what settled, sleep when nothing was queued, stop on a signal. This
// module is that loop, done once. It adds no authority: it calls
// `runNextUnitTurns` with exactly the store, ports and principals the host
// hands it, and routing stays with the store.

import { setTimeout as sleep } from "node:timers/promises";
import { types as nodeTypes } from "node:util";

import { validateGraphDefinition, type GraphDefinition } from "../graph/definition.js";
import { captureCapabilityRecord } from "../internal/capability.js";
import { assertEvidenceString } from "../internal/evidence.js";
import { assertIdentifier, assertSafePositiveInt } from "../internal/guards.js";
import type { WorkerNodePorts } from "./turn.js";
import {
  MAX_TURN_BATCH_SIZE,
  runNextUnitTurns,
  type ClaimedUnitTurnSettlement,
  type RunClaimedUnitTurnInput,
  type WorkerTurnRunnerStore
} from "./unit-runner.js";

export const DEFAULT_WORKER_IDLE_MS = 1_000;
export const DEFAULT_WORKER_BATCH = 8;
export const MAX_WORKER_IDLE_MS = 3_600_000;

const WORKER_KINDS = new Set(["code", "model", "agent"]);

/**
 * The principals that run worker-side (code, model, agent) nodes of the given
 * sealed graphs, in first-seen node order. Human and callback nodes are
 * decided outside the worker and are left out.
 */
export function workerPrincipals(graphs: readonly GraphDefinition[]): readonly string[] {
  if (!Array.isArray(graphs)) throw new Error("workerPrincipals: graphs must be an array");
  const principals: string[] = [];
  for (const graphRaw of graphs as readonly unknown[]) {
    const graph = validateGraphDefinition(graphRaw);
    for (const node of graph.nodes) {
      if (WORKER_KINDS.has(node.kind) && !principals.includes(node.principal.id)) {
        principals.push(node.principal.id);
      }
    }
  }
  return Object.freeze(principals);
}

/** One settled (or rejected) turn, with the principal it was claimed for. */
export interface WorkerTurnSettlement extends ClaimedUnitTurnSettlement {
  readonly principalId: string;
}

export interface RunWorkerInput {
  readonly store: WorkerTurnRunnerStore;
  /** Ports as for `runNextUnitTurns`, e.g. wrapped by `withApprovalReviewPorts`. */
  readonly ports: WorkerNodePorts;
  readonly leaseOwner: string;
  /** Principals to claim for, in order. Default: `workerPrincipals(graphs)`. */
  readonly principals?: readonly string[];
  /** Sealed graphs whose worker principals are claimed for when `principals` is omitted. */
  readonly graphs?: readonly GraphDefinition[];
  /** Turns claimed per principal per pass, 1..256. Default 8. */
  readonly batch?: number;
  /** Sleep after a pass that claimed nothing. Default 1000 ms. */
  readonly idleMs?: number;
  /** Return after the first pass that claims nothing instead of sleeping. */
  readonly untilIdle?: boolean;
  /**
   * Stops the loop between passes and wakes it from its idle sleep. Turns
   * already claimed run to settlement; the signal is not passed to bodies.
   */
  readonly signal?: AbortSignal;
  /** Called once per claimed turn, after it settled or was rejected. */
  readonly onSettled?: (settlement: WorkerTurnSettlement) => void | Promise<void>;
  readonly successOutboxEvents?: RunClaimedUnitTurnInput["successOutboxEvents"];
  readonly failureOutboxEvents?: RunClaimedUnitTurnInput["failureOutboxEvents"];
  readonly now?: () => Date;
}

export interface RunWorkerResult {
  /** Passes over every principal. */
  readonly passes: number;
  /** Turns claimed. */
  readonly turns: number;
  /** Turns that settled with an outcome. */
  readonly succeeded: number;
  /** Turns that ended terminally (dead-lettered). */
  readonly terminal: number;
  /** Turns whose run rejected (store or evidence errors); see `onSettled`. */
  readonly rejected: number;
  /** Why the loop returned. */
  readonly stoppedBy: "idle" | "signal";
}

function optionalFunction(value: unknown, label: string): ((...args: never[]) => unknown) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function" || nodeTypes.isProxy(value)) {
    throw new Error(`${label} must be a non-Proxy function`);
  }
  return value as (...args: never[]) => unknown;
}

/**
 * Poll every worker principal, claim and settle their queued turns, and
 * repeat until `signal` aborts (or, with `untilIdle`, until a pass claims
 * nothing). A failing claim (store unavailable) is thrown; a rejected turn
 * is counted and reported through `onSettled`, and the loop goes on.
 */
export async function runWorker(inputRaw: RunWorkerInput): Promise<RunWorkerResult> {
  const raw = captureCapabilityRecord(
    inputRaw,
    [
      "store",
      "ports",
      "leaseOwner",
      "principals",
      "graphs",
      "batch",
      "idleMs",
      "untilIdle",
      "signal",
      "onSettled",
      "successOutboxEvents",
      "failureOutboxEvents",
      "now"
    ],
    ["store", "ports", "leaseOwner"],
    "runWorker input"
  );
  const leaseOwner = assertEvidenceString(raw.leaseOwner, "runWorker input.leaseOwner");
  let principals: readonly string[];
  if (raw.principals !== undefined) {
    if (!Array.isArray(raw.principals)) throw new Error("runWorker input.principals must be an array");
    principals = Object.freeze((raw.principals as unknown[]).map((principal, index) =>
      assertIdentifier(principal, `runWorker input.principals[${index}]`)
    ));
  } else if (raw.graphs !== undefined) {
    principals = workerPrincipals(raw.graphs as readonly GraphDefinition[]);
  } else {
    throw new Error("runWorker input needs principals or graphs");
  }
  if (principals.length === 0) throw new Error("runWorker input names no worker principal");
  const batch = raw.batch === undefined
    ? DEFAULT_WORKER_BATCH
    : assertSafePositiveInt(raw.batch, "runWorker input.batch");
  if (batch > MAX_TURN_BATCH_SIZE) {
    throw new Error(`runWorker input.batch must be 1..${MAX_TURN_BATCH_SIZE}`);
  }
  const idleMs = raw.idleMs === undefined
    ? DEFAULT_WORKER_IDLE_MS
    : assertSafePositiveInt(raw.idleMs, "runWorker input.idleMs");
  if (idleMs > MAX_WORKER_IDLE_MS) {
    throw new Error(`runWorker input.idleMs must be 1..${MAX_WORKER_IDLE_MS}`);
  }
  if (raw.untilIdle !== undefined && typeof raw.untilIdle !== "boolean") {
    throw new Error("runWorker input.untilIdle must be a boolean");
  }
  const untilIdle = raw.untilIdle === true;
  const signal = raw.signal;
  if (
    signal !== undefined
    && (
      signal === null
      || typeof signal !== "object"
      || nodeTypes.isProxy(signal)
      || Object.getPrototypeOf(signal) !== AbortSignal.prototype
    )
  ) {
    throw new Error("runWorker input.signal must be a non-Proxy AbortSignal");
  }
  const stop = signal as AbortSignal | undefined;
  const stopped = (): boolean => stop?.aborted === true;
  const onSettled = optionalFunction(raw.onSettled, "runWorker input.onSettled") as
    RunWorkerInput["onSettled"];
  const passThrough = {
    ...(raw.successOutboxEvents === undefined
      ? {}
      : { successOutboxEvents: raw.successOutboxEvents as RunClaimedUnitTurnInput["successOutboxEvents"] }),
    ...(raw.failureOutboxEvents === undefined
      ? {}
      : { failureOutboxEvents: raw.failureOutboxEvents as RunClaimedUnitTurnInput["failureOutboxEvents"] }),
    ...(raw.now === undefined ? {} : { now: raw.now as () => Date })
  };

  let passes = 0;
  let turns = 0;
  let succeeded = 0;
  let terminal = 0;
  let rejected = 0;
  const result = (stoppedBy: RunWorkerResult["stoppedBy"]): RunWorkerResult =>
    Object.freeze({ passes, turns, succeeded, terminal, rejected, stoppedBy });

  while (!stopped()) {
    passes += 1;
    let claimed = 0;
    for (const principalId of principals) {
      if (stopped()) return result("signal");
      const settlements = await runNextUnitTurns({
        store: raw.store as WorkerTurnRunnerStore,
        principalId,
        ports: raw.ports as WorkerNodePorts,
        leaseOwner,
        batch,
        ...passThrough
      });
      for (const settlement of settlements) {
        claimed += 1;
        turns += 1;
        if (settlement.result.status === "rejected") rejected += 1;
        else if (settlement.result.value.status === "succeeded") succeeded += 1;
        else terminal += 1;
        if (onSettled !== undefined) {
          await onSettled(Object.freeze({ ...settlement, principalId }));
        }
      }
    }
    if (claimed > 0) continue;
    if (untilIdle) return result("idle");
    try {
      await sleep(idleMs, undefined, stop === undefined ? {} : { signal: stop });
    } catch (error) {
      if (stopped()) break;
      throw error;
    }
  }
  return result("signal");
}

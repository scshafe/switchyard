// execute/worker.ts — a ready-made polling worker loop.
//
// `runNextUnitTurns` claims and settles one homogeneous batch for one
// principal. Every host then writes the same loop around it: find the
// principals that run code, model and agent nodes, claim for each in turn,
// report what settled, sleep when nothing was queued, stop on a signal. This
// module is that loop, done once. It adds no authority: it calls
// `runNextUnitTurns` with exactly the store, ports and principals the host
// hands it, and routing stays with the store.
//
// Given `graphs`, it runs only units of those sealed graphs. A claim is per
// principal and returns one homogeneous batch (one node of one graph lane);
// the store contract has no graph filter and no lease release, so a batch of
// another graph or version is claimed, withheld from the ports and reported,
// and its lease lapses after the node's `leaseMs`. The unit waits instead of
// failing at a reviewed node whose ports were built for another version.

import { setTimeout as sleep } from "node:timers/promises";
import { types as nodeTypes } from "node:util";

import { validateGraphDefinition, type GraphDefinition } from "../graph/definition.js";
import {
  captureCapabilityDataProperty,
  captureCapabilityMethod,
  captureCapabilityRecord,
  captureDenseArrayItems
} from "../internal/capability.js";
import { assertEvidenceString } from "../internal/evidence.js";
import { assertIdentifier, assertSafePositiveInt } from "../internal/guards.js";
import type { WorkerNodePorts } from "./turn.js";
import {
  MAX_TURN_BATCH_SIZE,
  runNextUnitTurns,
  type ClaimUnitTurnsInput,
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

/**
 * A claimed turn `runWorker` did not run because its unit is on a graph (or
 * graph version) the worker was not given. Nothing was recorded for it: the
 * turn stays open and is claimable again once its lease lapses.
 */
export interface WorkerSkippedTurn {
  readonly principalId: string;
  readonly queueId: string;
  readonly unitId: string;
  readonly nodeId: string;
  /** The graph version the unit runs on. */
  readonly graph: { readonly graphId: string; readonly version: number; readonly digest: string };
  /** The graph versions this worker was given, as `graphId vN`. */
  readonly given: readonly string[];
  /** One readable line naming the unit, its graph version and the given ones. */
  readonly message: string;
}

/** `process.emitWarning` code used when `runWorker` has no `onSkipped`. */
export const SWITCHYARD_WORKER_GRAPH_NOT_GIVEN_WARNING = "SWITCHYARD_WORKER_GRAPH_NOT_GIVEN";

export interface RunWorkerInput {
  readonly store: WorkerTurnRunnerStore;
  /** Ports as for `runNextUnitTurns`, e.g. wrapped by `withApprovalReviewPorts`. */
  readonly ports: WorkerNodePorts;
  readonly leaseOwner: string;
  /** Principals to claim for, in order. Default: `workerPrincipals(graphs)`. */
  readonly principals?: readonly string[];
  /**
   * The sealed graphs, every version, whose units this worker runs; pass each
   * version that still has units in flight. Their worker principals are
   * claimed for when `principals` is omitted. A claimed turn of any other
   * graph or version is not run: it is reported through `onSkipped` and
   * waits (its lease lapses after the node's `leaseMs`). Without `graphs`,
   * every claimed turn is run.
   */
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
  /**
   * Called for each claimed turn of a graph version not in `graphs`. Without
   * it, `runWorker` emits one process warning
   * (`SWITCHYARD_WORKER_GRAPH_NOT_GIVEN`) per such version.
   */
  readonly onSkipped?: (skipped: WorkerSkippedTurn) => void | Promise<void>;
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
  /** Claimed turns not run because their graph version was not given; see `onSkipped`. */
  readonly skipped: number;
  /** Why the loop returned. */
  readonly stoppedBy: "idle" | "signal";
}

const MAX_SKIPPED_CLAIMS_PER_PRINCIPAL = 64;

interface GivenGraphs {
  readonly digests: ReadonlySet<string>;
  readonly names: readonly string[];
}

function givenGraphs(graphsRaw: readonly unknown[]): GivenGraphs {
  const digests = new Set<string>();
  const names: string[] = [];
  for (const graphRaw of graphsRaw) {
    const graph = validateGraphDefinition(graphRaw);
    if (digests.has(graph.graphDigest)) continue;
    digests.add(graph.graphDigest);
    names.push(`${graph.graphId} v${graph.version}`);
  }
  return Object.freeze({ digests, names: Object.freeze(names) });
}

/**
 * The claimed turn's unit, node and graph identity, read through data
 * properties only; `undefined` when the claim is malformed (the runner then
 * rejects the batch as it always has).
 */
function claimedGraph(claim: unknown): Omit<WorkerSkippedTurn, "principalId" | "given" | "message"> | undefined {
  try {
    const label = "claimed unit turn";
    const graph = captureCapabilityDataProperty(claim, "graph", label);
    const fields = {
      queueId: captureCapabilityDataProperty(claim, "queueId", label),
      unitId: captureCapabilityDataProperty(claim, "unitId", label),
      nodeId: captureCapabilityDataProperty(claim, "nodeId", label),
      graphId: captureCapabilityDataProperty(graph, "graphId", `${label}.graph`),
      version: captureCapabilityDataProperty(graph, "version", `${label}.graph`),
      digest: captureCapabilityDataProperty(graph, "graphDigest", `${label}.graph`)
    };
    if (
      typeof fields.queueId !== "string" || typeof fields.unitId !== "string"
      || typeof fields.nodeId !== "string" || typeof fields.graphId !== "string"
      || typeof fields.version !== "number" || typeof fields.digest !== "string"
    ) return undefined;
    return {
      queueId: fields.queueId,
      unitId: fields.unitId,
      nodeId: fields.nodeId,
      graph: Object.freeze({ graphId: fields.graphId, version: fields.version, digest: fields.digest })
    };
  } catch {
    return undefined;
  }
}

/**
 * The host's store with a claim that withholds batches of graphs not given.
 * Every other method is the store's own.
 */
function givenGraphStore(
  storeRaw: unknown,
  given: GivenGraphs,
  withhold: (turn: Omit<WorkerSkippedTurn, "principalId">) => void
): WorkerTurnRunnerStore {
  const label = "worker turn runner store";
  const claimUnitTurns = captureCapabilityMethod(storeRaw, "claimUnitTurns", label);
  return Object.freeze({
    async claimUnitTurns(input: ClaimUnitTurnsInput) {
      const claimed: unknown = await claimUnitTurns(input);
      let items: readonly unknown[];
      try {
        items = captureDenseArrayItems(claimed, "claimed unit turns", MAX_TURN_BATCH_SIZE);
      } catch {
        return claimed;
      }
      const kept: unknown[] = [];
      for (const item of items) {
        const identity = claimedGraph(item);
        if (identity === undefined || given.digests.has(identity.graph.digest)) {
          kept.push(item);
          continue;
        }
        withhold(Object.freeze({
          ...identity,
          given: given.names,
          message: `unit ${identity.unitId} waits at ${identity.nodeId}: it runs on graph `
            + `${identity.graph.graphId} v${identity.graph.version}, which this worker was not given `
            + `(it has ${given.names.join(", ")}). Pass that version in the worker's graphs to run it.`
        }));
      }
      return kept;
    },
    heartbeatTurn: captureCapabilityMethod(storeRaw, "heartbeatTurn", label),
    prepareTurnAttempt: captureCapabilityMethod(storeRaw, "prepareTurnAttempt", label),
    cacheTurnCompletion: captureCapabilityMethod(storeRaw, "cacheTurnCompletion", label),
    recordTurnFailure: captureCapabilityMethod(storeRaw, "recordTurnFailure", label),
    settleTurn: captureCapabilityMethod(storeRaw, "settleTurn", label)
  }) as WorkerTurnRunnerStore;
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
      "onSkipped",
      "successOutboxEvents",
      "failureOutboxEvents",
      "now"
    ],
    ["store", "ports", "leaseOwner"],
    "runWorker input"
  );
  const leaseOwner = assertEvidenceString(raw.leaseOwner, "runWorker input.leaseOwner");
  let given: GivenGraphs | undefined;
  if (raw.graphs !== undefined) {
    if (!Array.isArray(raw.graphs)) throw new Error("runWorker input.graphs must be an array");
    given = givenGraphs(raw.graphs as readonly unknown[]);
  }
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
  const onSkipped = optionalFunction(raw.onSkipped, "runWorker input.onSkipped") as
    RunWorkerInput["onSkipped"];
  const warnedDigests = new Set<string>();
  const reportSkipped = async (skippedTurn: WorkerSkippedTurn): Promise<void> => {
    if (onSkipped !== undefined) {
      await onSkipped(skippedTurn);
    } else if (!warnedDigests.has(skippedTurn.graph.digest)) {
      warnedDigests.add(skippedTurn.graph.digest);
      process.emitWarning(skippedTurn.message, { code: SWITCHYARD_WORKER_GRAPH_NOT_GIVEN_WARNING });
    }
  };
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
  let skipped = 0;
  const result = (stoppedBy: RunWorkerResult["stoppedBy"]): RunWorkerResult =>
    Object.freeze({ passes, turns, succeeded, terminal, rejected, skipped, stoppedBy });
  const withheld: Omit<WorkerSkippedTurn, "principalId">[] = [];
  const store = given === undefined
    ? raw.store as WorkerTurnRunnerStore
    : givenGraphStore(raw.store, given, (turn) => withheld.push(turn));

  while (!stopped()) {
    passes += 1;
    let claimed = 0;
    for (const principalId of principals) {
      if (stopped()) return result("signal");
      // A claim that held only turns of other graph versions is repeated:
      // those turns are leased now, so the store offers the next batch.
      const seen = new Set<string>();
      for (let round = 0; round < MAX_SKIPPED_CLAIMS_PER_PRINCIPAL; round += 1) {
        withheld.length = 0;
        const settlements = await runNextUnitTurns({
          store,
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
        const fresh = withheld.splice(0).filter((turn) => !seen.has(turn.queueId));
        for (const turn of fresh) {
          seen.add(turn.queueId);
          skipped += 1;
          await reportSkipped(Object.freeze({ ...turn, principalId }));
        }
        if (settlements.length > 0 || fresh.length === 0) break;
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

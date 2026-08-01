// execute/shard-runner.ts — execute ONE shard through a single shared node
// walk. runOneShard owns the legacy Pipeline claim/heartbeat/finalize/release
// lifecycle. runBoundShard accepts host-bound work + an opaque external fence,
// appends only stage evidence, and returns an outcome for host settlement.
// Both execute compiled nodes in array order per item (CompiledPipeline.nodes
// are already topologically ordered) and isolate per-item failures (a terminal
// item skips its downstream nodes while the other items continue).
//
// PROMOTED from inbox-pipeline/src/worker/service.ts runOneShotPipelineWorker
// (the claim-one-shard shape with idle outcome; option validation — attempt
// budget 1..10, heartbeat cadence below the lease duration, the exact
// runId+shardId pairing rule; the artifacts map + pipeline_input/node_output
// slot resolution; the missing-artifact LOUD rejection; the terminal-item
// `break` + `continue` isolation; runWithHeartbeat with single-flight
// heartbeats, deferred heartbeat-error surfacing, and timer.unref; failShard
// swallowing a lost lease; completed/partial finalization outcomes) — re-cut
// over the PipelineStore port + the B3 durable executor, which now owns the
// prepare/persist/retry/dead-letter cycle that service.ts inlined.
// CHANGES in the promotion:
//   - NodeInvoker PORT for the non-code kinds (model/agent/gate): B3 defines
//     the port and ships a fake; B4 (model bindings + receipts), B5 (gate
//     decision flows), and B6 (agent steps) implement it. Dispatch is on
//     compiled node kind; catalog.resolveExecutable remains the LOUD
//     parity lookup for EVERY kind before dispatch;
//   - heartbeatEveryMs floor lowered from the inbox 5000ms to 1ms so hermetic
//     tests can observe heartbeats; production hosts configure their own
//     floors (the everyMs < leaseDurationMs relationship is kept);
//   - the inbox email-specific admissions (provider registration, hydration
//     readiness, claim-topology snapshot checks) stay HOST concerns — the
//     engine-level equivalents are the sealed-compiled-pipeline revalidation
//     (validateCompiledPipeline on the claim) and the compile-time checks.
//
// STANDALONE: relative imports only (no npm deps, no zod, no pg).

import { types as nodeTypes } from "node:util";

import { validateCompiledPipeline, type CompiledPipelineNode } from "../compile.js";
import { StageCatalog } from "../catalog.js";
import { digest } from "../contracts/digest.js";
import type { StageContext } from "../node.js";
import {
  ExternalFenceRejectedError,
  EvidenceConflictError,
  BoundEvidencePersistenceError,
  ShardLeaseLostError,
  type BoundPipelineEvidenceStore,
  type BoundPipelineExecutionIdentity,
  type BoundPipelineShard,
  type OutboxEvents,
  type PipelineStore,
  type ShardClaim,
  type ShardClaimItem
} from "../store.js";
import {
  classifyStageFailure,
  executeBoundDurableStage,
  executeDurableStage,
  OutboxEvidenceNotCommittedError,
  PipelineStageError,
  StageEvidenceAssemblyError,
  StageResultConflictError,
  type DurableStageResult,
  type ResolvedSlotValue,
  type StageFailureOutboxContext
} from "./durable-stage.js";
import {
  PipelineControlOutcomeError,
  PipelineShardCancelledError,
  PipelineShardDeferredError
} from "./control.js";

// ── NodeInvoker: the non-code execution port (B4/B5/B6 implement it) ──────

export interface NodeInvocation {
  runId: string;
  itemId: string;
  node: CompiledPipelineNode;
  /** The composed, contract-validated stage input. */
  input: unknown;
  attempt: number;
  /** Stable across retries and external-fence takeovers. */
  idempotencyKey: string;
  signal?: AbortSignal;
}

/**
 * The injected executor for non-code node kinds. The durable executor still
 * owns idempotency, retries, dead letters, and contract validation around
 * every call — an invoker only performs ONE attempt and returns the raw
 * output (B4: model binding resolution + usage receipts; B5: gate decision
 * flows; B6: agent steps). A control outcome may bypass that outer attempt
 * only before any unrecorded side effect/usage; independently durable and
 * idempotent inner work is safe. v0.2 rejects at_most_once before invocation;
 * honest support requires durable intent plus indeterminate reconciliation.
 */
export interface NodeInvoker {
  invoke(invocation: NodeInvocation): Promise<unknown>;
}

function isInstanceOf<T>(
  value: unknown,
  constructor: abstract new (...args: any[]) => T
): value is T {
  try {
    if (
      value !== null
      && (typeof value === "object" || typeof value === "function")
      && nodeTypes.isProxy(value)
    ) {
      return false;
    }
    return value instanceof constructor;
  } catch {
    return false;
  }
}

/**
 * The B3 FAKE invoker: identity by default (echoes the composed input — the
 * B2 "identity-only executables for non-code kinds" behavior), overridable
 * per stageId for tests. B4/B5/B6 replace it with real implementations.
 */
export function createFakeNodeInvoker(
  handlers: Record<string, (invocation: NodeInvocation) => unknown | Promise<unknown>> = {}
): NodeInvoker {
  return {
    async invoke(invocation: NodeInvocation): Promise<unknown> {
      const handler = handlers[invocation.node.stage.id];
      return handler === undefined ? invocation.input : handler(invocation);
    }
  };
}

// ── Heartbeats (promoted runWithHeartbeat) ────────────────────────────────

/**
 * Run `operation` while heartbeating the shard lease every `everyMs`:
 * single-flight (a slow heartbeat is never overlapped), failures captured and
 * surfaced AFTER the operation (a lost lease fences the result even when the
 * work itself succeeded), timer unref'd so it never holds the process open.
 */
export async function runWithShardHeartbeat<T>(input: {
  store: PipelineStore;
  shardId: string;
  leaseToken: string;
  everyMs: number;
  extendByMs: number;
  now: () => Date;
  operation: () => Promise<T>;
}): Promise<T> {
  const fields = snapshotOptionRecord(
    input,
    HEARTBEAT_OPTION_KEYS,
    HEARTBEAT_OPTION_KEYS,
    "runWithShardHeartbeat input"
  );
  const heartbeatShard = captureObjectMethod(
    fields.store,
    "heartbeatShard",
    "heartbeat store"
  );
  const shardId = assertIdentityString(
    fields.shardId,
    "runWithShardHeartbeat shardId"
  );
  const leaseToken = assertIdentityString(
    fields.leaseToken,
    "runWithShardHeartbeat leaseToken"
  );
  const everyMs = fields.everyMs;
  const extendByMs = fields.extendByMs;
  if (!Number.isInteger(everyMs) || (everyMs as number) < 1) {
    throw new Error("runWithShardHeartbeat everyMs must be a positive integer");
  }
  if (!Number.isInteger(extendByMs) || (extendByMs as number) < 1) {
    throw new Error("runWithShardHeartbeat extendByMs must be a positive integer");
  }
  const now = fields.now;
  if (typeof now !== "function") {
    throw new Error("runWithShardHeartbeat now must be a function");
  }
  const operation = fields.operation;
  if (typeof operation !== "function") {
    throw new Error("runWithShardHeartbeat operation must be a function");
  }
  let heartbeatError: unknown;
  let heartbeatFailed = false;
  let heartbeatInFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (heartbeatInFlight || heartbeatFailed) return;
    // Begin with a promise boundary so a synchronous host method, clock, or
    // request-construction failure is captured instead of escaping the timer
    // callback as an uncaught exception.
    heartbeatInFlight = Promise.resolve()
      .then(() => heartbeatShard({
        shardId,
        leaseToken,
        extendByMs: extendByMs as number,
        at: Date.prototype.toISOString.call(now())
      })
      )
      .catch((error: unknown) => {
        heartbeatFailed = true;
        heartbeatError = error;
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, everyMs as number);
  timer.unref();
  let operationOutcome!:
    | { ok: true; value: T }
    | { ok: false; error: unknown };
  try {
    operationOutcome = {
      ok: true,
      value: await Promise.resolve().then(() => operation())
    };
  } catch (error) {
    operationOutcome = { ok: false, error };
  } finally {
    clearInterval(timer);
    // Snapshot then join the last single-flight heartbeat. Its catch handler
    // records the authoritative lease/control error and resolves this promise.
    const finalHeartbeat = heartbeatInFlight;
    if (finalHeartbeat) await finalHeartbeat;
  }
  // Heartbeat authority wins even when the operation also rejected. Otherwise
  // a concurrent supersession/cancel could be misreported as defer/failure.
  if (heartbeatFailed) throw heartbeatError;
  if (!operationOutcome.ok) throw operationOutcome.error;
  return operationOutcome.value;
}

// ── The one-shot shard runner ─────────────────────────────────────────────

export interface ShardRunnerOptions {
  store: PipelineStore;
  catalog: StageCatalog;
  /** REQUIRED when the claimed pipeline contains any non-code node. */
  invoker?: NodeInvoker;
  leaseOwner: string;
  /** Default 1_200_000 (promoted). */
  leaseDurationMs?: number;
  /** Default max(10_000, leaseDurationMs/3); must be < leaseDurationMs. */
  heartbeatEveryMs?: number;
  /** Retry budget per node, 1..10, default 2. */
  maxAttempts?: number;
  /** Per-nodeId overrides of the retry budget. */
  maxAttemptsByNode?: Record<string, number>;
  /** Exact-claim narrowing (both or neither — promoted pairing rule). */
  runId?: string;
  shardId?: string;
  /**
   * Host hook: outbox events to append ATOMICALLY with a node's fresh success
   * (the transactional outbox — e.g. inbox's proposal externalization).
   */
  outboxEventsFor?: (context: {
    runId: string;
    node: CompiledPipelineNode;
    itemId: string;
    output: unknown;
    attempt: number;
    idempotencyKey: string;
  }) => OutboxEvents;
  /**
   * Host hook: outbox events to append ATOMICALLY with a node's failed
   * attempt. Provider/model/agent usage receipts belong here; success-only
   * business events (for example a human-escalation projection) do not.
   */
  failureOutboxEventsFor?: (context: StageFailureOutboxContext) => OutboxEvents;
  signal?: AbortSignal;
  /** Injectable clock (drives claim/heartbeat/finalize timestamps). */
  now?: () => Date;
}

export type ShardRunOutcome =
  | { status: "idle" }
  | {
      status: "completed";
      runId: string;
      shardId: string;
      itemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "partial";
      runId: string;
      shardId: string;
      itemCount: number;
      completedItemCount: number;
      terminalItemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | { status: "deferred"; runId: string; shardId: string; reasonCode: string }
  | { status: "cancelled"; runId: string; shardId: string; reasonCode: string }
  | { status: "failed"; runId: string; shardId: string; retryable: boolean; errorCode: string };

/**
 * Runner options for work whose lease/fence is owned by the host.
 *
 * Ownership options from {@link ShardRunnerOptions} are structurally absent:
 * no lease owner, duration, heartbeat cadence, or exact-claim selector can be
 * supplied. `fence` is passed through by identity to `evidenceStore`.
 */
export type BoundShardRunnerOptions<TFence> = Omit<
  ShardRunnerOptions,
  | "store"
  | "leaseOwner"
  | "leaseDurationMs"
  | "heartbeatEveryMs"
  | "runId"
  | "shardId"
  | "now"
> & {
  shard: BoundPipelineShard;
  evidenceStore: BoundPipelineEvidenceStore<TFence>;
  fence: TFence;
  /** Digest-sealed immutable run/shard/definition/item/host-action identity. */
  executionIdentity: BoundPipelineExecutionIdentity;
  /** Injectable clock for append evidence timestamps. */
  now?: () => Date;
};

/**
 * Host settlement instruction returned by {@link runBoundShard}. No arm
 * mutates or releases the external fence.
 */
export type BoundShardRunOutcome =
  | {
      status: "completed";
      runId: string;
      shardId: string;
      itemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "partial";
      runId: string;
      shardId: string;
      itemCount: number;
      completedItemCount: number;
      terminalItemCount: number;
      stageExecutionCount: number;
      reusedStageCount: number;
    }
  | {
      status: "control";
      runId: string;
      shardId: string;
      /** Opaque payload returned verbatim for host validation and settlement. */
      control: unknown;
    }
  | {
      status: "failed";
      runId: string;
      shardId: string;
      retryable: boolean;
      errorCode: string;
    };

interface ShardExecutionMetrics {
  itemCount: number;
  completedItemCount: number;
  terminalItemCount: number;
  stageExecutionCount: number;
  reusedStageCount: number;
}

interface ExecuteShardNodesInput {
  shard: BoundPipelineShard;
  catalog: StageCatalog;
  invoker?: NodeInvoker;
  executeStage(input: {
    item: ShardClaimItem;
    node: CompiledPipelineNode;
    slots: readonly ResolvedSlotValue[];
    invoke: (input: unknown, ctx: StageContext) => Promise<unknown>;
  }): Promise<DurableStageResult>;
}

const BOUND_IDENTITY_KEYS = [
  "schemaVersion",
  "hostActionId",
  "runId",
  "shardId",
  "pipeline",
  "compiledDigest",
  "itemCount",
  "itemSetDigest",
  "identityDigest"
] as const;

function snapshotExactDataRecord(
  value: unknown,
  expected: readonly string[],
  label: string
): Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new Error(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unexpected symbol keys`);
  }
  const actualStrings = (actual as string[]).sort();
  const wanted = [...expected].sort();
  if (
    actualStrings.length !== wanted.length
    || actualStrings.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    // Capture each caller-owned field exactly once without invoking accessors.
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotOptionRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(allowedKeys);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of actual as string[]) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: descriptor.value
    });
  }
  return Object.freeze(snapshot);
}

function captureObjectMethod(
  target: unknown,
  key: string,
  label: string
): (...args: any[]) => any {
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
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw new Error(`${label}.${key} must be a data-property function`);
      }
      const method = descriptor.value;
      return (...args: any[]) => method.apply(target, args);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new Error(`${label}.${key} must be a function`);
}

function captureNodeInvoker(value: unknown): NodeInvoker {
  const invoke = captureObjectMethod(value, "invoke", "node invoker");
  return Object.freeze({
    invoke: (invocation: NodeInvocation) => invoke(invocation)
  });
}

function capturePipelineStore(value: unknown): PipelineStore {
  const methodNames = [
    "claimNextShard",
    "heartbeatShard",
    "completeShard",
    "failShard",
    "deferShard",
    "cancelShard",
    "prepareStageExecution",
    "persistStageSuccess",
    "persistStageFailure",
    "recordDeadLetter"
  ] as const;
  const captured = Object.fromEntries(
    methodNames.map((methodName) => [
      methodName,
      captureObjectMethod(value, methodName, "pipeline store")
    ])
  );
  return Object.freeze(captured) as unknown as PipelineStore;
}

function captureBoundEvidenceStore<TFence>(
  value: unknown
): BoundPipelineEvidenceStore<TFence> {
  const prepareStageExecution = captureObjectMethod(
    value,
    "prepareStageExecution",
    "bound evidence store"
  );
  const persistStageSuccess = captureObjectMethod(
    value,
    "persistStageSuccess",
    "bound evidence store"
  );
  const persistStageFailure = captureObjectMethod(
    value,
    "persistStageFailure",
    "bound evidence store"
  );
  const recordDeadLetter = captureObjectMethod(
    value,
    "recordDeadLetter",
    "bound evidence store"
  );
  return Object.freeze({
    prepareStageExecution: prepareStageExecution as BoundPipelineEvidenceStore<TFence>["prepareStageExecution"],
    persistStageSuccess: persistStageSuccess as BoundPipelineEvidenceStore<TFence>["persistStageSuccess"],
    persistStageFailure: persistStageFailure as BoundPipelineEvidenceStore<TFence>["persistStageFailure"],
    recordDeadLetter: recordDeadLetter as BoundPipelineEvidenceStore<TFence>["recordDeadLetter"]
  });
}

function captureStageCatalog(value: unknown): StageCatalog {
  if (
    value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || !isInstanceOf(value, StageCatalog)
  ) {
    throw new Error("runner catalog must be a StageCatalog instance");
  }
  const resolveExecutable = captureObjectMethod(
    value,
    "resolveExecutable",
    "stage catalog"
  );
  const contracts = value.contracts;
  return Object.freeze({
    contracts,
    resolveExecutable: (stageId: string, version: number) =>
      resolveExecutable(stageId, version)
  }) as unknown as StageCatalog;
}

const SHARD_RUNNER_OPTION_KEYS = [
  "store",
  "catalog",
  "invoker",
  "leaseOwner",
  "leaseDurationMs",
  "heartbeatEveryMs",
  "maxAttempts",
  "maxAttemptsByNode",
  "runId",
  "shardId",
  "outboxEventsFor",
  "failureOutboxEventsFor",
  "signal",
  "now"
] as const;

const HEARTBEAT_OPTION_KEYS = [
  "store",
  "shardId",
  "leaseToken",
  "everyMs",
  "extendByMs",
  "now",
  "operation"
] as const;

const BOUND_RUNNER_OPTION_KEYS = [
  "shard",
  "evidenceStore",
  "fence",
  "executionIdentity",
  "catalog",
  "invoker",
  "maxAttempts",
  "maxAttemptsByNode",
  "outboxEventsFor",
  "failureOutboxEventsFor",
  "signal",
  "now"
] as const;

function assertIdentityString(value: unknown, label: string): string {
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

function assertDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function snapshotJsonData(
  value: unknown,
  label: string,
  ancestors = new WeakSet<object>()
): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} number must be finite`);
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new Error(`${label} must contain only plain JSON data`);
  }
  if (ancestors.has(value)) throw new Error(`${label} must not be cyclic`);
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${label} must be a plain array`);
      }
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
        throw new Error(`${label} must be a dense array without extra keys`);
      }
      const array = Array.from({ length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) {
          throw new Error(`${label}[${index}] must be an enumerable data property`);
        }
        return snapshotJsonData(descriptor.value, `${label}[${index}]`, ancestors);
      });
      return Object.freeze(array);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must be a plain data object`);
    }
    const object: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new Error(`${label} has symbol keys`);
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor) || descriptor.enumerable !== true) {
        throw new Error(`${label}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(object, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: snapshotJsonData(descriptor.value, `${label}.${key}`, ancestors)
      });
    }
    return Object.freeze(object);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotBoundPipelineShard(value: unknown): BoundPipelineShard {
  const snapshot = snapshotJsonData(value, "bound shard");
  const root = snapshotExactDataRecord(
    snapshot,
    ["runId", "shardId", "compiled", "items"],
    "bound shard"
  );
  const runId = assertIdentityString(root.runId, "bound shard runId");
  const shardId = assertIdentityString(root.shardId, "bound shard shardId");
  const compiled = snapshotJsonData(
    validateCompiledPipeline(root.compiled),
    "bound shard compiled pipeline"
  ) as BoundPipelineShard["compiled"];
  if (!Array.isArray(root.items) || root.items.length < 1) {
    throw new Error("bound shard items must be a non-empty array");
  }
  const items = root.items.map((item, index) => {
    const record = snapshotExactDataRecord(
      item,
      ["itemId", "ordinal", "input", "inputDigest"],
      `bound shard items[${index}]`
    );
    const itemId = assertIdentityString(record.itemId, `bound shard items[${index}].itemId`);
    if (!Number.isInteger(record.ordinal) || (record.ordinal as number) < 1) {
      throw new Error(`bound shard items[${index}].ordinal must be a positive integer`);
    }
    const inputDigest = assertDigest(record.inputDigest, `bound shard items[${index}].inputDigest`);
    if (digest(record.input) !== inputDigest) {
      throw new Error(`bound shard items[${index}].inputDigest does not match input`);
    }
    return Object.freeze({
      itemId,
      ordinal: record.ordinal as number,
      input: record.input,
      inputDigest
    });
  });
  return Object.freeze({
    runId,
    shardId,
    compiled,
    items: Object.freeze(items)
  });
}

function snapshotShardClaim(value: unknown): ShardClaim {
  const snapshot = snapshotJsonData(value, "pipeline shard claim");
  const root = snapshotExactDataRecord(
    snapshot,
    [
      "runId",
      "shardId",
      "leaseOwner",
      "leaseToken",
      "acquiredAt",
      "expiresAt",
      "compiled",
      "items"
    ],
    "pipeline shard claim"
  );
  const shard = snapshotBoundPipelineShard({
    runId: root.runId,
    shardId: root.shardId,
    compiled: root.compiled,
    items: root.items
  });
  return Object.freeze({
    ...shard,
    leaseOwner: assertIdentityString(root.leaseOwner, "pipeline shard claim leaseOwner"),
    leaseToken: assertIdentityString(root.leaseToken, "pipeline shard claim leaseToken"),
    acquiredAt: assertIdentityString(root.acquiredAt, "pipeline shard claim acquiredAt"),
    expiresAt: assertIdentityString(root.expiresAt, "pipeline shard claim expiresAt")
  }) as unknown as ShardClaim;
}

interface ShardSettlementEnvelope {
  readonly runId: string;
  readonly shardId: string;
  readonly leaseToken: string;
}

/**
 * Capture only the immutable identity needed to settle a claim before
 * validating the larger caller-owned payload. If compiled/items are corrupt,
 * this envelope still lets the runner release the exact fenced lease instead
 * of abandoning it until expiry.
 */
function snapshotShardSettlementEnvelope(value: unknown): ShardSettlementEnvelope {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new Error("pipeline shard claim settlement envelope must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const read = (key: "runId" | "shardId" | "leaseToken"): string => {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw new Error(
        `pipeline shard claim settlement envelope.${key} must be an enumerable data property`
      );
    }
    return assertIdentityString(
      descriptor.value,
      `pipeline shard claim settlement envelope ${key}`
    );
  };
  return Object.freeze({
    runId: read("runId"),
    shardId: read("shardId"),
    leaseToken: read("leaseToken")
  });
}

function boundItemSetDigest(shard: BoundPipelineShard): string {
  return digest(shard.items.map((item) => ({
    itemId: item.itemId,
    ordinal: item.ordinal,
    inputDigest: item.inputDigest
  })));
}

/**
 * Seal the immutable identity a host action must present with every bound
 * evidence append. Fence generations may change during takeover; this value
 * must not.
 */
export function createBoundPipelineExecutionIdentity(input: {
  hostActionId: string;
  shard: BoundPipelineShard;
}): BoundPipelineExecutionIdentity {
  const wrapper = snapshotExactDataRecord(
    input,
    ["hostActionId", "shard"],
    "bound execution identity input"
  );
  const shard = snapshotBoundPipelineShard(wrapper.shard);
  const compiled = snapshotJsonData(
    validateCompiledPipeline(shard.compiled),
    "pipeline shard compiled pipeline"
  ) as BoundPipelineShard["compiled"];
  const payload = {
    schemaVersion: "bound-pipeline-execution.v1" as const,
    hostActionId: assertIdentityString(wrapper.hostActionId, "hostActionId"),
    runId: shard.runId,
    shardId: shard.shardId,
    pipeline: {
      id: compiled.pipeline.id,
      version: compiled.pipeline.version,
      definitionDigest: compiled.pipeline.digest
    },
    compiledDigest: compiled.compiledDigest,
    itemCount: shard.items.length,
    itemSetDigest: boundItemSetDigest(shard)
  };
  return Object.freeze({
    ...payload,
    pipeline: Object.freeze(payload.pipeline),
    identityDigest: digest(payload)
  });
}

/** Validate the seal and its exact correspondence to the supplied shard. */
export function validateBoundPipelineExecutionIdentity(
  value: unknown,
  shard: BoundPipelineShard
): BoundPipelineExecutionIdentity {
  const canonicalShard = snapshotBoundPipelineShard(shard);
  const compiled = validateCompiledPipeline(canonicalShard.compiled);
  const identity = snapshotExactDataRecord(
    value,
    BOUND_IDENTITY_KEYS,
    "bound execution identity"
  );
  if (identity.schemaVersion !== "bound-pipeline-execution.v1") {
    throw new Error("bound execution identity schemaVersion is unsupported");
  }
  const hostActionId = assertIdentityString(identity.hostActionId, "bound execution identity hostActionId");
  const runId = assertIdentityString(identity.runId, "bound execution identity runId");
  const shardId = assertIdentityString(identity.shardId, "bound execution identity shardId");
  const pipeline = snapshotExactDataRecord(
    identity.pipeline,
    ["id", "version", "definitionDigest"],
    "bound execution identity pipeline"
  );
  const pipelineId = assertIdentityString(pipeline.id, "bound execution identity pipeline.id");
  const pipelineVersion = pipeline.version;
  if (!Number.isInteger(pipelineVersion) || (pipelineVersion as number) < 1) {
    throw new Error("bound execution identity pipeline.version must be a positive integer");
  }
  const definitionDigest = assertDigest(
    pipeline.definitionDigest,
    "bound execution identity pipeline.definitionDigest"
  );
  const compiledDigest = assertDigest(identity.compiledDigest, "bound execution identity compiledDigest");
  const itemSetDigest = assertDigest(identity.itemSetDigest, "bound execution identity itemSetDigest");
  const identityDigest = assertDigest(identity.identityDigest, "bound execution identity identityDigest");
  const itemCount = identity.itemCount;
  if (!Number.isInteger(itemCount) || (itemCount as number) < 1) {
    throw new Error("bound execution identity itemCount must be a positive integer");
  }
  const expectedItemSetDigest = boundItemSetDigest(canonicalShard);
  if (
    runId !== canonicalShard.runId
    || shardId !== canonicalShard.shardId
    || pipelineId !== compiled.pipeline.id
    || pipelineVersion !== compiled.pipeline.version
    || definitionDigest !== compiled.pipeline.digest
    || compiledDigest !== compiled.compiledDigest
    || itemCount !== canonicalShard.items.length
    || itemSetDigest !== expectedItemSetDigest
  ) {
    throw new Error("bound execution identity does not match the immutable shard");
  }
  const payload = {
    schemaVersion: "bound-pipeline-execution.v1" as const,
    hostActionId,
    runId,
    shardId,
    pipeline: {
      id: pipelineId,
      version: pipelineVersion as number,
      definitionDigest
    },
    compiledDigest,
    itemCount: itemCount as number,
    itemSetDigest
  };
  if (digest(payload) !== identityDigest) {
    throw new Error("bound execution identity digest does not match its payload");
  }
  // Never retain or pass through caller-owned/deserialized objects. The one
  // canonical frozen snapshot returned here is reused for every async append,
  // closing mutation races between validation and persistence.
  return Object.freeze({
    ...payload,
    pipeline: Object.freeze(payload.pipeline),
    identityDigest
  });
}

/**
 * The single node-walk implementation shared by Pipeline-owned and
 * externally fenced runners. It contains no lease lifecycle operations.
 */
async function executeShardNodes(
  input: ExecuteShardNodesInput
): Promise<ShardExecutionMetrics> {
  const { shard } = input;
  const compiled = snapshotJsonData(
    validateCompiledPipeline(shard.compiled),
    "pipeline shard compiled pipeline"
  ) as BoundPipelineShard["compiled"];
  const unsupportedNode = compiled.nodes.find(
    (node) => node.deliverySemantics === "at_most_once"
  );
  if (unsupportedNode !== undefined) {
    throw new PipelineStageError(
      "at_most_once_execution_unsupported",
      false,
      new Error(
        `pipeline contains at_most_once node ${unsupportedNode.nodeId}; v0.2 rejects the whole DAG before stage invocation`
      ),
      "shard"
    );
  }
  if (
    typeof shard.runId !== "string"
    || shard.runId.length === 0
    || typeof shard.shardId !== "string"
    || shard.shardId.length === 0
  ) {
    throw new Error(
      "Bound pipeline shard immutable configuration requires non-empty runId and shardId"
    );
  }
  if (shard.items.length === 0) {
    throw new Error(
      "Bound pipeline shard immutable configuration must contain at least one item"
    );
  }
  const itemIds = new Set<string>();
  const ordinals = new Set<number>();
  let lastOrdinal = 0;
  for (const item of shard.items) {
    if (
      typeof item.itemId !== "string"
      || item.itemId.length === 0
      || itemIds.has(item.itemId)
    ) {
      throw new Error(
        "Bound pipeline shard immutable configuration requires non-empty, unique itemId values"
      );
    }
    if (
      !Number.isInteger(item.ordinal)
      || item.ordinal < 1
      || ordinals.has(item.ordinal)
      || item.ordinal <= lastOrdinal
    ) {
      throw new Error(
        "Bound pipeline shard immutable configuration requires positive, unique, ascending ordinals"
      );
    }
    let actualInputDigest: string;
    try {
      actualInputDigest = digest(item.input);
    } catch (error) {
      throw new Error(
        `Bound pipeline shard item ${item.itemId} input is not digestable immutable configuration`,
        { cause: error }
      );
    }
    if (actualInputDigest !== item.inputDigest) {
      throw new Error(
        `Bound pipeline shard item ${item.itemId} inputDigest does not match its input`
      );
    }
    itemIds.add(item.itemId);
    ordinals.add(item.ordinal);
    lastOrdinal = item.ordinal;
  }

  let stageExecutionCount = 0;
  let reusedStageCount = 0;
  let terminalItemCount = 0;

  for (const item of shard.items) {
    const artifacts = new Map<string, unknown>();
    for (const node of compiled.nodes) {
      const slots: ResolvedSlotValue[] = node.inputs.map((nodeInput) => ({
        slot: nodeInput.slot,
        contract: nodeInput.contract,
        value:
          nodeInput.source.kind === "pipeline_input"
            ? item.input
            : artifacts.get(nodeInput.source.nodeId)
      }));
      if (slots.some(({ value }) => value === undefined)) {
        throw new Error(
          `Pipeline node ${node.nodeId} resolved an undefined input artifact — compiled topology violated`
        );
      }

      const executable = input.catalog.resolveExecutable(
        node.stage.id,
        node.stage.version
      );
      let invoke: (value: unknown, ctx: StageContext) => Promise<unknown>;
      if (node.kind === "code") {
        const run = executable.run;
        if (typeof run !== "function") {
          throw new Error(
            `Stage ${node.stage.id}@${node.stage.version} is kind "code" but its executable has no run() function`
          );
        }
        invoke = (value, ctx) => run.call(executable, value, ctx);
      } else {
        const invoker = input.invoker;
        if (!invoker) {
          throw new Error(
            `No NodeInvoker is configured for non-code pipeline node ${node.nodeId} (kind "${node.kind}")`
          );
        }
        invoke = (value, ctx) =>
          invoker.invoke({
            runId: shard.runId,
            itemId: item.itemId,
            node,
            input: value,
            attempt: ctx.attempt ?? 1,
            idempotencyKey: ctx.idempotencyKey!,
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal })
          });
      }

      const result = await input.executeStage({ item, node, slots, invoke });
      stageExecutionCount += 1;
      if (result.status === "terminal") {
        terminalItemCount += 1;
        break;
      }
      if (result.reused) reusedStageCount += 1;
      artifacts.set(node.nodeId, result.output);
    }
  }

  return {
    itemCount: shard.items.length,
    completedItemCount: shard.items.length - terminalItemCount,
    terminalItemCount,
    stageExecutionCount,
    reusedStageCount
  };
}

async function settleShardControl(
  error: unknown,
  claim: ShardSettlementEnvelope,
  store: PipelineStore,
  now: () => Date
): Promise<ShardRunOutcome | undefined> {
  if (isInstanceOf(error, PipelineShardDeferredError)) {
    // A control outcome is true only after its fenced durable settlement.
    // Lost fences therefore propagate instead of manufacturing audit truth.
    await store.deferShard({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      reasonCode: error.reasonCode,
      at: now().toISOString()
    });
    return {
      status: "deferred",
      runId: claim.runId,
      shardId: claim.shardId,
      reasonCode: error.reasonCode
    };
  }
  if (isInstanceOf(error, PipelineShardCancelledError)) {
    await store.cancelShard({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      reasonCode: error.reasonCode,
      at: now().toISOString()
    });
    return {
      status: "cancelled",
      runId: claim.runId,
      shardId: claim.shardId,
      reasonCode: error.reasonCode
    };
  }
  return undefined;
}

/**
 * Claim and process AT MOST ONE shard (idle when nothing is claimable).
 * Per-item failure isolation: a terminal item breaks out of ITS node loop
 * (downstream nodes skipped) while the other items continue; only shard-scoped
 * failures (lease lost, immutable configuration/contract rejections) abort the
 * whole shard via failShard. Finalization is derived from persisted evidence
 * by completeShard once every member is resolved.
 */
export async function runOneShard(options: ShardRunnerOptions): Promise<ShardRunOutcome> {
  const fields = snapshotOptionRecord(
    options,
    SHARD_RUNNER_OPTION_KEYS,
    ["store", "catalog", "leaseOwner"],
    "runOneShard options"
  );
  const store = capturePipelineStore(fields.store);
  const catalog = captureStageCatalog(fields.catalog);
  const leaseOwner = assertIdentityString(fields.leaseOwner, "runOneShard leaseOwner");
  const invoker = fields.invoker === undefined
    ? undefined
    : captureNodeInvoker(fields.invoker);
  const outboxEventsFor = fields.outboxEventsFor;
  if (outboxEventsFor !== undefined && typeof outboxEventsFor !== "function") {
    throw new Error("runOneShard: outboxEventsFor must be a function");
  }
  const failureOutboxEventsFor = fields.failureOutboxEventsFor;
  if (
    failureOutboxEventsFor !== undefined
    && typeof failureOutboxEventsFor !== "function"
  ) {
    throw new Error("runOneShard: failureOutboxEventsFor must be a function");
  }
  const maxAttemptsByNode = fields.maxAttemptsByNode === undefined
    ? undefined
    : snapshotJsonData(
        fields.maxAttemptsByNode,
        "runOneShard maxAttemptsByNode"
      ) as Record<string, number>;
  const leaseDurationMs = (fields.leaseDurationMs as number | undefined) ?? 1_200_000;
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error("runOneShard: leaseDurationMs must be a positive integer");
  }
  const heartbeatEveryMs = (fields.heartbeatEveryMs as number | undefined)
    ?? Math.max(10_000, Math.floor(leaseDurationMs / 3));
  if (!Number.isInteger(heartbeatEveryMs) || heartbeatEveryMs < 1 || heartbeatEveryMs >= leaseDurationMs) {
    throw new Error("runOneShard: heartbeatEveryMs must be a positive integer less than leaseDurationMs");
  }
  const maxAttempts = (fields.maxAttempts as number | undefined) ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("runOneShard: maxAttempts must be an integer from 1 through 10");
  }
  if ((fields.runId === undefined) !== (fields.shardId === undefined)) {
    throw new Error("runOneShard: an exact shard run requires both runId and shardId");
  }
  const nowCandidate = fields.now ?? (() => new Date());
  if (typeof nowCandidate !== "function") {
    throw new Error("runOneShard: now must be a function");
  }
  const now = nowCandidate as () => Date;
  const capturedOptions = Object.freeze({
    store,
    catalog,
    leaseOwner,
    leaseDurationMs,
    heartbeatEveryMs,
    maxAttempts,
    ...(invoker === undefined ? {} : { invoker }),
    ...(maxAttemptsByNode === undefined ? {} : { maxAttemptsByNode }),
    ...(fields.runId === undefined
      ? {}
      : { runId: fields.runId as string, shardId: fields.shardId as string }),
    ...(outboxEventsFor === undefined ? {} : { outboxEventsFor }),
    ...(failureOutboxEventsFor === undefined ? {} : { failureOutboxEventsFor }),
    ...(fields.signal === undefined ? {} : { signal: fields.signal as AbortSignal }),
    now
  }) as ShardRunnerOptions & {
    leaseDurationMs: number;
    heartbeatEveryMs: number;
    maxAttempts: number;
    now: () => Date;
  };

  const claimRaw = await store.claimNextShard({
    leaseOwner,
    leaseDurationMs,
    ...(fields.runId === undefined
      ? {}
      : { runId: fields.runId as string, shardId: fields.shardId as string }),
    at: now().toISOString()
  });
  if (!claimRaw) return { status: "idle" };
  // Capture the fence envelope first. Full claim validation is intentionally
  // inside the settlement guard so corrupt compiled/item evidence does not
  // strand a valid lease for its entire duration.
  const settlementClaim = snapshotShardSettlementEnvelope(claimRaw);

  try {
    const claim = snapshotShardClaim(claimRaw);
    return await processClaim(claim, capturedOptions);
  } catch (error) {
    const controlOutcome = await settleShardControl(
      error,
      settlementClaim,
      store,
      now
    );
    if (controlOutcome) return controlOutcome;
    const failure = classifyStageFailure(error);
    try {
      await store.failShard({
        shardId: settlementClaim.shardId,
        leaseToken: settlementClaim.leaseToken,
        retryable: failure.retryable,
        errorCode: failure.code,
        at: now().toISOString()
      });
    } catch (finishError) {
      // A lost fence cannot prove that this failure was recorded. It may mean
      // a concurrent claimant owns the shard, or that completeShard committed
      // and only its response was lost. Propagate the typed authority loss;
      // returning status:"failed" here would manufacture settlement evidence.
      if (isInstanceOf(finishError, ShardLeaseLostError)) {
        throw finishError;
      } else {
        // A host may discover authoritative defer/cancel state only while
        // revalidating inside failShard's settlement transaction. Route that
        // late control through the same fenced settlement instead of appending
        // or reporting a false shard failure.
        const lateControlOutcome = await settleShardControl(
          finishError,
          settlementClaim,
          store,
          now
        );
        if (lateControlOutcome) return lateControlOutcome;
        throw finishError;
      }
    }
    return {
      status: "failed",
      runId: settlementClaim.runId,
      shardId: settlementClaim.shardId,
      retryable: failure.retryable,
      errorCode: failure.code
    };
  }
}

/**
 * Execute an already-bound shard under a host-owned fence.
 *
 * The runner performs only digest/contract validation, durable stage evidence,
 * invocation, retry routing, and deterministic node traversal. It cannot
 * claim, heartbeat, defer, cancel, complete, fail, or release host work
 * because those operations do not exist on {@link BoundPipelineEvidenceStore}.
 * The host validates the returned outcome and performs its one authoritative
 * settlement transaction.
 */
export async function runBoundShard<TFence>(
  options: BoundShardRunnerOptions<TFence>
): Promise<BoundShardRunOutcome> {
  const fields = snapshotOptionRecord(
    options,
    BOUND_RUNNER_OPTION_KEYS,
    ["shard", "evidenceStore", "fence", "executionIdentity", "catalog"],
    "runBoundShard options"
  );
  const maxAttempts = (fields.maxAttempts as number | undefined) ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error(
      "runBoundShard: maxAttempts must be an integer from 1 through 10"
    );
  }
  const nowCandidate = fields.now ?? (() => new Date());
  if (typeof nowCandidate !== "function") {
    throw new Error("runBoundShard: now must be a function");
  }
  const now = nowCandidate as () => Date;
  const catalog = captureStageCatalog(fields.catalog);
  const evidenceStore = captureBoundEvidenceStore<TFence>(fields.evidenceStore);
  const fence = fields.fence as TFence;
  const invoker = fields.invoker === undefined
    ? undefined
    : captureNodeInvoker(fields.invoker);
  const outboxEventsFor = fields.outboxEventsFor;
  if (outboxEventsFor !== undefined && typeof outboxEventsFor !== "function") {
    throw new Error("runBoundShard: outboxEventsFor must be a function");
  }
  const failureOutboxEventsFor = fields.failureOutboxEventsFor;
  if (
    failureOutboxEventsFor !== undefined
    && typeof failureOutboxEventsFor !== "function"
  ) {
    throw new Error("runBoundShard: failureOutboxEventsFor must be a function");
  }
  const maxAttemptsByNode = fields.maxAttemptsByNode === undefined
    ? undefined
    : snapshotJsonData(
        fields.maxAttemptsByNode,
        "runBoundShard maxAttemptsByNode"
      ) as Record<string, number>;
  // Capture every caller-owned byte once before any async boundary. All
  // evidence and outcomes below use only this canonical frozen snapshot.
  const shard = snapshotBoundPipelineShard(fields.shard);

  try {
    const executionIdentity = validateBoundPipelineExecutionIdentity(
      fields.executionIdentity,
      shard
    );
    const compiled = snapshotJsonData(
      validateCompiledPipeline(shard.compiled),
      "bound shard compiled pipeline"
    ) as BoundPipelineShard["compiled"];
    const unsafeNode = compiled.nodes.find(
      (node) => node.deliverySemantics === "at_most_once"
    );
    if (unsafeNode !== undefined) {
      throw new PipelineStageError(
        "at_most_once_execution_unsupported",
        false,
        new Error(
          `node ${unsafeNode.nodeId} declares at_most_once, which v0.2 rejects before invocation: crash-safe execution requires durable intent plus indeterminate-effect reconciliation`
        ),
        "shard"
      );
    }
    const metrics = await executeShardNodes({
      shard,
      catalog,
      ...(invoker === undefined ? {} : { invoker }),
      executeStage: ({ item, node, slots, invoke }) =>
        executeBoundDurableStage({
          evidenceStore,
          fence,
          executionIdentity,
          contracts: catalog.contracts,
          runId: shard.runId,
          itemId: item.itemId,
          node,
          slots,
          invoke,
          maxAttempts:
            maxAttemptsByNode?.[node.nodeId] ?? maxAttempts,
          ...(outboxEventsFor === undefined
            ? {}
            : {
                outboxEvents: (output, { runId, attempt, idempotencyKey }) =>
                  assembleBoundOutbox(
                    "assemble_success_outbox",
                    () => outboxEventsFor({
                      runId,
                      node,
                      itemId: item.itemId,
                      output,
                      attempt,
                      idempotencyKey
                    })
                  )
              }),
          ...(failureOutboxEventsFor === undefined
            ? {}
            : {
                failureOutboxEvents: (context) =>
                  assembleBoundOutbox(
                    "assemble_failure_outbox",
                    () => failureOutboxEventsFor(context)
                  )
              }),
          ...(fields.signal === undefined
            ? {}
            : { signal: fields.signal as AbortSignal }),
          now
        })
    });

    if (metrics.terminalItemCount > 0) {
      return {
        status: "partial",
        runId: shard.runId,
        shardId: shard.shardId,
        itemCount: metrics.itemCount,
        completedItemCount: metrics.completedItemCount,
        terminalItemCount: metrics.terminalItemCount,
        stageExecutionCount: metrics.stageExecutionCount,
        reusedStageCount: metrics.reusedStageCount
      };
    }
    return {
      status: "completed",
      runId: shard.runId,
      shardId: shard.shardId,
      itemCount: metrics.itemCount,
      stageExecutionCount: metrics.stageExecutionCount,
      reusedStageCount: metrics.reusedStageCount
    };
  } catch (error) {
    // External authority failures are not stage outcomes. The host needs the
    // original typed rejection to decide whether its task was fenced/reclaimed.
    if (
      isInstanceOf(error, ExternalFenceRejectedError)
      || isInstanceOf(error, BoundEvidencePersistenceError)
      || isInstanceOf(error, OutboxEvidenceNotCommittedError)
      || isInstanceOf(error, StageEvidenceAssemblyError)
      || isInstanceOf(error, StageResultConflictError)
      || isInstanceOf(error, EvidenceConflictError)
    ) throw error;
    if (isInstanceOf(error, PipelineControlOutcomeError)) {
      return {
        status: "control",
        runId: shard.runId,
        shardId: shard.shardId,
        control: error.outcome
      };
    }
    if (isInstanceOf(error, PipelineShardDeferredError)) {
      return {
        status: "control",
        runId: shard.runId,
        shardId: shard.shardId,
        control: {
          kind: "deferred",
          reasonCode: error.reasonCode
        }
      };
    }
    if (isInstanceOf(error, PipelineShardCancelledError)) {
      return {
        status: "control",
        runId: shard.runId,
        shardId: shard.shardId,
        control: {
          kind: "cancelled",
          reasonCode: error.reasonCode
        }
      };
    }
    const failure = classifyStageFailure(error);
    return {
      status: "failed",
      runId: shard.runId,
      shardId: shard.shardId,
      retryable: failure.retryable,
      errorCode: failure.code
    };
  }
}

function assembleBoundOutbox<T extends OutboxEvents>(
  operation: "assemble_success_outbox" | "assemble_failure_outbox",
  assemble: () => T
): T {
  try {
    return assemble();
  } catch (error) {
    if (isInstanceOf(error, BoundEvidencePersistenceError)) throw error;
    throw new BoundEvidencePersistenceError(operation, error);
  }
}

/**
 * Descriptive alias for hosts that call the pre-bound input an externally
 * claimed shard. This is the same implementation, not a second lifecycle.
 */
export const executeClaimedShard: typeof runBoundShard = runBoundShard;

async function processClaim(
  claim: ShardClaim,
  options: ShardRunnerOptions & { leaseDurationMs: number; heartbeatEveryMs: number; maxAttempts: number; now: () => Date }
): Promise<ShardRunOutcome> {
  const metrics = await executeShardNodes({
    shard: claim,
    catalog: options.catalog,
    ...(options.invoker === undefined ? {} : { invoker: options.invoker }),
    executeStage: ({ item, node, slots, invoke }) =>
      runWithShardHeartbeat({
        store: options.store,
        shardId: claim.shardId,
        leaseToken: claim.leaseToken,
        everyMs: options.heartbeatEveryMs,
        extendByMs: options.leaseDurationMs,
        now: options.now,
        operation: () =>
          executeDurableStage({
            store: options.store,
            contracts: options.catalog.contracts,
            shardId: claim.shardId,
            leaseToken: claim.leaseToken,
            runId: claim.runId,
            itemId: item.itemId,
            node,
            slots,
            invoke,
            maxAttempts:
              options.maxAttemptsByNode?.[node.nodeId] ?? options.maxAttempts,
            ...(options.outboxEventsFor === undefined
              ? {}
              : {
                  outboxEvents: (output, { runId, attempt, idempotencyKey }) =>
                    options.outboxEventsFor!({
                      runId,
                      node,
                      itemId: item.itemId,
                      output,
                      attempt,
                      idempotencyKey
                    })
                }),
            ...(options.failureOutboxEventsFor === undefined
              ? {}
              : {
                  failureOutboxEvents: options.failureOutboxEventsFor
                }),
            ...(options.signal === undefined
              ? {}
              : { signal: options.signal }),
            now: options.now
          })
      })
  });

  const finalization = await options.store.completeShard({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    at: options.now().toISOString()
  });
  if (finalization.status === "partial") {
    return {
      status: "partial",
      runId: claim.runId,
      shardId: claim.shardId,
      itemCount: finalization.itemCount,
      completedItemCount: finalization.completedItemCount,
      terminalItemCount: finalization.terminalItemCount,
      stageExecutionCount: metrics.stageExecutionCount,
      reusedStageCount: metrics.reusedStageCount
    };
  }
  return {
    status: "completed",
    runId: claim.runId,
    shardId: claim.shardId,
    itemCount: finalization.itemCount,
    stageExecutionCount: metrics.stageExecutionCount,
    reusedStageCount: metrics.reusedStageCount
  };
}

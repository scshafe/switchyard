import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import {
  createGraphDefinition,
  graphDefinitionRef
} from "@scshafe/switchyard/graph/definition";
import { ExecutionFailureError } from "@scshafe/switchyard/execute/failure";
import {
  recordHumanNodeDecision,
  runNextUnitTurn
} from "@scshafe/switchyard/execute/unit-runner";
import {
  nodeExecutionFingerprint,
  nodeTurnCompletionDigest
} from "@scshafe/switchyard/execute/turn";
import { nodeTurnSettlementDigest } from "@scshafe/switchyard/execute/turn-evidence";
import {
  registerUnitStoreConformanceTests
} from "@scshafe/switchyard/store/unit-store-conformance";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import {
  MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION,
  MemoryUnitStore
} from "@scshafe/switchyard/store/memory-unit-store";

function memoryDriver() {
  let epoch = Date.parse("2026-08-27T12:00:00.000Z");
  let nextId = 1;
  let armed;
  let hits = [];
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({
    graphStore,
    now: () => new Date(epoch),
    idFactory: (kind) => `${kind}-${nextId++}`,
    settleCheckpoint: (checkpoint) => {
      hits.push(checkpoint);
      if (checkpoint === armed) {
        throw new Error(`simulated process death at settle checkpoint ${checkpoint}`);
      }
    }
  });

  return {
    graphStore,
    unitStore,
    now: () => new Date(epoch),
    advanceClock(milliseconds) {
      epoch += milliseconds;
    },
    armSettleCrash(checkpoint) {
      armed = checkpoint;
      hits = [];
    },
    async recover() {
      armed = undefined;
    },
    checkpointHits() {
      return Object.freeze([...hits]);
    },
    async evidence() {
      return unitStore.evidenceSnapshot();
    },
    async close() {}
  };
}

registerUnitStoreConformanceTests({
  backendName: "MemoryUnitStore",
  createDriver: () => memoryDriver()
});

const SNAPSHOT_TURN = Object.freeze({
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 1_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
});

function snapshotNode(nodeId, refId) {
  return {
    nodeId,
    ref: { id: refId, version: 1 },
    kind: "code",
    input: "unit-artifact.v1",
    outcomes: { version: 1, outcomes: ["done"] },
    principal: { id: "v2_worker" },
    turn: SNAPSHOT_TURN
  };
}

function snapshotGraph(graphId, routed = false, sharedRefId) {
  const source = snapshotNode("source", sharedRefId ?? `${graphId}.source`);
  if (!routed) {
    return createGraphDefinition({
      graphId,
      version: 1,
      description: `Snapshot state graph ${graphId}.`,
      entry: "source",
      nodes: [source],
      edges: [],
      terminals: [{ nodeId: "source", outcome: "done" }]
    });
  }
  return createGraphDefinition({
    graphId,
    version: 1,
    description: `Snapshot continuation graph ${graphId}.`,
    entry: "source",
    nodes: [source, snapshotNode("target", `${graphId}.target`)],
    edges: [{
      edgeId: "source-target",
      from: "source",
      when: { outcome: "done" },
      to: ["target"]
    }],
    terminals: [{ nodeId: "target", outcome: "done" }]
  });
}

function snapshotJoinGraph(graphId) {
  return createGraphDefinition({
    graphId,
    version: 1,
    description: `Snapshot join continuation graph ${graphId}.`,
    entry: "start",
    nodes: [
      snapshotNode("start", `${graphId}.start`),
      snapshotNode("branch-a", `${graphId}.branch-a`),
      snapshotNode("branch-b", `${graphId}.branch-b`),
      {
        ...snapshotNode("join", `${graphId}.join`),
        outcomes: { version: 1, outcomes: ["done", "join_unsatisfiable"] },
        join: { inbound: ["a-join", "b-join"], require: "all" }
      }
    ],
    edges: [
      { edgeId: "start-a", from: "start", when: { outcome: "done" }, to: ["branch-a"] },
      { edgeId: "start-b", from: "start", when: { outcome: "done" }, to: ["branch-b"] },
      { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
      { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] }
    ],
    terminals: [
      { nodeId: "join", outcome: "done" },
      { nodeId: "join", outcome: "join_unsatisfiable" }
    ]
  });
}

function snapshotHarness(options = {}) {
  const clock = options.clock ?? { epoch: Date.parse("2026-08-28T12:00:00.000Z") };
  const graphStore = options.graphStore ?? new MemoryGraphStore();
  let nextId = 1;
  const prefix = options.prefix ?? "snapshot";
  const unitStore = new MemoryUnitStore({
    graphStore,
    now: () => new Date(clock.epoch),
    idFactory: (kind) => `${prefix}-${kind}-${nextId++}`,
    ...(options.initialState === undefined ? {} : { initialState: options.initialState })
  });
  return { clock, graphStore, unitStore };
}

async function snapshotAdmit(harness, graph, unitId) {
  await harness.graphStore.publishGraph(graph);
  return harness.unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("unit-artifact.v1", { unitId }),
    admittedAt: new Date(harness.clock.epoch).toISOString(),
    principalId: "v2_admitter"
  });
}

async function claimAndCache(harness, nodeId = "source") {
  const claims = await harness.unitStore.claimUnitTurns({
    principalId: "v2_worker",
    leaseOwner: "snapshot-worker",
    batch: 1,
    nodeId
  });
  assert.equal(claims.length, 1);
  const claim = claims[0];
  const node = claim.graph.nodes.find((candidate) => candidate.nodeId === claim.nodeId);
  assert.ok(node);
  const prepared = await harness.unitStore.prepareTurnAttempt({
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    leaseToken: claim.leaseToken,
    nodeRef: node.ref,
    fingerprint: nodeExecutionFingerprint(node),
    inputDigest: claim.inputArtifact.digest,
    maxAttempts: node.turn.maxAttempts
  });
  assert.equal(prepared.disposition, "reserved");
  const completion = Object.freeze({ outcome: "done" });
  const completionDigest = nodeTurnCompletionDigest(completion);
  const at = new Date(harness.clock.epoch).toISOString();
  await harness.unitStore.cacheTurnCompletion({
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    leaseToken: claim.leaseToken,
    attemptNumber: prepared.attemptNumber,
    attemptIndex: prepared.attemptIndex,
    idempotencyKey: prepared.idempotencyKey,
    completion,
    completionDigest,
    startedAt: at,
    settledAt: at
  });
  return { claim, prepared, completion, completionDigest, at };
}

async function runSnapshotCode(harness, nodeId) {
  return runNextUnitTurn({
    store: harness.unitStore,
    principalId: "v2_worker",
    leaseOwner: `snapshot-${nodeId}`,
    nodeId,
    ports: { code: { run: async () => ({ outcome: "done" }) } },
    now: () => new Date(harness.clock.epoch)
  });
}

test("MemoryUnitStore state snapshot restores an active lease and continues settlement atomically", async () => {
  const original = snapshotHarness({ prefix: "before-restore" });
  const graph = snapshotGraph("memory-store.snapshot-settle", true);
  await snapshotAdmit(original, graph, "unit-snapshot-settle");
  const cached = await claimAndCache(original);
  const snapshot = structuredClone(original.unitStore.stateSnapshot());
  snapshot.nextEnqueueSequence += 10;

  const restored = snapshotHarness({
    initialState: snapshot,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "after-restore"
  });
  const settlementDigest = nodeTurnSettlementDigest({
    queueId: cached.claim.queueId,
    unitId: cached.claim.unitId,
    nodeId: cached.claim.nodeId,
    attemptNumber: cached.prepared.attemptNumber,
    attemptIndex: cached.prepared.attemptIndex,
    idempotencyKey: cached.prepared.idempotencyKey,
    principalId: "v2_worker",
    startedAt: cached.at,
    settledAt: cached.at,
    completionDigest: cached.completionDigest
  });
  const settleInput = {
    queueId: cached.claim.queueId,
    unitId: cached.claim.unitId,
    nodeId: cached.claim.nodeId,
    leaseToken: cached.claim.leaseToken,
    attemptNumber: cached.prepared.attemptNumber,
    attemptIndex: cached.prepared.attemptIndex,
    idempotencyKey: cached.prepared.idempotencyKey,
    principalId: "v2_worker",
    startedAt: cached.at,
    settledAt: cached.at,
    completion: cached.completion,
    completionDigest: cached.completionDigest,
    settlementDigest
  };
  const duplicateDigestOutbox = [
    { eventType: "snapshot event", payload: { ordinal: 1 } },
    { eventType: "snapshot event", payload: { ordinal: 1 } }
  ];
  const settled = await restored.unitStore.settleTurn(settleInput, duplicateDigestOutbox);

  assert.equal(settled.created, true);
  const targets = await restored.unitStore.listQueuedUnits({
    principalId: "v2_worker",
    nodeId: "target"
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].unitId, "unit-snapshot-settle");
  assert.equal(
    restored.unitStore.stateSnapshot().queues.find((queue) => queue.nodeId === "target")
      .enqueueSequence,
    snapshot.nextEnqueueSequence
  );
  assert.equal(restored.unitStore.stateSnapshot().leases.length, 0);
  const concluded = restored.unitStore.stateSnapshot();
  assert.equal(concluded.outbox.length, 2);
  assert.equal(concluded.outbox[0].eventDigest, concluded.outbox[1].eventDigest);
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: concluded }));
});

test("MemoryUnitStore state snapshot reclaims an expired cached attempt without rerunning its body", async () => {
  const original = snapshotHarness({ prefix: "cached-before" });
  const graph = snapshotGraph("memory-store.snapshot-cached");
  await snapshotAdmit(original, graph, "unit-snapshot-cached");
  await claimAndCache(original);
  const snapshot = original.unitStore.stateSnapshot();
  original.clock.epoch += SNAPSHOT_TURN.leaseMs + 1;

  const restored = snapshotHarness({
    initialState: snapshot,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "cached-after"
  });
  let bodyCalls = 0;
  const result = await runNextUnitTurn({
    store: restored.unitStore,
    principalId: "v2_worker",
    leaseOwner: "restored-worker",
    nodeId: "source",
    ports: {
      code: {
        run: async () => {
          bodyCalls += 1;
          return { outcome: "done" };
        }
      }
    },
    now: () => new Date(restored.clock.epoch)
  });

  assert.equal(result?.status, "succeeded");
  assert.equal(bodyCalls, 0);
  const state = restored.unitStore.stateSnapshot();
  assert.equal(state.cachedCompletions.length, 1);
  assert.equal(state.settlements.length, 1);
});

test("MemoryUnitStore state snapshot preserves external lease completion metadata", async () => {
  const original = snapshotHarness({ prefix: "external-before" });
  const graph = createGraphDefinition({
    graphId: "memory-store.snapshot-external",
    version: 1,
    description: "Snapshot continuation retains the submitted human decision fence.",
    entry: "review",
    nodes: [{
      ...snapshotNode("review", "memory-store.snapshot-external.review"),
      kind: "human",
      outcomes: { version: 1, outcomes: ["approved", "rejected"] },
      principal: { id: "v2_console" }
    }],
    edges: [],
    terminals: [
      { nodeId: "review", outcome: "approved" },
      { nodeId: "review", outcome: "rejected" }
    ]
  });
  const admitted = await snapshotAdmit(original, graph, "unit-snapshot-external");
  const completionDigest = nodeTurnCompletionDigest({ outcome: "approved" });
  const claimed = await original.unitStore.claimExternalUnitTurn({
    principalId: "v2_console",
    kind: "human",
    queueId: admitted.entryQueue.queueId,
    unitId: admitted.unit.unitId,
    nodeId: "review",
    actorId: "operator-1",
    completionDigest,
    outboxEventDigests: []
  });
  assert.equal(claimed.disposition, "claimed");
  const snapshot = original.unitStore.stateSnapshot();
  assert.deepEqual(snapshot.leases[0].lease.external, {
    kind: "human",
    actorId: "operator-1",
    completionDigest,
    outboxEventDigests: []
  });

  const restored = snapshotHarness({
    initialState: snapshot,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "external-after"
  });
  const result = await recordHumanNodeDecision({
    store: restored.unitStore,
    principalId: "v2_console",
    decision: {
      queueId: admitted.entryQueue.queueId,
      unitId: admitted.unit.unitId,
      nodeId: "review",
      outcome: "approved",
      actor: { actorId: "operator-1" }
    },
    now: () => new Date(restored.clock.epoch)
  });
  assert.equal(result.status, "succeeded");
  assert.equal(restored.unitStore.stateSnapshot().leases.length, 0);
});

test("MemoryUnitStore state snapshot restores retry and terminal dead-letter evidence", async () => {
  const original = snapshotHarness({ prefix: "failure-before" });
  const graph = snapshotGraph("memory-store.snapshot-failure");
  await snapshotAdmit(original, graph, "unit-snapshot-failure");
  const result = await runNextUnitTurn({
    store: original.unitStore,
    principalId: "v2_worker",
    leaseOwner: "failure-worker",
    nodeId: "source",
    ports: {
      code: {
        run: async () => {
          throw new ExecutionFailureError("snapshot_retry_exhausted", true);
        }
      }
    },
    now: () => new Date(original.clock.epoch)
  });
  assert.equal(result.status, "terminal");
  const snapshot = original.unitStore.stateSnapshot();
  assert.equal(snapshot.failures.length, 2);
  assert.equal(snapshot.deadLetters.length, 1);

  const restored = snapshotHarness({
    initialState: snapshot,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "failure-after"
  });
  assert.deepEqual(restored.unitStore.stateSnapshot(), snapshot);
  assert.equal((await restored.unitStore.listDeadLetters()).length, 1);
});

test("MemoryUnitStore state snapshot resumes pending join progress and queues it once", async () => {
  const original = snapshotHarness({ prefix: "join-before" });
  const graph = snapshotJoinGraph("memory-store.snapshot-join");
  await snapshotAdmit(original, graph, "unit-snapshot-join");
  assert.equal((await runSnapshotCode(original, "start")).status, "succeeded");
  assert.equal((await runSnapshotCode(original, "branch-a")).status, "succeeded");
  const pending = await original.unitStore.readJoinProgress({
    unitId: "unit-snapshot-join",
    nodeId: "join"
  });
  assert.equal(pending.status, "pending");

  const restored = snapshotHarness({
    initialState: original.unitStore.stateSnapshot(),
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "join-after"
  });
  assert.equal((await runSnapshotCode(restored, "branch-b")).status, "succeeded");
  const queued = await restored.unitStore.readJoinProgress({
    unitId: "unit-snapshot-join",
    nodeId: "join"
  });
  assert.equal(queued.status, "queued");
  assert.equal((await restored.unitStore.listQueuedUnits({
    principalId: "v2_worker",
    nodeId: "join"
  })).length, 1);
  assert.doesNotThrow(() => new MemoryUnitStore({
    initialState: restored.unitStore.stateSnapshot()
  }));
});

test("MemoryUnitStore state snapshot preserves the per-shared-node graph fairness cursor", async () => {
  const original = snapshotHarness({ prefix: "fair-before" });
  const sharedRef = "memory-store.snapshot-fairness.shared";
  const graphA = snapshotGraph("memory-store.snapshot-fairness-a", false, sharedRef);
  const graphB = snapshotGraph("memory-store.snapshot-fairness-b", false, sharedRef);
  await snapshotAdmit(original, graphA, "unit-fair-a1");
  await snapshotAdmit(original, graphA, "unit-fair-a2");
  await snapshotAdmit(original, graphB, "unit-fair-b1");

  const first = await original.unitStore.claimUnitTurns({
    principalId: "v2_worker",
    leaseOwner: "fairness-before",
    batch: 1,
    nodeId: "source"
  });
  assert.equal(first[0].unitId, "unit-fair-a1");
  const snapshot = original.unitStore.stateSnapshot();
  assert.equal(snapshot.fairnessCursor.length, 1);

  const restored = snapshotHarness({
    initialState: snapshot,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "fair-after"
  });
  const second = await restored.unitStore.claimUnitTurns({
    principalId: "v2_worker",
    leaseOwner: "fairness-after",
    batch: 1,
    nodeId: "source"
  });
  assert.equal(second[0].unitId, "unit-fair-b1");
});

test("MemoryUnitStore state hydration detaches input and rejects duplicate or broken sealed evidence", async () => {
  const original = snapshotHarness({ prefix: "validation-before" });
  const graph = snapshotGraph("memory-store.snapshot-validation");
  await snapshotAdmit(original, graph, "unit-snapshot-validation");
  const snapshot = original.unitStore.stateSnapshot();
  assert.equal(snapshot.schemaVersion, MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.unitGraphs[0].graph), true);

  const mutable = structuredClone(snapshot);
  const restored = snapshotHarness({
    initialState: mutable,
    graphStore: original.graphStore,
    clock: original.clock,
    prefix: "validation-after"
  });
  mutable.units[0].unitId = "caller-mutated";
  assert.equal(
    (await restored.unitStore.readUnit({ unitId: "unit-snapshot-validation" })).unitId,
    "unit-snapshot-validation"
  );

  const duplicateQueue = structuredClone(snapshot);
  duplicateQueue.queues.push(structuredClone(duplicateQueue.queues[0]));
  assert.throws(
    () => new MemoryUnitStore({ initialState: duplicateQueue }),
    /queues: duplicate identity/
  );

  const staleSequence = structuredClone(snapshot);
  staleSequence.nextEnqueueSequence = staleSequence.queues[0].enqueueSequence;
  assert.throws(
    () => new MemoryUnitStore({ initialState: staleSequence }),
    /nextEnqueueSequence must exceed every retained queue sequence/
  );

  const brokenJourney = structuredClone(snapshot);
  brokenJourney.journey[0].principalId = "forged_principal";
  assert.throws(
    () => new MemoryUnitStore({ initialState: brokenJourney }),
    /journey record digest mismatch/
  );

  const brokenGraph = structuredClone(snapshot);
  brokenGraph.unitGraphs[0].graph.description = "digest seal bypass";
  assert.throws(
    () => new MemoryUnitStore({ initialState: brokenGraph }),
    /digest mismatch/
  );
});

test("MemoryUnitStore captures Date intrinsics before hostile runtime mutation", async () => {
  const driver = memoryDriver();
  const graph = createGraphDefinition({
    graphId: "memory-store.date-intrinsics",
    version: 1,
    description: "Date authority is captured before store operations.",
    entry: "only",
    nodes: [{
      nodeId: "only",
      ref: { id: "memory-store.date-intrinsics.only", version: 1 },
      kind: "code",
      input: "unit-artifact.v1",
      outcomes: { version: 1, outcomes: ["done"] },
      principal: { id: "v2_worker" },
      turn: {
        idempotency: "per (unitId, nodeId, attemptNumber)",
        leaseMs: 1_000,
        maxAttempts: 1,
        retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
      }
    }],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "done" }]
  });
  await driver.graphStore.publishGraph(graph);
  await driver.unitStore.admitUnit({
    unitId: "unit-date-intrinsics",
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("unit-artifact.v1", { seed: true }),
    admittedAt: driver.now().toISOString(),
    principalId: "v2_admitter"
  });

  const originalParse = Date.parse;
  const originalToISOString = Date.prototype.toISOString;
  Date.parse = () => {
    throw new Error("hostile Date.parse");
  };
  Date.prototype.toISOString = () => {
    throw new Error("hostile Date.prototype.toISOString");
  };
  try {
    const claims = await driver.unitStore.claimUnitTurns({
      principalId: "v2_worker",
      leaseOwner: "date-intrinsics-worker",
      batch: 1,
      nodeId: "only"
    });
    assert.equal(claims.length, 1);
  } finally {
    Date.parse = originalParse;
    Date.prototype.toISOString = originalToISOString;
  }
});

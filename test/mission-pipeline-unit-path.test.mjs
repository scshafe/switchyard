import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import { digest } from "mission-pipeline/contracts/digest";
import { nodeExecutionFingerprint } from "mission-pipeline/execute/turn";
import { nodeTurnFailureDigest } from "mission-pipeline/execute/turn-evidence";
import { runNextUnitTurn } from "mission-pipeline/execute/unit-runner";
import { createGraphDefinition, graphDefinitionRef } from "mission-pipeline/graph/definition";
import { MemoryGraphStore } from "mission-pipeline/store/memory-graph-store";
import { MemoryUnitStore } from "mission-pipeline/store/memory-unit-store";
import {
  MAX_UNIT_PATH_RECORDS,
  projectUnitPath,
  UNIT_PATH_SCHEMA_VERSION
} from "mission-pipeline/store/unit-path";
import { node } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";
import {
  FIXTURES,
  createSupportTriageHarness
} from "./fixtures/mission-pipeline/support-triage-example.mjs";

const WORKER = "v2_worker";

/** Prototype-free records compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** A tiny memory harness with a deterministic clock the tests can advance. */
function harness(graph, unitId, prefix) {
  let epoch = Date.parse("2026-09-10T11:00:00.000Z");
  let sequence = 0;
  const now = () => new Date((epoch += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({ graphStore, now, idFactory: (kind) => `${prefix}-${kind}-${++sequence}` });
  return {
    unitStore,
    now,
    advance: (ms) => { epoch += ms; },
    async admit() {
      await graphStore.publishGraph(graph);
      return unitStore.admitUnit({
        unitId,
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope("unit-artifact.v1", { unitId }),
        admittedAt: now().toISOString(),
        principalId: "v2_admitter"
      });
    },
    run(nodeId, completion) {
      return runNextUnitTurn({
        store: unitStore,
        principalId: WORKER,
        leaseOwner: `${prefix}-worker`,
        nodeId,
        ports: { code: { run: async () => completion } },
        now
      });
    },
    journey: () => unitStore.readJourney({ unitId })
  };
}

function joinGraph(graphId, branchAOutcomes = ["done"], recover = false) {
  return createGraphDefinition({
    graphId,
    version: 1,
    description: `Join projection graph ${graphId}.`,
    entry: "start",
    nodes: [
      node("start", ["ready"]),
      node("branch-a", branchAOutcomes),
      node("branch-b", ["done"]),
      node("join", ["joined", "join_unsatisfiable"], { join: { inbound: ["a-join", "b-join"], require: "all" } }),
      ...(recover ? [node("recover", ["done"], { input: "mission-pipeline.join-unsatisfiable.v1" })] : [])
    ],
    edges: [
      { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
      { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
      { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
      { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] },
      ...(recover ? [{ edgeId: "join-recover", from: "join", when: { outcome: "join_unsatisfiable" }, to: ["recover"] }] : [])
    ],
    terminals: [
      ...(branchAOutcomes.includes("drop") ? [{ nodeId: "branch-a", outcome: "drop" }] : []),
      { nodeId: "join", outcome: "joined" },
      ...(recover ? [{ nodeId: "recover", outcome: "done" }] : [{ nodeId: "join", outcome: "join_unsatisfiable" }])
    ]
  });
}

/** Re-seal a tampered journey record so only the semantic check under test can reject it. */
function resealed(record, changes) {
  const { recordDigest: _old, ...base } = { ...record, ...changes };
  return { ...base, recordDigest: digest(base) };
}

test("unit path: the support-triage positive path projects states, edges, usage, and the open human queue", async () => {
  const triage = createSupportTriageHarness({ fixture: FIXTURES.positive });
  await triage.admit();
  await triage.drain();
  const before = projectUnitPath(await triage.journey());

  assert.equal(before.schemaVersion, UNIT_PATH_SCHEMA_VERSION);
  assert.equal(before.unitId, FIXTURES.positive.unitId);
  assert.equal(before.graph.id, "example.support-triage");
  assert.equal(before.entryNodeId, "normalize");
  assert.equal(before.records, 8);
  assert.equal(before.concluded, false);
  assert.deepEqual(before.openQueueIds.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.values(before.nodes).map((entry) => [entry.nodeId, entry.state])),
    {
      normalize: "settled",
      "outage-signal": "settled",
      "ground-evidence": "settled",
      "outage-verify": "settled",
      "blast-radius": "settled",
      assemble: "settled",
      summarize: "settled",
      "dispatch-review": "pending"
    }
  );
  assert.deepEqual(before.nodes["blast-radius"].outcomes, ["many"]);
  assert.deepEqual(plain(before.edges), {
    "normalize-ready": 1,
    "signal-yes": 1,
    "evidence-grounded": 1,
    "verify-confirmed": 1,
    "blast-radius-assemble": 1,
    "assemble-proposed": 1,
    "summarize-dispatch": 1
  });
  assert.deepEqual(plain(before.joins), {});
  assert.equal(before.nodes["dispatch-review"].occurrences[0].queueId, before.openQueueIds[0]);
  assert.deepEqual(before.nodes["dispatch-review"].occurrences[0].inboundEdgeIds, ["summarize-dispatch"]);
  assert.equal(before.nodes["dispatch-review"].occurrences[0].queuedBySequence, 8);
  // Usage comes from the journey's receipts: four model attempts, none elsewhere.
  assert.deepEqual(before.usage, { receipts: 4, chargedTokens: 1711, chargedCostMicroUsd: 0 });
  assert.deepEqual(before.nodes["outage-signal"].usage, { receipts: 1, chargedTokens: 433, chargedCostMicroUsd: 0 });
  assert.deepEqual(before.nodes.normalize.usage, { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 });
  assert.deepEqual((await triage.modelCalls()).chargedTokens, before.usage.chargedTokens);

  await triage.decide("dispatch-review", "approved");
  const after = projectUnitPath(await triage.journey());
  assert.equal(after.concluded, true);
  assert.deepEqual(after.openQueueIds, []);
  const decided = after.nodes["dispatch-review"];
  assert.equal(decided.state, "settled");
  assert.deepEqual(decided.outcomes, ["approved"]);
  assert.equal(decided.occurrences[0].principalId, "triage_console");
  assert.equal(decided.occurrences[0].actorId, "dispatcher-1");
  assert.equal(decided.occurrences[0].attempts, 1);
});

test("unit path: a terminal failure is dead, routes nowhere, and concludes the unit", async () => {
  const triage = createSupportTriageHarness({ fixture: FIXTURES["provider-outage"] });
  await triage.admit();
  await triage.drain();
  const path = projectUnitPath(await triage.journey());
  const signal = path.nodes["outage-signal"];
  assert.equal(signal.state, "dead");
  assert.deepEqual(signal.outcomes, []);
  assert.equal(signal.occurrences.length, 1);
  assert.equal(signal.occurrences[0].state, "dead");
  assert.equal(signal.occurrences[0].attempts, 2);
  assert.equal(signal.occurrences[0].failures, 2);
  assert.equal(signal.occurrences[0].errorCode, "dependency_unavailable");
  assert.equal(signal.occurrences[0].outcome, undefined);
  assert.equal(path.concluded, true);
  assert.deepEqual(path.usage, { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 });
  assert.deepEqual(Object.keys(path.nodes), ["normalize", "outage-signal"]);
});

test("unit path: a retryable failure leaves the occurrence open as failed until the retry settles it", async () => {
  const graph = createGraphDefinition({
    graphId: "unit-path.retry",
    version: 1,
    description: "One node with three attempts.",
    entry: "only",
    nodes: [node("only", ["done"], { turn: { maxAttempts: 3 } })],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "done" }]
  });
  const store = harness(graph, "unit-retry", "retry");
  await store.admit();
  const [claim] = await store.unitStore.claimUnitTurns({ principalId: WORKER, leaseOwner: "retry-claim", batch: 1 });
  const sealedNode = claim.graph.nodes.find((candidate) => candidate.nodeId === claim.nodeId);
  const prepared = await store.unitStore.prepareTurnAttempt({
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    leaseToken: claim.leaseToken,
    nodeRef: sealedNode.ref,
    fingerprint: nodeExecutionFingerprint(sealedNode),
    inputDigest: claim.inputArtifact.digest,
    maxAttempts: sealedNode.turn.maxAttempts
  });
  assert.equal(prepared.disposition, "reserved");
  const startedAt = store.now().toISOString();
  const failedAt = store.now().toISOString();
  const failure = {
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    attemptNumber: prepared.attemptNumber,
    attemptIndex: prepared.attemptIndex,
    idempotencyKey: prepared.idempotencyKey,
    principalId: WORKER,
    startedAt,
    failedAt,
    errorCode: "unit_path_retryable",
    errorMessage: "simulated retryable failure",
    retryable: true,
    terminal: false,
    usage: []
  };
  await store.unitStore.recordTurnFailure({ ...failure, leaseToken: claim.leaseToken, failureDigest: nodeTurnFailureDigest(failure) });

  const retrying = projectUnitPath(await store.journey());
  assert.equal(retrying.nodes.only.state, "failed");
  assert.equal(retrying.nodes.only.occurrences[0].state, "open");
  assert.equal(retrying.nodes.only.occurrences[0].failures, 1);
  assert.equal(retrying.nodes.only.occurrences[0].errorCode, "unit_path_retryable");
  assert.deepEqual(retrying.openQueueIds, [claim.queueId]);
  assert.equal(retrying.concluded, false);

  store.advance(sealedNode.turn.leaseMs + 1);
  const result = await store.run("only", { outcome: "done" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attemptIndex, 2);
  const settled = projectUnitPath(await store.journey());
  assert.equal(settled.nodes.only.state, "settled");
  assert.deepEqual(settled.nodes.only.outcomes, ["done"]);
  assert.equal(settled.nodes.only.occurrences[0].attempts, 2);
  assert.equal(settled.nodes.only.occurrences[0].failures, 1);
  assert.equal(settled.nodes.only.occurrences[0].errorCode, "unit_path_retryable");
  assert.equal(settled.concluded, true);
});

test("unit path: join progress follows offers, queues once with its provenance, and records late offers", async () => {
  const store = harness(joinGraph("unit-path.join-all"), "unit-join", "join");
  await store.admit();
  await store.run("start", { outcome: "ready" });
  await store.run("branch-a", { outcome: "done" });
  const pending = projectUnitPath(await store.journey());
  assert.deepEqual(plain(pending.joins), {
    join: { nodeId: "join", status: "pending", edges: { "a-join": "offered" }, lateOffers: 0 }
  });
  assert.equal("join" in pending.nodes, false);
  assert.deepEqual(plain(pending.edges), { "start-a": 1, "start-b": 1, "a-join": 1 });
  assert.equal(pending.nodes["branch-b"].state, "pending");

  await store.run("branch-b", { outcome: "done" });
  const queued = projectUnitPath(await store.journey());
  assert.equal(queued.joins.join.status, "queued");
  assert.equal(queued.joins.join.selectedEdgeId, "a-join");
  assert.deepEqual(plain(queued.joins.join.edges), { "a-join": "offered", "b-join": "offered" });
  assert.equal(queued.nodes.join.state, "pending");
  assert.deepEqual(queued.nodes.join.occurrences[0].inboundEdgeIds, ["a-join", "b-join"]);
  assert.equal(queued.nodes.join.occurrences[0].queueId, queued.joins.join.queueId);
  assert.deepEqual(plain(queued.edges), { "start-a": 1, "start-b": 1, "a-join": 1, "b-join": 1 });

  await store.run("join", { outcome: "joined" });
  const done = projectUnitPath(await store.journey());
  assert.equal(done.nodes.join.state, "settled");
  assert.equal(done.concluded, true);
});

test("unit path: an unsatisfiable join has no node entry, carries the synthetic digest, and routes its recovery", async () => {
  const store = harness(joinGraph("unit-path.join-unsatisfiable", ["done", "drop"], true), "unit-unsat", "unsat");
  await store.admit();
  await store.run("start", { outcome: "ready" });
  await store.run("branch-a", { outcome: "drop" });
  const resolved = projectUnitPath(await store.journey());
  assert.equal(resolved.joins.join.status, "unsatisfiable");
  assert.deepEqual(plain(resolved.joins.join.edges), { "a-join": "impossible" });
  assert.match(resolved.joins.join.syntheticOutcomeDigest, /^[a-f0-9]{64}$/);
  assert.equal("join" in resolved.nodes, false);
  assert.equal(resolved.nodes.recover.state, "pending");
  assert.deepEqual(resolved.nodes.recover.occurrences[0].inboundEdgeIds, ["join-recover"]);
  assert.equal(resolved.edges["join-recover"], 1);
  // The synthetic record follows the causal settlement in the journey.
  const journey = await store.journey();
  const synthetic = journey.findIndex((record) => record.kind === "join_unsatisfiable");
  assert.equal(resolved.nodes.recover.occurrences[0].queuedBySequence, synthetic + 1);
  assert.equal(resolved.concluded, false);

  await store.run("branch-b", { outcome: "done" });
  const late = projectUnitPath(await store.journey());
  assert.equal(late.joins.join.lateOffers, 1);
  assert.equal(late.edges["b-join"], undefined);
  await store.run("recover", { outcome: "done" });
  assert.equal(projectUnitPath(await store.journey()).concluded, true);
});

test("unit path: refuses tampered, reordered, partial, or inconsistent journeys", async () => {
  const triage = createSupportTriageHarness({ fixture: FIXTURES.negative });
  await triage.admit();
  await triage.drain();
  const journey = structuredClone(await triage.journey());
  assert.equal(journey.length, 3);

  const tampered = structuredClone(journey);
  tampered[2].outcome = "yes";
  assert.throws(() => projectUnitPath(tampered), /unit journey\[2\]: record digest mismatch/);

  const reordered = [journey[0], journey[2]];
  assert.throws(() => projectUnitPath(reordered), /unit journey\[1\]\.sequence must be 2 \(got 3\)/);

  assert.throws(() => projectUnitPath(journey.slice(1)), /unit journey\[0\] must be the unit_admitted record/);
  assert.throws(() => projectUnitPath([]), /must contain the admission record/);
  assert.throws(() => projectUnitPath(new Proxy(journey, {})), /Proxies are not accepted/);
  assert.throws(() => projectUnitPath({ length: 1, 0: journey[0] }), /plain non-Proxy array/);

  const ghostQueue = [journey[0], resealed(journey[1], { queueId: "ghost-queue" })];
  assert.throws(() => projectUnitPath(ghostQueue), /queue ghost-queue was never queued/);

  const wrongNode = [journey[0], resealed(journey[1], { nodeId: "outage-signal" })];
  assert.throws(() => projectUnitPath(wrongNode), /belongs to node normalize, not outage-signal/);

  const twice = [...journey, resealed(journey[2], { sequence: 4 })];
  assert.throws(() => projectUnitPath(twice), /is already settled/);

  const foreign = [journey[0], resealed(journey[1], { unitId: "another-unit" })];
  assert.throws(() => projectUnitPath(foreign), /changes the unit identity/);

  const otherGraph = [journey[0], resealed(journey[1], { graph: { ...journey[1].graph, version: 2 } })];
  assert.throws(() => projectUnitPath(otherGraph), /changes the graph identity/);

  const secondAdmission = [...journey, resealed(journey[0], { sequence: 4 })];
  assert.throws(() => projectUnitPath(secondAdmission), /exactly one admission record/);

  const smuggled = [journey[0], resealed(journey[1], { leaseToken: "secret" })];
  assert.throws(() => projectUnitPath(smuggled), /unknown key\(s\) "leaseToken"/);

  const oversized = { length: MAX_UNIT_PATH_RECORDS + 1 };
  assert.throws(() => projectUnitPath(Array.from(oversized, () => journey[0])), /at most 100000 items/);
});

test("unit path: the projection is deterministic, frozen, and prototype-free", async () => {
  const triage = createSupportTriageHarness({ fixture: FIXTURES.ambiguous });
  await triage.admit();
  await triage.drain();
  const journey = await triage.journey();
  const first = projectUnitPath(journey);
  const second = projectUnitPath(structuredClone(journey));
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.nodes), true);
  assert.equal(Object.isFrozen(first.nodes["outage-signal"].occurrences), true);
  assert.equal(Object.getPrototypeOf(first.nodes), null);
  assert.equal(Object.getPrototypeOf(first.edges), null);
  assert.equal(Object.getPrototypeOf(first.joins), null);
  assert.equal("constructor" in first.nodes, false);
  assert.equal(JSON.parse(JSON.stringify(first)).nodes["outage-signal"].state, "settled");
  assert.equal(first.nodes["triage-review"].state, "pending");
  assert.equal(first.lastRecordedAt, journey[journey.length - 1].recordedAt);
});

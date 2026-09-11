import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactEnvelope, artifactRef } from "mission-pipeline/contracts/artifact";
import { canonicalJson, digest } from "mission-pipeline/contracts/digest";
import { runNextUnitTurn } from "mission-pipeline/execute/unit-runner";
import { createGraphDefinition, graphDefinitionRef, JOIN_INPUT_ARTIFACT_CONTRACT } from "mission-pipeline/graph/definition";
import { createJoinInputArtifact, validateJoinInputArtifact } from "mission-pipeline/store/join-input";
import { MemoryUnitStore } from "mission-pipeline/store/memory-unit-store";
import { fixtureGraphs, node } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const AT = "2026-09-11T12:00:00.000Z";
const CONFIGURATION = { id: "fixture.join-policy", version: 2, digest: digest({ policy: "combine" }) };
const LEFT = createArtifactEnvelope("classification.v1", { category: "support", flags: [true, false] });
const RIGHT = createArtifactEnvelope("lookup.v1", { candidates: [{ id: "case-17" }], confidence: 0.8 });

function graphFor(require = "all") {
  const draft = clone(fixtureGraphs.join);
  const join = draft.nodes.find((item) => item.nodeId === "join");
  join.input = JOIN_INPUT_ARTIFACT_CONTRACT;
  join.join = { ...join.join, require, compose: "envelope" };
  join.configuration = CONFIGURATION;
  draft.nodes.find((item) => item.nodeId === "branch-a").configuration = CONFIGURATION;
  draft.nodes.find((item) => item.nodeId === "branch-a").outputs = { done: LEFT.contractId };
  draft.nodes.find((item) => item.nodeId === "branch-b").outputs = { done: RIGHT.contractId };
  return createGraphDefinition(draft);
}

function inputFor() {
  return {
    unitId: "unit-envelope",
    nodeId: "join",
    accepted: [
      { edgeId: "branch-a-to-join", sourceNodeId: "branch-a", sourceQueueId: "queue-a", sourceEvidenceDigest: digest({ source: "a" }), offeredAt: AT, artifact: LEFT },
      { edgeId: "branch-b-to-join", sourceNodeId: "branch-b", sourceQueueId: "queue-b", sourceEvidenceDigest: digest({ source: "b" }), offeredAt: AT, artifact: RIGHT }
    ]
  };
}

function assertPublicSnapshot(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), null);
  Object.values(value).forEach(assertPublicSnapshot);
}

test("join input helper embeds heterogeneous payloads, exact graph/configuration identity, and sealed order", () => {
  const graph = graphFor();
  const input = inputFor();
  const artifact = createJoinInputArtifact(graph, input);
  assert.equal(artifact.contractId, JOIN_INPUT_ARTIFACT_CONTRACT);
  assert.deepEqual(clone(artifact.payload), {
    schemaVersion: JOIN_INPUT_ARTIFACT_CONTRACT,
    unitId: input.unitId,
    graph: graphDefinitionRef(graph),
    nodeId: "join",
    nodeRef: graph.nodes.find((item) => item.nodeId === "join").ref,
    configuration: CONFIGURATION,
    require: "all",
    accepted: input.accepted.map((offer) => ({
      ...offer,
      sourceNodeRef: graph.nodes.find((item) => item.nodeId === offer.sourceNodeId).ref,
      ...(offer.sourceNodeId === "branch-a" ? { sourceConfiguration: CONFIGURATION } : {})
    }))
  });
  assert.equal(artifact.digest, digest(artifact.payload));
  assert.equal(artifact.bytes, Buffer.byteLength(canonicalJson(artifact.payload)));
  assertPublicSnapshot(artifact);
  assertPublicSnapshot(validateJoinInputArtifact(graph, artifact));
  input.accepted[0].sourceQueueId = "changed";
  assert.equal(artifact.payload.accepted[0].sourceQueueId, "queue-a");
  assert.equal("queueId" in artifact.payload, false);
});

test("identical accepted evidence gives identical envelope bytes/digest in either arrival order", () => {
  const graph = graphFor();
  const input = inputFor();
  const forward = createJoinInputArtifact(graph, input);
  const reverse = createJoinInputArtifact(graph, { ...input, accepted: [...input.accepted].reverse() });
  assert.equal(canonicalJson(forward), canonicalJson(reverse));
  const changed = clone(input);
  changed.accepted[0].sourceEvidenceDigest = digest({ source: "new evidence" });
  assert.notEqual(createJoinInputArtifact(graph, changed).digest, forward.digest);
  changed.accepted[0].sourceEvidenceDigest = input.accepted[0].sourceEvidenceDigest;
  changed.accepted[0].offeredAt = "2026-09-11T12:00:01.000Z";
  assert.notEqual(createJoinInputArtifact(graph, changed).digest, forward.digest);
});

test("nOf helper includes exactly supplied accepted offers and refuses duplicate or insufficient evidence", () => {
  const graph = graphFor({ nOf: 1 });
  const input = inputFor();
  const artifact = createJoinInputArtifact(graph, { ...input, accepted: [input.accepted[1]] });
  assert.deepEqual(artifact.payload.accepted.map((offer) => offer.edgeId), ["branch-b-to-join"]);
  assert.throws(() => createJoinInputArtifact(graph, { ...input, accepted: [] }), /does not satisfy/);
  assert.throws(() => createJoinInputArtifact(graph, { ...input, accepted: [input.accepted[0], input.accepted[0]] }), /duplicate accepted edge/);
  assert.throws(() => createJoinInputArtifact(graphFor(), { ...input, accepted: [input.accepted[0]] }), /does not satisfy/);
});

test("join input helpers refuse ordinary/select nodes, foreign sources, and missing source queue identity", () => {
  const graph = graphFor();
  assert.throws(() => createJoinInputArtifact(createGraphDefinition(fixtureGraphs.join), inputFor()), /not an envelope join/);
  assert.throws(() => createJoinInputArtifact(graph, { ...inputFor(), nodeId: "start" }), /not an envelope join/);
  for (const change of [
    (input) => { input.accepted[0].sourceNodeId = "branch-b"; },
    (input) => { input.accepted[0].edgeId = "fan-out"; },
    (input) => { delete input.accepted[0].sourceQueueId; },
    (input) => { input.accepted[0].sourceQueueId = undefined; },
    (input) => { input.accepted[0].offeredAt = "2026-09-11"; },
    (input) => { input.accepted[0].sourceEvidenceDigest = "bad"; }
  ]) {
    const input = clone(inputFor());
    change(input);
    assert.throws(() => createJoinInputArtifact(graph, input));
  }
});

test("join input validation rejects re-sealed identity/configuration/order substitutions and unsealed embedded data", () => {
  const graph = graphFor();
  const artifact = createJoinInputArtifact(graph, inputFor());
  for (const change of [
    (payload) => { payload.schemaVersion = "other.v1"; },
    (payload) => { payload.graph.digest = digest({ other: true }); },
    (payload) => { payload.nodeId = "branch-a"; },
    (payload) => { payload.nodeRef.version += 1; },
    (payload) => { payload.configuration.digest = digest({ other: true }); },
    (payload) => { delete payload.configuration; },
    (payload) => { payload.require = { nOf: 1 }; },
    (payload) => { payload.accepted.reverse(); },
    (payload) => { payload.accepted[0].sourceNodeRef.version += 1; },
    (payload) => { delete payload.accepted[0].sourceConfiguration; },
    (payload) => { payload.accepted[1].sourceConfiguration = CONFIGURATION; },
    (payload) => { payload.accepted[0].artifact.payload.category = "changed"; },
    (payload) => { payload.extra = true; },
    (payload) => { payload.accepted[0].extra = true; }
  ]) {
    const payload = clone(artifact.payload);
    change(payload);
    assert.throws(() => validateJoinInputArtifact(graph, createArtifactEnvelope(JOIN_INPUT_ARTIFACT_CONTRACT, payload)));
  }
  assert.throws(() => validateJoinInputArtifact(graph, { ...artifact, digest: "0".repeat(64) }), /digest mismatch/);
  assert.throws(() => validateJoinInputArtifact(graph, LEFT), /expected mission-pipeline.join-input.v1/);
});

test("join input hostile boundaries reject without invoking getters/proxy traps and preserve special own keys", () => {
  const graph = graphFor();
  let called = 0;
  const input = inputFor();
  const accessor = { ...input };
  Object.defineProperty(accessor, "accepted", { enumerable: true, get() { called += 1; return input.accepted; } });
  const proxy = new Proxy(input, { get() { called += 1; throw new Error("invoked"); }, ownKeys() { called += 1; throw new Error("invoked"); } });
  for (const hostile of [accessor, proxy, { ...input, accepted: new Array(2) }]) {
    assert.throws(() => createJoinInputArtifact(graph, hostile));
  }
  assert.equal(called, 0);
  const special = JSON.parse('{"__proto__":{"safe":true},"constructor":"own","prototype":1}');
  input.accepted[0].artifact = createArtifactEnvelope("special.v1", special);
  const artifact = createJoinInputArtifact(graph, input);
  assert.equal(artifact.payload.accepted[0].artifact.payload.__proto__.safe, true);
  assertPublicSnapshot(artifact);
  const cycle = inputFor();
  cycle.accepted[0].artifact = { ...LEFT, payload: cycle };
  assert.throws(() => createJoinInputArtifact(graph, cycle), /cyclic|acyclic/);
});

test("join input aggregate depth/value/string budgets apply before recursive sealing", () => {
  const graph = graphFor();
  const depth = inputFor();
  let payload = {};
  for (let index = 0; index < 70; index += 1) payload = { child: payload };
  depth.accepted[0].artifact = { ...LEFT, payload };
  assert.throws(() => createJoinInputArtifact(graph, depth), /depth/);
  const values = inputFor();
  values.accepted[0].artifact = { ...LEFT, payload: Array(250_001).fill(null) };
  assert.throws(() => createJoinInputArtifact(graph, values), /value budget/);
  const strings = inputFor();
  strings.accepted[0].artifact = { ...LEFT, payload: "x".repeat(16_777_217) };
  assert.throws(() => createJoinInputArtifact(graph, strings), /string budget/);
});

async function harness(graph = graphFor()) {
  let sequence = 0;
  let epoch = Date.parse(AT);
  const now = () => new Date(epoch);
  const store = new MemoryUnitStore({ now, idFactory: (kind) => `${kind}-${++sequence}` });
  await store.publishGraph(graph);
  await store.admitUnit({ unitId: "unit-envelope", graph: graphDefinitionRef(graph), seedArtifact: createArtifactEnvelope("unit-artifact.v1", { seed: true }), admittedAt: AT, principalId: "v2_admitter" });
  const run = async (nodeId, completion) => {
    epoch += 1_000;
    const result = await runNextUnitTurn({ store, nodeId, principalId: "v2_worker", leaseOwner: `worker-${nodeId}`, ports: { code: { run: async () => completion } }, now });
    assert.equal(result.status, "succeeded");
    return result;
  };
  const queued = async (nodeId = "join") => (await store.listQueuedUnits({ principalId: "v2_worker", nodeId }))[0];
  return { graph, store, run, queued, now };
}

async function completedHarness(require = "all") {
  const result = await harness(graphFor(require));
  await result.run("start", { outcome: "ready" });
  await result.run("branch-b", { outcome: "done", outputArtifact: RIGHT });
  await result.run("branch-a", { outcome: "done", outputArtifact: LEFT });
  return result;
}

test("memory envelope join restores pending and queued snapshots with all embedded evidence intact", async () => {
  const { store, graph, run, queued, now } = await harness();
  await run("start", { outcome: "ready" });
  await run("branch-b", { outcome: "done", outputArtifact: RIGHT });
  const pending = store.stateSnapshot();
  assert.equal(new MemoryUnitStore({ initialState: clone(pending), now }).stateSnapshot().joins[0].status, "pending");
  await run("branch-a", { outcome: "done", outputArtifact: LEFT });
  const queue = await queued();
  assert.deepEqual(queue.inputArtifact.payload.accepted.map((item) => item.artifact.payload), [clone(LEFT.payload), clone(RIGHT.payload)]);
  assert.equal(queue.inputArtifact.payload.accepted[1].offeredAt < queue.inputArtifact.payload.accepted[0].offeredAt, true);
  const snapshot = store.stateSnapshot();
  const recovered = new MemoryUnitStore({ initialState: clone(snapshot), now });
  assert.equal(canonicalJson(recovered.stateSnapshot()), canonicalJson(snapshot));
  assert.equal((await recovered.getArtifact({ artifact: artifactRef(queue.inputArtifact) })).digest, queue.inputArtifact.digest);
  assert.equal(validateJoinInputArtifact(graph, queue.inputArtifact).digest, queue.inputArtifact.digest);
  let seen;
  const result = await runNextUnitTurn({ store: recovered, nodeId: "join", principalId: "v2_worker", leaseOwner: "restored", ports: { code: { run: async (input) => { seen = input; return { outcome: "joined" }; } } }, now });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(seen, queue.inputArtifact.payload);
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: clone(recovered.stateSnapshot()), now }));
});

test("memory nOf envelope excludes late offers and preserves its snapshot after late branch settlement", async () => {
  const { store, queued, now } = await completedHarness({ nOf: 1 });
  const queue = await queued();
  assert.deepEqual(queue.inputArtifact.payload.accepted.map((offer) => offer.edgeId), ["branch-b-to-join"]);
  const journey = await store.readJourney({ unitId: "unit-envelope" });
  assert.equal(journey.flatMap((record) => record.routing ?? []).some((effect) => effect.kind === "join_offer" && effect.edgeId === "branch-a-to-join" && effect.disposition === "join_already_resolved_noop"), true);
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: clone(store.stateSnapshot()), now }));
});

test("mixed optional bytes wrappers retain each accepted ref and restore despite content-address deduplication", async () => {
  const draft = clone(graphFor());
  delete draft.graphDigest;
  draft.nodes.find((item) => item.nodeId === "branch-b").outputs = { done: LEFT.contractId };
  const graph = createGraphDefinition(draft);
  const { store, run, queued, now } = await harness(graph);
  const withoutBytes = { contractId: LEFT.contractId, digest: LEFT.digest, payload: LEFT.payload };
  await run("start", { outcome: "ready" });
  await run("branch-a", { outcome: "done", outputArtifact: LEFT });
  await run("branch-b", { outcome: "done", outputArtifact: withoutBytes });
  const queue = await queued();
  const [a, b] = queue.inputArtifact.payload.accepted;
  assert.deepEqual(a.artifact, clone(LEFT));
  assert.deepEqual(b.artifact, clone(withoutBytes));
  assert.equal(a.artifact.bytes, LEFT.bytes);
  assert.equal("bytes" in b.artifact, false);
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: clone(store.stateSnapshot()), now }));
});

function replaceInput(snapshot, change) {
  const queue = snapshot.queues.find((item) => item.nodeId === "join");
  const previous = queue.inputArtifact;
  const payload = clone(previous.payload);
  change(payload);
  const next = createArtifactEnvelope(JOIN_INPUT_ARTIFACT_CONTRACT, payload);
  queue.inputArtifact = next;
  snapshot.artifacts = snapshot.artifacts.map((artifact) => artifact.contractId === previous.contractId && artifact.digest === previous.digest ? next : artifact);
}

test("snapshot restore rejects re-sealed envelope unit/graph/ref/config/payload substitutions", async () => {
  const { store, now } = await completedHarness();
  const snapshot = store.stateSnapshot();
  for (const change of [
    (payload) => { payload.unitId = "foreign-unit"; },
    (payload) => { payload.graph.digest = digest({ foreign: true }); },
    (payload) => { payload.nodeRef.version += 1; },
    (payload) => { payload.configuration.digest = digest({ foreign: true }); },
    (payload) => { payload.accepted[0].sourceNodeRef.version += 1; },
    (payload) => { payload.accepted[0].sourceConfiguration.digest = digest({ foreign: true }); },
    (payload) => { payload.accepted[0].artifact = createArtifactEnvelope(LEFT.contractId, { replacement: true }); },
    (payload) => { payload.accepted[0].sourceQueueId = "foreign-queue"; },
    (payload) => { payload.accepted.reverse(); }
  ]) {
    const altered = clone(snapshot);
    replaceInput(altered, change);
    assert.throws(() => new MemoryUnitStore({ initialState: altered, now }), /join input|envelope join/);
  }
});

test("snapshot restore binds queue/progress and accepted offers to actual retained source settlements/routing", async () => {
  const { store, now } = await completedHarness();
  const snapshot = store.stateSnapshot();
  for (const change of [
    (state) => { state.queues.find((queue) => queue.nodeId === "join").join.accepted.pop(); },
    (state) => { state.queues.find((queue) => queue.nodeId === "join").inboundEdgeIds.reverse(); },
    (state) => { state.queues.find((queue) => queue.nodeId === "join").sourceEvidenceDigest = digest({ fake: true }); },
    (state) => { state.queues.find((queue) => queue.nodeId === "join").queuedAt = AT; },
    (state) => { state.joins[0].selectedEdgeId = "branch-b-to-join"; },
    (state) => { state.joins = []; },
    (state) => { state.joins[0].inbound[0].offer.sourceQueueId = "foreign-queue"; },
    (state) => { state.joins[0].inbound[0].offer.sourceQueueId = state.joins[0].inbound[1].offer.sourceQueueId; },
    (state) => { delete state.joins[0].inbound[0].offer.sourceQueueId; },
    (state) => { state.joins[0].inbound[0].offer.sourceNodeId = "branch-b"; },
    (state) => { state.joins[0].inbound[0].offer.sourceEvidenceDigest = digest({ fake: true }); },
    (state) => { state.joins[0].inbound[0].offer.offeredAt = AT; },
    (state) => { state.joins[0].inbound[0].offer.artifact = artifactRef(RIGHT); },
    (state) => {
      const record = state.journey.find((item) => item.kind === "turn_settled" && item.nodeId === "branch-a");
      record.routing.find((effect) => effect.kind === "join_offer").disposition = "join_already_resolved_noop";
      const { recordDigest: _ignored, ...base } = record;
      record.recordDigest = digest(base);
    }
  ]) {
    const altered = clone(snapshot);
    change(altered);
    assert.throws(() => new MemoryUnitStore({ initialState: altered, now }), /envelope join/);
  }
});

test("synthetic join_unsatisfiable offers embed and restore with no fabricated source queue", async () => {
  const draft = clone(fixtureGraphs.join);
  const a = draft.nodes.find((item) => item.nodeId === "branch-a");
  a.outcomes.outcomes.push("skip");
  draft.terminals.push({ nodeId: "branch-a", outcome: "skip" });
  draft.terminals = draft.terminals.filter((item) => item.nodeId !== "join" || item.outcome !== "join_unsatisfiable");
  draft.nodes.push(node("aggregate", ["done", "join_unsatisfiable"], { input: JOIN_INPUT_ARTIFACT_CONTRACT, join: { inbound: ["unsatisfiable-to-aggregate"], require: "all", compose: "envelope" } }));
  draft.edges.push({ edgeId: "unsatisfiable-to-aggregate", from: "join", when: { outcome: "join_unsatisfiable" }, to: ["aggregate"] });
  draft.terminals.push({ nodeId: "aggregate", outcome: "done" }, { nodeId: "aggregate", outcome: "join_unsatisfiable" });
  const graph = createGraphDefinition(draft);
  const { store, run, queued, now } = await harness(graph);
  await run("start", { outcome: "ready" });
  await run("branch-a", { outcome: "skip" });
  const queue = await queued("aggregate");
  const [offer] = queue.inputArtifact.payload.accepted;
  assert.equal("sourceQueueId" in offer, false);
  assert.equal(offer.artifact.contractId, "mission-pipeline.join-unsatisfiable.v1");
  assert.equal(offer.sourceNodeId, "join");
  assert.equal(validateJoinInputArtifact(graph, queue.inputArtifact).digest, queue.inputArtifact.digest);
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: clone(store.stateSnapshot()), now }));
  const altered = clone(store.stateSnapshot());
  const progress = altered.joins.find((item) => item.nodeId === "aggregate");
  progress.inbound[0].offer.sourceEvidenceDigest = digest({ fake: true });
  assert.throws(() => new MemoryUnitStore({ initialState: altered, now }), /envelope join/);
});

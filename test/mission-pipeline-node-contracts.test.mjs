// Declared output contracts (per outcome) and node configuration refs: the
// definition validator, the compile-time edge check, the completion-time
// check, the fingerprint slot, and the worker context that carries the ref.

import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { digest } from "@scshafe/switchyard/contracts/digest";
import {
  snapshotWorkerNodeTurnContext,
  validateNodeTurnCompletion
} from "@scshafe/switchyard/execute/ports";
import {
  executeNodeTurnAttempt,
  NODE_EXECUTION_CONFIGURATION_FINGERPRINT,
  nodeExecutionFingerprint,
  nodeTurnIdempotencyKey
} from "@scshafe/switchyard/execute/turn";
import { runNextUnitTurn } from "@scshafe/switchyard/execute/unit-runner";
import { compileGraph, sameDeclaredOutputs } from "@scshafe/switchyard/graph/compile";
import {
  createGraphDefinition,
  declaredNodeOutput,
  graphDefinitionRef,
  validateSwitchyardNode,
  validateSwitchyardNodeConfigurationRef
} from "@scshafe/switchyard/graph/definition";
import { nodeDefinitionSignature, nodeDefinitionSignatureConflict } from "@scshafe/switchyard/store/graph-store";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";
import {
  fixtureGraphs,
  MODEL_BINDING,
  node
} from "./fixtures/switchyard/node-graph-v2-fixtures.mjs";

const clone = (value) => structuredClone(value);
const CONFIGURATION = Object.freeze({
  id: "fixture.policy",
  version: 3,
  digest: digest({ threshold: 0.7 })
});
const OTHER_CONFIGURATION = Object.freeze({ ...CONFIGURATION, version: 4, digest: digest({ threshold: 0.8 }) });

/** The filter chain with outputs declared on every routed outcome. */
function declaredChain() {
  const draft = clone(fixtureGraphs["filter-chain"]);
  draft.nodes[0].outputs = { pass: "unit-artifact.v1", drop: "unit-artifact.v1" };
  draft.nodes[1].outputs = { ok: "unit-artifact.v1" };
  return draft;
}

test("outputs: keys must be declared outcomes carrying contract ids, never the engine-reserved outcome", () => {
  const base = node("judge", ["yes", "no"]);
  const declared = validateSwitchyardNode({ ...base, outputs: { yes: "answer.v1", no: "answer.v1" } });
  assert.deepEqual(declared.outputs, { yes: "answer.v1", no: "answer.v1" });
  assert.equal(Object.isFrozen(declared.outputs), true);
  assert.equal(declaredNodeOutput(declared, "yes"), "answer.v1");
  assert.equal(declaredNodeOutput(declared, "maybe"), undefined);
  assert.equal(declaredNodeOutput(validateSwitchyardNode(base), "yes"), undefined);
  // A partial declaration is allowed: undeclared outcomes stay unchecked.
  assert.deepEqual(validateSwitchyardNode({ ...base, outputs: { yes: "answer.v1" } }).outputs, { yes: "answer.v1" });

  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: { maybe: "answer.v1" } }),
    /outputs: outcome "maybe" is not declared by this node/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: { yes: "no-version" } }),
    /outputs\.yes: contract id must match <name>\.v<number>/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: {} }),
    /outputs: must declare at least one outcome \(omit the key instead\)/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: undefined }),
    /outputs is present but undefined \(omit the key instead\)/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: "answer.v1" }),
    /outputs: must be a plain object/
  );
  const join = node("gate", ["joined", "join_unsatisfiable"], {
    join: { inbound: ["some-edge"], require: "all" }
  });
  assert.throws(
    () => validateSwitchyardNode({ ...join, outputs: { join_unsatisfiable: "anything.v1" } }),
    /engine-reserved outcome "join_unsatisfiable" always carries switchyard\.join-unsatisfiable\.v1/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...base, outputs: { "Yes!": "answer.v1" } }),
    /outputs outcome: must match the identifier grammar/
  );
});

test("outputs: the declaration is definition data that moves the graph digest, in any key order", () => {
  const plain = createGraphDefinition(fixtureGraphs["filter-chain"]);
  const declared = createGraphDefinition(declaredChain());
  assert.notEqual(declared.graphDigest, plain.graphDigest);
  const reordered = declaredChain();
  reordered.nodes[0].outputs = { drop: "unit-artifact.v1", pass: "unit-artifact.v1" };
  assert.equal(createGraphDefinition(reordered).graphDigest, declared.graphDigest);
  assert.equal(sameDeclaredOutputs({ a: "x.v1", b: "y.v1" }, { b: "y.v1", a: "x.v1" }), true);
  assert.equal(sameDeclaredOutputs({ a: "x.v1" }, { a: "x.v2" }), false);
  assert.equal(sameDeclaredOutputs(undefined, { a: "x.v1" }), false);
  assert.equal(sameDeclaredOutputs(undefined, undefined), true);
});

test("compile: a declared output must be accepted by every target of every edge that carries the outcome", () => {
  assert.equal(compileGraph(createGraphDefinition(declaredChain())).graph.id, "fixture.filter-chain");

  const mismatch = declaredChain();
  mismatch.nodes[0].outputs = { pass: "normalized.v1", drop: "unit-artifact.v1" };
  assert.throws(
    () => compileGraph(createGraphDefinition(mismatch)),
    /Graph edge filter-pass carries outcome "pass" from node filter as normalized\.v1, but target node normalize accepts unit-artifact\.v1/
  );

  // The check follows the edge, so it covers fan-out targets and joins alike.
  const joined = clone(fixtureGraphs.join);
  joined.nodes.find((candidate) => candidate.nodeId === "branch-b").outputs = { done: "other.v1" };
  assert.throws(
    () => compileGraph(createGraphDefinition(joined)),
    /Graph edge branch-b-to-join carries outcome "done" from node branch-b as other\.v1, but target node join accepts unit-artifact\.v1/
  );

  // A terminal outcome may declare what it retains; nothing routes, nothing conflicts.
  const terminalOnly = clone(fixtureGraphs["filter-chain"]);
  terminalOnly.nodes[0].outputs = { drop: "rejection.v1" };
  assert.equal(compileGraph(createGraphDefinition(terminalOnly)).nodesById.filter.outputs.drop, "rejection.v1");

  // Undeclared outcomes are not checked at all.
  const partial = clone(fixtureGraphs["filter-chain"]);
  partial.nodes[1].outputs = { ok: "unit-artifact.v1" };
  assert.equal(compileGraph(createGraphDefinition(partial)).nodesById.normalize.outputs.ok, "unit-artifact.v1");
});

test("compile: one node ref cannot declare two output maps; the same map in another order is one definition", () => {
  const twice = {
    graphId: "fixture.outputs-reuse",
    version: 1,
    description: "One ref, two output declarations.",
    entry: "left",
    nodes: [
      node("left", ["next"], { refId: "shared.definition", outputs: { next: "unit-artifact.v1" } }),
      node("right", ["next"], { refId: "shared.definition", outputs: { next: "other.v1" } })
    ],
    edges: [{ edgeId: "left-to-right", from: "left", when: { outcome: "next" }, to: ["right"] }],
    terminals: [{ nodeId: "right", outcome: "next" }]
  };
  assert.throws(
    () => compileGraph(createGraphDefinition(twice)),
    /Node definition shared\.definition@1 is reused with different output contracts; change the node version/
  );
  const undeclaredTwin = clone(twice);
  delete undeclaredTwin.nodes[1].outputs;
  assert.throws(
    () => compileGraph(createGraphDefinition(undeclaredTwin)),
    /reused with different output contracts/
  );
  const consistent = clone(twice);
  consistent.nodes[1].outputs = { next: "unit-artifact.v1" };
  assert.equal(compileGraph(createGraphDefinition(consistent)).graph.id, "fixture.outputs-reuse");
});

test("signature: declared outputs are definition-bound across graphs and compare as maps", () => {
  const withOutputs = nodeDefinitionSignature(node("only", ["done", "skipped"], {
    outputs: { skipped: "b.v1", done: "a.v1" }
  }));
  assert.deepEqual(withOutputs, {
    kind: "code",
    input: "unit-artifact.v1",
    outcomes: ["done", "skipped"],
    outputs: { done: "a.v1", skipped: "b.v1" }
  });
  assert.deepEqual(Object.keys(withOutputs.outputs), ["done", "skipped"]);
  const without = nodeDefinitionSignature(node("only", ["done", "skipped"]));
  assert.equal("outputs" in without, false);
  assert.equal(nodeDefinitionSignatureConflict(without, withOutputs), "output contracts");
  assert.equal(nodeDefinitionSignatureConflict(withOutputs, without), "output contracts");
  assert.equal(nodeDefinitionSignatureConflict(withOutputs, { ...withOutputs, outputs: { done: "a.v1", skipped: "c.v1" } }), "output contracts");
  assert.equal(nodeDefinitionSignatureConflict(withOutputs, { ...withOutputs, outputs: { skipped: "b.v1", done: "a.v1" } }), undefined);
  assert.equal(nodeDefinitionSignatureConflict(without, { ...without, kind: "model" }), "kind");
});

test("completion: a declared output binds the artifact this outcome carries, returned or carried forward", () => {
  const judge = validateSwitchyardNode({
    ...node("judge", ["yes", "no", "carry"]),
    outputs: { yes: "answer.v1", carry: "unit-artifact.v1" }
  });
  const answer = createArtifactEnvelope("answer.v1", { answer: true });
  const wrong = createArtifactEnvelope("other.v1", { answer: true });
  assert.equal(validateNodeTurnCompletion(judge, { outcome: "yes", outputArtifact: answer }).outputArtifact.contractId, "answer.v1");
  assert.throws(
    () => validateNodeTurnCompletion(judge, { outcome: "yes", outputArtifact: wrong }),
    /node judge outcome "yes" must carry answer\.v1 \(got other\.v1\)/
  );
  assert.throws(
    () => validateNodeTurnCompletion(judge, { outcome: "yes" }),
    /node judge outcome "yes" must carry answer\.v1 \(got unit-artifact\.v1, the input carried forward\)/
  );
  // Carry-forward declared as the input contract: no artifact is exactly right.
  assert.deepEqual(validateNodeTurnCompletion(judge, { outcome: "carry" }), { outcome: "carry" });
  assert.throws(
    () => validateNodeTurnCompletion(judge, { outcome: "carry", outputArtifact: answer }),
    /outcome "carry" must carry unit-artifact\.v1 \(got answer\.v1\)/
  );
  // An undeclared outcome is unchecked, as before.
  assert.equal(validateNodeTurnCompletion(judge, { outcome: "no", outputArtifact: wrong }).outputArtifact.contractId, "other.v1");
});

test("configuration: a strict content-addressed ref allowed on every kind, sealed into the graph digest", () => {
  assert.deepEqual(validateSwitchyardNodeConfigurationRef(CONFIGURATION), CONFIGURATION);
  assert.throws(() => validateSwitchyardNodeConfigurationRef({ ...CONFIGURATION, extra: 1 }), /unknown key\(s\) "extra"/);
  assert.throws(() => validateSwitchyardNodeConfigurationRef({ id: "x", version: 1 }), /missing required key\(s\) "digest"/);
  assert.throws(() => validateSwitchyardNodeConfigurationRef({ ...CONFIGURATION, version: 0 }), /version: must be a safe positive integer/);
  assert.throws(() => validateSwitchyardNodeConfigurationRef({ ...CONFIGURATION, digest: "sha256:x" }), /bare lowercase sha256 hex/);
  assert.throws(() => validateSwitchyardNodeConfigurationRef({ ...CONFIGURATION, id: "Not Valid" }), /identifier grammar/);

  for (const kind of ["code", "model", "agent", "human", "callback"]) {
    const configured = validateSwitchyardNode({
      ...node(`kind-${kind}`, ["ok"], { kind, ...(kind === "model" ? { binding: MODEL_BINDING } : {}) }),
      configuration: CONFIGURATION
    });
    assert.deepEqual(configured.configuration, CONFIGURATION);
  }
  assert.throws(
    () => validateSwitchyardNode({ ...node("only", ["ok"]), configuration: undefined }),
    /configuration is present but undefined \(omit the key instead\)/
  );
  const plain = createGraphDefinition(fixtureGraphs["filter-chain"]);
  const configured = clone(fixtureGraphs["filter-chain"]);
  configured.nodes[0].configuration = CONFIGURATION;
  assert.notEqual(createGraphDefinition(configured).graphDigest, plain.graphDigest);
  // Configuration is graph-instance data: the node definition signature ignores it.
  assert.deepEqual(nodeDefinitionSignature(configured.nodes[0]), nodeDefinitionSignature(fixtureGraphs["filter-chain"].nodes[0]));
});

test("configuration: fills the fingerprint slot that was sealed as \"default\", and nothing else moves", () => {
  const plain = node("only", ["ok"]);
  assert.equal(NODE_EXECUTION_CONFIGURATION_FINGERPRINT, "default");
  assert.equal(
    nodeExecutionFingerprint(plain),
    digest({ bindingFingerprint: "none", configurationFingerprint: "default" })
  );
  const configured = { ...plain, configuration: CONFIGURATION };
  assert.equal(
    nodeExecutionFingerprint(configured),
    digest({ bindingFingerprint: "none", configurationFingerprint: CONFIGURATION.digest })
  );
  assert.notEqual(nodeExecutionFingerprint({ ...plain, configuration: OTHER_CONFIGURATION }), nodeExecutionFingerprint(configured));
  const modelNode = node("model", ["ok"], { kind: "model", binding: MODEL_BINDING });
  assert.equal(
    nodeExecutionFingerprint({ ...modelNode, configuration: CONFIGURATION }),
    digest({ bindingFingerprint: MODEL_BINDING.bindingDigest, configurationFingerprint: CONFIGURATION.digest })
  );
  const keyFor = (candidate) => nodeTurnIdempotencyKey({
    unitId: "unit-1",
    nodeId: "only",
    attemptNumber: 1,
    nodeRef: candidate.ref,
    fingerprint: nodeExecutionFingerprint(candidate),
    inputDigest: "a".repeat(64)
  });
  assert.notEqual(keyFor(configured), keyFor(plain));
});

test("configuration: the worker context carries the sealed ref, and an attempt whose context disagrees is refused", async () => {
  const graph = createGraphDefinition({
    graphId: "fixture.configured",
    version: 1,
    description: "One configured code node.",
    entry: "only",
    nodes: [{ ...node("only", ["ok"]), configuration: CONFIGURATION }],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "ok" }]
  });
  const sealed = compileGraph(graph).nodesById.only;
  const input = createArtifactEnvelope("unit-artifact.v1", { seed: 1 });
  const contextFor = (configuration) => ({
    graph: graphDefinitionRef(graph),
    queueId: "queue-1",
    unitId: "unit-1",
    nodeId: "only",
    nodeRef: sealed.ref,
    attemptNumber: 1,
    attemptIndex: 1,
    idempotencyKey: nodeTurnIdempotencyKey({
      unitId: "unit-1",
      nodeId: "only",
      attemptNumber: 1,
      nodeRef: sealed.ref,
      fingerprint: nodeExecutionFingerprint(sealed),
      inputDigest: input.digest
    }),
    inputArtifact: { contractId: input.contractId, digest: input.digest, bytes: input.bytes },
    ...(configuration === undefined ? {} : { configuration })
  });
  const snapshot = snapshotWorkerNodeTurnContext(contextFor(CONFIGURATION));
  assert.deepEqual({ ...snapshot.configuration }, CONFIGURATION);
  assert.equal(Object.isFrozen(snapshot.configuration), true);
  assert.equal(Object.getPrototypeOf(snapshot.configuration), null);
  assert.equal("configuration" in snapshotWorkerNodeTurnContext(contextFor(undefined)), false);
  assert.throws(
    () => snapshotWorkerNodeTurnContext({ ...contextFor(CONFIGURATION), configuration: { id: "x" } }),
    /configuration: missing required key\(s\)/
  );
  assert.throws(
    () => snapshotWorkerNodeTurnContext({ ...contextFor(CONFIGURATION), configuration: undefined }),
    /configuration is present but undefined/
  );

  const seen = [];
  const ports = { code: { run: async (_input, context) => { seen.push(context.configuration); return { outcome: "ok" }; } } };
  const completion = await executeNodeTurnAttempt({ node: sealed, context: contextFor(CONFIGURATION), inputArtifact: input, ports });
  assert.deepEqual(completion, { outcome: "ok" });
  assert.deepEqual(seen.map((entry) => ({ ...entry })), [CONFIGURATION]);
  await assert.rejects(
    executeNodeTurnAttempt({ node: sealed, context: contextFor(undefined), inputArtifact: input, ports }),
    /worker context configuration does not match sealed node only/
  );
  await assert.rejects(
    executeNodeTurnAttempt({ node: sealed, context: contextFor(OTHER_CONFIGURATION), inputArtifact: input, ports }),
    /worker context configuration does not match sealed node only/
  );
  assert.equal(seen.length, 1);
});

test("configuration: the runner hands the sealed ref to the body and the journey's attempt key includes it", async () => {
  const graph = createGraphDefinition({
    graphId: "fixture.configured-run",
    version: 1,
    description: "A configured code node run through the memory store.",
    entry: "only",
    nodes: [{ ...node("only", ["ok"]), configuration: CONFIGURATION }],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "ok" }]
  });
  let epoch = Date.parse("2026-09-10T12:00:00.000Z");
  const now = () => new Date((epoch += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({ graphStore, now, idFactory: (kind) => `${kind}-${epoch}` });
  await graphStore.publishGraph(graph);
  await unitStore.admitUnit({
    unitId: "unit-configured",
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("unit-artifact.v1", { seed: true }),
    admittedAt: now().toISOString(),
    principalId: "v2_admitter"
  });
  const seen = [];
  const result = await runNextUnitTurn({
    store: unitStore,
    principalId: "v2_worker",
    leaseOwner: "configured",
    ports: { code: { run: async (_input, context) => { seen.push(context.configuration); return { outcome: "ok" }; } } },
    now
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(seen.map((entry) => ({ ...entry })), [CONFIGURATION]);
  const journey = await unitStore.readJourney({ unitId: "unit-configured" });
  const settled = journey.find((record) => record.kind === "turn_settled");
  const sealed = compileGraph(graph).nodesById.only;
  assert.equal(settled.idempotencyKey, nodeTurnIdempotencyKey({
    unitId: "unit-configured",
    nodeId: "only",
    attemptNumber: settled.attemptNumber,
    nodeRef: sealed.ref,
    fingerprint: nodeExecutionFingerprint(sealed),
    inputDigest: settled.inputArtifact.digest
  }));
});

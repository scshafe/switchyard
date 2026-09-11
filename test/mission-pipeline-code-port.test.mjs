import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import { codeNodePortByNode } from "mission-pipeline/execute/code-port";
import { isExecutionFailureError } from "mission-pipeline/execute/failure";
import { runNextUnitTurn } from "mission-pipeline/execute/unit-runner";
import { createGraphDefinition, graphDefinitionRef } from "mission-pipeline/graph/definition";
import { MemoryGraphStore } from "mission-pipeline/store/memory-graph-store";
import { MemoryUnitStore } from "mission-pipeline/store/memory-unit-store";
import { node } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";

const context = (nodeId) => Object.freeze({
  graph: { id: "code-port.fixture", version: 1, digest: "a".repeat(64) },
  queueId: "queue-1",
  unitId: "unit-1",
  nodeId,
  nodeRef: { id: `fixture.${nodeId}`, version: 1 },
  attemptNumber: 1,
  attemptIndex: 1,
  idempotencyKey: "b".repeat(64),
  inputArtifact: { contractId: "unit-artifact.v1", digest: "c".repeat(64) }
});

test("code port by node: dispatches on the turn's nodeId and passes input and context through", async () => {
  const calls = [];
  const port = codeNodePortByNode({
    alpha: async (input, turn) => {
      calls.push(["alpha", input, turn.nodeId]);
      return { outcome: "done" };
    },
    beta: async (input, turn) => {
      calls.push(["beta", input, turn.nodeId]);
      return { outcome: "other" };
    }
  });
  assert.deepEqual(await port.run({ seed: 1 }, context("beta")), { outcome: "other" });
  assert.deepEqual(await port.run({ seed: 2 }, context("alpha")), { outcome: "done" });
  assert.deepEqual(calls, [["beta", { seed: 1 }, "beta"], ["alpha", { seed: 2 }, "alpha"]]);
  assert.equal(Object.isFrozen(port), true);
});

test("code port by node: an unregistered node is a terminal configuration rejection before any body runs", async () => {
  let invoked = 0;
  const port = codeNodePortByNode({
    alpha: async () => {
      invoked += 1;
      return { outcome: "done" };
    }
  });
  await assert.rejects(port.run({}, context("gamma")), (error) => {
    assert.equal(isExecutionFailureError(error), true);
    assert.equal(error.code, "immutable_configuration_rejected");
    assert.equal(error.retryable, false);
    assert.match(String(error.cause?.message), /no body registered for node gamma/);
    return true;
  });
  const rejection = (pattern) => (error) => {
    assert.equal(error.code, "immutable_configuration_rejected");
    assert.match(String(error.cause?.message), pattern);
    return true;
  };
  await assert.rejects(port.run({}, { nodeId: "constructor" }), rejection(/no body registered for node constructor/));
  await assert.rejects(port.run({}, null), rejection(/no body registered for node undefined/));
  assert.equal(invoked, 0);
});

test("code port by node: bodies are captured once as data-property functions under identifier keys", async () => {
  assert.throws(() => codeNodePortByNode(null), /plain non-Proxy data object/);
  assert.throws(() => codeNodePortByNode(new Proxy({}, {})), /plain non-Proxy data object/);
  assert.throws(() => codeNodePortByNode({ alpha: "not a function" }), /alpha must be a non-Proxy function/);
  assert.throws(
    () => codeNodePortByNode({ alpha: new Proxy(async () => ({ outcome: "done" }), {}) }),
    /alpha must be a non-Proxy function/
  );
  assert.throws(() => codeNodePortByNode({ "Not Valid": async () => ({ outcome: "done" }) }), /identifier grammar/);
  assert.throws(() => codeNodePortByNode({ [Symbol("alpha")]: async () => ({}) }), /symbol keys/);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "alpha", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => ({ outcome: "done" });
    }
  });
  assert.throws(() => codeNodePortByNode(accessor), /alpha must be an enumerable data property/);
  assert.equal(getterCalls, 0);

  const bodies = { alpha: async () => ({ outcome: "first" }) };
  const port = codeNodePortByNode(bodies);
  bodies.alpha = async () => ({ outcome: "mutated" });
  bodies.beta = async () => ({ outcome: "added" });
  assert.deepEqual(await port.run({}, context("alpha")), { outcome: "first" });
  await assert.rejects(port.run({}, context("beta")), (error) => {
    assert.equal(isExecutionFailureError(error), true);
    assert.match(String(error.cause?.message), /no body registered for node beta/);
    return true;
  });
});

test("code port by node: runs real turns through the engine and dead-letters a node with no body", async () => {
  const graph = createGraphDefinition({
    graphId: "code-port.engine",
    version: 1,
    description: "Two registered code nodes and one with no body.",
    entry: "source",
    nodes: [
      node("source", ["done"]),
      node("target", ["done"]),
      node("orphan", ["done"], { turn: { maxAttempts: 3 } })
    ],
    edges: [
      { edgeId: "source-target", from: "source", when: { outcome: "done" }, to: ["target"] },
      { edgeId: "target-orphan", from: "target", when: { outcome: "done" }, to: ["orphan"] }
    ],
    terminals: [{ nodeId: "orphan", outcome: "done" }]
  });
  let epoch = Date.parse("2026-09-10T10:00:00.000Z");
  const now = () => new Date((epoch += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({ graphStore, now, idFactory: (kind) => `${kind}-${epoch}` });
  await graphStore.publishGraph(graph);
  await unitStore.admitUnit({
    unitId: "unit-code-port",
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("unit-artifact.v1", { seed: true }),
    admittedAt: now().toISOString(),
    principalId: "v2_admitter"
  });
  const seen = [];
  const ports = {
    code: codeNodePortByNode({
      source: async (input, turn) => {
        seen.push(`${turn.nodeId}:${JSON.stringify(input)}`);
        return { outcome: "done", outputArtifact: createArtifactEnvelope("unit-artifact.v1", { from: "source" }) };
      },
      target: async (input, turn) => {
        seen.push(`${turn.nodeId}:${JSON.stringify(input)}`);
        return { outcome: "done" };
      }
    })
  };
  const run = () => runNextUnitTurn({ store: unitStore, principalId: "v2_worker", leaseOwner: "code-port", ports, now });
  assert.equal((await run()).status, "succeeded");
  assert.equal((await run()).status, "succeeded");
  assert.deepEqual(seen, ['source:{"seed":true}', 'target:{"from":"source"}']);

  // The orphan's turn is terminal on its first attempt: no body, no retry, no successor.
  const orphan = await run();
  assert.deepEqual(orphan, { status: "terminal", errorCode: "immutable_configuration_rejected", attempts: 1 });
  const deadLetters = await unitStore.listDeadLetters({ unitId: "unit-code-port" });
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].nodeId, "orphan");
  assert.equal(await run(), undefined);
});

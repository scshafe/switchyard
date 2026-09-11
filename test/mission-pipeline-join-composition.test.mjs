import test from "node:test";
import assert from "node:assert/strict";
import { compileGraph } from "mission-pipeline/graph/compile";
import { createGraphDefinition, JOIN_INPUT_ARTIFACT_CONTRACT } from "mission-pipeline/graph/definition";
import { projectGraphDisplay } from "mission-pipeline/graph/display";
import { graphDefinitionDiff } from "mission-pipeline/graph/diff";
import { fixtureGraphs } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";

function composed() {
  const draft = structuredClone(fixtureGraphs.join);
  draft.nodes[3].input = JOIN_INPUT_ARTIFACT_CONTRACT;
  draft.nodes[3].join.compose = "envelope";
  draft.nodes[1].outputs = { done: "branch-a.v1" };
  draft.nodes[2].outputs = { done: "branch-b.v1" };
  return draft;
}

test("envelope joins accept heterogeneous declared branch outputs only with the reserved input", () => {
  const graph = createGraphDefinition(composed());
  const compiled = compileGraph(graph);
  assert.equal(compiled.nodesById.join.input, JOIN_INPUT_ARTIFACT_CONTRACT);
  assert.equal(compiled.nodesById.join.join.compose, "envelope");
  const wrongInput = composed(); wrongInput.nodes[3].input = "arbitrary.v1";
  assert.throws(() => compileGraph(createGraphDefinition(wrongInput)), /requires mission-pipeline\.join-input\.v1/);
  for (const mode of [undefined, "select"]) {
    const draft = composed();
    if (mode === undefined) delete draft.nodes[3].join.compose;
    else draft.nodes[3].join.compose = mode;
    assert.throws(() => compileGraph(createGraphDefinition(draft)), /target node join accepts/);
  }
  const mixedFanout = composed();
  mixedFanout.edges[1].to.push("branch-b");
  assert.throws(() => compileGraph(createGraphDefinition(mixedFanout)), /target node branch-b accepts/);
});

test("compose is optional sealed graph data; malformed or hostile modes fail before access", () => {
  const original = createGraphDefinition(fixtureGraphs.join);
  assert.equal(Object.hasOwn(original.nodes[3].join, "compose"), false);
  const explicit = structuredClone(fixtureGraphs.join); explicit.nodes[3].join.compose = "select";
  const selected = createGraphDefinition(explicit);
  assert.notEqual(selected.graphDigest, original.graphDigest);
  compileGraph(selected);
  assert.equal(graphDefinitionDiff(original, selected).empty, false);
  for (const mode of [undefined, null, 1, false, "merge", {}, []]) {
    const draft = composed(); draft.nodes[3].join.compose = mode;
    assert.throws(() => createGraphDefinition(draft), /compose|undefined/);
  }
  let reads = 0;
  const getter = composed();
  Object.defineProperty(getter.nodes[3].join, "compose", { enumerable: true, get() { reads += 1; return "envelope"; } });
  assert.throws(() => createGraphDefinition(getter));
  const proxy = composed();
  proxy.nodes[3].join = new Proxy(proxy.nodes[3].join, { get() { reads += 1; }, ownKeys() { reads += 1; return []; } });
  assert.throws(() => createGraphDefinition(proxy));
  assert.equal(reads, 0);
});

test("display carries opt-in composition on both join descriptions without changing legacy shapes", () => {
  const projection = projectGraphDisplay(compileGraph(createGraphDefinition(composed())));
  assert.equal(projection.joins[0].compose, "envelope");
  assert.equal(projection.nodes.find(node => node.nodeId === "join").join.compose, "envelope");
  assert.equal(Object.isFrozen(projection.joins[0]), true);
  assert.equal(Object.getPrototypeOf(projection.joins[0]), null);
  const legacy = projectGraphDisplay(compileGraph(createGraphDefinition(fixtureGraphs.join)));
  assert.equal(Object.hasOwn(legacy.joins[0], "compose"), false);
});

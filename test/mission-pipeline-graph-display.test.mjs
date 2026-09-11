import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalJson } from "mission-pipeline/contracts/digest";
import { compileGraph } from "mission-pipeline/graph/compile";
import { createGraphDefinition } from "mission-pipeline/graph/definition";
import { GRAPH_DISPLAY_SCHEMA_VERSION, projectGraphDisplay } from "mission-pipeline/graph/display";
import { createGoalManifest, validateGoalManifest } from "mission-pipeline/graph/goals";
import { fixtureGraphs, node } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";
import {
  COMPILED_SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_MONOLITH_GRAPH,
  SUPPORT_TRIAGE_GOALS_DRAFT,
  SUPPORT_TRIAGE_GOAL_MANIFEST,
  SUPPORT_TRIAGE_PRESENTATION,
  presentationCoverage,
  renderSupportTriageMermaid
} from "./fixtures/mission-pipeline/support-triage-example.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const displayOf = (draft) => projectGraphDisplay(compileGraph(createGraphDefinition(draft)));
const depths = (display) => Object.fromEntries(display.nodes.map((node) => [node.nodeId, node.depth]));
const golden = JSON.parse(readFileSync(new URL("./fixtures/mission-pipeline/graph-display.golden.json", import.meta.url), "utf8"));

const graphs = {
  ...Object.fromEntries(Object.entries(fixtureGraphs).map(([name, draft]) => [name, createGraphDefinition(draft)])),
  "support-triage": SUPPORT_TRIAGE_GRAPH,
  "support-triage-monolith": SUPPORT_TRIAGE_MONOLITH_GRAPH
};

for (const [name, graph] of Object.entries(graphs)) {
  test(`graph display golden: ${name}`, () => {
    const display = projectGraphDisplay(compileGraph(graph));
    assert.equal(display.schemaVersion, GRAPH_DISPLAY_SCHEMA_VERSION);
    assert.deepEqual(plain(display), golden[name]);
    assert.equal(canonicalJson(display), canonicalJson(projectGraphDisplay(compileGraph(graph))));
    // Every declared edge/target pair survives merging exactly once.
    assert.deepEqual(
      display.arrows.flatMap((arrow) => arrow.edgeIds.map((edgeId) => `${edgeId}\u0000${arrow.to}`)).sort(),
      graph.edges.flatMap((edge) => edge.to.map((to) => `${edge.edgeId}\u0000${to}`)).sort()
    );
    assert.deepEqual(plain(display.terminals), plain(graph.terminals));
  });
}

test("graph display: longest DAG paths ignore declaration order, shortcuts, and repeated edges", () => {
  const display = displayOf({
    graphId: "display.depth",
    version: 1,
    description: "A shortcut must not lower the structural depth.",
    entry: "start",
    nodes: [node("sink", ["done"]), node("middle", ["next"]), node("start", ["go"])],
    edges: [
      { edgeId: "shortcut", from: "start", when: { outcome: "go" }, to: ["sink"] },
      { edgeId: "middle-sink", from: "middle", when: { outcome: "next" }, to: ["sink"] },
      { edgeId: "start-middle", from: "start", when: { outcome: "go" }, to: ["middle"] },
      { edgeId: "start-middle-again", from: "start", when: { anyOf: ["go"] }, to: ["middle"] }
    ],
    terminals: [{ nodeId: "sink", outcome: "done" }]
  });
  assert.deepEqual(depths(display), { sink: 2, middle: 1, start: 0 });
  assert.deepEqual(display.nodes.map((node) => node.nodeId), ["sink", "middle", "start"]);
  assert.deepEqual(display.arrows.map((arrow) => [arrow.from, arrow.to]), [["start", "sink"], ["middle", "sink"], ["start", "middle"]]);
  assert.deepEqual(display.arrows[2].edgeIds, ["start-middle", "start-middle-again"]);
  assert.equal(display.nodes.find((node) => node.nodeId === "start").marks, false);
});

test("graph display: any reachable cycle switches the entire graph to finite BFS depth", () => {
  const draft = {
    graphId: "display.cycle",
    version: 1,
    description: "A DAG prefix with a shortcut and a downstream self-loop.",
    entry: "start",
    nodes: [node("start", ["go"]), node("middle", ["go"]), node("end", ["go"]), node("loop", ["again", "done"])],
    edges: [
      { edgeId: "start-middle", from: "start", when: { outcome: "go" }, to: ["middle", "end"] },
      { edgeId: "middle-end", from: "middle", when: { outcome: "go" }, to: ["end"] },
      { edgeId: "end-loop", from: "end", when: { outcome: "go" }, to: ["loop"] },
      { edgeId: "loop-again", from: "loop", when: { outcome: "again" }, to: ["loop"] }
    ],
    terminals: [{ nodeId: "loop", outcome: "done" }]
  };
  assert.deepEqual(depths(displayOf(draft)), { start: 0, middle: 1, end: 1, loop: 2 });
  // A cycle through entry must keep entry at zero too.
  draft.edges[3].to = ["start"];
  assert.deepEqual(depths(displayOf(draft)), { start: 0, middle: 1, end: 1, loop: 2 });
});

function markingDraft() {
  return {
    graphId: "display.marking",
    version: 1,
    description: "Two marks reach the same successors through different edge declarations.",
    entry: "mark",
    nodes: [node("mark", ["yes", "no"]), node("left", ["done"]), node("right", ["done"])],
    edges: [
      { edgeId: "yes-both", from: "mark", when: { outcome: "yes" }, to: ["right", "left"] },
      { edgeId: "no-left", from: "mark", when: { outcome: "no" }, to: ["left"] },
      { edgeId: "no-right", from: "mark", when: { anyOf: ["no", "yes"] }, to: ["right"] },
      { edgeId: "conditional-duplicate", from: "mark", when: { outcome: "yes", where: [{ pointer: "/payload/signal", equals: true }] }, to: ["left"] }
    ],
    terminals: [{ nodeId: "left", outcome: "done" }, { nodeId: "right", outcome: "done" }]
  };
}

test("graph display: merges arrows, preserves fan-out evidence, and recognizes guaranteed marks", () => {
  const display = displayOf(markingDraft());
  assert.equal(display.nodes[0].marks, true);
  assert.deepEqual(plain(display.arrows), [
    { from: "mark", to: "right", outcomes: ["yes", "no"], edgeIds: ["yes-both", "no-right"], conditional: false,
      fanOut: [{ edgeId: "yes-both", coTargets: ["left"], outcomes: ["yes"] }] },
    { from: "mark", to: "left", outcomes: ["yes", "no"], edgeIds: ["yes-both", "no-left", "conditional-duplicate"], conditional: true,
      fanOut: [{ edgeId: "yes-both", coTargets: ["right"], outcomes: ["yes"] }] }
  ]);
  assert.equal(display.nodes[1].marks, false);
});

test("graph display: conditional extra targets and terminal outcomes are never guaranteed marks", () => {
  const draft = markingDraft();
  draft.nodes.push(node("shadow", ["done"]));
  draft.terminals.push({ nodeId: "shadow", outcome: "done" });
  for (const outcome of ["yes", "no"]) {
    draft.edges.push({ edgeId: `shadow-${outcome}`, from: "mark", when: { outcome, where: [{ pointer: "/payload/signal", equals: true }] }, to: ["shadow"] });
  }
  // Same syntactic target union for every outcome is insufficient: this
  // target depends on artifact data and is not guaranteed by either outcome.
  const display = displayOf(draft);
  assert.equal(display.nodes[0].marks, false);
  assert.equal(display.arrows.find((arrow) => arrow.to === "shadow").conditional, true);
  const terminal = markingDraft();
  terminal.nodes[0].outcomes.outcomes.push("stop");
  terminal.terminals.push({ nodeId: "mark", outcome: "stop" });
  assert.equal(displayOf(terminal).nodes[0].marks, false);
});

test("graph display: merged fan-outs retain each edge's own outcome provenance", () => {
  const draft = markingDraft();
  draft.edges.push({ edgeId: "no-both", from: "mark", when: { anyOf: ["no", "yes"] }, to: ["left", "right"] });
  const display = displayOf(draft);
  for (const arrow of display.arrows) {
    assert.deepEqual(arrow.outcomes, ["yes", "no"]);
    assert.deepEqual(arrow.fanOut.map((fork) => [fork.edgeId, fork.outcomes]), [
      ["yes-both", ["yes"]], ["no-both", ["no", "yes"]]
    ]);
    assert.equal(Object.isFrozen(arrow.fanOut[1].outcomes), true);
  }
});

function assertFrozenRecords(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), null);
  for (const item of Object.values(value)) assertFrozenRecords(item);
}

test("graph display: prototype-looking identifiers remain data and every output record is detached and frozen", () => {
  const draft = {
    graphId: "display.prototype",
    version: 1,
    description: "Presentation text stays out of the projection.",
    entry: "constructor",
    nodes: [node("constructor", ["constructor", "prototype"], { outputs: { constructor: "unit-artifact.v1" } }), node("prototype", ["done"])],
    edges: [{ edgeId: "constructor", from: "constructor", when: { anyOf: ["constructor", "prototype"] }, to: ["prototype"] }],
    terminals: [{ nodeId: "prototype", outcome: "done" }]
  };
  const compiled = compileGraph(createGraphDefinition(draft));
  const display = projectGraphDisplay(compiled);
  assert.equal(display.nodes[0].marks, true);
  assert.equal(display.nodes[0].outputs.constructor, "unit-artifact.v1");
  assert.equal(display.arrows[0].to, "prototype");
  assert.notEqual(display.graph, compiled.graph);
  assert.notEqual(display.nodes[0].ref, compiled.nodes[0].ref);
  assertFrozenRecords(display);
  assertFrozenRecords(projectGraphDisplay(COMPILED_SUPPORT_TRIAGE_GRAPH));
  assertFrozenRecords(displayOf(fixtureGraphs["escalation-ladder"]));
  assert.throws(() => { display.nodes[0].outputs.constructor = "other.v1"; }, TypeError);
  draft.nodes[0].ref.id = "changed";
  assert.equal(display.nodes[0].ref.id, "fixture.constructor");
  assert.equal(JSON.stringify(display).includes(draft.description), false);
  assert.equal(Object.hasOwn(display.nodes[0], "principal"), false);
});

test("graph display: rejects copied or forged compiled data and hostile carriers before any property access", () => {
  const compiled = COMPILED_SUPPORT_TRIAGE_GRAPH;
  const message = /requires a compileGraph result; recompile the sealed GraphDefinition/;
  let reads = 0;
  const hostile = new Proxy(compiled, {
    get() { reads += 1; throw new Error("get trap"); },
    getPrototypeOf() { reads += 1; throw new Error("prototype trap"); },
    ownKeys() { reads += 1; throw new Error("keys trap"); }
  });
  const accessor = Object.defineProperty({}, "graph", { enumerable: true, get() { reads += 1; throw new Error("getter"); } });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const input of [null, undefined, 1, [], hostile, revoked.proxy, accessor,
    { ...compiled }, plain(compiled),
    { ...compiled, graph: { ...compiled.graph, digest: "f".repeat(64) } },
    { ...compiled, outboundByNode: {} }, Object.freeze({ ...compiled })]) {
    assert.throws(() => projectGraphDisplay(input), message);
  }
  assert.equal(reads, 0);
  assert.deepEqual(projectGraphDisplay(compileGraph(plain(SUPPORT_TRIAGE_GRAPH))), projectGraphDisplay(compiled));
});

test("graph display: inherited optional fields cannot inject presentation data or execute getters", () => {
  let reads = 0;
  for (const key of ["binding", "configuration", "outputs", "join"]) {
    Object.defineProperty(Object.prototype, key, { configurable: true, get() { reads += 1; throw new Error(`inherited ${key}`); } });
  }
  try {
    const display = displayOf(fixtureGraphs["filter-chain"]);
    assert.equal(reads, 0);
    assert.equal(Object.hasOwn(display.nodes[0], "outputs"), false);
    assert.equal(Object.hasOwn(display.nodes[0], "join"), false);
  } finally {
    for (const key of ["binding", "configuration", "outputs", "join"]) delete Object.prototype[key];
  }
});

test("graph display: bounded fan-out expansion preserves every edge at the maximum target width", () => {
  const targets = Array.from({ length: 64 }, (_, index) => `target-${index}`);
  const display = displayOf({
    graphId: "display.wide",
    version: 1,
    description: "A valid compact graph expands to more projection values than the input budget.",
    entry: "start",
    nodes: [node("start", ["yes", "no"]), ...targets.map((target) => node(target, ["done"]))],
    edges: Array.from({ length: 16 }, (_, index) => ({
      edgeId: `fan-${index}`, from: "start", when: { anyOf: ["yes", "no"] }, to: targets
    })),
    terminals: targets.map((nodeId) => ({ nodeId, outcome: "done" }))
  });
  assert.equal(display.nodes[0].marks, true);
  assert.equal(display.arrows.length, 64);
  for (const arrow of display.arrows) {
    assert.equal(arrow.edgeIds.length, 16);
    assert.equal(arrow.fanOut.length, 16);
    for (const fan of arrow.fanOut) {
      assert.deepEqual(fan.coTargets, targets.filter((target) => target !== arrow.to));
    }
  }
  assertFrozenRecords(display);
});

test("graph display: the example's presentation, Mermaid, and re-sealed goal manifest retain the exact graph identity", () => {
  const display = projectGraphDisplay(COMPILED_SUPPORT_TRIAGE_GRAPH);
  assert.deepEqual(plain(display.graph), plain(SUPPORT_TRIAGE_GOAL_MANIFEST.graph));
  assert.deepEqual(createGoalManifest(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_GOALS_DRAFT), SUPPORT_TRIAGE_GOAL_MANIFEST);
  assert.deepEqual(validateGoalManifest(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_GOAL_MANIFEST), SUPPORT_TRIAGE_GOAL_MANIFEST);
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_PRESENTATION), []);
  const document = readFileSync(new URL("../docs/EXAMPLE-SUPPORT-TRIAGE.md", import.meta.url), "utf8");
  const mermaid = document.match(/```mermaid\n([\s\S]*?)```/);
  assert.ok(mermaid);
  assert.equal(mermaid[1].trim(), renderSupportTriageMermaid().trim());
  assert.deepEqual(depths(display), { normalize: 0, "outage-signal": 1, "ground-evidence": 2, "outage-verify": 3,
    "blast-radius": 4, assemble: 5, summarize: 6, "dispatch-review": 7, "triage-review": 6 });
  assert.deepEqual(display.nodes.filter((node) => node.marks).map((node) => node.nodeId), ["blast-radius", "summarize"]);
});

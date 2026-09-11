import test from "node:test";
import assert from "node:assert/strict";

import { graphTurnBudget } from "mission-pipeline/graph/budget";
import { createGraphDefinition } from "mission-pipeline/graph/definition";
import {
  fixtureGraphs,
  node
} from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";
import { SUPPORT_TRIAGE_GRAPH } from "./fixtures/mission-pipeline/support-triage-example.mjs";

const budgetOf = (draft) => graphTurnBudget(createGraphDefinition(draft));
const column = (budget, field) => Object.fromEntries(
  Object.values(budget.nodes).map((entry) => [entry.nodeId, entry[field]])
);

test("graph turn budget: a linear chain bounds turns by attempts per node", () => {
  const budget = budgetOf(fixtureGraphs["filter-chain"]);
  assert.equal(budget.graph.id, "fixture.filter-chain");
  assert.equal(budget.acyclic, true);
  assert.deepEqual(budget.cycleEdges, []);
  assert.deepEqual(column(budget, "depth"), { filter: 0, normalize: 1, sink: 2 });
  assert.deepEqual(column(budget, "maxOccurrences"), { filter: 1, normalize: 1, sink: 1 });
  assert.deepEqual(column(budget, "maxTurns"), { filter: 2, normalize: 2, sink: 2 });
  assert.equal(budget.maxDepth, 2);
  assert.equal(budget.maxTurns, 6);
  assert.deepEqual(budget.maxTurnsByKind, { code: 6, model: 0, agent: 0, human: 0, callback: 0 });
});

test("graph turn budget: kinds are totalled separately and a join counts once", () => {
  const router = budgetOf(fixtureGraphs["outcome-router"]);
  assert.equal(router.maxTurns, 6);
  assert.deepEqual(router.maxTurnsByKind, { code: 4, model: 2, agent: 0, human: 0, callback: 0 });
  assert.equal(router.maxDepth, 1);

  const join = budgetOf(fixtureGraphs.join);
  assert.deepEqual(column(join, "maxOccurrences"), { start: 1, "branch-a": 1, "branch-b": 1, join: 1 });
  assert.equal(join.nodes.join.join, true);
  assert.equal(join.maxTurns, 8);
  assert.equal(join.maxDepth, 2);

  const ladder = budgetOf(fixtureGraphs["escalation-ladder"]);
  assert.equal(ladder.acyclic, true);
  assert.equal(ladder.maxTurns, 10);
  assert.deepEqual(ladder.maxTurnsByKind, { code: 4, model: 0, agent: 0, human: 4, callback: 2 });
  assert.deepEqual(column(ladder, "depth"), {
    triage: 0,
    "review-tier-1": 1,
    "tier-1-timer": 1,
    "tier-1-race": 2,
    "review-tier-2": 3
  });
});

test("graph turn budget: an ordinary target converged on by distinct sources can queue once per source", () => {
  const converge = budgetOf({
    graphId: "budget.converge",
    version: 1,
    description: "Two branches reach one ordinary node without a join.",
    entry: "start",
    nodes: [
      node("start", ["ready"]),
      node("left", ["done"]),
      node("right", ["done"]),
      node("sink", ["done"])
    ],
    edges: [
      { edgeId: "fan-out", from: "start", when: { outcome: "ready" }, to: ["left", "right"] },
      { edgeId: "left-sink", from: "left", when: { outcome: "done" }, to: ["sink"] },
      { edgeId: "right-sink", from: "right", when: { outcome: "done" }, to: ["sink"] }
    ],
    terminals: [{ nodeId: "sink", outcome: "done" }]
  });
  assert.deepEqual(column(converge, "maxOccurrences"), { start: 1, left: 1, right: 1, sink: 2 });
  assert.equal(converge.nodes.sink.maxTurns, 4);
  assert.equal(converge.maxTurns, 10);

  // Several edges from ONE source dedupe to one occurrence, as settlement does.
  const duplicate = budgetOf({
    graphId: "budget.duplicate-edges",
    version: 1,
    description: "Two matching edges from one settlement queue the target once.",
    entry: "source",
    nodes: [node("source", ["done"]), node("target", ["done"])],
    edges: [
      { edgeId: "first", from: "source", when: { outcome: "done" }, to: ["target"] },
      { edgeId: "second", from: "source", when: { anyOf: ["done"] }, to: ["target"] }
    ],
    terminals: [{ nodeId: "target", outcome: "done" }]
  });
  assert.equal(duplicate.nodes.target.maxOccurrences, 1);
});

test("graph turn budget: the support-triage example's worst case is exact", () => {
  const budget = graphTurnBudget(SUPPORT_TRIAGE_GRAPH);
  assert.equal(budget.acyclic, true);
  assert.deepEqual(column(budget, "maxOccurrences"), {
    normalize: 1,
    "outage-signal": 1,
    "ground-evidence": 1,
    "outage-verify": 1,
    "blast-radius": 1,
    assemble: 1,
    summarize: 1,
    "dispatch-review": 1,
    "triage-review": 4
  });
  assert.equal(budget.maxTurns, 16);
  assert.deepEqual(budget.maxTurnsByKind, { code: 3, model: 8, agent: 0, human: 5, callback: 0 });
  assert.equal(budget.maxDepth, 7);
  assert.equal(budget.nodes["triage-review"].depth, 6);
});

test("graph turn budget: a cycle is reported by its back edges and bounds nothing", () => {
  const cyclic = budgetOf({
    graphId: "budget.cycle",
    version: 1,
    description: "A reachable cycle.",
    entry: "a",
    nodes: [node("a", ["next"]), node("b", ["next", "stop"])],
    edges: [
      { edgeId: "a-to-b", from: "a", when: { outcome: "next" }, to: ["b"] },
      { edgeId: "b-to-a", from: "b", when: { outcome: "next" }, to: ["a"] }
    ],
    terminals: [{ nodeId: "b", outcome: "stop" }]
  });
  assert.equal(cyclic.acyclic, false);
  assert.deepEqual(cyclic.cycleEdges, [{ edgeId: "b-to-a", from: "b", to: "a" }]);
  assert.equal(cyclic.maxTurns, null);
  assert.equal(cyclic.maxDepth, null);
  assert.deepEqual(cyclic.maxTurnsByKind, { code: null, model: null, agent: null, human: null, callback: null });
  assert.deepEqual(column(cyclic, "maxOccurrences"), { a: null, b: null });
  assert.deepEqual(column(cyclic, "depth"), { a: null, b: null });

  const selfLoop = budgetOf({
    graphId: "budget.self-loop",
    version: 1,
    description: "A node that re-queues itself.",
    entry: "again",
    nodes: [node("again", ["retry", "done"])],
    edges: [{ edgeId: "again-again", from: "again", when: { outcome: "retry" }, to: ["again"] }],
    terminals: [{ nodeId: "again", outcome: "done" }]
  });
  assert.deepEqual(selfLoop.cycleEdges, [{ edgeId: "again-again", from: "again", to: "again" }]);
});

test("graph turn budget: validation is the compiler's, and the result is frozen data", () => {
  assert.throws(() => graphTurnBudget({}), /graph definition/);
  const uncovered = structuredClone(fixtureGraphs["filter-chain"]);
  uncovered.terminals = uncovered.terminals.filter((terminal) => terminal.outcome !== "drop");
  assert.throws(() => budgetOf(uncovered), /outcome "drop" is uncovered/);

  const budget = budgetOf(fixtureGraphs["filter-chain"]);
  assert.equal(Object.isFrozen(budget), true);
  assert.equal(Object.isFrozen(budget.nodes), true);
  assert.equal(Object.isFrozen(budget.cycleEdges), true);
  assert.equal(Object.getPrototypeOf(budget.nodes), null);
  assert.equal("constructor" in budget.nodes, false);
  assert.deepEqual(budgetOf(fixtureGraphs["filter-chain"]), budget);
});

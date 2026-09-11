import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { digest } from "mission-pipeline/contracts/digest";
import { compileGraph } from "mission-pipeline/graph/compile";
import { createGraphDefinition } from "mission-pipeline/graph/definition";
import { graphDefinitionDiff } from "mission-pipeline/graph/diff";
import { fixtureGraphs, node } from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";
import {
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_MONOLITH_GRAPH
} from "./fixtures/mission-pipeline/support-triage-example.mjs";

const GOLDEN = JSON.parse(readFileSync(
  new URL("./fixtures/mission-pipeline/graph-diff-golden-vectors.json", import.meta.url), "utf8"
));
const plain = (value) => JSON.parse(JSON.stringify(value));
const seal = createGraphDefinition;
const graphs = {
  ...Object.fromEntries(Object.entries(fixtureGraphs).map(([name, draft]) => [name, seal(draft)])),
  "support-triage": SUPPORT_TRIAGE_GRAPH
};

function draftOf(graph) {
  const { graphDigest: _digest, ...draft } = structuredClone(graph);
  return draft;
}

function revisionOf(graph) {
  const draft = draftOf(graph);
  draft.version += 1;
  draft.nodes.find((node) => node.nodeId === graph.entry).turn.maxAttempts += 1;
  draft.nodes.reverse();
  draft.edges.reverse();
  draft.terminals.reverse();
  return seal(draft);
}

function assertFrozenData(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : null);
  for (const child of Object.values(value)) assertFrozenData(child);
}

for (const [name, graph] of Object.entries(graphs)) {
  test(`graph definition diff: ${name} golden seals and complete diff digests`, () => {
    const revision = revisionOf(graph);
    const same = graphDefinitionDiff(graph, graph);
    const changed = graphDefinitionDiff(graph, revision);
    assert.deepEqual({
      sealedDigest: graph.graphDigest,
      candidateDigest: revision.graphDigest,
      sameDiffDigest: digest(same),
      revisionDiffDigest: digest(changed)
    }, GOLDEN.graphs[name]);
    assert.equal(same.empty, true);
    assert.deepEqual(plain(same.unchanged), {
      nodes: graph.nodes.length, edges: graph.edges.length, terminals: graph.terminals.length
    });
    assert.equal(changed.empty, false);
    assert.equal(changed.nodes.length, 1);
    assert.equal(changed.nodes[0].nodeId, graph.entry);
    assert.deepEqual(plain(changed.nodes[0].fields), [{
      field: "turn.maxAttempts",
      from: String(graph.nodes.find((node) => node.nodeId === graph.entry).turn.maxAttempts),
      to: String(revision.nodes.find((node) => node.nodeId === graph.entry).turn.maxAttempts)
    }]);
    assertFrozenData(changed);
  });
}

test("graph definition diff: the focused and overloaded support examples have a golden structural comparison", () => {
  const diff = graphDefinitionDiff(SUPPORT_TRIAGE_MONOLITH_GRAPH, SUPPORT_TRIAGE_GRAPH);
  assert.deepEqual({
    sealedDigest: SUPPORT_TRIAGE_MONOLITH_GRAPH.graphDigest,
    candidateDigest: SUPPORT_TRIAGE_GRAPH.graphDigest,
    diffDigest: digest(diff)
  }, GOLDEN.supportTriageComparison);
  assert.equal(diff.sameFamily, false);
  assert.equal(diff.empty, false);
  assert.deepEqual(diff.nodes.filter((node) => node.change === "removed").map((node) => node.nodeId), ["triage"]);
  assert.deepEqual(diff.nodes.filter((node) => node.change === "added").map((node) => node.nodeId), [
    "assemble", "blast-radius", "ground-evidence", "outage-signal", "outage-verify", "summarize"
  ]);
  assertFrozenData(diff);
});

test("graph definition diff: identities account for added, removed, and changed structure once", () => {
  const original = graphs["filter-chain"];
  const candidate = draftOf(original);
  candidate.version = 2;
  candidate.description = "Candidate graph description.";
  candidate.entry = "review";
  candidate.nodes = candidate.nodes.filter((node) => node.nodeId !== "normalize");
  const filter = candidate.nodes.find((node) => node.nodeId === "filter");
  filter.ref.version = 2;
  filter.outcomes = { version: 2, outcomes: ["pass", "hold"] };
  candidate.nodes.push(node("review", ["approved"], { kind: "human" }));
  candidate.edges = [
    { edgeId: "filter-pass", from: "filter", when: { anyOf: ["pass"] }, to: ["review"] },
    { edgeId: "review-approved", from: "review", when: { outcome: "approved" }, to: ["sink"] }
  ];
  candidate.terminals = [{ nodeId: "filter", outcome: "hold" }, { nodeId: "sink", outcome: "done" }];
  const revised = seal(candidate);
  const diff = plain(graphDefinitionDiff(original, revised));
  assert.deepEqual(diff.sealed, { graphId: original.graphId, version: 1, digest: original.graphDigest });
  assert.deepEqual(diff.candidate, { graphId: original.graphId, version: 2, digest: revised.graphDigest });
  assert.equal(diff.sameFamily, true);
  assert.deepEqual(diff.description, {
    field: "description", from: JSON.stringify(original.description), to: '"Candidate graph description."'
  });
  assert.deepEqual(diff.entry, { field: "entry", from: '"filter"', to: '"review"' });
  assert.deepEqual(diff.nodes, [
    {
      nodeId: "filter", change: "changed", outcomesAdded: ["hold"], outcomesRemoved: ["drop"],
      fields: [
        { field: "ref", from: '{"id":"fixture.filter","version":1}', to: '{"id":"fixture.filter","version":2}' },
        { field: "outcomes.version", from: "1", to: "2" }
      ]
    },
    { nodeId: "normalize", change: "removed", outcomesAdded: [], outcomesRemoved: ["ok"], fields: [] },
    { nodeId: "review", change: "added", outcomesAdded: ["approved"], outcomesRemoved: [], fields: [] }
  ]);
  assert.deepEqual(diff.edges, [
    {
      edgeId: "filter-pass", change: "changed", from: "filter", to: ["review"],
      outcomesAdded: [], outcomesRemoved: [], fields: [
        { field: "to", from: '["normalize"]', to: '["review"]' },
        { field: "when", from: '{"outcome":"pass"}', to: '{"anyOf":["pass"]}' }
      ]
    },
    {
      edgeId: "normalize-ok", change: "removed", from: "normalize", to: ["sink"],
      outcomesAdded: [], outcomesRemoved: ["ok"], fields: []
    },
    {
      edgeId: "review-approved", change: "added", from: "review", to: ["sink"],
      outcomesAdded: ["approved"], outcomesRemoved: [], fields: []
    }
  ]);
  assert.deepEqual(diff.terminals, [
    { nodeId: "filter", outcome: "drop", change: "removed" },
    { nodeId: "filter", outcome: "hold", change: "added" }
  ]);
  assert.deepEqual(diff.unchanged, { nodes: 1, edges: 0, terminals: 1 });
});

test("graph definition diff: node policy, binding, outputs, and configuration use canonical machine values", () => {
  const original = graphs["outcome-router"];
  const draft = draftOf(original);
  const classify = draft.nodes.find((node) => node.nodeId === "classify");
  classify.ref = { id: "router.revised", version: 2 };
  classify.outcomes.version = 2;
  classify.kind = "agent";
  classify.input = "changed.v1";
  classify.principal.id = "another_principal";
  classify.binding = { kind: "model", bindingId: "undefined", version: 2, bindingDigest: "b".repeat(64) };
  classify.outputs = { noise: "changed.v1", jobs: "unit-artifact.v1" };
  classify.configuration = { id: "policy", version: 3, digest: "c".repeat(64) };
  classify.turn.leaseMs = 45_000;
  classify.turn.maxAttempts = 3;
  const fields = plain(graphDefinitionDiff(original, seal(draft))).nodes[0].fields;
  assert.deepEqual(fields.map((change) => change.field), [
    "ref", "kind", "input", "principal.id", "outcomes.version", "outputs", "binding.bindingId",
    "binding.version", "binding.bindingDigest", "configuration", "turn.leaseMs", "turn.maxAttempts"
  ]);
  assert.deepEqual(fields.find((change) => change.field === "outputs"), {
    field: "outputs", from: "undefined", to: '{"jobs":"unit-artifact.v1","noise":"changed.v1"}'
  });
  assert.deepEqual(fields.find((change) => change.field === "turn.leaseMs"), {
    field: "turn.leaseMs", from: "30000", to: "45000"
  });
  const noBinding = draftOf(original);
  delete noBinding.nodes[0].binding;
  const addedBinding = graphDefinitionDiff(seal(noBinding), seal(draft)).nodes[0].fields;
  assert.deepEqual(plain(addedBinding.find((change) => change.field === "binding.bindingId")), {
    field: "binding.bindingId", from: "undefined", to: '"undefined"'
  });
  const reversed = graphDefinitionDiff(seal(draft), original);
  assert.deepEqual(plain(reversed.nodes[0].fields), fields.map(({ field, from, to }) => ({ field, from: to, to: from })));
});

test("graph definition diff: top-level and vocabulary reorderings are empty while source seals remain exact", () => {
  for (const original of Object.values(graphs)) {
    const draft = draftOf(original);
    draft.version += 1;
    draft.nodes.reverse();
    draft.edges.reverse();
    draft.terminals.reverse();
    for (const node of draft.nodes) {
      node.outcomes.outcomes.reverse();
      if (node.outputs) node.outputs = Object.fromEntries(Object.entries(node.outputs).reverse());
      if (node.configuration) node.configuration = Object.fromEntries(Object.entries(node.configuration).reverse());
    }
    const reordered = seal(draft);
    const diff = graphDefinitionDiff(original, reordered);
    assert.equal(diff.empty, true, original.graphId);
    assert.notEqual(diff.sealed.digest, diff.candidate.digest);
  }
  const otherFamily = draftOf(graphs.join);
  otherFamily.graphId = "another.family";
  const diff = graphDefinitionDiff(graphs.join, seal(otherFamily));
  assert.equal(diff.empty, true);
  assert.equal(diff.sameFamily, false);
});

test("graph definition diff: target, predicate, and join array order are structural", () => {
  const original = graphs.join;
  const draft = draftOf(original);
  draft.edges[0].to.reverse();
  draft.nodes.find((node) => node.nodeId === "join").join.inbound.reverse();
  const diff = plain(graphDefinitionDiff(original, seal(draft)));
  assert.deepEqual(diff.nodes.map((node) => node.fields.map((field) => field.field)), [["join"]]);
  assert.deepEqual(diff.edges.map((edge) => edge.fields.map((field) => field.field)), [["to"]]);

  const first = draftOf(graphs["filter-chain"]);
  first.edges[0].when = { anyOf: ["pass", "drop"] };
  const second = structuredClone(first);
  second.edges[0].when.anyOf.reverse();
  const predicate = graphDefinitionDiff(seal(first), seal(second)).edges[0];
  assert.deepEqual(plain(predicate.outcomesAdded), []);
  assert.deepEqual(plain(predicate.outcomesRemoved), []);
  assert.deepEqual(plain(predicate.fields), [
    { field: "when", from: '{"anyOf":["pass","drop"]}', to: '{"anyOf":["drop","pass"]}' }
  ]);
});

test("graph definition diff: changed edge source, outcomes, and where arms are retained", () => {
  const first = draftOf(graphs["shadow-lane"]);
  const second = structuredClone(first);
  second.edges[1].from = "primary";
  second.edges[1].when = { outcome: "done", where: [{ pointer: "/payload/risk", equals: "low" }] };
  const edge = plain(graphDefinitionDiff(seal(first), seal(second))).edges[0];
  assert.equal(edge.from, "primary");
  assert.deepEqual(edge.outcomesAdded, ["done"]);
  assert.deepEqual(edge.outcomesRemoved, ["routed"]);
  assert.deepEqual(edge.fields, [
    { field: "from", from: '"classify"', to: '"primary"' },
    {
      field: "when",
      from: '{"outcome":"routed","where":[{"equals":"high","pointer":"/payload/risk"}]}',
      to: '{"outcome":"done","where":[{"equals":"low","pointer":"/payload/risk"}]}'
    }
  ]);
});

test("graph definition diff: terminal pair identities cannot collide through colons", () => {
  const base = {
    graphId: "diff.colon-pairs", version: 1, description: "Colon-bearing terminal pairs.", entry: "a",
    nodes: [node("a", ["b:c"]), node("a:b", ["c"])], edges: [],
    terminals: [{ nodeId: "a", outcome: "b:c" }]
  };
  const candidate = { ...base, terminals: [{ nodeId: "a:b", outcome: "c" }] };
  const diff = graphDefinitionDiff(seal(base), seal(candidate));
  assert.deepEqual(plain(diff.terminals), [
    { nodeId: "a", outcome: "b:c", change: "removed" },
    { nodeId: "a:b", outcome: "c", change: "added" }
  ]);
  assert.equal(diff.unchanged.terminals, 0);
});

test("graph definition diff: sealed incomplete candidates can be inspected before compilation", () => {
  const draft = draftOf(graphs["filter-chain"]);
  draft.terminals = draft.terminals.filter((terminal) => terminal.nodeId !== "filter");
  const candidate = seal(draft);
  assert.throws(() => compileGraph(candidate), /outcome "drop" is uncovered/);
  const diff = graphDefinitionDiff(graphs["filter-chain"], candidate);
  assert.deepEqual(plain(diff.terminals), [{ nodeId: "filter", outcome: "drop", change: "removed" }]);
});

test("graph definition diff: output records are frozen, prototype-free, detached, and serializable", () => {
  const original = structuredClone(graphs.join);
  const candidate = structuredClone(revisionOf(graphs.join));
  const sourceBefore = structuredClone(original);
  const candidateBefore = structuredClone(candidate);
  const diff = graphDefinitionDiff(original, candidate);
  assertFrozenData(diff);
  assert.deepEqual(original, sourceBefore);
  assert.deepEqual(candidate, candidateBefore);
  original.graphId = "mutated";
  candidate.nodes[0].turn.maxAttempts = 10;
  assert.equal(diff.sealed.graphId, "fixture.join");
  assert.throws(() => { diff.nodes[0].fields[0].to = "100"; }, TypeError);
  assert.throws(() => { diff.nodes.push({}); }, TypeError);
});

test("graph definition diff: hostile values and tampered seals fail without invoking capabilities", () => {
  const valid = graphs.join;
  assert.throws(() => graphDefinitionDiff({}, valid), /graph definition/);
  assert.throws(() => graphDefinitionDiff(valid, fixtureGraphs.join), /missing required key.*graphDigest/);
  assert.throws(() => graphDefinitionDiff(valid, { ...valid, description: "Tampered." }), /digest mismatch/);
  let calls = 0;
  const accessor = structuredClone(valid);
  Object.defineProperty(accessor.nodes[0], "configuration", {
    enumerable: true, get() { calls += 1; return {}; }
  });
  const proxy = new Proxy({}, {
    ownKeys() { calls += 1; return []; },
    get() { calls += 1; return undefined; },
    getPrototypeOf() { calls += 1; return null; }
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const nested = structuredClone(valid);
  nested.nodes[0].ref = proxy;
  const sparse = structuredClone(valid);
  delete sparse.nodes[0];
  const cycle = structuredClone(valid);
  cycle.loop = cycle;
  for (const hostile of [accessor, proxy, revoked.proxy, nested, sparse, cycle]) {
    assert.throws(() => graphDefinitionDiff(hostile, valid), /plain|data property|dense array|acyclic/);
    assert.throws(() => graphDefinitionDiff(valid, hostile), /plain|data property|dense array|acyclic/);
  }
  assert.equal(calls, 0);
  let deep = {};
  for (let depth = 0; depth < 25; depth += 1) deep = { child: deep };
  assert.throws(() => graphDefinitionDiff({ ...valid, deep }, valid), /maximum depth/);
});

test("graph definition diff: inherited optional getters cannot become node changes", () => {
  const original = graphs["filter-chain"];
  const originals = new Map();
  let reads = 0;
  try {
    for (const key of ["outputs", "configuration", "binding", "join"]) {
      originals.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
      Object.defineProperty(Object.prototype, key, {
        configurable: true, get() { reads += 1; throw new Error(`inherited ${key}`); }
      });
    }
    assert.equal(graphDefinitionDiff(original, original).empty, true);
    assert.equal(reads, 0);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
});

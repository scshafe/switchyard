import assert from "node:assert/strict";
import test from "node:test";
import { compileGraph, createGraphDefinition, projectGraphDisplay } from "@scshafe/switchyard";
import { buildPipelineDiagram, PIPELINE_PRESENTATION_SCHEMA_VERSION, validatePresentation } from "mission-pipeline-graphpaper";
import { fixtureGraphs } from "./fixtures/switchyard/node-graph-v2-fixtures.mjs";
import {
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_GOAL_MANIFEST,
  SUPPORT_TRIAGE_PRESENTATION
} from "./fixtures/switchyard/support-triage-example.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
function input() {
  return {
    definition: SUPPORT_TRIAGE_GRAPH,
    projection: projectGraphDisplay(compileGraph(SUPPORT_TRIAGE_GRAPH)),
    presentation: { schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION, ...plain(SUPPORT_TRIAGE_PRESENTATION) },
    goalManifest: SUPPORT_TRIAGE_GOAL_MANIFEST
  };
}

function problems(value) {
  return validatePresentation(value.projection, value.presentation, { definition: value.definition, goalManifest: value.goalManifest });
}

test("coverage diagnostics name missing and unknown nodes and prevent building", () => {
  const value = input();
  delete value.presentation.nodes.normalize;
  value.presentation.nodes.unrelated = { name: "Unrelated" };
  const diagnostics = problems(value);
  assert.ok(diagnostics.some((entry) => /normalize/u.test(entry)));
  assert.ok(diagnostics.some((entry) => /unrelated/u.test(entry)));
  assert.equal(Object.isFrozen(diagnostics), true);
  assert.throws(() => buildPipelineDiagram(value), /normalize|unrelated/u);
});

test("unclaimed terminal remains a diagnostic and is drawn once as an explicit fallback", () => {
  const value = input();
  value.presentation.terminals = value.presentation.terminals.filter((entry) => entry.id !== "rejected-input");
  assert.ok(problems(value).some((entry) => /normalize.*malformed/u.test(entry)));
  const model = buildPipelineDiagram(value);
  assert.deepEqual(plain(model.metadata.pipeline.unclaimedTerminals), [{ nodeId: "normalize", outcome: "malformed" }]);
  const fallback = model.nodes.filter((entry) => entry.metadata?.unpresented);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].subtitle, "unpresented terminal");
  assert.equal(model.edges.filter((edge) => edge.from === "normalize" && edge.label === "malformed").length, 1);
});

test("duplicate terminal claims cannot duplicate or invent completion", () => {
  const value = input();
  value.presentation.terminals.push({ id: "duplicate", name: "Duplicate", ends: [{ nodeId: "normalize", outcome: "malformed" }] });
  assert.ok(problems(value).some((entry) => /claimed|duplicate/u.test(entry)));
  assert.throws(() => buildPipelineDiagram(value), /claimed|duplicate/u);
});

test("a presentation cannot claim a nonterminal outcome or a missing node as an exit", () => {
  for (const end of [{ nodeId: "normalize", outcome: "ready" }, { nodeId: "missing", outcome: "done" }]) {
    const value = input();
    value.presentation.endpoints[0].exits.push(end);
    assert.ok(problems(value).some((entry) => new RegExp(end.nodeId, "u").test(entry)));
    assert.throws(() => buildPipelineDiagram(value));
  }
});

test("wait connections require an existing human node", () => {
  for (const nodeId of ["normalize", "missing"]) {
    const value = input();
    value.presentation.endpoints[0].waits = [nodeId];
    assert.ok(problems(value).some((entry) => new RegExp(nodeId, "u").test(entry)));
    assert.throws(() => buildPipelineDiagram(value));
  }
});

test("arrow groups are an exact partition of the sealed merged vocabulary", () => {
  const cases = [
    [],
    [{ outcomes: [] }],
    [{ outcomes: ["invented"] }],
    [{ outcomes: ["summarized"] }],
    [{ outcomes: ["summarized", "unusable"] }, { outcomes: ["summarized"] }]
  ];
  for (const groups of cases) {
    const value = input();
    value.presentation.arrows = { "summarize->dispatch-review": groups };
    assert.throws(() => buildPipelineDiagram(value), /arrow|group|outcome|summarize/u);
  }
  const value = input();
  value.presentation.arrows = { "summarize->dispatch-review": [
    { outcomes: ["summarized"], label: "Model summary", note: "Usable summary." },
    { outcomes: ["unusable"], label: "Fallback summary", note: "Deterministic fallback." }
  ] };
  assert.deepEqual(plain(problems(value)), []);
  const arrows = buildPipelineDiagram(value).edges.filter((entry) => entry.from === "summarize");
  assert.deepEqual(arrows.map((entry) => entry.label), ["Model summary", "Fallback summary"]);
  assert.deepEqual(arrows.map((entry) => entry.description), ["Usable summary.", "Deterministic fallback."]);
});

test("an arrow group cannot attach words to a nonexistent route", () => {
  const value = input();
  value.presentation.arrows = { "normalize->dispatch-review": [{ outcomes: ["ready"] }] };
  assert.ok(problems(value).some((entry) => /normalize->dispatch-review/u.test(entry)));
  assert.throws(() => buildPipelineDiagram(value), /normalize->dispatch-review/u);
});

test("model names must match the exact sealed binding digest", () => {
  const value = input();
  value.presentation.nodes["outage-signal"].model = { name: "A stale model", bindingDigest: "0".repeat(64) };
  assert.ok(problems(value).some((entry) => /binding|model/u.test(entry)));
  assert.throws(() => buildPipelineDiagram(value), /binding|model/u);
  const binding = value.definition.nodes.find((entry) => entry.nodeId === "outage-signal").binding;
  value.presentation.nodes["outage-signal"].model.bindingDigest = binding.bindingDigest;
  assert.deepEqual(plain(problems(value)), []);
  assert.ok(buildPipelineDiagram(value).nodes.find((entry) => entry.id === "outage-signal").rows
    .some((row) => row.label === "model" && row.value === "A stale model"));
});

test("goal words cannot redefine membership or bypass a sealed manifest", () => {
  const value = input();
  value.presentation.goals["outage-escalation"].members = ["normalize"];
  assert.ok(problems(value).some((entry) => /goal|member/u.test(entry)));
  assert.throws(() => buildPipelineDiagram(value), /goal|member/u);
  const missing = input();
  delete missing.goalManifest;
  assert.throws(() => buildPipelineDiagram(missing), /goal|manifest/u);
  const missingDefinition = input();
  delete missingDefinition.definition;
  assert.throws(() => buildPipelineDiagram(missingDefinition), /definition|manifest/u);
});

test("source verification refuses a projection altered under the same digest", () => {
  const value = input();
  value.projection = plain(value.projection);
  value.projection.nodes[0].depth += 1;
  assert.throws(() => buildPipelineDiagram(value), /projection|definition|source|match/u);
});

test("source verification refuses stale definitions and a tampered graph seal", () => {
  const value = input();
  const { graphDigest, ...draft } = plain(value.definition);
  value.definition = createGraphDefinition({ ...draft, version: draft.version + 1 });
  assert.throws(() => buildPipelineDiagram(value), /projection|definition|identity|match|graph/u);
  const tampered = input();
  tampered.definition = { ...tampered.definition, graphDigest: "0".repeat(64) };
  assert.throws(() => buildPipelineDiagram(tampered), /digest|seal|graph/u);
});

test("unknown schemas and future runtime modes fail instead of silently drawing static state", () => {
  for (const schemaVersion of ["mission-pipeline-presentation.v2", "", null]) {
    const value = input();
    value.presentation.schemaVersion = schemaVersion;
    assert.throws(() => buildPipelineDiagram(value), /schema/u);
  }
  const projection = input();
  projection.projection = { ...projection.projection, schemaVersion: "mission-pipeline-graph-display.v2" };
  assert.throws(() => buildPipelineDiagram(projection), /schema/u);
  for (const unsupported of ["overlay", "metrics"]) {
    assert.throws(() => buildPipelineDiagram({ ...input(), [unsupported]: {} }), /key|field|unsupported|overlay|metrics/u);
  }
});

test("accessors and toJSON callbacks are rejected without execution", () => {
  let calls = 0;
  const getter = input();
  Object.defineProperty(getter.presentation.nodes.normalize, "summary", { enumerable: true, get() { calls += 1; return "unsafe"; } });
  assert.throws(() => buildPipelineDiagram(getter), /accessor|getter|data|descriptor/u);
  const callback = input();
  callback.presentation.toJSON = () => { calls += 1; return {}; };
  assert.throws(() => buildPipelineDiagram(callback), /function|key|data|JSON|toJSON/u);
  const projection = input();
  Object.defineProperty(projection, "projection", { get() { calls += 1; return {}; } });
  assert.throws(() => buildPipelineDiagram(projection), /accessor|getter|data|descriptor/u);
  assert.equal(calls, 0);
});

test("hostile non-JSON presentation data, cycles, and sparse arrays are rejected", () => {
  for (const hostile of [new Date(), NaN, Infinity, 1n, () => "code"]) {
    const value = input();
    value.presentation.nodes.normalize.summary = hostile;
    assert.throws(() => buildPipelineDiagram(value));
  }
  const cyclic = input();
  cyclic.presentation.nodes.normalize.rows = [{ label: "cycle", value: cyclic.presentation }];
  assert.throws(() => buildPipelineDiagram(cyclic), /cycl|depth|data|string/u);
  const sparse = input();
  sparse.presentation.endpoints = new Array(1);
  assert.throws(() => buildPipelineDiagram(sparse), /sparse|array|index|data/u);
});

test("projection references cannot route an arrow to a node absent from the projection", () => {
  const value = input();
  value.projection = plain(value.projection);
  value.projection.arrows[0].to = "missing";
  delete value.definition;
  delete value.goalManifest;
  delete value.presentation.goals;
  assert.throws(() => buildPipelineDiagram(value), /missing|arrow|target|node/u);
});

test("Proxies, revoked Proxies, symbols, and non-enumerable fields are refused without traps", () => {
  let traps = 0;
  const trap = () => { traps += 1; throw new Error("must not execute"); };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const hostile of [proxy, revoked.proxy]) {
    assert.throws(() => buildPipelineDiagram(hostile));
    const value = input();
    value.presentation.nodes.normalize = hostile;
    assert.throws(() => buildPipelineDiagram(value));
    assert.throws(() => validatePresentation(value.projection, value.presentation, hostile));
  }
  const symbol = input();
  symbol.presentation[Symbol("extra")] = true;
  assert.throws(() => buildPipelineDiagram(symbol), /symbol/u);
  const hidden = input();
  Object.defineProperty(hidden.presentation, "hidden", { value: true });
  assert.throws(() => buildPipelineDiagram(hidden), /enumerable/u);
  assert.equal(traps, 0);
});

test("inherited optional presentation fields cannot fabricate text or execute getters", () => {
  const value = input();
  let calls = 0;
  const keys = ["model", "rows", "waits", "description", "historical", "arrows"];
  for (const key of keys) Object.defineProperty(Object.prototype, key, {
    configurable: true, get() { calls += 1; throw new Error(`inherited ${key}`); }
  });
  try {
    const model = buildPipelineDiagram(value);
    assert.equal(calls, 0);
    assert.equal(Object.hasOwn(model, "lifecycle"), false);
  } finally {
    for (const key of keys) delete Object.prototype[key];
  }
});

test("admission bounds reject deep, huge, and oversized-text carriers", () => {
  const deep = input();
  let nested = {};
  for (let index = 0; index < 30; index += 1) nested = { nested };
  deep.presentation.extra = nested;
  assert.throws(() => buildPipelineDiagram(deep), /depth/u);
  const huge = input();
  huge.presentation.endpoints = new Array(1_000_001);
  assert.throws(() => buildPipelineDiagram(huge), /budget/u);
  const long = input();
  long.presentation.nodes.normalize.name = "x".repeat(8_193);
  assert.throws(() => buildPipelineDiagram(long), /bounded text/u);
});

test("duplicate sink IDs and ambiguous exit/wait connections prevent building", () => {
  const duplicate = input();
  duplicate.presentation.endpoints.push({ ...duplicate.presentation.endpoints[0], exits: [] });
  assert.throws(() => buildPipelineDiagram(duplicate), /duplicate endpoint ID/u);
  const ambiguous = input();
  const endpoint = ambiguous.presentation.endpoints.find((entry) => entry.exits.length > 0);
  endpoint.waits = [endpoint.exits[0].nodeId];
  assert.throws(() => buildPipelineDiagram(ambiguous), /both an exit and a wait/u);
});

test("copied projections cannot invent fan-out or contradict contributing edge identities", () => {
  const original = plain(projectGraphDisplay(compileGraph(createGraphDefinition(fixtureGraphs.join))));
  const check = (projection) => validatePresentation(projection, {
    schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION, title: "A join",
    nodes: Object.fromEntries(projection.nodes.map((node) => [node.nodeId, { name: node.nodeId }])),
    endpoints: [], terminals: []
  });
  const fan = original.arrows.find((arrow) => arrow.fanOut.length > 0);
  assert.ok(fan);
  const mutations = [
    (projection) => { projection.arrows.find((arrow) => arrow.fanOut.length > 0).fanOut = []; },
    (projection) => {
      const arrow = projection.arrows.find((arrow) => arrow.fanOut.length > 0);
      arrow.fanOut[0].coTargets = [arrow.from];
    },
    (projection) => { delete projection.arrows.find((arrow) => arrow.fanOut.length > 0).fanOut[0].outcomes; },
    (projection) => {
      const lone = projection.arrows.find((arrow) => arrow.fanOut.length === 0);
      const target = projection.nodes.find((node) => node.nodeId !== lone.to).nodeId;
      lone.fanOut.push({ edgeId: lone.edgeIds[0], coTargets: [target], outcomes: [...lone.outcomes] });
    }
  ];
  for (const mutate of mutations) {
    const projection = plain(original);
    mutate(projection);
    assert.throws(() => check(projection), /fan-out/u);
  }
  const reused = plain(original);
  const lone = reused.arrows.find((arrow) => arrow.fanOut.length === 0);
  lone.edgeIds.push(fan.edgeIds[0]);
  assert.throws(() => check(reused), /inconsistent sources/u);
});

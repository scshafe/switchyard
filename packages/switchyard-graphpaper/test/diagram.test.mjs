import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileGraph, createGraphDefinition, projectGraphDisplay } from "@scshafe/switchyard";
import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import {
  buildPipelineDiagram,
  pipelineLegend,
  PIPELINE_RENDER_OPTIONS,
  PIPELINE_PRESENTATION_SCHEMA_VERSION,
  validatePresentation
} from "switchyard-graphpaper";
import { fixtureGraphs, node } from "./fixtures/switchyard/node-graph-v2-fixtures.mjs";
import {
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_GOAL_MANIFEST,
  SUPPORT_TRIAGE_PRESENTATION
} from "./fixtures/switchyard/support-triage-example.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const fixtureText = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fixture = (name) => JSON.parse(fixtureText(name));
const source = fixture("inbox-graph8.source.json");
const supportPresentation = () => ({ schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION, ...plain(SUPPORT_TRIAGE_PRESENTATION) });
const supportInput = () => ({
  projection: projectGraphDisplay(compileGraph(SUPPORT_TRIAGE_GRAPH)),
  presentation: supportPresentation(),
  definition: SUPPORT_TRIAGE_GRAPH,
  goalManifest: SUPPORT_TRIAGE_GOAL_MANIFEST
});

function inboxPresentation() {
  const raw = source.presentation;
  return {
    schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION,
    id: "inbox-email-pipeline",
    title: raw.diagramTitle,
    subtitle: raw.subtitle,
    unitNoun: "email",
    nodes: Object.fromEntries(Object.entries(raw.nodePresentation).map(([nodeId, words]) => [nodeId, {
      name: words.name,
      summary: words.summary,
      ...(words.rows === undefined ? {} : { rows: words.rows }),
      ...(source.models[nodeId] === undefined ? {} : { model: source.models[nodeId] })
    }])),
    arrows: raw.arrowPresentation,
    endpoints: raw.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      system: endpoint.system,
      summary: endpoint.summary,
      kind: endpoint.kind,
      via: endpoint.via,
      outboxEventTypes: endpoint.outboxEventTypes,
      exits: raw.endpointExits.filter((exit) => exit.endpointId === endpoint.id)
        .map(({ nodeId, outcome }) => ({ nodeId, outcome })),
      waits: endpoint.fromNodeIds.filter((nodeId) =>
        !raw.endpointExits.some((exit) => exit.nodeId === nodeId && exit.endpointId === endpoint.id))
    })),
    terminals: raw.terminals
  };
}

function genericPresentation(definition) {
  return {
    schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION,
    title: "Fixture workflow",
    nodes: Object.fromEntries(definition.nodes.map((entry) => [entry.nodeId, { name: entry.nodeId }])),
    endpoints: [],
    terminals: definition.terminals.map((end, index) => ({ id: `end-${index}`, name: end.outcome, ends: [end] }))
  };
}

function buildDraft(draft, presentation) {
  const definition = createGraphDefinition(draft);
  return buildPipelineDiagram({
    definition,
    projection: projectGraphDisplay(compileGraph(definition)),
    presentation: presentation ?? genericPresentation(definition)
  });
}

function assertFrozenData(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), null);
  for (const child of Object.values(value)) assertFrozenData(child);
}

test("Inbox static golden preserves the independent existing builder modulo metadata.pipeline", () => {
  const presentation = inboxPresentation();
  const projection = projectGraphDisplay(compileGraph(source.definition));
  assert.deepEqual(plain(validatePresentation(projection, presentation, { definition: source.definition })), []);
  const model = plain(buildPipelineDiagram({ projection, presentation, definition: source.definition }));
  const pipeline = model.metadata.pipeline;
  delete model.metadata.pipeline;
  assert.equal(JSON.stringify(model, null, 2) + "\n", fixtureText("inbox-graph8.static.golden.json"));
  assert.deepEqual(pipeline.graph, { id: source.definition.graphId, version: 8, digest: source.definition.graphDigest });
  assert.equal(pipeline.mode, "static");
  assert.equal(pipeline.schemaVersion, "switchyard-diagram.v1");
});

test("Inbox witness hashes and model labels remain tied to the retained exact graph", () => {
  const provenance = fixture("inbox-graph8.provenance.json");
  for (const [name, recorded] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(fixtureText(name)).digest("hex"), recorded.sha256);
  }
  assert.equal(source.definition.graphDigest, provenance.graph.digest);
  assert.equal(Object.keys(source.models).length, 5);
  for (const [nodeId, model] of Object.entries(source.models)) {
    assert.equal(model.bindingDigest, source.definition.nodes.find((entry) => entry.nodeId === nodeId).binding.bindingDigest);
  }
  assert.equal(Object.hasOwn(source, "prompts"), false);
  assert.equal(Object.hasOwn(source, "implementations"), false);
});

test("support-triage static golden is independent of Inbox presentation and runtime policy", () => {
  const input = supportInput();
  assert.deepEqual(plain(validatePresentation(input.projection, input.presentation, {
    definition: input.definition, goalManifest: input.goalManifest
  })), []);
  const model = buildPipelineDiagram(input);
  assert.equal(JSON.stringify(model, null, 2) + "\n", fixtureText("support-triage.static.golden.json"));
  assert.equal(model.nodes.length, SUPPORT_TRIAGE_GRAPH.nodes.length + 3);
  assert.deepEqual(plain(model.metadata.pipeline.unclaimedTerminals), []);
  for (const definition of SUPPORT_TRIAGE_GRAPH.nodes) {
    const shown = model.nodes.find((entry) => entry.id === definition.nodeId);
    assert.equal(shown.type, definition.kind);
    assert.equal(shown.status, undefined);
    if (definition.binding) assert.ok(shown.rows.some((row) => row.label === "binding"));
  }
  assert.match(model.description, /takes a unit down it/u);
  assert.equal(model.metadata.pipeline.graph.digest, SUPPORT_TRIAGE_GRAPH.graphDigest);
});

test("models are detached, frozen, prototype-free, deterministic JSON data", () => {
  const input = supportInput();
  const model = buildPipelineDiagram(input);
  const before = JSON.stringify(model);
  assertFrozenData(model);
  assert.equal(JSON.stringify(buildPipelineDiagram(input)), before);
  assert.deepEqual(plain(model), plain(buildPipelineDiagram({ ...input, projection: plain(input.projection) })));
  input.presentation.nodes.normalize.name = "A different name";
  assert.equal(JSON.stringify(model), before);
  assert.throws(() => { model.nodes[0].title = "mutated"; }, TypeError);
  assert.throws(() => { model.edges.push({ from: "x", to: "y" }); }, TypeError);
});

test("presentation changes its digest without changing the sealed graph identity", () => {
  const input = supportInput();
  const before = buildPipelineDiagram(input);
  assert.equal(before.metadata.pipeline.presentationDigest,
    createHash("sha256").update(canonicalJson(input.presentation)).digest("hex"));
  input.presentation.nodes.normalize.name = "Ticket preparation";
  const after = buildPipelineDiagram(input);
  assert.notEqual(before.metadata.pipeline.presentationDigest, after.metadata.pipeline.presentationDigest);
  assert.deepEqual(before.metadata.pipeline.graph, after.metadata.pipeline.graph);
  assert.equal(after.nodes.find((entry) => entry.id === "normalize").title, "Ticket preparation (1)");
});

test("historical lifecycle is explicit and keeps the frozen model identity", () => {
  const input = supportInput();
  const current = buildPipelineDiagram(input);
  const historical = buildPipelineDiagram({ ...input, historical: true });
  assert.equal(current.lifecycle, undefined);
  assert.deepEqual(plain(historical.lifecycle), { state: "historical", label: "Historical" });
  assert.deepEqual(historical.metadata.pipeline.graph, current.metadata.pipeline.graph);
  const withoutLifecycle = plain(historical);
  delete withoutLifecycle.lifecycle;
  assert.deepEqual(withoutLifecycle, plain(current));
});

test("static endpoints and explicitly presented human waits claim no execution or delivery state", () => {
  const input = supportInput();
  input.presentation.endpoints.push({ id: "review-console", name: "Review console", exits: [], waits: ["dispatch-review", "triage-review"] });
  const model = buildPipelineDiagram(input);
  assert.equal(model.edges.filter((edge) => edge.to === "endpoint:review-console").length, 2);
  for (const entry of model.nodes) assert.equal(entry.status, undefined);
  for (const edge of model.edges) assert.equal(edge.metadata?.flow, undefined);
  assert.equal(model.nodes.find((entry) => entry.id === "endpoint:on-call").subtitle, undefined);
});

for (const [name, draft] of Object.entries(fixtureGraphs)) {
  test(`catalog topology remains drawn: ${name}`, () => {
    const definition = createGraphDefinition(draft);
    const model = buildDraft(draft);
    for (const entry of definition.nodes) {
      assert.equal(model.nodes.find((shown) => shown.id === entry.nodeId)?.type, entry.kind);
    }
    for (const edge of definition.edges) {
      for (const to of edge.to) assert.ok(model.edges.some((shown) => shown.from === edge.from && shown.to === to));
    }
    for (const terminal of definition.terminals) {
      assert.equal(model.edges.filter((edge) => edge.type === "exit" && edge.from === terminal.nodeId && edge.label === terminal.outcome).length, 1);
    }
    assert.deepEqual(plain(model.metadata.pipeline.unclaimedTerminals), []);
  });
}

test("joins draw their exact threshold and inbound kind without implying readiness", () => {
  const draft = plain(fixtureGraphs.join);
  const joined = draft.nodes.find((entry) => entry.join);
  joined.join.require = { nOf: 1 };
  const model = buildDraft(draft);
  assert.equal(model.nodes.find((entry) => entry.id === joined.nodeId).badges[0].label, "join · 1 of 2");
  const inbound = model.edges.filter((edge) => edge.to === joined.nodeId);
  assert.equal(inbound.length, 2);
  assert.ok(inbound.every((edge) => edge.type === "join"));
  assert.equal(model.nodes.find((entry) => entry.id === joined.nodeId).status, undefined);
});

test("conditional arrows never assert always and preserve their routing qualification", () => {
  const draft = {
    graphId: "sdk.conditional", version: 1, description: "Conditional fork.", entry: "start",
    nodes: [node("start", ["go"]), node("done", ["done"]), node("fallback", ["done"])],
    edges: [
      { edgeId: "go", from: "start", when: { outcome: "go", where: [{ pointer: "/payload/ready", equals: true }] }, to: ["done"] },
      { edgeId: "fallback", from: "start", when: { outcome: "go" }, to: ["fallback"] }
    ],
    terminals: [{ nodeId: "done", outcome: "done" }, { nodeId: "fallback", outcome: "done" }]
  };
  const model = buildDraft(draft);
  const edge = model.edges.find((entry) => entry.to === "done");
  assert.notEqual(edge.label, "always");
  assert.match(edge.description, /conditional/u);
  assert.equal(model.nodes[0].metadata.marks, undefined);
});

test("fan-out prose uses exact contributing outcomes and older projections keep missing lineage explicit", () => {
  const definition = createGraphDefinition({
    graphId: "sdk.fanout", version: 1, description: "Merged arrows do not imply shared outcome lineage.", entry: "start",
    nodes: [node("start", ["yes", "no"]), node("left", ["done"]), node("right", ["done"])],
    edges: [
      { edgeId: "both", from: "start", when: { outcome: "yes" }, to: ["left", "right"] },
      { edgeId: "left-only", from: "start", when: { outcome: "no" }, to: ["left"] },
      { edgeId: "right-only", from: "start", when: { outcome: "no" }, to: ["right"] }
    ],
    terminals: [{ nodeId: "left", outcome: "done" }, { nodeId: "right", outcome: "done" }]
  });
  const projection = projectGraphDisplay(compileGraph(definition));
  const presentation = genericPresentation(definition);
  const modern = buildPipelineDiagram({ projection, presentation, definition });
  for (const edge of modern.edges.filter((entry) => entry.from === "start")) {
    assert.match(edge.description, /on yes the same unit also goes to/u);
  }
  const older = plain(projection);
  for (const arrow of older.arrows) for (const fork of arrow.fanOut) delete fork.outcomes;
  const model = buildPipelineDiagram({ projection: older, presentation });
  for (const edge of model.edges.filter((entry) => entry.from === "start")) {
    assert.match(edge.description, /contributing edge both also targets/u);
    assert.doesNotMatch(edge.description, /on yes/u);
  }
});

test("all five engine node kinds survive presentation without consumer role guesses", () => {
  const kinds = ["code", "model", "agent", "human", "callback"];
  const model = buildDraft({
    graphId: "sdk.kinds", version: 1, description: "Every engine kind is drawn directly.", entry: "code",
    nodes: kinds.map((kind) => node(kind, ["done"], {
      kind,
      ...(kind === "model" ? { binding: source.definition.nodes.find((entry) => entry.kind === "model").binding } : {})
    })),
    edges: kinds.slice(0, -1).map((kind, index) => ({ edgeId: `after-${kind}`, from: kind, when: { outcome: "done" }, to: [kinds[index + 1]] })),
    terminals: [{ nodeId: "callback", outcome: "done" }]
  });
  assert.deepEqual(model.nodes.slice(0, 5).map((entry) => entry.type), kinds);
});

test("small marking vocabularies split visibly while every declared outcome remains represented", () => {
  const model = buildDraft({
    graphId: "sdk.mark", version: 1, description: "Marks rejoin the same path.", entry: "mark",
    nodes: [node("mark", ["yes", "no"]), node("done", ["done"])],
    edges: [{ edgeId: "same-target", from: "mark", when: { anyOf: ["yes", "no"] }, to: ["done"] }],
    terminals: [{ nodeId: "done", outcome: "done" }]
  });
  assert.equal(model.nodes[0].rows[0].label, "marks");
  assert.deepEqual(model.edges.filter((edge) => edge.to === "done").map((edge) => edge.label), ["yes", "no"]);
  assert.ok(model.edges.filter((edge) => edge.to === "done").every((edge) => /unit record/u.test(edge.description)));
});

test("sink and edge IDs cannot alias authored graph nodes or multiple terminal outcomes", () => {
  const draft = {
    graphId: "sdk.ids", version: 1, description: "Synthetic IDs remain distinct.", entry: "terminal:shared",
    nodes: [node("terminal:shared", ["yes", "no"])], edges: [],
    terminals: [{ nodeId: "terminal:shared", outcome: "yes" }, { nodeId: "terminal:shared", outcome: "no" }]
  };
  const presentation = { ...genericPresentation(draft), terminals: [{ id: "shared", name: "Same sink", ends: draft.terminals }] };
  const model = buildDraft(draft, presentation);
  assert.equal(new Set(model.nodes.map((entry) => entry.id)).size, model.nodes.length);
  assert.equal(new Set(model.edges.map((edge) => edge.id)).size, model.edges.length);
  assert.ok(model.edges.every((edge) => edge.from !== edge.to));
});

test("static legend and render options are immutable graphpaper data; later modes are refused", () => {
  assertFrozenData(pipelineLegend());
  assertFrozenData(PIPELINE_RENDER_OPTIONS);
  for (const type of ["code", "model", "human", "agent", "callback", "endpoint", "terminal"]) {
    assert.ok(pipelineLegend().some((entry) => entry.type === type));
  }
  assert.equal(PIPELINE_RENDER_OPTIONS.direction, "DOWN");
  assert.equal(PIPELINE_RENDER_OPTIONS.edgeLabelPlacement, "tail");
  for (const mode of ["run", "metrics", "proposal"]) assert.throws(() => pipelineLegend(mode), /static/u);
});

test("wide fan-out accepts projections larger than the engine definition snapshot budget", () => {
  const targets = Array.from({ length: 64 }, (_, index) => `target-${index}`);
  const model = buildDraft({
    graphId: "sdk.wide", version: 1, description: "Bounded expansion stays usable.", entry: "start",
    nodes: [node("start", ["yes", "no"]), ...targets.map((target) => node(target, ["done"]))],
    edges: Array.from({ length: 16 }, (_, index) => ({ edgeId: `fan-${index}`, from: "start", when: { anyOf: ["yes", "no"] }, to: targets })),
    terminals: targets.map((nodeId) => ({ nodeId, outcome: "done" }))
  });
  assert.equal(model.edges.filter((edge) => edge.from === "start").length, 64);
  assert.equal(model.nodes.length, 129);
  assertFrozenData(model);
});

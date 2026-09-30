import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Exercise the validator shipped beside the public browser entry, including in
// the offline installed-package gate. This is a private test seam, not an API.
const { captureViewerRecord, snapshotViewerData, validateStaticModel, validateNodeDetails } = await import(
  new URL("./viewer-data.js", import.meta.resolve("switchyard-graphpaper/browser"))
);

const fixture = () => JSON.parse(readFileSync(new URL("./fixtures/support-triage.static.golden.json", import.meta.url), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const identity = fixture().metadata.pipeline.graph;
const details = () => ({
  graph: { ...identity },
  nodeId: "outage-signal",
  sealed: {
    ref: { id: "triage.outage-signal", version: 1 },
    kind: "model",
    input: "support-ticket.v1",
    outcomes: ["yes", "no", "uncertain"],
    maxAttempts: 2,
    leaseMs: 60_000,
    binding: { kind: "model", bindingId: "triage.outage-signal", version: 1, bindingDigest: "a".repeat(64) }
  },
  outputs: [{ outcome: "yes", contractId: "outage-signal.v1" }],
  model: {
    name: "Example model", id: "example.model", version: 1, providerId: "example.provider",
    parameters: { temperature: 0, responseFormat: "json" },
    prompt: { digest: "b".repeat(64), systemPrompt: "Evaluate supplied ticket evidence. <markup> remains text." }
  },
  implementation: {
    body: { module: "example/node.js", symbol: "evaluate" },
    port: { module: "example/port.js", symbol: "invoke" },
    dispatch: "outage-signal"
  },
  question: "Does the ticket establish an outage?"
});
const checkDetails = (value) => validateNodeDetails(value, identity, "outage-signal");

function assertFrozenData(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), null);
  for (const child of Object.values(value)) assertFrozenData(child);
}

test("viewer data validates the complete static golden from objects and JSON and detaches it", () => {
  const source = fixture();
  const original = plain(source);
  const result = validateStaticModel(source);
  assert.deepEqual(plain(result), original);
  assert.deepEqual(plain(validateStaticModel(JSON.stringify(source))), original);
  assertFrozenData(result);
  source.nodes[0].title = "Changed after validation";
  source.metadata.pipeline.graph.digest = "f".repeat(64);
  assert.equal(result.nodes[0].title, original.nodes[0].title);
  assert.equal(result.metadata.pipeline.graph.digest, original.metadata.pipeline.graph.digest);
  assert.throws(() => { result.nodes[0].title = "mutation"; }, TypeError);
});

test("viewer data refuses renderer state and nested extensions outside the static schema", () => {
  const mutations = [
    ["model stages", (value) => { value.stages = ["one", "two"]; }],
    ["metadata stages", (value) => { value.metadata.stages = ["one", "two"]; }],
    ["metadata scope", (value) => { value.metadata.scopeOf = "normalize"; }],
    ["metadata lifecycle", (value) => { value.metadata.lifecycle = "active"; }],
    ["node status", (value) => { value.nodes[0].status = "settled"; }],
    ["node scope", (value) => { value.nodes[0].scope = {}; }],
    ["node details", (value) => { value.nodes[0].details = { title: "Hidden payload" }; }],
    ["node metadata stage", (value) => { value.nodes[0].metadata.stage = 2; }],
    ["node metadata scope", (value) => { value.nodes[0].metadata.scopeRef = "hidden"; }],
    ["node metadata visual state", (value) => { value.nodes[0].metadata.visualGroup = "unobserved"; }],
    ["edge flow", (value) => { value.edges[0].metadata = { flow: true }; }],
    ["edge stages", (value) => { value.edges[0].stages = [2]; }],
    ["row detail", (value) => { value.nodes[0].rows[0].description = "Not a static row field"; }],
    ["pipeline extra", (value) => { value.metadata.pipeline.unitId = "unit-1"; }],
    ["graph extra", (value) => { value.metadata.pipeline.graph.title = "Not identity"; }],
    ["endpoint extra", (value) => { value.nodes.find((node) => node.type === "endpoint").metadata.reached = true; }],
    ["terminal extra", (value) => { value.nodes.find((node) => node.type === "terminal").metadata.status = "settled"; }]
  ];
  for (const [label, mutate] of mutations) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateStaticModel(value), /unknown key/u, label);
  }
});

test("viewer data requires the exact static schema and consistent graph aliases", () => {
  for (const mode of ["run", "metrics", "proposal", "static.v2"]) {
    const value = fixture();
    value.metadata.pipeline.mode = mode;
    assert.throws(() => validateStaticModel(value), /pipeline.mode/u);
  }
  const future = fixture();
  future.metadata.pipeline.schemaVersion = "switchyard-diagram.v2";
  assert.throws(() => validateStaticModel(future), /pipeline.schemaVersion/u);
  for (const [key, replacement] of [["graphId", "different"], ["graphVersion", 2], ["graphDigest", "f".repeat(64)], ["highlighted", true]]) {
    const value = fixture();
    value.metadata[key] = replacement;
    assert.throws(() => validateStaticModel(value), /contradicts static graph identity/u, key);
  }
  const unsupported = fixture();
  unsupported.metadata.publication = "inferred";
  assert.throws(() => validateStaticModel(unsupported), /publication/u);
});

test("viewer data rejects duplicate IDs, missing endpoints, and contradictory node metadata", () => {
  const duplicateNode = fixture();
  duplicateNode.nodes.push(plain(duplicateNode.nodes[0]));
  assert.throws(() => validateStaticModel(duplicateNode), /node IDs must be unique/u);
  const duplicateEdge = fixture();
  duplicateEdge.edges.push(plain(duplicateEdge.edges[0]));
  assert.throws(() => validateStaticModel(duplicateEdge), /edge IDs must be unique/u);
  for (const key of ["from", "to"]) {
    const missing = fixture();
    missing.edges[0][key] = "missing";
    assert.throws(() => validateStaticModel(missing), /missing node/u);
  }
  for (const [key, replacement] of [["nodeId", "different"], ["role", "model"], ["kind", "human"]]) {
    const value = fixture();
    value.nodes[0].metadata[key] = replacement;
    assert.throws(() => validateStaticModel(value), /contradicts its identity/u, key);
  }
});

test("viewer data accepts generated display IDs and text longer than one presentation field", () => {
  const value = fixture();
  const long = "Generated text ".repeat(800);
  assert.ok(long.length > 8_192);
  value.title = long;
  value.nodes[0].title = long;
  value.nodes[0].rows[0].value = long;
  value.edges[0].description = long;
  value.edges[0].id = `${value.edges[0].from}->${value.edges[0].to}~2`;
  const result = validateStaticModel(value);
  assert.equal(result.nodes[0].title, long);
  assert.equal(result.edges[0].id, value.edges[0].id);
  value.lifecycle = { state: "historical", label: "Historical" };
  assert.equal(validateStaticModel(value).lifecycle.state, "historical");
  value.lifecycle.state = "current";
  assert.throws(() => validateStaticModel(value), /lifecycle.state/u);
});

test("viewer data keeps structured and legacy unclaimed terminal metadata consistent", () => {
  const value = fixture();
  value.metadata.pipeline.unclaimedTerminals = [{ nodeId: "normalize", outcome: "malformed" }];
  value.metadata.unclaimedTerminals = ["normalize:malformed"];
  assert.doesNotThrow(() => validateStaticModel(value));
  value.metadata.unclaimedTerminals = ["normalize:ready"];
  assert.throws(() => validateStaticModel(value), /unclaimed terminal metadata disagrees/u);
});

test("viewer snapshot rejects accessors and executable values without invoking them", () => {
  let calls = 0;
  const getter = () => { calls += 1; return "should not run"; };
  const model = fixture();
  Object.defineProperty(model, "title", { enumerable: true, get: getter });
  assert.throws(() => validateStaticModel(model), /enumerable data properties/u);
  const array = ["safe"];
  Object.defineProperty(array, "0", { enumerable: true, get: getter });
  assert.throws(() => snapshotViewerData(array), /enumerable data array entries/u);
  const capability = Object.defineProperty({}, "details", { enumerable: true, get: getter });
  assert.throws(() => captureViewerRecord(capability, ["details"], [], "options"), /enumerable data property/u);
  const serializable = fixture();
  serializable.toJSON = () => { calls += 1; return {}; };
  assert.throws(() => validateStaticModel(serializable), /plain JSON data/u);
  assert.equal(calls, 0);
});

test("viewer snapshot refuses symbols, hidden fields, non-JSON leaves, cycles, and sparse arrays", () => {
  const cycle = {}; cycle.self = cycle;
  const hidden = Object.defineProperty({}, "private", { value: "hidden" });
  const extendedArray = Object.assign([1], { extra: "unexpected" });
  for (const value of [
    { [Symbol("hidden")]: true }, hidden, { leaf: Symbol("value") }, { leaf: undefined },
    { leaf: () => {} }, { leaf: 1n }, { leaf: NaN }, { leaf: Infinity }, cycle,
    new Date(0), new Map(), [, "sparse"], extendedArray
  ]) assert.throws(() => snapshotViewerData(value), /symbol|enumerable|plain JSON|dense arrays/u);
  assert.equal(snapshotViewerData({ value: -0 }).value, 0);
  assert.equal(Object.is(snapshotViewerData({ value: -0 }).value, -0), false);
});

test("viewer snapshot and JSON admission enforce depth, array, and text budgets", () => {
  let nested = "leaf";
  for (let index = 0; index < 26; index += 1) nested = { child: nested };
  assert.throws(() => snapshotViewerData(nested), /value\/depth budget/u);
  assert.throws(() => snapshotViewerData(new Array(1_000_001)), /array budget/u);
  const excessive = "x".repeat(33_554_433);
  assert.throws(() => snapshotViewerData({ value: excessive }), /string budget/u);
  assert.throws(() => validateStaticModel(excessive), /JSON exceeds the text budget/u);
  assert.throws(() => validateStaticModel("{invalid JSON"), SyntaxError);
});

test("viewer snapshot treats constructor and __proto__ as own JSON data", () => {
  const parsed = JSON.parse('{"constructor":"ordinary","__proto__":{"polluted":true}}');
  const result = snapshotViewerData(parsed);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(result.constructor, "ordinary");
  assert.equal(result.__proto__.polluted, true);
  assert.equal(Object.getPrototypeOf(result.__proto__), null);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assertFrozenData(result);
  const model = fixture();
  const previous = model.nodes[0].id;
  model.nodes[0].id = "constructor";
  model.nodes[0].metadata.nodeId = "constructor";
  for (const edge of model.edges) for (const key of ["from", "to"]) if (edge[key] === previous) edge[key] = "constructor";
  assert.equal(validateStaticModel(JSON.stringify(model)).nodes[0].id, "constructor");
});

test("node details validate displayed and withheld prompts as detached immutable data", () => {
  const source = details();
  const result = checkDetails(source);
  assert.deepEqual(plain(result), source);
  assertFrozenData(result);
  source.model.prompt.systemPrompt = "Changed after validation";
  source.outputs[0].contractId = "changed.v1";
  assert.equal(result.model.prompt.systemPrompt, details().model.prompt.systemPrompt);
  assert.equal(result.outputs[0].contractId, "outage-signal.v1");
  const withheld = details();
  withheld.model.prompt = { withheld: "This version has no retained prompt." };
  assert.deepEqual(plain(checkDetails(JSON.stringify(withheld))), withheld);
  const code = details();
  code.sealed.kind = "code";
  delete code.sealed.binding;
  delete code.model;
  assert.equal(checkDetails(code).sealed.kind, "code");
});

test("node details refuse every graph identity mismatch and a different selected node", () => {
  for (const [key, replacement] of [["id", "other.graph"], ["version", 2], ["digest", "f".repeat(64)]]) {
    const value = details();
    value.graph[key] = replacement;
    assert.throws(() => checkDetails(JSON.stringify(value)), /identity mismatch/u, key);
  }
  const other = details(); other.nodeId = "outage-verify";
  assert.throws(() => checkDetails(other), /identity mismatch/u);
  assert.throws(() => validateNodeDetails(details(), identity, "endpoint:dispatch"), /identity mismatch/u);
});

test("node details reject prompt unions, raw artifacts, and unrecognized nested data", () => {
  for (const prompt of [
    {}, { digest: "b".repeat(64) }, { systemPrompt: "Missing digest" },
    { digest: "b".repeat(64), systemPrompt: "Visible", withheld: "Hidden" },
    { withheld: "Hidden", extra: true }, { digest: "invalid", systemPrompt: "Text" }
  ]) {
    const value = details(); value.model.prompt = prompt;
    assert.throws(() => checkDetails(value), /prompt|unknown key/u);
  }
  for (const mutate of [
    (value) => { value.artifact = { payload: "raw ticket" }; },
    (value) => { value.sealed.principal = { id: "host.secret" }; },
    (value) => { value.model.receipt = { tokens: 1 }; },
    (value) => { value.implementation.body.source = "executable"; },
    (value) => { value.outputs[0].payload = "raw ticket"; }
  ]) {
    const value = details(); mutate(value);
    assert.throws(() => checkDetails(value), /unknown key/u);
  }
});

test("node details enforce sealed kind, contracts, bounded attempts, binding, and vocabularies", () => {
  const mutations = [
    (value) => { value.sealed.kind = "worker"; },
    (value) => { value.sealed.input = "not-a-contract"; },
    (value) => { value.sealed.maxAttempts = 11; },
    (value) => { value.sealed.leaseMs = 86_400_001; },
    (value) => { value.sealed.ref.version = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.sealed.outcomes = []; },
    (value) => { value.sealed.outcomes = ["yes", "yes"]; },
    (value) => { delete value.sealed.binding; },
    (value) => { value.sealed.kind = "code"; },
    (value) => { value.sealed.binding.bindingDigest = "A".repeat(64); }
  ];
  for (const mutate of mutations) {
    const value = details(); mutate(value);
    assert.throws(() => checkDetails(value), /unsupported|contract ID|integer|nonempty|unique|binding|digest/u);
  }
});

test("node details output contracts are unique and name declared outcomes", () => {
  const duplicate = details(); duplicate.outputs.push({ ...duplicate.outputs[0] });
  assert.throws(() => checkDetails(duplicate), /output outcomes must be unique/u);
  const unknown = details(); unknown.outputs[0].outcome = "invented";
  assert.throws(() => checkDetails(unknown), /undeclared outcome/u);
  const invalid = details(); invalid.outputs[0].contractId = "artifact";
  assert.throws(() => checkDetails(invalid), /output contract/u);
  const omitted = details(); delete omitted.outputs;
  assert.equal(Object.hasOwn(checkDetails(omitted), "outputs"), false);
});

test("node details parameter maps are bounded scalar data with safe special keys", () => {
  const source = details();
  source.model.parameters = JSON.parse('{"constructor":"allowed","__proto__":"ordinary","temperature":0}');
  const result = checkDetails(JSON.stringify(source));
  assert.equal(Object.getPrototypeOf(result.model.parameters), null);
  assert.equal(Object.hasOwn(result.model.parameters, "__proto__"), true);
  assert.equal(result.model.parameters.__proto__, "ordinary");
  for (const parameters of [{ enabled: true }, { nested: {} }, { temperature: Infinity }, [0, 1], Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`p${index}`, 0]))]) {
    const invalid = details(); invalid.model.parameters = parameters;
    assert.throws(() => checkDetails(invalid), /parameter|plain JSON/u);
  }
});

test("node details reject accessors and JSON control text before consumers render them", () => {
  let calls = 0;
  const value = details();
  Object.defineProperty(value.model.prompt, "systemPrompt", { enumerable: true, get() { calls += 1; return "hidden"; } });
  assert.throws(() => checkDetails(value), /enumerable data properties/u);
  assert.equal(calls, 0);
  const control = details(); control.question = "invisible\u0000text";
  assert.throws(() => checkDetails(JSON.stringify(control)), /question must be bounded text/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalJson } from "@scshafe/switchyard/contracts/digest";
import {
  MAX_GRAPH_VALIDATION_DEPTH,
  MAX_GRAPH_VALIDATION_STRING_CODE_UNITS,
  MAX_GRAPH_VALIDATION_VALUES
} from "@scshafe/switchyard/graph/limits";
import {
  MAX_NODE_OUTCOMES,
  validateOutcomeVocabulary
} from "@scshafe/switchyard/graph/outcome";
import {
  isUnconditionalOutcomePredicate,
  predicateOutcomes,
  validateEdge,
  validateJsonPointer,
  validateJsonScalar,
  validateOutcomePredicate
} from "@scshafe/switchyard/graph/edge";
import {
  createGraphDefinition,
  graphDefinitionRef,
  JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
  SWITCHYARD_ENGINE_PRINCIPAL_ID,
  validateGraphDefinition,
  validateSwitchyardNode,
  validateSwitchyardNodeBindingRef
} from "@scshafe/switchyard/graph/definition";
import { compileGraph } from "@scshafe/switchyard/graph/compile";
import {
  adversarialGraphs,
  fixtureGraphs,
  MODEL_BINDING,
  TURN,
  node
} from "./fixtures/switchyard/node-graph-v2-fixtures.mjs";

const goldenPath = new URL(
  "./fixtures/switchyard/graph-v2-digest-golden-vectors.json",
  import.meta.url
);
const GOLDEN = JSON.parse(readFileSync(goldenPath, "utf8"));
const clone = (value) => structuredClone(value);
const sealAndCompile = (draft) => compileGraph(createGraphDefinition(draft));

test("outcome vocabulary: validates a non-empty unique versioned set and freezes it", () => {
  const input = { version: 2, outcomes: ["clean", "join_unsatisfiable"] };
  const vocabulary = validateOutcomeVocabulary(input);
  input.outcomes[0] = "caller-mutated";
  assert.deepEqual(vocabulary, {
    version: 2,
    outcomes: ["clean", "join_unsatisfiable"]
  });
  assert.equal(Object.isFrozen(vocabulary), true);
  assert.equal(Object.isFrozen(vocabulary.outcomes), true);
  assert.throws(() => validateOutcomeVocabulary({ version: 1, outcomes: [] }), /outcomes must be an array of 1\.\.64/);
  assert.throws(
    () => validateOutcomeVocabulary({ version: 1, outcomes: ["same", "same"] }),
    /outcomes must be unique/
  );
  assert.throws(
    () => validateOutcomeVocabulary({ version: 1, outcomes: ["Not valid"] }),
    /identifier grammar/
  );
  assert.throws(
    () => validateOutcomeVocabulary({ version: 0, outcomes: ["ok"] }),
    /version: must be a safe positive integer/
  );
  assert.throws(
    () => validateOutcomeVocabulary({ version: 1, outcomes: ["ok"], default: "ok" }),
    /unknown key\(s\) "default"/
  );
  assert.throws(
    () => validateOutcomeVocabulary({
      version: 1,
      outcomes: Array.from({ length: MAX_NODE_OUTCOMES + 1 }, (_, index) => `o${index}`)
    }),
    /outcomes must be an array of 1\.\.64/
  );
});

test("identity versions: unsafe integers are rejected before they can alias", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(
    () => validateOutcomeVocabulary({ version: unsafe, outcomes: ["ok"] }),
    /version: must be a safe positive integer/
  );

  const unsafeGraph = clone(fixtureGraphs["filter-chain"]);
  unsafeGraph.version = unsafe;
  assert.throws(
    () => createGraphDefinition(unsafeGraph),
    /graph definition: version: must be a safe positive integer/
  );

  const unsafeNode = node("unsafe-node", ["ok"], { version: unsafe });
  assert.throws(
    () => validateSwitchyardNode(unsafeNode),
    /ref\.version: must be a safe positive integer/
  );

  assert.throws(
    () => validateSwitchyardNodeBindingRef({ ...MODEL_BINDING, version: unsafe }),
    /binding\.version: must be a safe positive integer/
  );
});

test("edge predicates: the three-arm language is closed, frozen, and RFC 6901 strict", () => {
  const exact = validateOutcomePredicate({ outcome: "clean" });
  const any = validateOutcomePredicate({ anyOf: ["clean", "review"] });
  const conditional = validateOutcomePredicate({
    outcome: "clean",
    where: [
      { pointer: "", equals: null },
      { pointer: "/payload/a~1b/~0flag", equals: -0 }
    ]
  });
  assert.deepEqual(predicateOutcomes(exact), ["clean"]);
  assert.deepEqual(predicateOutcomes(any), ["clean", "review"]);
  assert.equal(isUnconditionalOutcomePredicate(exact), true);
  assert.equal(isUnconditionalOutcomePredicate(any), true);
  assert.equal(isUnconditionalOutcomePredicate(conditional), false);
  assert.equal(conditional.where[1].equals, 0);
  assert.equal(Object.isFrozen(conditional.where[0]), true);
  assert.equal(validateJsonPointer(""), "");
  assert.equal(validateJsonPointer("/"), "/");
  assert.equal(validateJsonScalar(-0), 0);
  assert.throws(() => validateOutcomePredicate({}), /closed predicate language/);
  assert.throws(
    () => validateOutcomePredicate({ outcome: "clean", anyOf: ["clean"] }),
    /unknown key\(s\) "outcome"/
  );
  assert.throws(() => validateOutcomePredicate({ anyOf: [] }), /anyOf must be an array of 1\.\.64/);
  assert.throws(
    () => validateOutcomePredicate({ anyOf: ["clean", "clean"] }),
    /anyOf outcomes must be unique/
  );
  assert.throws(
    () => validateOutcomePredicate({ outcome: "clean", where: [] }),
    /where must be an array of 1\.\.32/
  );
  assert.throws(() => validateJsonPointer("#/payload/x"), /URI fragments are not accepted/);
  assert.throws(() => validateJsonPointer("payload/x"), /beginning with "\/"/);
  assert.throws(() => validateJsonPointer("/payload/~2"), /invalid RFC 6901/);
  assert.throws(() => validateJsonScalar(Infinity), /finite JSON scalar/);
  assert.throws(() => validateJsonScalar({ nope: true }), /finite JSON scalar/);
});

test("edge contract: stable identity, non-empty unique targets, and strict keys", () => {
  const edge = validateEdge({
    edgeId: "route-clean",
    from: "filter",
    when: { anyOf: ["clean", "review"] },
    to: ["primary", "shadow"]
  });
  assert.deepEqual(edge.to, ["primary", "shadow"]);
  assert.equal(Object.isFrozen(edge), true);
  assert.equal(Object.isFrozen(edge.to), true);
  assert.throws(
    () => validateEdge({ ...edge, to: [] }),
    /to must be an array of 1\.\.64/
  );
  assert.throws(
    () => validateEdge({ ...edge, to: ["primary", "primary"] }),
    /target node IDs must be unique/
  );
  assert.throws(
    () => validateEdge({ ...edge, priority: 1 }),
    /unknown key\(s\) "priority"/
  );
});

test("required-own-key guards reject omissions instead of inherited defaults", () => {
  assert.throws(
    () => validateOutcomeVocabulary({ outcomes: ["ok"] }),
    /missing required key\(s\) "version"/
  );
  assert.throws(
    () => validateEdge({ edgeId: "missing-to", from: "a", when: { outcome: "ok" } }),
    /missing required key\(s\) "to"/
  );
  const missingTurn = node("missing-turn", ["ok"]);
  delete missingTurn.turn;
  assert.throws(
    () => validateSwitchyardNode(missingTurn),
    /missing required key\(s\) "turn"/
  );
  const missingTerminals = clone(fixtureGraphs["filter-chain"]);
  delete missingTerminals.terminals;
  assert.throws(
    () => createGraphDefinition(missingTerminals),
    /missing required key\(s\) "terminals"/
  );
});

test("node contract: follows the five-kind interface and ties outcomes to ref version", () => {
  for (const kind of ["code", "model", "agent", "human", "callback"]) {
    const candidate = node(`kind-${kind}`, ["ok"], {
      kind,
      ...(kind === "model" ? { binding: MODEL_BINDING } : {})
    });
    assert.equal(validateSwitchyardNode(candidate).kind, kind);
  }
  const mismatched = node("versioned", ["ok"], { version: 2 });
  mismatched.outcomes.version = 1;
  assert.throws(
    () => validateSwitchyardNode(mismatched),
    /outcome vocabulary version 1 must equal node ref version 2/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...node("bad-kind", ["ok"]), kind: "gate" }),
    /kind must be one of "code" \| "model" \| "agent" \| "human" \| "callback"/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...node("ttl", ["ok"]), ttlMs: 1 }),
    /unknown key\(s\) "ttlMs"/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...node("lease", ["ok"]), turn: { ...TURN, leaseMs: 0 } }),
    /leaseMs: must be a positive integer/
  );
  assert.throws(
    () => validateSwitchyardNode({ ...node("attempts", ["ok"]), turn: { ...TURN, maxAttempts: 11 } }),
    /maxAttempts: must be an integer in 1\.\.10/
  );
});

test("model binding ref: is symbolic, content-addressed, and strict", () => {
  assert.deepEqual(validateSwitchyardNodeBindingRef(MODEL_BINDING), MODEL_BINDING);
  assert.throws(
    () => validateSwitchyardNodeBindingRef({ ...MODEL_BINDING, kind: "decision" }),
    /kind must be "model"/
  );
  assert.throws(
    () => validateSwitchyardNodeBindingRef({ ...MODEL_BINDING, credential: "secret" }),
    /unknown key\(s\) "credential"/
  );
  assert.throws(
    () => validateSwitchyardNodeBindingRef({ ...MODEL_BINDING, bindingDigest: "sha256:nope" }),
    /bare lowercase sha256 hex/
  );
});

test("graph sealing: canonical digest, detachment, deep freeze, refs, and tamper rejection", () => {
  const callerDraft = clone(fixtureGraphs["filter-chain"]);
  const sealed = createGraphDefinition(callerDraft);
  const reversedTopLevel = Object.fromEntries(Object.entries(callerDraft).reverse());
  assert.equal(createGraphDefinition(reversedTopLevel).graphDigest, sealed.graphDigest);
  callerDraft.nodes[0].outcomes.outcomes[0] = "mutated";
  callerDraft.edges[0].to[0] = "sink";
  assert.equal(sealed.nodes[0].outcomes.outcomes[0], "pass");
  assert.equal(sealed.edges[0].to[0], "normalize");
  assert.equal(Object.isFrozen(sealed), true);
  assert.equal(Object.isFrozen(sealed.nodes[0].turn), true);
  assert.deepEqual(graphDefinitionRef(sealed), {
    id: "fixture.filter-chain",
    version: 1,
    digest: sealed.graphDigest
  });
  const tampered = clone(sealed);
  tampered.edges[0].to[0] = "sink";
  assert.throws(() => validateGraphDefinition(tampered), /digest mismatch/);
  assert.throws(
    () => createGraphDefinition({ ...fixtureGraphs["filter-chain"], executable: "nope" }),
    /unknown key\(s\) "executable"/
  );
});

test("graph sealing: golden canonical payloads and digests pin all six catalog shapes", () => {
  assert.equal(GOLDEN.vectors.length, 6);
  for (const vector of GOLDEN.vectors) {
    const sealed = createGraphDefinition(fixtureGraphs[vector.fixture]);
    const { graphDigest, ...base } = sealed;
    assert.equal(graphDigest, vector.graphDigest, vector.fixture);
    assert.equal(canonicalJson(base), vector.canonicalJson, vector.fixture);
  }
});

test("graph sealing: authored array order and every binding byte affect graphDigest", () => {
  const filter = clone(fixtureGraphs["filter-chain"]);
  const reversedEdges = clone(filter);
  reversedEdges.edges.reverse();
  assert.notEqual(
    createGraphDefinition(filter).graphDigest,
    createGraphDefinition(reversedEdges).graphDigest
  );
  const router = clone(fixtureGraphs["outcome-router"]);
  const rebound = clone(router);
  rebound.nodes[0].binding.bindingDigest = "b".repeat(64);
  assert.notEqual(
    createGraphDefinition(router).graphDigest,
    createGraphDefinition(rebound).graphDigest
  );
});

test("graph definition guards: duplicate node, edge, and terminal identities bite", () => {
  const duplicateNode = clone(fixtureGraphs["filter-chain"]);
  duplicateNode.nodes.push(clone(duplicateNode.nodes[0]));
  assert.throws(() => createGraphDefinition(duplicateNode), /node IDs must be unique/);

  const duplicateEdge = clone(fixtureGraphs["filter-chain"]);
  duplicateEdge.edges.push(clone(duplicateEdge.edges[0]));
  assert.throws(() => createGraphDefinition(duplicateEdge), /edge IDs must be unique/);

  const duplicateTerminal = clone(fixtureGraphs["filter-chain"]);
  duplicateTerminal.terminals.push(clone(duplicateTerminal.terminals[0]));
  assert.throws(
    () => createGraphDefinition(duplicateTerminal),
    /terminal node\/outcome pairs must be unique/
  );
});

test("graph hostile-data guards bite before property access", () => {
  const cyclic = clone(fixtureGraphs["filter-chain"]);
  cyclic.self = cyclic;
  assert.throws(() => createGraphDefinition(cyclic), /plain JSON data/);

  const sparse = clone(fixtureGraphs["filter-chain"]);
  sparse.edges = new Array(1);
  assert.throws(() => createGraphDefinition(sparse), /dense array/);

  const accessor = clone(fixtureGraphs["filter-chain"]);
  Object.defineProperty(accessor, "entry", {
    enumerable: true,
    get() {
      throw new Error("must never execute");
    }
  });
  assert.throws(() => createGraphDefinition(accessor), /entry must be an enumerable data property/);

  const proxied = new Proxy(clone(fixtureGraphs["filter-chain"]), {});
  assert.throws(() => createGraphDefinition(proxied), /plain JSON data/);

  const deepUnknown = {};
  let cursor = deepUnknown;
  for (let depth = 0; depth <= MAX_GRAPH_VALIDATION_DEPTH; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  assert.throws(
    () => createGraphDefinition({ ...fixtureGraphs["filter-chain"], unknown: deepUnknown }),
    /validation data exceeds the maximum depth/
  );

  assert.throws(
    () => createGraphDefinition({
      ...fixtureGraphs["filter-chain"],
      unknown: "x".repeat(MAX_GRAPH_VALIDATION_STRING_CODE_UNITS + 1)
    }),
    /validation data exceeds the aggregate string budget/
  );

  const oversizedDenseNodes = Array.from(
    { length: MAX_GRAPH_VALIDATION_VALUES },
    () => null
  );
  assert.throws(
    () => createGraphDefinition({
      ...fixtureGraphs["filter-chain"],
      nodes: oversizedDenseNodes
    }),
    /validation data exceeds the aggregate value budget/
  );

  const oversizedObject = Object.fromEntries(
    Array.from({ length: MAX_GRAPH_VALIDATION_VALUES }, (_, index) => [`k${index}`, null])
  );
  assert.throws(
    () => createGraphDefinition({
      unknown: oversizedObject,
      ...fixtureGraphs["filter-chain"]
    }),
    /validation data exceeds the aggregate value budget/
  );

  const aliased = clone(fixtureGraphs["filter-chain"]);
  const sharedTurn = { ...TURN };
  aliased.nodes[0].turn = sharedTurn;
  aliased.nodes[1].turn = sharedTurn;
  const detached = createGraphDefinition(aliased);
  assert.notEqual(detached.nodes[0].turn, detached.nodes[1].turn);
});

test("graph prototype-pollution guards ignore inherited optional authority", () => {
  let inheritedReads = 0;
  for (const key of ["anyOf", "binding", "join", "pointer"]) {
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      get() {
        inheritedReads += 1;
        return key === "pointer" ? "/ambient" : { ambient: true };
      }
    });
  }
  try {
    const compiled = sealAndCompile(fixtureGraphs["filter-chain"]);
    assert.equal(compiled.graph.id, "fixture.filter-chain");
    assert.equal(inheritedReads, 0);
    assert.throws(
      () => validateOutcomePredicate({ outcome: "ok", where: [{ equals: true }] }),
      /missing required key\(s\) "pointer"/
    );
    assert.equal(inheritedReads, 0);
  } finally {
    delete Object.prototype.binding;
    delete Object.prototype.anyOf;
    delete Object.prototype.join;
    delete Object.prototype.pointer;
  }
});

test("N1 fixtures: all six DESIGN catalog shapes compile", () => {
  assert.deepEqual(Object.keys(fixtureGraphs), [
    "filter-chain",
    "outcome-router",
    "escalation-ladder",
    "human-in-the-middle",
    "join",
    "shadow-lane"
  ]);
  for (const [name, draft] of Object.entries(fixtureGraphs)) {
    const compiled = compileGraph(createGraphDefinition(draft));
    assert.equal(compiled.graph.id, draft.graphId, name);
  }
  assert.deepEqual(
    [...new Set(Object.values(fixtureGraphs).flatMap((draft) => draft.nodes.map(({ kind }) => kind)))].sort(),
    ["agent", "callback", "code", "human", "model"]
  );
  assert.equal(
    Object.values(fixtureGraphs).some((draft) =>
      draft.edges.some((edge) => Object.hasOwn(edge.when, "anyOf"))
    ),
    true
  );
});

test("compiled graph: indexes preserve authored order and the entire result is frozen", () => {
  const shadow = sealAndCompile(fixtureGraphs["shadow-lane"]);
  assert.deepEqual(
    shadow.outboundByNode.classify.map((edge) => edge.edgeId),
    ["primary-route", "shadow-high-risk"]
  );
  assert.deepEqual(
    shadow.inboundByNode.primary.map((edge) => edge.edgeId),
    ["primary-route"]
  );
  assert.equal(shadow.edgesById["shadow-high-risk"].from, "classify");
  assert.equal(shadow.nodesById.shadow.kind, "agent");
  assert.equal(Object.isFrozen(shadow), true);
  assert.equal(Object.isFrozen(shadow.inboundByNode.primary), true);
  assert.equal(Object.isFrozen(shadow.edgesById["shadow-high-risk"].when), true);
  assert.throws(() => shadow.nodes.push(node("late", ["ok"])), TypeError);
  assert.throws(() => {
    shadow.nodesById.shadow.kind = "model";
  }, TypeError);
});

test("compiled graph: prototype-looking identifiers are data, never inherited authority", () => {
  const valid = {
    graphId: "fixture.prototype-safe",
    version: 1,
    description: "Prototype-looking identifiers remain ordinary graph data.",
    entry: "constructor",
    nodes: [node("constructor", ["done"])],
    edges: [],
    terminals: [{ nodeId: "constructor", outcome: "done" }]
  };
  const compiled = sealAndCompile(valid);
  assert.equal(Object.getPrototypeOf(compiled.nodesById), null);
  assert.equal(compiled.nodesById.constructor.nodeId, "constructor");

  const unknown = clone(valid);
  unknown.entry = "constructor";
  unknown.nodes[0].nodeId = "actual";
  unknown.terminals[0].nodeId = "actual";
  assert.throws(
    () => sealAndCompile(unknown),
    /Graph entry references unknown node constructor/
  );
});

test("N1 guard bites: unreachable node is rejected LOUDLY", () => {
  assert.throws(
    () => compileGraph(createGraphDefinition(adversarialGraphs["unreachable-node"])),
    /Graph node orphan is unreachable from entry filter/
  );
});

test("N1 guard bites: uncovered outcome names the exact node and outcome", () => {
  assert.throws(
    () => compileGraph(createGraphDefinition(adversarialGraphs["uncovered-outcome"])),
    /Graph node filter outcome "drop" is uncovered/
  );
});

test("N1 guard bites: join over a non-inbound edge is rejected LOUDLY", () => {
  assert.throws(
    () => compileGraph(createGraphDefinition(adversarialGraphs["join-over-non-inbound-edge"])),
    /Join node join declares edge fan-out, but that edge does not target join/
  );
});

test("N1 guard bites: edge outcome must be declared by its exact source node", () => {
  assert.throws(
    () => compileGraph(createGraphDefinition(adversarialGraphs["undeclared-outcome-in-edge"])),
    /Graph edge filter-pass from node filter references undeclared outcome "mystery"/
  );
});

test("compile references: entry, edge endpoints, and terminals fail closed", () => {
  const unknownEntry = clone(fixtureGraphs["filter-chain"]);
  unknownEntry.entry = "ghost";
  assert.throws(() => sealAndCompile(unknownEntry), /Graph entry references unknown node ghost/);

  const unknownSource = clone(fixtureGraphs["filter-chain"]);
  unknownSource.edges[0].from = "ghost";
  assert.throws(
    () => sealAndCompile(unknownSource),
    /Graph edge filter-pass references unknown source node ghost/
  );

  const unknownTarget = clone(fixtureGraphs["filter-chain"]);
  unknownTarget.edges[0].to = ["ghost"];
  assert.throws(
    () => sealAndCompile(unknownTarget),
    /Graph edge filter-pass references unknown target node ghost/
  );

  const unknownTerminalNode = clone(fixtureGraphs["filter-chain"]);
  unknownTerminalNode.terminals[0].nodeId = "ghost";
  assert.throws(
    () => sealAndCompile(unknownTerminalNode),
    /Graph terminal references unknown node ghost for outcome "drop"/
  );

  const unknownTerminalOutcome = clone(fixtureGraphs["filter-chain"]);
  unknownTerminalOutcome.terminals[0].outcome = "ghost";
  assert.throws(
    () => sealAndCompile(unknownTerminalOutcome),
    /Graph terminal for node filter references undeclared outcome "ghost"/
  );
});

test("binding compile rules: model requires a binding and every other kind forbids one", () => {
  const missing = clone(fixtureGraphs["outcome-router"]);
  delete missing.nodes[0].binding;
  assert.throws(
    () => sealAndCompile(missing),
    /Graph model node classify requires a model binding/
  );

  for (const kind of ["code", "agent", "human", "callback"]) {
    const illegal = clone(fixtureGraphs["filter-chain"]);
    illegal.nodes[0].kind = kind;
    illegal.nodes[0].binding = clone(MODEL_BINDING);
    assert.throws(
      () => sealAndCompile(illegal),
      new RegExp(`Graph ${kind} node filter does not accept a binding`)
    );
  }
});

test("completeness: conditional routes are additive, anyOf is total, and terminal/routed conflicts fail", () => {
  const conditionalOnly = clone(fixtureGraphs["shadow-lane"]);
  conditionalOnly.edges = conditionalOnly.edges.filter(
    (edge) => edge.edgeId !== "primary-route"
  );
  assert.throws(
    () => sealAndCompile(conditionalOnly),
    /Graph node classify outcome "routed" is uncovered/
  );

  const anyOf = clone(fixtureGraphs["filter-chain"]);
  anyOf.edges[0].when = { anyOf: ["pass", "drop"] };
  anyOf.terminals = anyOf.terminals.filter(
    (terminal) => !(terminal.nodeId === "filter" && terminal.outcome === "drop")
  );
  assert.equal(sealAndCompile(anyOf).graph.id, "fixture.filter-chain");

  const terminalAndRouted = clone(fixtureGraphs["filter-chain"]);
  terminalAndRouted.terminals.push({ nodeId: "filter", outcome: "pass" });
  assert.throws(
    () => sealAndCompile(terminalAndRouted),
    /Graph node filter outcome "pass" is both terminal and routed by edge filter-pass/
  );

  const terminalAndConditional = clone(fixtureGraphs["filter-chain"]);
  terminalAndConditional.edges.push({
    edgeId: "drop-shadow",
    from: "filter",
    when: { outcome: "drop", where: [{ pointer: "/payload/risk", equals: "high" }] },
    to: ["normalize"]
  });
  assert.throws(
    () => sealAndCompile(terminalAndConditional),
    /Graph node filter outcome "drop" is both terminal and routed by edge drop-shadow/
  );
});

test("joins: stable inbound identity is exact, nOf is bounded, and unsatisfiable is declared", () => {
  const nOf = clone(fixtureGraphs.join);
  nOf.nodes.find((candidate) => candidate.nodeId === "join").join.require = { nOf: 1 };
  assert.equal(sealAndCompile(nOf).nodesById.join.join.require.nOf, 1);

  const missingOutcome = clone(fixtureGraphs.join);
  const missingOutcomeNode = missingOutcome.nodes.find((candidate) => candidate.nodeId === "join");
  missingOutcomeNode.outcomes.outcomes = ["joined"];
  missingOutcome.terminals = missingOutcome.terminals.filter(
    (terminal) => terminal.outcome !== "join_unsatisfiable"
  );
  assert.throws(
    () => sealAndCompile(missingOutcome),
    /Join node join must declare outcome "join_unsatisfiable"/
  );

  const unknown = clone(fixtureGraphs.join);
  unknown.nodes.find((candidate) => candidate.nodeId === "join").join.inbound[0] = "ghost-edge";
  assert.throws(() => sealAndCompile(unknown), /Join node join declares unknown edge ghost-edge/);

  const omitted = clone(fixtureGraphs.join);
  omitted.nodes.find((candidate) => candidate.nodeId === "join").join.inbound = ["branch-a-to-join"];
  assert.throws(
    () => sealAndCompile(omitted),
    /Join node join omits actual inbound edge branch-b-to-join/
  );

  const impossibleNOf = clone(fixtureGraphs.join);
  impossibleNOf.nodes.find((candidate) => candidate.nodeId === "join").join.require = { nOf: 3 };
  assert.throws(
    () => sealAndCompile(impossibleNOf),
    /Join node join requires 3-of-2, but nOf cannot exceed declared inbound edges/
  );

  const duplicate = clone(fixtureGraphs.join);
  duplicate.nodes.find((candidate) => candidate.nodeId === "join").join.inbound = [
    "branch-a-to-join",
    "branch-a-to-join"
  ];
  assert.throws(() => createGraphDefinition(duplicate), /edge IDs must be unique/);
});

test("node-version identity: one ref/version cannot declare two outcome vocabularies", () => {
  const conflicting = {
    graphId: "fixture.conflicting-node-version",
    version: 1,
    description: "One node definition version cannot mean two outcome sets.",
    entry: "left",
    nodes: [
      node("left", ["next"], { refId: "shared.definition" }),
      node("right", ["done", "extra"], { refId: "shared.definition" })
    ],
    edges: [
      { edgeId: "left-to-right", from: "left", when: { outcome: "next" }, to: ["right"] }
    ],
    terminals: [
      { nodeId: "right", outcome: "done" },
      { nodeId: "right", outcome: "extra" }
    ]
  };
  assert.throws(
    () => sealAndCompile(conflicting),
    /Node definition shared\.definition@1 is reused with a different outcome vocabulary/
  );

  const consistent = clone(conflicting);
  consistent.nodes[1].outcomes.outcomes = ["next"];
  consistent.terminals = [{ nodeId: "right", outcome: "next" }];
  assert.equal(sealAndCompile(consistent).graph.id, "fixture.conflicting-node-version");

  const differentKind = clone(consistent);
  differentKind.nodes[1].kind = "human";
  assert.throws(
    () => sealAndCompile(differentKind),
    /Node definition shared\.definition@1 is reused with a different kind/
  );

  const differentInput = clone(consistent);
  differentInput.nodes[1].input = "other-input.v1";
  assert.throws(
    () => sealAndCompile(differentInput),
    /Node definition shared\.definition@1 is reused with a different input contract/
  );
});

test("admission semantics: the entry node cannot declare an inbound-offer join", () => {
  const joinedEntry = {
    graphId: "fixture.joined-entry",
    version: 1,
    description: "Admission has no inbound edge offer with which to satisfy a join.",
    entry: "a",
    nodes: [
      node("a", ["next", "join_unsatisfiable"], {
        join: { inbound: ["b-to-a"], require: "all" }
      }),
      node("b", ["next"])
    ],
    edges: [
      { edgeId: "a-to-b", from: "a", when: { outcome: "next" }, to: ["b"] },
      { edgeId: "b-to-a", from: "b", when: { outcome: "next" }, to: ["a"] }
    ],
    terminals: [{ nodeId: "a", outcome: "join_unsatisfiable" }]
  };
  assert.throws(
    () => sealAndCompile(joinedEntry),
    /Graph entry node a cannot declare a join/
  );
});

test("v2 graph structure: reachable cycles compile (no inherited v1 DAG rule)", () => {
  const cyclic = {
    graphId: "fixture.reachable-cycle",
    version: 1,
    description: "A structurally reachable cycle is legal graph configuration.",
    entry: "a",
    nodes: [node("a", ["next"]), node("b", ["next"])],
    edges: [
      { edgeId: "a-to-b", from: "a", when: { outcome: "next" }, to: ["b"] },
      { edgeId: "b-to-a", from: "b", when: { outcome: "next" }, to: ["a"] }
    ],
    terminals: []
  };
  const compiled = sealAndCompile(cyclic);
  assert.deepEqual(compiled.outboundByNode.b.map((edge) => edge.edgeId), ["b-to-a"]);
});

test("N3 guard bites: authored nodes cannot claim the reserved engine principal", () => {
  const reserved = clone(fixtureGraphs["filter-chain"]);
  reserved.nodes[0].principal.id = SWITCHYARD_ENGINE_PRINCIPAL_ID;
  assert.throws(
    () => sealAndCompile(reserved),
    /Graph node filter cannot use reserved engine principal switchyard\.engine/
  );
});

test("N3 guard bites: only a declared join may expose the engine outcome", () => {
  const ordinary = clone(fixtureGraphs["filter-chain"]);
  ordinary.nodes[0].outcomes.outcomes.push("join_unsatisfiable");
  ordinary.terminals.push({ nodeId: "filter", outcome: "join_unsatisfiable" });
  assert.throws(
    () => sealAndCompile(ordinary),
    /Graph non-join node filter cannot declare engine-reserved outcome "join_unsatisfiable"/
  );
});

test("N3 guard bites: routed join_unsatisfiable names the incompatible target", () => {
  const routed = clone(fixtureGraphs.join);
  routed.nodes.push(node("recover", ["done"], { input: "unit-artifact.v1" }));
  routed.edges.push({
    edgeId: "join-unsatisfiable-recovery",
    from: "join",
    when: { outcome: "join_unsatisfiable" },
    to: ["recover"]
  });
  routed.terminals = routed.terminals
    .filter(({ nodeId, outcome }) => !(nodeId === "join" && outcome === "join_unsatisfiable"))
    .concat({ nodeId: "recover", outcome: "done" });
  assert.throws(
    () => sealAndCompile(routed),
    new RegExp(
      `Graph edge join-unsatisfiable-recovery routes join_unsatisfiable to node recover, which requires ${JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT.replaceAll(".", "\\.")}`
    )
  );
});

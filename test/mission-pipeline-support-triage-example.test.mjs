// The support-ticket triage worked example, run on the real engine with
// fixture ports. docs/EXAMPLE-SUPPORT-TRIAGE.md narrates these paths; this
// file is what keeps that narration honest.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NODE_TURN_USAGE_EVENT_TYPE
} from "mission-pipeline/execute/unit-runner";
import { createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import { digest } from "mission-pipeline/contracts/digest";
import { validateNodeTurnCompletion } from "mission-pipeline/execute/ports";
import { nodeExecutionFingerprint } from "mission-pipeline/execute/turn";
import { compileGraph } from "mission-pipeline/graph/compile";
import { createGraphDefinition } from "mission-pipeline/graph/definition";
import { createGoalManifest, GOAL_MANIFEST_SCHEMA_VERSION, validateGoalManifest } from "mission-pipeline/graph/goals";
import { projectGoalClosures } from "mission-pipeline/store/goal-closures";
import { projectUnitPath } from "mission-pipeline/store/unit-path";
import {
  CODE_BODIES,
  COMPILED_SUPPORT_TRIAGE_GRAPH,
  CONTRACTS,
  FIXTURES,
  MODEL_BINDINGS,
  PRINCIPALS,
  PRIORITY_POLICY,
  PRIORITY_POLICY_REF,
  SUPPORT_TRIAGE_GOAL_MANIFEST,
  SUPPORT_TRIAGE_GOALS_DRAFT,
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_GRAPH_DRAFT,
  SUPPORT_TRIAGE_MONOLITH_GOAL_MANIFEST,
  SUPPORT_TRIAGE_MONOLITH_GRAPH,
  SUPPORT_TRIAGE_PRESENTATION,
  createSupportTriageHarness,
  journeyPath,
  presentationCoverage,
  renderSupportTriageMermaid
} from "./fixtures/mission-pipeline/support-triage-example.mjs";

const clone = (value) => structuredClone(value);
/** Prototype-free frozen records compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const shown = (resolution) => `${resolution.nodeId}:${resolution.outcome}=${resolution.kind}`;

async function runFixture(name, options = {}) {
  const harness = createSupportTriageHarness({ fixture: FIXTURES[name], ...options });
  await harness.admit();
  const results = await harness.drain();
  return { harness, results };
}

function outputArtifactRef(journey, nodeId) {
  const record = journey.find((entry) => entry.kind === "turn_settled" && entry.nodeId === nodeId);
  assert.ok(record?.outputArtifact, `${nodeId} settled with an output artifact`);
  return record.outputArtifact;
}

test("support triage: the focused graph compiles with every outcome routed or terminal", () => {
  const compiled = COMPILED_SUPPORT_TRIAGE_GRAPH;
  assert.equal(compiled.graph.id, "example.support-triage");
  assert.equal(compiled.nodes.length, 9);
  assert.equal(compiled.edges.length, 11);
  assert.equal(compiled.terminals.length, 7);
  assert.deepEqual(
    compiled.nodes.filter((node) => node.kind === "model").map((node) => node.nodeId),
    ["outage-signal", "outage-verify", "blast-radius", "summarize"]
  );
  assert.deepEqual(
    compiled.nodes.filter((node) => node.kind === "human").map((node) => node.nodeId),
    ["dispatch-review", "triage-review"]
  );
  // Each model invocation is a distinct sealed binding on one model revision.
  const bindingDigests = compiled.nodes
    .filter((node) => node.kind === "model")
    .map((node) => node.binding.bindingDigest);
  assert.equal(new Set(bindingDigests).size, 4);
  for (const binding of Object.values(MODEL_BINDINGS)) {
    assert.equal(binding.modelRevisionRef.id, "triage.small-judge");
  }
  // Every escalation source shares the one human fallback's input contract.
  assert.deepEqual(
    compiled.inboundByNode["triage-review"].map((edge) => edge.from).sort(),
    ["assemble", "ground-evidence", "outage-signal", "outage-verify"]
  );
  assert.equal(compiled.nodesById["triage-review"].input, CONTRACTS.escalation);
});

test("support triage: removing an escalation route fails compilation loudly", () => {
  const draft = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  draft.edges = draft.edges.filter((edge) => edge.edgeId !== "assemble-invalid");
  assert.throws(
    () => compileGraph(createGraphDefinition(draft)),
    /Graph node assemble outcome "invalid" is uncovered/
  );
  const conditionalOnly = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  const edge = conditionalOnly.edges.find((candidate) => candidate.edgeId === "signal-uncertain");
  edge.when = { outcome: "uncertain", where: [{ pointer: "/payload/reason", equals: "uncertain_answer" }] };
  assert.throws(
    () => compileGraph(createGraphDefinition(conditionalOnly)),
    /Graph node outage-signal outcome "uncertain" is uncovered/
  );
});

test("support triage: positive ticket takes four focused calls to a p1 proposal and a dispatcher", async () => {
  const { harness, results } = await runFixture("positive");
  assert.equal(results.every((result) => result.status === "succeeded"), true);
  const journey = await harness.journey();
  assert.deepEqual(journeyPath(journey), [
    "normalize:ready",
    "outage-signal:yes",
    "ground-evidence:grounded",
    "outage-verify:confirmed",
    "blast-radius:many",
    "assemble:proposed",
    "summarize:summarized"
  ]);
  assert.deepEqual(await harness.openQueues(), [
    { nodeId: "dispatch-review", kind: "human", contractId: CONTRACTS.packet }
  ]);

  const packet = await harness.artifact(outputArtifactRef(journey, "summarize"));
  assert.equal(packet.contractId, CONTRACTS.packet);
  assert.equal(packet.payload.proposal.priority, "p1");
  assert.equal(packet.payload.proposal.blastRadius, "many");
  assert.equal(packet.payload.summary.source, "model");
  // Provenance: the proposal names the exact artifact each step consumed.
  const steps = packet.payload.proposal.provenance.steps.map((step) => step.nodeId);
  assert.deepEqual(steps, ["outage-signal", "ground-evidence", "outage-verify", "blast-radius", "assemble"]);
  const signalInput = packet.payload.proposal.provenance.steps[0].input;
  const normalized = outputArtifactRef(journey, "normalize");
  assert.equal(signalInput.contractId, CONTRACTS.context);
  assert.equal(signalInput.digest, normalized.digest);
  const seed = journey[0].seedArtifact;
  assert.deepEqual(packet.payload.proposal.provenance.seed, { contractId: seed.contractId, digest: seed.digest });

  const calls = await harness.modelCalls();
  assert.equal(calls.calls, 4);
  assert.deepEqual(calls.byNode, { "outage-signal": 1, "outage-verify": 1, "blast-radius": 1, summarize: 1 });

  const decision = await harness.decide("dispatch-review", "approved");
  assert.equal(decision.status, "succeeded");
  assert.deepEqual(await harness.openQueues(), []);
  const settled = (await harness.journey()).at(-1);
  assert.equal(settled.kind, "turn_settled");
  assert.equal(settled.principalId, PRINCIPALS.console);
  assert.equal(settled.actorId, "dispatcher-1");
  assert.deepEqual(settled.routing, []);
});

test("support triage: negative ticket ends after one call at the standard-queue terminal", async () => {
  const { harness } = await runFixture("negative");
  assert.deepEqual(journeyPath(await harness.journey()), ["normalize:ready", "outage-signal:no"]);
  assert.deepEqual(await harness.openQueues(), []);
  assert.equal((await harness.modelCalls()).calls, 1);
  // The judgment is still retained as evidence even though nothing routes.
  const signal = await harness.artifact(outputArtifactRef(await harness.journey(), "outage-signal"));
  assert.equal(signal.payload.signal.answer, "no");
});

test("support triage: an uncertain answer is a declared outcome that reaches a person with the exact context", async () => {
  const { harness } = await runFixture("ambiguous");
  const journey = await harness.journey();
  assert.deepEqual(journeyPath(journey), ["normalize:ready", "outage-signal:uncertain"]);
  assert.deepEqual(await harness.openQueues(), [
    { nodeId: "triage-review", kind: "human", contractId: CONTRACTS.escalation }
  ]);
  const escalation = await harness.artifact(outputArtifactRef(journey, "outage-signal"));
  assert.equal(escalation.payload.step, "outage-signal");
  assert.equal(escalation.payload.reason, "uncertain_answer");
  assert.equal(escalation.payload.input.contractId, CONTRACTS.context);
  assert.equal(escalation.payload.input.digest, outputArtifactRef(journey, "normalize").digest);
  assert.equal((await harness.modelCalls()).calls, 1);

  const decision = await harness.decide("triage-review", "standard", "triager-2");
  assert.equal(decision.status, "succeeded");
  assert.deepEqual(await harness.openQueues(), []);
});

test("support triage: deterministic grounding refuses a quote the ticket does not contain", async () => {
  const { harness } = await runFixture("fabricated-evidence");
  const journey = await harness.journey();
  assert.deepEqual(journeyPath(journey), ["normalize:ready", "outage-signal:yes", "ground-evidence:ungrounded"]);
  const escalation = await harness.artifact(outputArtifactRef(journey, "ground-evidence"));
  assert.equal(escalation.payload.reason, "ungrounded_evidence");
  assert.deepEqual(escalation.payload.detail.missingQuotes, ["export is failing every night"]);
  assert.deepEqual(await harness.openQueues(), [
    { nodeId: "triage-review", kind: "human", contractId: CONTRACTS.escalation }
  ]);
  // The verifier never ran: one model call, not two.
  assert.equal((await harness.modelCalls()).calls, 1);
});

test("support triage: a provider outage dead-letters after bounded retries; a lifecycle failure is not a decision", async () => {
  const { harness, results } = await runFixture("provider-outage");
  assert.deepEqual(results.map((result) => result.status), ["succeeded", "terminal"]);
  assert.deepEqual(results[1], { status: "terminal", errorCode: "dependency_unavailable", attempts: 2 });
  const journey = await harness.journey();
  assert.deepEqual(journeyPath(journey), [
    "normalize:ready",
    "outage-signal!dependency_unavailable:retry",
    "outage-signal!dependency_unavailable:terminal"
  ]);
  const deadLetters = await harness.deadLetters();
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].nodeId, "outage-signal");
  // No successor, no human fallback: nothing routes from a terminal failure.
  assert.deepEqual(await harness.openQueues(), []);
  // A port that throws attaches no receipt; the outbox records no usage.
  assert.equal((await harness.modelCalls()).calls, 0);
});

test("support triage: a failed summary never changes routing; the deterministic line stands in", async () => {
  const { harness } = await runFixture("unusable-summary");
  const journey = await harness.journey();
  assert.deepEqual(journeyPath(journey), [
    "normalize:ready",
    "outage-signal:yes",
    "ground-evidence:grounded",
    "outage-verify:confirmed",
    "blast-radius:uncertain",
    "assemble:proposed",
    "summarize:unusable"
  ]);
  const packet = await harness.artifact(outputArtifactRef(journey, "summarize"));
  assert.equal(packet.payload.summary.source, "deterministic");
  assert.equal(packet.payload.summary.text, packet.payload.proposal.fallbackSummary);
  // Uncertain blast radius is carried as an explicit fact, never defaulted down.
  assert.equal(packet.payload.proposal.blastRadius, "unresolved");
  assert.equal(packet.payload.proposal.priority, "p2");
  assert.deepEqual(await harness.openQueues(), [
    { nodeId: "dispatch-review", kind: "human", contractId: CONTRACTS.packet }
  ]);
});

test("support triage: one outbox receipt per model attempt, none for code or human turns", async () => {
  const { harness } = await runFixture("positive");
  await harness.decide("dispatch-review", "rejected");
  const events = await harness.unitStore.listOutboxEvents({ unitId: FIXTURES.positive.unitId });
  const receipts = events.filter((event) => event.eventType === NODE_TURN_USAGE_EVENT_TYPE);
  assert.equal(receipts.length, 4);
  for (const event of receipts) {
    assert.equal(event.payload.receipt.trust, "provider_reported");
    assert.equal(event.payload.attemptIndex, 1);
    assert.ok(["outage-signal", "outage-verify", "blast-radius", "summarize"].includes(event.nodeId));
  }
  const journey = await harness.journey();
  for (const record of journey) {
    if (record.kind !== "turn_settled") continue;
    const node = COMPILED_SUPPORT_TRIAGE_GRAPH.nodesById[record.nodeId];
    assert.equal(record.usage.length, node.kind === "model" ? 1 : 0, `${record.nodeId} usage evidence`);
  }
});

test("support triage: a body can be checked against its sealed node without a store", async () => {
  const node = COMPILED_SUPPORT_TRIAGE_GRAPH.nodesById.normalize;
  const context = {
    graph: COMPILED_SUPPORT_TRIAGE_GRAPH.graph,
    queueId: "queue-x",
    unitId: "unit-x",
    nodeId: "normalize",
    nodeRef: node.ref,
    attemptNumber: 1,
    attemptIndex: 1,
    idempotencyKey: "a".repeat(64),
    inputArtifact: { contractId: CONTRACTS.ticket, digest: "0".repeat(64) }
  };
  const completion = await CODE_BODIES.normalize({ ticketId: "1", body: "  " }, context);
  assert.deepEqual(validateNodeTurnCompletion(node, completion), { outcome: "malformed" });
  const ready = await CODE_BODIES.normalize({ ticketId: "1", product: "console", customerTier: "free", subject: "s", body: "b" }, context);
  assert.equal(validateNodeTurnCompletion(node, ready).outputArtifact.contractId, CONTRACTS.context);
  assert.throws(
    () => validateNodeTurnCompletion(node, { outcome: "ready", outputArtifact: ready.outputArtifact, usage: [] }),
    /code node normalize must not return usage receipts/
  );
});

test("support triage: the same fixture replays to identical journey digests in a fresh store", async () => {
  const first = await runFixture("positive");
  const second = await runFixture("positive");
  const digests = async (harness) => (await harness.journey()).map((record) => record.recordDigest);
  assert.deepEqual(await digests(first.harness), await digests(second.harness));
  assert.equal(SUPPORT_TRIAGE_GRAPH.graphDigest, (await first.harness.journey())[0].graph.digest);
});

test("support triage: the overloaded single call answers the same fixtures with one call and a policy hidden in its port", async () => {
  const compiled = compileGraph(SUPPORT_TRIAGE_MONOLITH_GRAPH);
  assert.equal(compiled.nodes.filter((node) => node.kind === "model").length, 1);
  const expected = {
    positive: { path: ["normalize:ready", "triage:proposed"], open: "dispatch-review" },
    negative: { path: ["normalize:ready", "triage:standard"], open: null },
    ambiguous: { path: ["normalize:ready", "triage:uncertain"], open: "triage-review" },
    // The fabricated quote is invisible to a call that never grounds evidence.
    "fabricated-evidence": { path: ["normalize:ready", "triage:proposed"], open: "dispatch-review" }
  };
  for (const [name, expectation] of Object.entries(expected)) {
    const { harness } = await runFixture(name, { graph: SUPPORT_TRIAGE_MONOLITH_GRAPH, prefix: "monolith" });
    assert.deepEqual(journeyPath(await harness.journey()), expectation.path, name);
    const open = await harness.openQueues();
    assert.deepEqual(open.map((entry) => entry.nodeId), expectation.open === null ? [] : [expectation.open], name);
    assert.equal((await harness.modelCalls()).calls, 1, name);
  }
});

test("support triage: the presentation covers the sealed graph exactly, and the check bites", () => {
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_PRESENTATION), []);

  const unclaimed = structuredClone(SUPPORT_TRIAGE_PRESENTATION);
  unclaimed.terminals[0].ends = unclaimed.terminals[0].ends.filter((end) => end.outcome !== "unsupported");
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, unclaimed), [
    "terminal outage-verify:unsupported is not presented"
  ]);

  const invented = structuredClone(SUPPORT_TRIAGE_PRESENTATION);
  invented.terminals[0].ends.push({ nodeId: "blast-radius", outcome: "uncertain" });
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, invented), [
    "sink standard-queue claims blast-radius:uncertain, which the graph does not declare terminal"
  ]);

  const unnamed = structuredClone(SUPPORT_TRIAGE_PRESENTATION);
  delete unnamed.nodes.summarize;
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, unnamed), ["node summarize has no presentation"]);

  const silent = structuredClone(SUPPORT_TRIAGE_PRESENTATION);
  delete silent.nodes["blast-radius"].question;
  assert.deepEqual(presentationCoverage(SUPPORT_TRIAGE_GRAPH, silent), ["model node blast-radius states no question"]);

  // A graph change without its presentation change fails here, in the same change.
  const grown = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  grown.nodes.find((candidate) => candidate.nodeId === "assemble").outcomes.outcomes.push("deferred");
  grown.terminals.push({ nodeId: "assemble", outcome: "deferred" });
  assert.deepEqual(presentationCoverage(createGraphDefinition(grown), SUPPORT_TRIAGE_PRESENTATION), [
    "terminal assemble:deferred is not presented"
  ]);
});

test("support triage: the diagram in docs/EXAMPLE-SUPPORT-TRIAGE.md is derived from the sealed graph", () => {
  const doc = readFileSync(new URL("../docs/EXAMPLE-SUPPORT-TRIAGE.md", import.meta.url), "utf8");
  const fenced = /```mermaid\n([\s\S]*?)\n```/u.exec(doc);
  assert.ok(fenced, "the example doc carries a mermaid block");
  assert.equal(fenced[1], renderSupportTriageMermaid());
});

test("support triage: declared output contracts are proven at compile time and enforced at completion", () => {
  // Every routed contract in the example is declared, and the compiler agrees with every target.
  for (const graphNode of COMPILED_SUPPORT_TRIAGE_GRAPH.nodes) {
    if (graphNode.kind === "human") { assert.equal(graphNode.outputs, undefined); continue; }
    assert.deepEqual(Object.keys(graphNode.outputs).sort(), [...graphNode.outcomes.outcomes].sort(), graphNode.nodeId);
  }
  const wrong = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  wrong.nodes.find((candidate) => candidate.nodeId === "outage-signal").outputs.uncertain = CONTRACTS.signal;
  assert.throws(
    () => compileGraph(createGraphDefinition(wrong)),
    /Graph edge signal-uncertain carries outcome "uncertain" from node outage-signal as outage-signal\.v1, but target node triage-review accepts triage-escalation\.v1/
  );
  // A body that emits the wrong contract is refused before its completion is cached.
  const normalize = COMPILED_SUPPORT_TRIAGE_GRAPH.nodesById.normalize;
  assert.throws(
    () => validateNodeTurnCompletion(normalize, {
      outcome: "ready",
      outputArtifact: createArtifactEnvelope(CONTRACTS.ticket, { ticketId: "1" })
    }),
    /node normalize outcome "ready" must carry triage-context\.v1 \(got support-ticket\.v1\)/
  );
  assert.deepEqual(validateNodeTurnCompletion(normalize, { outcome: "malformed" }), { outcome: "malformed" });
});

test("support triage: the assembler runs only under the priority policy the graph pins", async () => {
  const assemble = COMPILED_SUPPORT_TRIAGE_GRAPH.nodesById.assemble;
  assert.deepEqual(assemble.configuration, PRIORITY_POLICY_REF);
  assert.equal(PRIORITY_POLICY_REF.digest, digest(PRIORITY_POLICY));

  // The same graph with a different policy digest is a different graph, a different
  // fingerprint, and a body that refuses to run: a policy edit can never be silent.
  const repinned = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  repinned.graphId = "example.support-triage-repinned";
  const target = repinned.nodes.find((candidate) => candidate.nodeId === "assemble");
  target.configuration = { ...PRIORITY_POLICY_REF, version: 2, digest: digest({ ...PRIORITY_POLICY, version: 2 }) };
  const variant = createGraphDefinition(repinned);
  assert.notEqual(variant.graphDigest, SUPPORT_TRIAGE_GRAPH.graphDigest);
  assert.notEqual(
    nodeExecutionFingerprint(compileGraph(variant).nodesById.assemble),
    nodeExecutionFingerprint(assemble)
  );

  const { harness, results } = await runFixture("positive", { graph: variant, prefix: "repinned" });
  assert.deepEqual(results.map((result) => result.status), ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "terminal"]);
  assert.deepEqual(journeyPath(await harness.journey()).slice(-2), [
    "blast-radius:many",
    "assemble!immutable_configuration_rejected:terminal"
  ]);
  assert.equal((await harness.deadLetters()).length, 1);
  assert.deepEqual(await harness.openQueues(), []);
});

test("support triage: the goal manifest names the objective and proves it closes exactly once", () => {
  const manifest = SUPPORT_TRIAGE_GOAL_MANIFEST;
  assert.deepEqual(plain(validateGoalManifest(SUPPORT_TRIAGE_GRAPH, manifest)), plain(manifest));
  assert.deepEqual(manifest.goals.map((goal) => goal.goalId), ["outage-escalation"]);
  assert.deepEqual(manifest.goals[0].resolutions.map(shown), [
    "outage-signal:no=resolved",
    "outage-signal:uncertain=escalated",
    "ground-evidence:ungrounded=escalated",
    "outage-verify:unsupported=resolved",
    "outage-verify:uncertain=escalated",
    "assemble:proposed=resolved",
    "assemble:invalid=escalated"
  ]);
  // The presentation's grouping follows the manifest; only the words are its own.
  assert.deepEqual(
    [...SUPPORT_TRIAGE_PRESENTATION.goals["outage-escalation"].members],
    [...manifest.goals[0].members]
  );

  // Forgetting that the proposal leaves the goal, or that a plain "no" ends the
  // journey, fails to seal.
  const seal = (goals) => createGoalManifest(SUPPORT_TRIAGE_GRAPH, { schemaVersion: GOAL_MANIFEST_SCHEMA_VERSION, goals });
  const without = (nodeId, outcome) => {
    const draft = clone(SUPPORT_TRIAGE_GOALS_DRAFT);
    draft.goals[0].resolutions = draft.goals[0].resolutions.filter(
      (resolution) => !(resolution.nodeId === nodeId && resolution.outcome === outcome)
    );
    return draft.goals;
  };
  assert.throws(
    () => seal(without("assemble", "proposed")),
    /assemble:proposed leaves the goal by edge assemble-proposed to summarize without a declared resolution/
  );
  assert.throws(
    () => seal(without("outage-signal", "no")),
    /outage-signal:no is a graph terminal but not a declared resolution/
  );

  // A graph change re-seals the manifest, and a new member outcome must be classified.
  const grown = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  grown.nodes.find((candidate) => candidate.nodeId === "assemble").outcomes.outcomes.push("deferred");
  grown.terminals.push({ nodeId: "assemble", outcome: "deferred" });
  const grownGraph = createGraphDefinition(grown);
  assert.throws(() => validateGoalManifest(grownGraph, manifest), /graph mismatch/);
  assert.throws(
    () => createGoalManifest(grownGraph, SUPPORT_TRIAGE_GOALS_DRAFT),
    /assemble:deferred is a graph terminal but not a declared resolution/
  );
});

test("support triage: every fixture closes the escalation goal exactly once, or dies inside it", async () => {
  const expected = {
    positive: { status: "closed", resolution: "assemble:proposed=resolved", turns: 5, receipts: 3 },
    negative: { status: "closed", resolution: "outage-signal:no=resolved", turns: 1, receipts: 1 },
    ambiguous: { status: "closed", resolution: "outage-signal:uncertain=escalated", turns: 1, receipts: 1 },
    "fabricated-evidence": { status: "closed", resolution: "ground-evidence:ungrounded=escalated", turns: 2, receipts: 1 },
    // A lifecycle failure is not a decision: the goal dies open, with no closure and no receipt.
    "provider-outage": { status: "dead", resolution: undefined, deadMembers: ["outage-signal"], turns: 2, receipts: 0 },
    "unusable-summary": { status: "closed", resolution: "assemble:proposed=resolved", turns: 5, receipts: 3 }
  };
  for (const [name, expectation] of Object.entries(expected)) {
    const { harness } = await runFixture(name);
    const closures = projectGoalClosures(SUPPORT_TRIAGE_GOAL_MANIFEST, projectUnitPath(await harness.journey()));
    assert.deepEqual(plain(closures.graph), plain(SUPPORT_TRIAGE_GOAL_MANIFEST.graph), name);
    const goal = closures.goals["outage-escalation"];
    assert.equal(goal.status, expectation.status, name);
    assert.equal(goal.resolution === undefined ? undefined : shown(goal.resolution), expectation.resolution, name);
    assert.deepEqual([...goal.deadMembers], expectation.deadMembers ?? [], name);
    assert.deepEqual([...goal.openMembers], [], name);
    assert.equal(goal.turns, expectation.turns, name);
    // Only model turns inside the goal are charged to it: the summary is outside.
    assert.equal(goal.usage.receipts, expectation.receipts, name);
  }

  // The overloaded graph closes the same goal in one turn, and cannot tell the
  // fabricated quote from a real one.
  const monolith = {
    positive: "triage:proposed=resolved",
    negative: "triage:standard=resolved",
    ambiguous: "triage:uncertain=escalated",
    "fabricated-evidence": "triage:proposed=resolved"
  };
  for (const [name, resolution] of Object.entries(monolith)) {
    const { harness } = await runFixture(name, { graph: SUPPORT_TRIAGE_MONOLITH_GRAPH, prefix: "monolith" });
    const goal = projectGoalClosures(SUPPORT_TRIAGE_MONOLITH_GOAL_MANIFEST, projectUnitPath(await harness.journey()))
      .goals["outage-escalation"];
    assert.equal(goal.status, "closed", name);
    assert.equal(shown(goal.resolution), resolution, name);
    assert.equal(goal.turns, 1, name);
    assert.equal(goal.usage.receipts, 1, name);
  }
});

test("support triage: the provider boundary receives the journey's own attempt identity", async () => {
  const { harness } = await runFixture("positive");
  const requests = harness.modelRequests();
  assert.deepEqual(requests.map((request) => request.nodeId), ["outage-signal", "outage-verify", "blast-radius", "summarize"]);
  const journey = await harness.journey();
  for (const request of requests) {
    const settled = journey.find((record) => record.kind === "turn_settled" && record.nodeId === request.nodeId);
    assert.equal(request.unitId, FIXTURES.positive.unitId, request.nodeId);
    assert.equal(request.queueId, settled.queueId, request.nodeId);
    assert.deepEqual(plain(request.nodeRef), plain(settled.nodeRef), request.nodeId);
    assert.equal(request.attemptNumber, settled.attemptNumber, request.nodeId);
    assert.equal(request.attemptIndex, settled.attemptIndex, request.nodeId);
    assert.equal(request.idempotencyKey, settled.idempotencyKey, request.nodeId);
    assert.equal(request.inputArtifact.contractId, settled.inputArtifact.contractId, request.nodeId);
    assert.equal(request.inputArtifact.digest, settled.inputArtifact.digest, request.nodeId);
    const sealedNode = SUPPORT_TRIAGE_GRAPH.nodes.find((node) => node.nodeId === request.nodeId);
    assert.equal(request.binding.bindingDigest, sealedNode.binding.bindingDigest, request.nodeId);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.hasOwn(request, "runId"), false);
  }

  // A retry is a second request at the same queue occurrence with a new key.
  const outage = await runFixture("provider-outage");
  const retried = outage.harness.modelRequests();
  assert.deepEqual(
    retried.map((request) => [request.nodeId, request.attemptNumber, request.attemptIndex]),
    [["outage-signal", 1, 1], ["outage-signal", 2, 2]]
  );
  assert.equal(retried[0].queueId, retried[1].queueId);
  assert.notEqual(retried[0].idempotencyKey, retried[1].idempotencyKey);
});

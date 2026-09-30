// First-run helpers: runWorker, workerPrincipals, fakeModelPort,
// unavailableUsageReceipt, providerReportedUsageReceipt, humanNodeAnswers and
// latestReviewNotes, driven through the graph of docs/FIRST-GRAPH.md on the
// memory stores, plus the messages a first run meets (a mistyped answer, a
// re-used unit id) and the record shapes the guide documents.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  NODE_TURN_IDEMPOTENCY,
  NODE_TURN_RETRY_TAXONOMY,
  SWITCHYARD_REVIEW_NOTES_CONTRACT,
  SWITCHYARD_REVIEW_REQUEST_CONTRACT,
  SWITCHYARD_REWORK_CONTRACT,
  TurnEvidenceConflictError,
  approvalReviewHumanDecision,
  applyApprovalReviewCompletion,
  binaryQuestion,
  codeNodePortByNode,
  createArtifactEnvelope,
  createGraphDefinition,
  digest,
  fakeModelPort,
  graphDefinitionRef,
  humanNodeAnswers,
  latestReviewNotes,
  providerReportedUsageReceipt,
  recordHumanNodeDecision,
  reviewNotes,
  runWorker,
  unavailableUsageReceipt,
  validateUsageReceipt,
  withApprovalReviewPorts,
  workerPrincipals
} from "@scshafe/switchyard";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";

// Exactly the graph of docs/first-graph-example/graph.mjs (same digest).
const turn = { idempotency: NODE_TURN_IDEMPOTENCY, retryTaxonomy: NODE_TURN_RETRY_TAXONOMY, leaseMs: 30_000, maxAttempts: 3 };
const binding = (bindingId, model) => ({ kind: "model", bindingId, version: 1, bindingDigest: digest(model) });
const SMALL = binding("small-local", { model: "qwen2.5-7b", where: "local" });
const CLOUD = binding("big-cloud", { model: "big-cloud-model", where: "cloud" });
const person = { kind: "human", principal: { id: "console" } };

function firstGraph() {
  const isQuestion = binaryQuestion({
    nodeId: "is-question",
    ref: { id: "first.is-question", version: 1 },
    input: "ticket.v1",
    principal: { id: "local-model" },
    binding: SMALL,
    turn,
    escalate: person,
    yes: { to: "draft-answer" },
    no: "terminal"
  });
  return createGraphDefinition({
    graphId: "first-switchyard",
    version: 1,
    description: "Triage a message, draft an answer behind a PII screen, have a person review the reply.",
    entry: "is-question",
    nodes: [
      ...isQuestion.nodes,
      {
        nodeId: "draft-answer",
        ref: { id: "first.draft-answer", version: 1 },
        kind: "model",
        input: "ticket.v1",
        outcomes: { version: 1, outcomes: ["drafted"] },
        outputs: { drafted: "draft.v1" },
        principal: { id: "cloud-model" },
        binding: CLOUD,
        turn,
        approval: { by: { kind: "model", binding: SMALL, principal: { id: "local-model" } }, onDeny: "terminal" }
      },
      {
        nodeId: "compose-reply",
        ref: { id: "first.compose-reply", version: 1 },
        kind: "code",
        input: "draft.v1",
        outcomes: { version: 1, outcomes: ["composed"] },
        outputs: { composed: "reply.v1" },
        principal: { id: "worker" },
        turn,
        review: { by: person, onReject: "terminal", maxRounds: 2 }
      }
    ],
    edges: [
      ...isQuestion.edges,
      { edgeId: "draft-answer.drafted", from: "draft-answer", when: { outcome: "drafted" }, to: ["compose-reply"] }
    ],
    terminals: [...isQuestion.terminals, { nodeId: "compose-reply", outcome: "composed" }]
  });
}

const reworkInputs = [];
const compose = async (input, context) => {
  const rework = context.inputArtifact.contractId === SWITCHYARD_REWORK_CONTRACT;
  if (rework) reworkInputs.push(input);
  const draft = rework ? input.input.payload : input;
  const notes = rework ? latestReviewNotes(input) : undefined;
  return {
    outcome: "composed",
    outputArtifact: createArtifactEnvelope("reply.v1", { body: `${draft.answer}${notes ? ` [${notes}]` : ""}` })
  };
};

const model = fakeModelPort({
  "is-question": (input) => (input.text.endsWith("?") ? "yes" : /buy now/i.test(input.text) ? "no" : "unsure"),
  "draft-answer::approval": (input) => (/@/.test(input.text) ? "denied" : "approved"),
  "draft-answer": async (input) => ({
    outcome: "drafted",
    outputArtifact: createArtifactEnvelope("draft.v1", { question: input.text, answer: `echo: ${input.text}` })
  })
});

function harness(graph = firstGraph()) {
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const now = () => new Date((clock += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({ graphStore, now });
  const ports = withApprovalReviewPorts(
    { code: codeNodePortByNode({ "compose-reply": compose, "compose-reply::rework": compose }), model },
    { graphs: [graph] }
  );
  return {
    graph,
    unitStore,
    ports,
    now,
    async admit(unitId, text) {
      await graphStore.publishGraph(graph);
      return unitStore.admitUnit({
        unitId,
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope("ticket.v1", { text }),
        admittedAt: now().toISOString(),
        principalId: "admitter"
      });
    },
    async decide(unitId, nodeId, answer, notes) {
      const [queued] = (await unitStore.listQueuedUnits({ principalId: "console", nodeId }))
        .filter((entry) => entry.unitId === unitId);
      assert.ok(humanNodeAnswers(graph, nodeId).includes(answer));
      const decision = approvalReviewHumanDecision(graph, {
        queued,
        outcome: answer,
        ...(notes === undefined ? {} : { outputArtifact: reviewNotes(notes) }),
        actor: { actorId: "alice" }
      });
      return recordHumanNodeDecision({ store: unitStore, principalId: "console", decision, now });
    },
    async path(unitId) {
      return (await unitStore.readJourney({ unitId }))
        .filter((record) => record.kind === "turn_settled")
        .map((record) => `${record.nodeId}:${record.outcome}`);
    }
  };
}

test("the test graph is the guide's graph: same sealed digest as docs/FIRST-GRAPH.md shows", async () => {
  const guide = await readFile(new URL("../docs/FIRST-GRAPH.md", import.meta.url), "utf8");
  const shown = guide.match(/graph first-switchyard v1, digest ([0-9a-f]{16})\.\.\./);
  assert.ok(shown, "the guide shows the graph digest");
  assert.equal(firstGraph().graphDigest.slice(0, 16), shown[1]);
});

test("workerPrincipals lists code/model/agent principals once, in node order, and skips people", () => {
  assert.deepEqual(workerPrincipals([firstGraph()]), ["local-model", "cloud-model", "worker"]);
  assert.deepEqual(workerPrincipals([]), []);
  assert.throws(() => workerPrincipals("nope"), /must be an array/);
});

test("runWorker drives the first graph: triage, PII screen, review with rework, and escalation to a person", async () => {
  const h = harness();
  await h.admit("u1", "What are your opening hours?");
  await h.admit("u2", "My email is jane@example.com, why was I charged twice?");
  await h.admit("u3", "I need to talk to someone about my order");
  await h.admit("u4", "Buy now! Cheap watches");

  const seen = [];
  const first = await runWorker({
    store: h.unitStore,
    ports: h.ports,
    graphs: [h.graph],
    leaseOwner: "test-worker",
    untilIdle: true,
    now: h.now,
    onSettled: ({ principalId, claim, result }) => {
      seen.push(`${principalId}/${claim.unitId}/${claim.nodeId}/${result.value.completion.outcome}`);
    }
  });
  assert.deepEqual({ ...first }, { passes: 3, turns: 8, succeeded: 8, terminal: 0, rejected: 0, stoppedBy: "idle" });
  assert.deepEqual(seen, [
    "local-model/u1/is-question/yes",
    "local-model/u2/is-question/yes",
    "local-model/u3/is-question/unsure",
    "local-model/u4/is-question/no",
    "local-model/u1/draft-answer::approval/approved",
    "local-model/u2/draft-answer::approval/denied",
    "cloud-model/u1/draft-answer/drafted",
    "worker/u1/compose-reply/composed"
  ]);

  assert.deepEqual(humanNodeAnswers(h.graph, "is-question.escalate-1"), ["yes", "no"]);
  assert.deepEqual(humanNodeAnswers(h.graph, "compose-reply::review"), ["accepted", "rejected"]);
  await h.decide("u3", "is-question.escalate-1", "yes");
  await h.decide("u1", "compose-reply::review", "rejected", "Say when we open.");
  const second = await runWorker({ store: h.unitStore, ports: h.ports, principals: ["local-model", "cloud-model", "worker"], leaseOwner: "w", untilIdle: true, batch: 1, now: h.now });
  assert.equal(second.turns, 4);
  await h.decide("u1", "compose-reply::review", "accepted");
  await h.decide("u3", "compose-reply::review", "accepted");

  assert.deepEqual(await h.path("u1"), [
    "is-question:yes",
    "draft-answer::approval:approved",
    "draft-answer:drafted",
    "compose-reply:composed",
    "compose-reply::review:rework",
    "compose-reply::rework:composed",
    "compose-reply::review:accepted:composed"
  ]);
  assert.deepEqual(await h.path("u2"), ["is-question:yes", "draft-answer::approval:denied"]);
  assert.deepEqual(await h.path("u3"), [
    "is-question:unsure",
    "is-question.escalate-1:yes",
    "draft-answer::approval:approved",
    "draft-answer:drafted",
    "compose-reply:composed",
    "compose-reply::review:accepted:composed"
  ]);
  assert.deepEqual(await h.path("u4"), ["is-question:no"]);
  const accepted = (await h.unitStore.readJourney({ unitId: "u1" })).at(-1);
  const reply = await h.unitStore.getArtifact({ artifact: accepted.outputArtifact });
  assert.equal(reply.payload.body, "echo: What are your opening hours? [Say when we open.]");
});

test("runWorker counts terminal turns and keeps going", async () => {
  const h = harness();
  const bare = withApprovalReviewPorts(
    { code: codeNodePortByNode({}), model: fakeModelPort({ "is-question": "yes" }) },
    { graphs: [h.graph] }
  );
  await h.admit("u1", "Hello?");
  const settled = [];
  const result = await runWorker({
    store: h.unitStore,
    ports: bare,
    graphs: [h.graph],
    leaseOwner: "w",
    untilIdle: true,
    now: h.now,
    onSettled: async (settlement) => {
      settled.push(settlement.result.value.status === "terminal" ? settlement.result.value.errorCode : "ok");
    }
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.terminal, 1);
  assert.deepEqual(settled, ["ok", "immutable_configuration_rejected"]);
});

test("runWorker sleeps when idle and stops on its signal", async () => {
  const h = harness();
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  const started = Date.now();
  const result = await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", idleMs: 5, signal: stop.signal });
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.turns, 0);
  assert.ok(result.passes >= 2, `expected several idle passes, got ${result.passes}`);
  assert.ok(Date.now() - started < 5_000);

  const aborted = new AbortController();
  aborted.abort();
  const none = await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", signal: aborted.signal });
  assert.deepEqual({ ...none }, { passes: 0, turns: 0, succeeded: 0, terminal: 0, rejected: 0, stoppedBy: "signal" });

  const long = new AbortController();
  setTimeout(() => long.abort(), 20);
  const woke = Date.now();
  await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", idleMs: 3_600_000, signal: long.signal });
  assert.ok(Date.now() - woke < 5_000, "the signal wakes an idle sleep");
});

test("runWorker validates its input", async () => {
  const h = harness();
  const base = { store: h.unitStore, ports: h.ports, leaseOwner: "w", untilIdle: true };
  await assert.rejects(runWorker(base), /needs principals or graphs/);
  await assert.rejects(runWorker({ ...base, principals: [] }), /names no worker principal/);
  await assert.rejects(runWorker({ ...base, principals: ["bad id"] }), /principals\[0\]/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], batch: 257 }), /batch must be 1\.\.256/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], idleMs: 0 }), /idleMs/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], untilIdle: "yes" }), /untilIdle/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], onSettled: 1 }), /onSettled/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], extra: 1 }), /unknown key/);
  await assert.rejects(runWorker({ ...base, principals: ["w"], signal: {} }), /AbortSignal/);
});

test("fakeModelPort answers per node with a valid no-telemetry receipt", async () => {
  const context = (nodeId) => ({ nodeId });
  const port = fakeModelPort({
    plain: "yes",
    object: { outcome: "drafted", outputArtifact: createArtifactEnvelope("draft.v1", { a: 1 }) },
    fn: async (input, turnContext) => `${input.n}-${turnContext.nodeId}`
  });
  const plain = await port.invoke({}, SMALL, context("plain"));
  assert.equal(plain.outcome, "yes");
  assert.deepEqual(validateUsageReceipt(plain.usage[0]), plain.usage[0]);
  assert.equal(plain.usage[0].trust, "unavailable");
  assert.equal((await port.invoke({}, SMALL, context("object"))).outputArtifact.contractId, "draft.v1");
  assert.equal((await port.invoke({ n: 3 }, SMALL, context("fn"))).outcome, "3-fn");
  await assert.rejects(port.invoke({}, SMALL, context("missing")), (error) =>
    error.code === "immutable_configuration_rejected" && error.retryable === false);
  assert.throws(() => fakeModelPort({ n: 1 }), /must be an outcome/);
  assert.throws(() => fakeModelPort(null), /plain non-Proxy/);
  assert.throws(() => fakeModelPort({ "bad id": "yes" }), /node id/);
});

test("unavailableUsageReceipt charges the floor and validates", () => {
  assert.deepEqual(validateUsageReceipt(unavailableUsageReceipt(12)), unavailableUsageReceipt(12));
  assert.equal(unavailableUsageReceipt().durationMs, 0);
  assert.throws(() => unavailableUsageReceipt(-1), /durationMs/);
  assert.throws(() => unavailableUsageReceipt(1.5), /durationMs/);
});

test("humanNodeAnswers gives the answers people give at each kind of node", () => {
  const graph = firstGraph();
  assert.deepEqual(humanNodeAnswers(graph, "draft-answer::approval"), ["approved", "denied"]);
  assert.deepEqual(humanNodeAnswers(graph, "compose-reply::review"), ["accepted", "rejected"]);
  assert.deepEqual(humanNodeAnswers(graph, "compose-reply::rework"), ["composed"]);
  assert.deepEqual(humanNodeAnswers(graph, "compose-reply"), ["composed"]);
  assert.deepEqual(humanNodeAnswers(graph, "is-question"), ["yes", "no", "unsure"]);
  assert.throws(() => humanNodeAnswers(graph, "nope"), /has no node "nope"/);
});

test("the review and rework records have the shape docs/FIRST-GRAPH.md documents", async () => {
  const h = harness();
  await h.admit("u1", "What are your opening hours?");
  await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", untilIdle: true, now: h.now });
  const [request] = await h.unitStore.listQueuedUnits({ principalId: "console", nodeId: "compose-reply::review" });
  assert.equal(request.inputArtifact.contractId, SWITCHYARD_REVIEW_REQUEST_CONTRACT);
  const review = request.inputArtifact.payload;
  assert.deepEqual(Object.keys(review).sort(), ["history", "input", "maxRounds", "outcome", "output", "round", "schemaVersion", "subject"]);
  assert.deepEqual(review.subject, { nodeId: "compose-reply", nodeRef: { id: "first.compose-reply", version: 1 } });
  assert.equal(review.round, 1);
  assert.equal(review.maxRounds, 2);
  assert.equal(review.outcome, "composed");
  assert.equal(review.input.contractId, "draft.v1");
  assert.equal(review.input.payload.question, "What are your opening hours?");
  assert.equal(review.output.contractId, "reply.v1");
  assert.equal(review.output.payload.body, "echo: What are your opening hours?");
  assert.deepEqual(review.history, []);
  assert.equal(latestReviewNotes(review), undefined);

  reworkInputs.length = 0;
  await h.decide("u1", "compose-reply::review", "rejected", "Say when we open.");
  await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", untilIdle: true, now: h.now });
  const [rework] = reworkInputs;
  assert.deepEqual(Object.keys(rework).sort(), ["history", "input", "maxRounds", "round", "schemaVersion", "subject"]);
  assert.equal(rework.schemaVersion, SWITCHYARD_REWORK_CONTRACT);
  assert.equal(rework.round, 2);
  assert.deepEqual(rework.input, review.input);
  assert.equal(rework.history.length, 1);
  assert.equal(rework.history[0].round, 1);
  assert.equal(rework.history[0].output.payload.body, "echo: What are your opening hours?");
  assert.equal(rework.history[0].feedback.contractId, SWITCHYARD_REVIEW_NOTES_CONTRACT);
  assert.equal(latestReviewNotes(rework), "Say when we open.");

  const [second] = await h.unitStore.listQueuedUnits({ principalId: "console", nodeId: "compose-reply::review" });
  assert.equal(second.inputArtifact.payload.round, 2);
  assert.equal(latestReviewNotes(second.inputArtifact.payload), "Say when we open.");
});

test("latestReviewNotes reads only reviewNotes feedback", () => {
  const entry = (feedback) => ({ history: [{ round: 1, outcome: "composed", output: {}, feedback }] });
  assert.equal(latestReviewNotes({ history: [] }), undefined);
  assert.equal(latestReviewNotes(entry(null)), undefined);
  assert.equal(latestReviewNotes(entry({ contractId: "other.v1", digest: "x", payload: { notes: "no" } })), undefined);
  assert.equal(latestReviewNotes(entry({ contractId: SWITCHYARD_REVIEW_NOTES_CONTRACT, digest: "x", payload: { notes: "yes" } })), "yes");
  assert.throws(() => latestReviewNotes(null), /review or rework record/);
});

test("a mistyped human answer names the answers the node takes, and is not called a body result", async () => {
  const h = harness();
  await h.admit("u1", "What are your opening hours?");
  await h.admit("u3", "I need to talk to someone about my order");
  await runWorker({ store: h.unitStore, ports: h.ports, graphs: [h.graph], leaseOwner: "w", untilIdle: true, now: h.now });
  const queued = async (nodeId) => (await h.unitStore.listQueuedUnits({ principalId: "console", nodeId }))[0];
  const review = await queued("compose-reply::review");
  const escalation = await queued("is-question.escalate-1");
  const answer = (turn, outcome) => () => approvalReviewHumanDecision(h.graph, { queued: turn, outcome, actor: { actorId: "alice" } });
  assert.throws(answer(review, "accept"), (error) => {
    assert.equal(
      error.message,
      'human answer at node compose-reply::review: "accept" is not an answer here; answer one of accepted | rejected'
    );
    return true;
  });
  assert.throws(answer(escalation, "yess"), /human answer at node is-question\.escalate-1: "yess" is not an answer here; answer one of yes \| no$/);
  assert.throws(answer(review, 7), /number is not an answer here/);
  // A reviewer body's wrong answer still says "body result" and lists the node's outcomes.
  assert.throws(
    () => applyApprovalReviewCompletion(h.graph, { nodeId: "compose-reply::review", inputArtifact: review.inputArtifact, completion: { outcome: "accept" } }),
    /node compose-reply::review body result: node compose-reply::review returned undeclared outcome "accept" \(its outcomes: accepted \| rejected\)/
  );
});

test("re-admitting a unit id: identical admissions replay, others name what differs", async () => {
  const h = harness();
  await h.admit("u1", "Hello?");
  const input = (overrides) => ({
    unitId: "u9",
    graph: graphDefinitionRef(h.graph),
    seedArtifact: createArtifactEnvelope("ticket.v1", { text: "Hello?" }),
    admittedAt: "2026-09-30T12:00:00.000Z",
    principalId: "admitter",
    ...overrides
  });
  assert.equal((await h.unitStore.admitUnit(input({}))).created, true);
  assert.equal((await h.unitStore.admitUnit(input({}))).created, false);
  await assert.rejects(h.unitStore.admitUnit(input({ admittedAt: "2026-09-30T12:00:01.000Z" })), (error) => {
    assert.ok(error instanceof TurnEvidenceConflictError);
    assert.match(error.message, /^admitUnit: unit u9 conflicts with immutable admission [0-9a-f]{64}; requested [0-9a-f]{64}/);
    assert.match(error.message, /differs in admittedAt: stored 2026-09-30T12:00:00\.000Z, requested 2026-09-30T12:00:01\.000Z\)/);
    assert.match(error.message, /returns created: false only when graph, seed artifact, admittedAt and principalId are all identical/);
    return true;
  });
  await assert.rejects(
    h.unitStore.admitUnit(input({ seedArtifact: createArtifactEnvelope("ticket.v1", { text: "Other" }), principalId: "someone" })),
    /differs in seed artifact: stored ticket\.v1 [0-9a-f]{12}, requested ticket\.v1 [0-9a-f]{12}; principalId: stored admitter, requested someone\)/
  );
});

test("usage receipts: what the guide's fake and real model ports return is what validation accepts", () => {
  // Fake (no telemetry): trust unavailable must charge at least 1 token and 1 micro-USD.
  const fake = unavailableUsageReceipt(3);
  assert.equal(fake.trust, "unavailable");
  assert.equal(fake.chargedTokens, 1);
  assert.equal(fake.chargedCostMicroUsd, 1);
  assert.deepEqual(validateUsageReceipt(fake), fake);
  assert.throws(() => validateUsageReceipt({ ...fake, chargedTokens: 0 }), /must charge at least 1 token/);
  assert.throws(() => validateUsageReceipt({ ...fake, chargedCostMicroUsd: 0 }), /must charge at least 1 micro-USD/);

  // Real (the server reported its token counts): charged = observed sum, a local server may charge 0 micro-USD.
  const real = providerReportedUsageReceipt({ inputTokens: 20, outputTokens: 3, chargedCostMicroUsd: 0, durationMs: 40 });
  assert.deepEqual({ ...real }, {
    schemaVersion: "usage-receipt.v1",
    trust: "provider_reported",
    observedInputTokens: 20,
    observedOutputTokens: 3,
    chargedTokens: 23,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 0,
    durationMs: 40
  });
  assert.deepEqual(validateUsageReceipt(real), real);
  // A server that reports zero tokens is still an observation; zero is accepted.
  assert.equal(providerReportedUsageReceipt({ inputTokens: 0, outputTokens: 0, chargedCostMicroUsd: 0 }).chargedTokens, 0);
  // A hosted API's price goes in chargedCostMicroUsd.
  assert.equal(providerReportedUsageReceipt({ inputTokens: 1000, outputTokens: 200, chargedCostMicroUsd: 450 }).chargedCostMicroUsd, 450);
  assert.throws(() => providerReportedUsageReceipt({ inputTokens: -1, outputTokens: 0, chargedCostMicroUsd: 0 }), /inputTokens/);
  assert.throws(() => providerReportedUsageReceipt({ inputTokens: 1, outputTokens: 0 }), /chargedCostMicroUsd/);
  assert.throws(() => providerReportedUsageReceipt({ inputTokens: 1, outputTokens: 0, chargedCostMicroUsd: -1 }), /chargedCostMicroUsd/);
});

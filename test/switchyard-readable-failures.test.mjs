// Readable failures (2.4.0): a failure's message travels with its code into
// the terminal turn result, the failure evidence the store records and the
// failure outbox context; fakeModelPort names the node it has no rule for;
// runWorker leaves units of a graph version it was not given waiting instead
// of running them with the wrong ports; withApprovalReviewPorts and
// publishGraph say which version is missing or must change.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ExecutionFailureError,
  GraphPublicationConflictError,
  NODE_TURN_IDEMPOTENCY,
  NODE_TURN_RETRY_TAXONOMY,
  SWITCHYARD_REWORK_CONTRACT,
  SWITCHYARD_WORKER_GRAPH_NOT_GIVEN_WARNING,
  approvalReviewHumanDecision,
  classifyExecutionFailure,
  codeNodePortByNode,
  createArtifactEnvelope,
  createGraphDefinition,
  digest,
  fakeModelPort,
  graphDefinitionRef,
  recordHumanNodeDecision,
  reviewNotes,
  runNextUnitTurn,
  runWorker,
  withApprovalReviewPorts
} from "@scshafe/switchyard";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";

const turn = { idempotency: NODE_TURN_IDEMPOTENCY, retryTaxonomy: NODE_TURN_RETRY_TAXONOMY, leaseMs: 30_000, maxAttempts: 3 };
const SMALL = { kind: "model", bindingId: "small-local", version: 1, bindingDigest: digest({ model: "small" }) };
const person = { kind: "human", principal: { id: "console" } };

// draft (model) -> compose (code, reviewed by a person) -> done
function replyGraph({ version = 1, maxRounds = 2, extraModelNode = false } = {}) {
  const nodes = [
    {
      nodeId: "draft",
      ref: { id: "t.draft", version: 1 },
      kind: "model",
      input: "ticket.v1",
      outcomes: { version: 1, outcomes: ["drafted"] },
      outputs: { drafted: "draft.v1" },
      principal: { id: "local-model" },
      binding: SMALL,
      turn
    },
    {
      nodeId: "compose",
      ref: { id: "t.compose", version: 1 },
      kind: "code",
      input: "draft.v1",
      outcomes: { version: 1, outcomes: ["composed"] },
      outputs: { composed: "reply.v1" },
      principal: { id: "worker" },
      turn,
      review: { by: person, onReject: "terminal", maxRounds }
    }
  ];
  const edges = [{ edgeId: "draft.drafted", from: "draft", when: { outcome: "drafted" }, to: ["compose"] }];
  let entry = "draft";
  if (extraModelNode) {
    nodes.unshift({
      nodeId: "screen",
      ref: { id: "t.screen", version: 1 },
      kind: "model",
      input: "ticket.v1",
      outcomes: { version: 1, outcomes: ["ok"] },
      principal: { id: "local-model" },
      binding: SMALL,
      turn
    });
    edges.push({ edgeId: "screen.ok", from: "screen", when: { outcome: "ok" }, to: ["draft"] });
    entry = "screen";
  }
  return createGraphDefinition({
    graphId: "readable",
    version,
    description: "Draft a reply, compose it, have a person review it.",
    entry,
    nodes,
    edges,
    terminals: [{ nodeId: "compose", outcome: "composed" }]
  });
}

const compose = async (input, context) => {
  const draft = context.inputArtifact.contractId === SWITCHYARD_REWORK_CONTRACT ? input.input.payload : input;
  return { outcome: "composed", outputArtifact: createArtifactEnvelope("reply.v1", { body: `re: ${draft.text}` }) };
};
const model = fakeModelPort({
  draft: (input) => ({ outcome: "drafted", outputArtifact: createArtifactEnvelope("draft.v1", { text: input.text }) })
});
const code = codeNodePortByNode({ compose, "compose::rework": compose });

function stores() {
  let clock = Date.parse("2026-09-30T10:00:00.000Z");
  const now = () => new Date((clock += 1_000));
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({ graphStore, now });
  return {
    graphStore,
    unitStore,
    now,
    async admit(graph, unitId, text = "hello?") {
      await graphStore.publishGraph(graph);
      await unitStore.admitUnit({
        unitId,
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope("ticket.v1", { text }),
        admittedAt: now().toISOString(),
        principalId: "admitter"
      });
    },
    async reject(graph, unitId, notes) {
      const [queued] = (await unitStore.listQueuedUnits({ principalId: "console", nodeId: "compose::review" }))
        .filter((entry) => entry.unitId === unitId);
      const decision = approvalReviewHumanDecision(graph, {
        queued,
        outcome: "rejected",
        outputArtifact: reviewNotes(notes),
        actor: { actorId: "alice" }
      });
      return recordHumanNodeDecision({ store: unitStore, principalId: "console", decision, now });
    },
    async open(unitId) {
      const journey = await unitStore.readJourney({ unitId });
      return journey.filter((record) => record.kind === "turn_failed");
    }
  };
}

test("ExecutionFailureError carries a readable message: given, else its Error cause's, else the code", () => {
  const explicit = new ExecutionFailureError("provider_refused", false, undefined, "the provider refused the prompt");
  assert.equal(explicit.message, "the provider refused the prompt");
  assert.equal(explicit.code, "provider_refused");
  assert.deepEqual(classifyExecutionFailure(explicit), { code: "provider_refused", retryable: false });

  const fromCause = new ExecutionFailureError("model_unreachable", true, new TypeError("fetch failed"));
  assert.equal(fromCause.message, "fetch failed");
  assert.equal(fromCause.cause.message, "fetch failed");

  assert.equal(new ExecutionFailureError("plain_code", true).message, "plain_code");
  assert.equal(new ExecutionFailureError("string_cause", true, "not an error").message, "string_cause");
  assert.equal(new ExecutionFailureError("empty", true, new Error("")).message, "empty");
  const hostile = new Proxy(new Error("trap"), { get() { throw new Error("trap ran"); }, getPrototypeOf() { throw new Error("trap ran"); } });
  assert.equal(new ExecutionFailureError("proxied", false, hostile).message, "proxied");
  const accessor = Object.defineProperty(new Error("x"), "message", { get() { throw new Error("getter ran"); } });
  assert.equal(new ExecutionFailureError("accessor", false, accessor).message, "accessor");
});

test("fakeModelPort names the node it has no rule for, and the rules it has", async () => {
  const port = fakeModelPort({ "is-question": "yes", "draft-answer": "drafted" });
  await assert.rejects(
    port.invoke({ text: "hi" }, SMALL, { nodeId: "in-scope" }),
    (error) => {
      assert.equal(error.code, "immutable_configuration_rejected");
      assert.equal(error.retryable, false);
      assert.equal(
        error.message,
        'no fake-model rule for node "in-scope"; it has rules for "is-question", "draft-answer". Add a rule keyed by the node id to fakeModelPort({ ... })'
      );
      return true;
    }
  );
  await assert.rejects(fakeModelPort({}).invoke({}, SMALL, { nodeId: "x" }), /no fake-model rule for node "x"; it has none/);
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`node-${index}-${"n".repeat(20)}`, "ok"]));
  await assert.rejects(fakeModelPort(many).invoke({}, SMALL, { nodeId: "missing" }), (error) => {
    assert.ok(error.message.length <= 1_000);
    assert.ok(error.message.endsWith("..."));
    return true;
  });
});

test("a terminal turn result, the failure outbox context and the recorded failure carry the message", async () => {
  const graph = replyGraph({ extraModelNode: true });
  const h = stores();
  await h.admit(graph, "u1");
  const contexts = [];
  const result = await runNextUnitTurn({
    store: h.unitStore,
    principalId: "local-model",
    leaseOwner: "w",
    ports: { model },
    failureOutboxEvents(context) {
      contexts.push(context);
      return [];
    },
    now: h.now
  });
  const message = 'no fake-model rule for node "screen"; it has rules for "draft". Add a rule keyed by the node id to fakeModelPort({ ... })';
  assert.equal(result.status, "terminal");
  assert.equal(result.errorCode, "immutable_configuration_rejected");
  assert.equal(result.errorMessage, message);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].errorMessage, message);
  const [failure] = await h.open("u1");
  assert.equal(failure.errorCode, "immutable_configuration_rejected");
  assert.equal(failure.errorMessage, message);
  assert.equal(failure.terminal, true);
});

test("runWorker leaves units of a graph version it was not given waiting, says so, and runs them once given", async () => {
  const v1 = replyGraph({ version: 1, maxRounds: 2 });
  const v2 = replyGraph({ version: 2, maxRounds: 3 });
  const h = stores();
  const portsFor = (graphs) => withApprovalReviewPorts({ code, model }, { graphs });
  await h.admit(v1, "old");
  await runWorker({ store: h.unitStore, ports: portsFor([v1]), graphs: [v1], leaseOwner: "w1", untilIdle: true, now: h.now });
  await h.reject(v1, "old", "shorter, please");
  await h.admit(v2, "new");

  // A worker given only v2: it runs "new" to the review, and withholds the
  // rework of "old" (on v1) instead of failing it.
  const skipped = [];
  const settled = [];
  const onlyV2 = await runWorker({
    store: h.unitStore,
    ports: portsFor([v2]),
    graphs: [v2],
    leaseOwner: "w2",
    untilIdle: true,
    now: h.now,
    onSettled: ({ claim, result }) => settled.push(`${claim.unitId}/${claim.nodeId}/${result.value.status}`),
    onSkipped: (turn) => skipped.push(turn)
  });
  assert.deepEqual(settled, ["new/draft/succeeded", "new/compose/succeeded"]);
  assert.equal(onlyV2.skipped, 1);
  assert.equal(onlyV2.terminal, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].principalId, "worker");
  assert.equal(skipped[0].unitId, "old");
  assert.equal(skipped[0].nodeId, "compose::rework");
  assert.deepEqual({ ...skipped[0].graph }, { graphId: "readable", version: 1, digest: v1.graphDigest });
  assert.deepEqual([...skipped[0].given], ["readable v2"]);
  assert.equal(
    skipped[0].message,
    "unit old waits at compose::rework: it runs on graph readable v1, which this worker was not given (it has readable v2). "
    + "Pass that version in the worker's graphs to run it."
  );
  assert.deepEqual(await h.open("old"), [], "nothing was recorded for the withheld turn");

  // Its lease lapses, and the turn is queued as before.
  for (let index = 0; index < 40; index += 1) h.now();
  const [waiting] = (await h.unitStore.listQueuedUnits({ principalId: "worker", nodeId: "compose::rework" }));
  assert.equal(waiting.unitId, "old");

  // A worker given both versions runs it on v1.
  const both = [];
  const all = await runWorker({
    store: h.unitStore,
    ports: portsFor([v2, v1]),
    graphs: [v2, v1],
    leaseOwner: "w3",
    untilIdle: true,
    now: h.now,
    onSettled: ({ claim, result }) => both.push(`${claim.unitId}/${claim.nodeId}/${result.value.status}`)
  });
  assert.deepEqual(both, ["old/compose::rework/succeeded"]);
  assert.equal(all.skipped, 0);
  const [review] = (await h.unitStore.listQueuedUnits({ principalId: "console", nodeId: "compose::review" }))
    .filter((entry) => entry.unitId === "old");
  assert.equal(review.inputArtifact.payload.round, 2);
  assert.equal(review.inputArtifact.payload.maxRounds, 2, "the v1 unit keeps v1's two rounds");
});

test("without onSkipped, runWorker emits one process warning per graph version it was not given", async () => {
  const v1 = replyGraph({ version: 1 });
  const v2 = replyGraph({ version: 2 });
  const h = stores();
  await h.admit(v1, "a");
  await h.admit(v1, "b");
  const warnings = [];
  const listener = (warning) => warnings.push(warning);
  process.on("warning", listener);
  try {
    const result = await runWorker({
      store: h.unitStore,
      ports: withApprovalReviewPorts({ code, model }, { graphs: [v2] }),
      graphs: [v2],
      leaseOwner: "w",
      untilIdle: true,
      now: h.now
    });
    assert.equal(result.skipped, 2);
    assert.equal(result.turns, 0);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", listener);
  }
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, SWITCHYARD_WORKER_GRAPH_NOT_GIVEN_WARNING);
  assert.match(warnings[0].message, /^unit a waits at draft: it runs on graph readable v1, which this worker was not given \(it has readable v2\)/);

  // Without graphs (principals only) every claimed turn runs, as before.
  for (let index = 0; index < 40; index += 1) h.now();
  const any = await runWorker({
    store: h.unitStore,
    ports: withApprovalReviewPorts({ code, model }, { graphs: [v1] }),
    principals: ["local-model", "worker"],
    leaseOwner: "w",
    untilIdle: true,
    now: h.now
  });
  assert.equal(any.skipped, 0);
  assert.equal(any.succeeded, 4);
});

test("withApprovalReviewPorts fails a review or rework turn of a version it was not given, naming it, before the body runs", async () => {
  const v1 = replyGraph({ version: 1 });
  const v2 = replyGraph({ version: 2 });
  const h = stores();
  await h.admit(v1, "old");
  await runWorker({ store: h.unitStore, ports: withApprovalReviewPorts({ code, model }, { graphs: [v1] }), graphs: [v1], leaseOwner: "w", untilIdle: true, now: h.now });
  await h.reject(v1, "old", "again");
  let ran = 0;
  const counting = codeNodePortByNode({ compose, "compose::rework": async (...args) => { ran += 1; return compose(...args); } });
  const results = [];
  // The worker runs both versions, but the ports were built for v2 only.
  await runWorker({
    store: h.unitStore,
    ports: withApprovalReviewPorts({ code: counting, model }, { graphs: [v2] }),
    graphs: [v2, v1],
    leaseOwner: "w",
    untilIdle: true,
    now: h.now,
    onSettled: ({ result }) => results.push(result.value)
  });
  assert.equal(ran, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "terminal");
  assert.equal(results[0].errorCode, "immutable_stage_contract_rejected");
  assert.equal(
    results[0].errorMessage,
    "withApprovalReviewPorts was not given graph readable v1, the version unit old runs on, so it cannot build the record for "
    + "compose::rework (it has readable v2). Pass every graph version with units in flight in options.graphs"
  );
});

test("publishing a changed graph under a published version says to give it a new version", async () => {
  const graphStore = new MemoryGraphStore();
  await graphStore.publishGraph(replyGraph({ version: 1, maxRounds: 2 }));
  await assert.rejects(graphStore.publishGraph(replyGraph({ version: 1, maxRounds: 3 })), (error) => {
    assert.ok(error instanceof GraphPublicationConflictError);
    assert.match(error.message, /^publishGraph: graph readable@1 is already published with digest [0-9a-f]{64}; requested digest [0-9a-f]{64} conflicts with immutable evidence\. /);
    assert.match(error.message, /A published version never changes: publish the changed graph under a new version \(units admitted to readable@1 keep running on it\)$/);
    return true;
  });
});

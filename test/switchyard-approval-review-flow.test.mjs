// Approval before and review after, end to end through the memory unit store.

import test from "node:test";
import assert from "node:assert/strict";

import { reviewNotes } from "@scshafe/switchyard/execute/approval-review";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";
import {
  ACTORS,
  BINDINGS,
  CONTRACTS,
  PRINCIPALS,
  TURN,
  answer,
  createHarness,
  fanoutDraft,
  node,
  qaDraft,
  seal
} from "./fixtures/switchyard/approval-review-fixtures.mjs";

const clone = (value) => structuredClone(value);
const MODEL_REVIEW = Object.freeze({ by: ACTORS.reviewer, onReject: "terminal" });

/** The draft body: first attempts answer v1; a rework answers the latest notes. */
const drafting = (input, context) => {
  if (!context.nodeId.endsWith("::rework")) return { outcome: "done", outputArtifact: answer({ text: "Lyon", round: 1 }) };
  assert.equal(context.inputArtifact.contractId, "switchyard.rework.v1");
  const latest = input.history.at(-1);
  return {
    outcome: "done",
    outputArtifact: answer({ text: "Paris", round: input.round, addressed: latest.feedback?.payload.notes ?? null })
  };
};

const reject = (notes) => () => ({ outcome: "rejected", outputArtifact: reviewNotes(notes) });

test("approval: a model approver denies and the node never runs", async () => {
  const graph = seal(qaDraft({ approval: { by: ACTORS.screen, onDeny: "terminal" } }));
  const harness = createHarness({ graph, models: { "draft::approval": "denied", draft: drafting } });
  const admitted = await harness.admit();
  assert.equal(admitted.entryQueue.nodeId, "draft::approval");
  await harness.drain();
  assert.deepEqual(await harness.path(), ["draft::approval:denied"]);
  assert.deepEqual(harness.modelLog.map((call) => call.nodeId), ["draft::approval"]);
  assert.equal(harness.modelLog[0].bindingId, BINDINGS.local.bindingId);
  // The approver saw exactly the node's input.
  const [approval] = await harness.settled("draft::approval");
  assert.equal(approval.principalId, PRINCIPALS.screen);
  assert.equal(approval.inputArtifact.contractId, CONTRACTS.question);
  assert.equal(approval.inputArtifact.digest, (await harness.journey())[0].seedArtifact.digest);
  assert.deepEqual(harness.modelLog[0].input, { question: "What is the capital of France?" });
  assert.deepEqual(await harness.openQueues(), []);
  assert.deepEqual(await harness.settled("draft"), []);
});

test("approval: a denial can route to a named node that receives the input", async () => {
  const graph = seal(qaDraft({ approval: { by: ACTORS.screen, onDeny: { to: "refused" } } }));
  const harness = createHarness({
    graph,
    models: { "draft::approval": "denied" },
    code: { refused: async () => ({ outcome: "noted" }) }
  });
  await harness.admit();
  await harness.drain();
  assert.deepEqual(await harness.path(), ["draft::approval:denied", "refused:noted"]);
  assert.deepEqual(harness.codeLog[0].input, { question: "What is the capital of France?" });
});

test("approval: a person approves and the node runs on the approved input", async () => {
  const graph = seal(qaDraft({ approval: { by: ACTORS.human, onDeny: "terminal" } }));
  const harness = createHarness({
    graph,
    models: { draft: drafting },
    code: { publish: async () => ({ outcome: "published" }) }
  });
  await harness.admit();
  assert.deepEqual(await harness.drain(), []);
  assert.deepEqual(await harness.openQueues(), [`draft::approval<${CONTRACTS.question}>`]);
  const decided = await harness.decide("draft::approval", "approved", { actorId: "approver-7" });
  assert.equal(decided.status, "succeeded");
  await harness.drain();
  assert.deepEqual(await harness.path(), ["draft::approval:approved", "draft:done", "publish:published"]);
  const [approval] = await harness.settled("draft::approval");
  assert.equal(approval.actorId, "approver-7");
  assert.equal(approval.principalId, PRINCIPALS.console);
  const [draft] = await harness.settled("draft");
  assert.equal(draft.inputArtifact.digest, approval.inputArtifact.digest);
  assert.deepEqual(await harness.openQueues(), []);
});

test("review: a model rejects twice, the node reworks with the notes, then rejected routes per onReject", async () => {
  const graph = seal(qaDraft({ review: { by: ACTORS.reviewer, onReject: { to: "escalate" } } }));
  const harness = createHarness({
    graph,
    models: {
      draft: drafting,
      "draft::rework": drafting,
      "draft::review": [reject("Lyon is not the capital."), reject("Cite a source.")]
    }
  });
  await harness.admit();
  await harness.drain();
  assert.deepEqual(await harness.path(), [
    "draft:done",
    "draft::review:rework",
    "draft::rework:done",
    "draft::review:rejected"
  ]);
  // Round 2 ran at the twin with the round-1 notes and output in its input.
  const rework = harness.modelLog.find((call) => call.nodeId === "draft::rework");
  assert.equal(rework.contractId, "switchyard.rework.v1");
  assert.equal(rework.input.round, 2);
  assert.equal(rework.input.maxRounds, 2);
  assert.deepEqual(rework.input.input.payload, { question: "What is the capital of France?" });
  assert.deepEqual(rework.input.history.map((entry) => [entry.round, entry.outcome, entry.output.payload.text, entry.feedback.payload.notes]), [
    [1, "done", "Lyon", "Lyon is not the capital."]
  ]);
  // The reviewer saw input + output each round.
  const reviews = harness.modelLog.filter((call) => call.nodeId === "draft::review");
  assert.deepEqual(reviews.map((call) => [call.input.round, call.input.output.payload.text, call.input.history.length]), [[1, "Lyon", 0], [2, "Paris", 1]]);
  assert.deepEqual(reviews[1].input.output.payload.addressed, "Lyon is not the capital.");
  // The final rejection carries the whole record to the named node.
  assert.deepEqual(await harness.openQueues(), ["escalate<switchyard.review-rejected.v1>"]);
  const [, finalReview] = await harness.settled("draft::review");
  const rejected = await harness.artifact(finalReview.outputArtifact);
  assert.equal(rejected.payload.maxRounds, 2);
  assert.deepEqual(rejected.payload.history.map((entry) => entry.feedback.payload.notes), ["Lyon is not the capital.", "Cite a source."]);
  assert.equal(finalReview.principalId, PRINCIPALS.reviewer);
  // Rounds are counted by the journal too: one reviewed settlement per round.
  assert.equal((await harness.settled("draft::review")).length, 2);
  assert.equal((await harness.settled("draft")).length + (await harness.settled("draft::rework")).length, 2);
  const decided = await harness.decide("escalate", "handled");
  assert.equal(decided.status, "succeeded");
  assert.deepEqual(await harness.openQueues(), []);
});

test("review: maxRounds 1 and onReject terminal ends at the first rejection without a twin", async () => {
  const graph = seal(qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal", maxRounds: 1 } }));
  assert.equal(graph.nodes.some((candidate) => candidate.nodeId === "draft::rework"), false);
  const harness = createHarness({ graph, models: { draft: drafting, "draft::review": reject("No.") } });
  await harness.admit();
  await harness.drain();
  assert.deepEqual(await harness.path(), ["draft:done", "draft::review:rejected"]);
  assert.deepEqual(await harness.openQueues(), []);
});

test("review: a person rejects with notes and accepts round 2; publish gets round 2's output unchanged", async () => {
  const graph = seal(qaDraft({ review: { by: ACTORS.human, onReject: "terminal", maxRounds: 3 } }));
  const harness = createHarness({
    graph,
    models: { draft: drafting, "draft::rework": drafting },
    code: { publish: async () => ({ outcome: "published" }) }
  });
  await harness.admit();
  await harness.drain();
  assert.deepEqual(await harness.openQueues(), ["draft::review<switchyard.review-request.v1>"]);
  const [queued] = await harness.unitStore.listQueuedUnits({ principalId: PRINCIPALS.console, nodeId: "draft::review" });
  assert.equal(queued.inputArtifact.payload.output.payload.text, "Lyon");
  assert.deepEqual(queued.inputArtifact.payload.input.payload, { question: "What is the capital of France?" });
  await harness.decide("draft::review", "rejected", { outputArtifact: reviewNotes("Wrong city."), actorId: "editor-1" });
  await harness.drain();
  await harness.decide("draft::review", "accepted", { actorId: "editor-1" });
  await harness.drain();
  assert.deepEqual(await harness.path(), [
    "draft:done",
    "draft::review:rework",
    "draft::rework:done",
    "draft::review:accepted:done",
    "publish:published"
  ]);
  const [reworked] = await harness.settled("draft::rework");
  const request = await harness.artifact(reworked.outputArtifact);
  assert.equal(request.payload.round, 2);
  const [, accepted] = await harness.settled("draft::review");
  assert.equal(accepted.actorId, "editor-1");
  assert.equal(accepted.outputArtifact.contractId, CONTRACTS.answer);
  assert.equal(accepted.outputArtifact.digest, request.payload.output.digest);
  const published = harness.codeLog.find((call) => call.nodeId === "publish");
  assert.deepEqual(published.input, { text: "Paris", round: 2, addressed: "Wrong city." });
});

test("approval and review on the same node: a person approves, a model reviews and accepts", async () => {
  const graph = seal(qaDraft({
    approval: { by: ACTORS.human, onDeny: "terminal" },
    review: { by: ACTORS.reviewer, onReject: "terminal" }
  }));
  const harness = createHarness({
    graph,
    models: { draft: drafting, "draft::review": "accepted" },
    code: { publish: async () => ({ outcome: "published" }) }
  });
  await harness.admit();
  await harness.decide("draft::approval", "approved");
  await harness.drain();
  assert.deepEqual(await harness.path(), [
    "draft::approval:approved",
    "draft:done",
    "draft::review:accepted:done",
    "publish:published"
  ]);
  assert.deepEqual(harness.modelLog.map((call) => call.nodeId), ["draft", "draft::review"]);
  assert.deepEqual(harness.codeLog[0].input, { text: "Lyon", round: 1 });
});

test("review inside a join: the join waits for the review loop and composes the accepted output", async () => {
  const graph = seal(fanoutDraft({ review: MODEL_REVIEW }));
  const harness = createHarness({
    graph,
    models: { left: drafting, "left::rework": drafting, "left::review": [reject("Try again."), "accepted"] },
    code: {
      split: async () => ({ outcome: "go" }),
      right: async () => ({ outcome: "done", outputArtifact: answer({ text: "right" }) }),
      gather: async () => ({ outcome: "gathered" })
    }
  });
  await harness.admit();
  await harness.drain();
  const path = await harness.path();
  assert.deepEqual(path.filter((step) => step.startsWith("left") || step.startsWith("gather")), [
    "left:done",
    "left::review:rework",
    "left::rework:done",
    "left::review:accepted:done",
    "gather:gathered"
  ]);
  const progress = await harness.unitStore.readJoinProgress({ unitId: "unit-1", nodeId: "gather" });
  assert.equal(progress.status, "queued");
  assert.deepEqual(progress.inbound.map((leg) => [leg.edgeId, leg.state, leg.offer?.sourceNodeId]), [
    ["left-done", "offered", "left::review"],
    ["right-done", "offered", "right"]
  ]);
  const gathered = harness.codeLog.find((call) => call.nodeId === "gather");
  assert.deepEqual(gathered.input.accepted.map((offer) => offer.artifact.payload.text), ["Paris", "right"]);
});

test("review inside a join: a final rejection makes the leg impossible and an all-join unsatisfiable", async () => {
  const graph = seal(fanoutDraft({ review: { ...MODEL_REVIEW, maxRounds: 1 } }));
  const harness = createHarness({
    graph,
    models: { left: drafting, "left::review": reject("No.") },
    code: {
      split: async () => ({ outcome: "go" }),
      right: async () => ({ outcome: "done", outputArtifact: answer({ text: "right" }) })
    }
  });
  await harness.admit();
  await harness.drain();
  const path = await harness.path();
  assert.ok(path.indexOf("left::review:rejected") < path.indexOf("gather:join_unsatisfiable"));
  assert.ok(path.includes("right:done"));
  const progress = await harness.unitStore.readJoinProgress({ unitId: "unit-1", nodeId: "gather" });
  assert.equal(progress.status, "unsatisfiable");
});

test("fail closed: without the port decorator a reviewed node's raw output is refused", async () => {
  const graph = seal(qaDraft({ review: MODEL_REVIEW }));
  const harness = createHarness({ graph, models: { draft: drafting }, decorate: false });
  await harness.admit();
  const [result] = await harness.drain();
  assert.equal(result.status, "terminal");
  assert.equal(result.errorCode, "immutable_stage_contract_rejected");
  const failure = (await harness.journey()).find((record) => record.kind === "turn_failed");
  assert.match(failure.errorMessage, /must carry switchyard\.review-request\.v1/);
  // The model call's receipt is kept even though its result was refused.
  assert.equal(failure.usage.length, 1);
});

test("fail closed: a reviewer that answers outside accepted|rejected fails terminally and keeps its receipt", async () => {
  const graph = seal(qaDraft({ review: MODEL_REVIEW }));
  const forged = { outcome: "rework", outputArtifact: answer({ text: "forged" }) };
  const harness = createHarness({ graph, models: { draft: drafting, "draft::review": () => forged } });
  await harness.admit();
  const results = await harness.drain();
  assert.deepEqual(results.map((result) => result.status), ["succeeded", "terminal"]);
  const failure = (await harness.journey()).find((record) => record.kind === "turn_failed");
  assert.equal(failure.nodeId, "draft::review");
  assert.match(failure.errorMessage, /invalid\.review-result/);
  assert.equal(failure.usage.length, 1);
  assert.equal((await harness.unitStore.listDeadLetters({ unitId: "unit-1" })).length, 1);
});

test("snapshot restore mid-review: the expanded graph rehydrates and the loop continues", async () => {
  const graph = seal(qaDraft({ approval: { by: ACTORS.human, onDeny: "terminal" }, review: { by: ACTORS.human, onReject: "terminal" } }));
  const first = createHarness({ graph, models: { draft: drafting, "draft::rework": drafting } });
  await first.admit();
  await first.decide("draft::approval", "approved");
  await first.drain();
  await first.decide("draft::review", "rejected", { outputArtifact: reviewNotes("Again.") });
  const snapshot = clone(first.unitStore.stateSnapshot());
  assert.doesNotThrow(() => new MemoryUnitStore({ initialState: snapshot }));
  const second = createHarness({
    graph,
    models: { draft: drafting, "draft::rework": drafting },
    code: { publish: async () => ({ outcome: "published" }) },
    initialState: snapshot,
    prefix: "ar2",
    startAt: "2026-09-29T11:00:00.000Z"
  });
  await second.drain();
  await second.decide("draft::review", "accepted");
  await second.drain();
  assert.deepEqual(await second.path(), [
    "draft::approval:approved",
    "draft:done",
    "draft::review:rework",
    "draft::rework:done",
    "draft::review:accepted:done",
    "publish:published"
  ]);
});

test("retry: a person re-decides after a denial, and onReject retry reworks past any round count", async () => {
  const graph = seal(qaDraft({
    approval: { by: ACTORS.human, onDeny: { retry: true } },
    review: { by: ACTORS.human, onReject: { retry: true } }
  }));
  const harness = createHarness({
    graph,
    models: { draft: drafting, "draft::rework": drafting },
    code: { publish: async () => ({ outcome: "published" }) }
  });
  await harness.admit();
  await harness.decide("draft::approval", "denied");
  assert.deepEqual(await harness.openQueues(), [`draft::approval<${CONTRACTS.question}>`]);
  await harness.decide("draft::approval", "approved");
  await harness.drain();
  for (const notes of ["One.", "Two.", "Three."]) {
    await harness.decide("draft::review", "rejected", { outputArtifact: reviewNotes(notes) });
    await harness.drain();
  }
  const [queued] = await harness.unitStore.listQueuedUnits({ principalId: PRINCIPALS.console, nodeId: "draft::review" });
  assert.equal(queued.inputArtifact.payload.round, 4);
  assert.equal(queued.inputArtifact.payload.maxRounds, null);
  assert.deepEqual(queued.inputArtifact.payload.history.map((entry) => entry.feedback.payload.notes), ["One.", "Two.", "Three."]);
  await harness.decide("draft::review", "accepted");
  await harness.drain();
  const path = await harness.path();
  assert.deepEqual(path.slice(0, 3), ["draft::approval:denied", "draft::approval:approved", "draft:done"]);
  assert.equal(path.filter((step) => step === "draft::review:rejected").length, 3);
  assert.deepEqual(path.slice(-2), ["draft::review:accepted:done", "publish:published"]);
});

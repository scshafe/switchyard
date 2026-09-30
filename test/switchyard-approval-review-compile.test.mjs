// Approval / review settings: sealed expansion shape, digests, and loud refusal.

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "@scshafe/switchyard/contracts/digest";
import {
  approvalReviewEdgeIds,
  approvalReviewRole
} from "@scshafe/switchyard/graph/approval-review";
import { graphTurnBudget } from "@scshafe/switchyard/graph/budget";
import { compileGraph } from "@scshafe/switchyard/graph/compile";
import { createGraphDefinition, validateGraphDefinition } from "@scshafe/switchyard/graph/definition";
import { projectGraphDisplay } from "@scshafe/switchyard/graph/display";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import {
  ACTORS,
  BINDINGS,
  CONTRACTS,
  PRINCIPALS,
  TURN,
  answer,
  fanoutDraft,
  node,
  qaDraft,
  seal
} from "./fixtures/switchyard/approval-review-fixtures.mjs";

const clone = (value) => structuredClone(value);
const plain = (value) => JSON.parse(JSON.stringify(value));
const unseal = ({ graphDigest, ...draft }) => clone(draft);
/** Re-seal a hand-edited graph with a correct digest, bypassing expansion. */
const forge = (draft) => ({ ...draft, graphDigest: digest(draft) });

const BOTH = Object.freeze({
  approval: { by: ACTORS.screen, onDeny: "terminal" },
  review: { by: ACTORS.reviewer, onReject: { to: "escalate" } }
});

test("expansion: approval in front, review behind, rework twin, with fixed contracts", () => {
  const graph = seal(qaDraft(BOTH));
  assert.equal(graph.entry, "draft::approval");
  assert.deepEqual(graph.nodes.map((candidate) => [
    candidate.nodeId,
    candidate.kind,
    candidate.ref.id,
    candidate.input,
    candidate.outcomes.outcomes.join("|"),
    candidate.principal.id
  ]), [
    ["draft::approval", "model", "fixture.draft::approval.model", CONTRACTS.question, "approved|denied", PRINCIPALS.screen],
    ["draft", "model", "fixture.draft", CONTRACTS.question, "done", PRINCIPALS.cloud],
    ["draft::review", "model", "fixture.draft::review.model.rounds", "switchyard.review-request.v1", "accepted:done|rework|rejected", PRINCIPALS.reviewer],
    ["draft::rework", "model", "fixture.draft::rework", "switchyard.rework.v1", "done", PRINCIPALS.cloud],
    ["publish", "code", "fixture.publish", CONTRACTS.answer, "published", PRINCIPALS.worker],
    ["escalate", "human", "fixture.escalate", "switchyard.review-rejected.v1", "handled", PRINCIPALS.console]
  ]);
  const byId = Object.fromEntries(graph.nodes.map((candidate) => [candidate.nodeId, candidate]));
  assert.deepEqual(plain(byId["draft::approval"].outputs), { approved: CONTRACTS.question, denied: CONTRACTS.question });
  assert.deepEqual(plain(byId["draft::approval"].binding), plain(BINDINGS.local));
  assert.deepEqual(plain(byId["draft::review"].outputs), {
    "accepted:done": CONTRACTS.answer,
    rework: "switchyard.rework.v1",
    rejected: "switchyard.review-rejected.v1"
  });
  assert.deepEqual(plain(byId["draft::rework"].binding), plain(BINDINGS.cloud));
  // The sealed subject keeps its authored contract and carries its settings;
  // the default round bound is written in.
  assert.deepEqual(plain(byId.draft.outputs), { done: CONTRACTS.answer });
  assert.equal(byId.draft.review.maxRounds, 2);
  assert.deepEqual(graph.edges.map((edge) => [edge.edgeId, edge.from, JSON.stringify(edge.when), edge.to.join(",")]), [
    ["draft-done", "draft::review", '{"outcome":"accepted:done"}', "publish"],
    ["draft::approval.approved", "draft::approval", '{"outcome":"approved"}', "draft"],
    ["draft::review.in", "draft", '{"anyOf":["done"]}', "draft::review"],
    ["draft::review.rework", "draft::review", '{"outcome":"rework"}', "draft::rework"],
    ["draft::review.rejected", "draft::review", '{"outcome":"rejected"}', "escalate"],
    ["draft::rework.out", "draft::rework", '{"anyOf":["done"]}', "draft::review"]
  ]);
  assert.deepEqual(plain(graph.terminals), [
    { nodeId: "publish", outcome: "published" },
    { nodeId: "escalate", outcome: "handled" },
    { nodeId: "draft::approval", outcome: "denied" }
  ]);
  // Only the compiled view of the subject declares the review request.
  const compiled = compileGraph(graph);
  assert.deepEqual(plain(compiled.nodesById.draft.outputs), { done: "switchyard.review-request.v1" });
  assert.equal(compiled.nodes.length, 6);
  assert.deepEqual(plain(approvalReviewEdgeIds("draft")), {
    approved: "draft::approval.approved",
    denied: "draft::approval.denied",
    reviewIn: "draft::review.in",
    rework: "draft::review.rework",
    rejected: "draft::review.rejected",
    reworkOut: "draft::rework.out"
  });
  assert.deepEqual(["draft", "draft::approval", "draft::review", "draft::rework", "publish"].map((id) => approvalReviewRole(graph, id)?.role), [
    "subject", "approval", "review", "rework", undefined
  ]);
  // The display projection accepts the expanded graph as ordinary nodes.
  assert.equal(projectGraphDisplay(compiled).nodes.length, 6);
});

test("expansion: digests are deterministic, default-stable, idempotent and pinned", () => {
  const graph = seal(qaDraft(BOTH));
  assert.equal(graph.graphDigest, "b6c2b9fda616e4d17181f773b2c91e6ac466cd1c5075cf8d9fae4040ae509122");
  assert.equal(seal(qaDraft(BOTH)).graphDigest, graph.graphDigest);
  const explicit = qaDraft({ ...BOTH, review: { ...BOTH.review, maxRounds: 2 } });
  assert.equal(seal(explicit).graphDigest, graph.graphDigest);
  // Key order inside a setting does not matter; canonical JSON seals it.
  const reordered = qaDraft({ ...BOTH, review: { onReject: { to: "escalate" }, by: { principal: ACTORS.reviewer.principal, binding: BINDINGS.reviewer, kind: "model" } } });
  assert.equal(seal(reordered).graphDigest, graph.graphDigest);
  // Resealing the sealed, expanded graph is a fixed point.
  assert.equal(createGraphDefinition(unseal(graph)).graphDigest, graph.graphDigest);
  assert.equal(validateGraphDefinition(clone(graph)).graphDigest, graph.graphDigest);
  // A setting change is a digest change.
  assert.notEqual(seal(qaDraft({ ...BOTH, review: { ...BOTH.review, maxRounds: 3 } })).graphDigest, graph.graphDigest);
  assert.notEqual(seal(qaDraft({ ...BOTH, approval: { by: ACTORS.human, onDeny: "terminal" } })).graphDigest, graph.graphDigest);
  // A graph without settings seals exactly as it did before 2.2.0.
  const bare = qaDraft({});
  const sealed = seal(bare);
  assert.equal(sealed.graphDigest, "af2cb0539661d0db95aacc9764b23e738eb88fd5a59892e9eed4e14981af87c9");
  assert.equal(sealed.graphDigest, digest(plain(bare)));
});

test("expansion: moved edges keep ids and predicates; terminals follow; join_unsatisfiable stays", () => {
  const draft = {
    graphId: "fixture.moves",
    version: 1,
    description: "Edge, where-arm and terminal moves on a reviewed join node.",
    entry: "start",
    nodes: [
      node("start", ["a", "b"]),
      node("merge", ["ok", "odd", "join_unsatisfiable"], {
        join: { inbound: ["start-a", "start-b"], require: { nOf: 1 } },
        review: { by: ACTORS.human, onReject: "terminal", maxRounds: 1 }
      }),
      node("next", ["done"]),
      node("fallback", ["done"]),
      node("unsat", ["noted"], { input: "switchyard.join-unsatisfiable.v1" })
    ],
    edges: [
      { edgeId: "start-a", from: "start", when: { outcome: "a" }, to: ["merge"] },
      { edgeId: "start-b", from: "start", when: { outcome: "b" }, to: ["merge"] },
      { edgeId: "merge-ok-flag", from: "merge", when: { outcome: "ok", where: [{ pointer: "/payload/flag", equals: true }] }, to: ["fallback"] },
      { edgeId: "merge-any", from: "merge", when: { anyOf: ["ok"] }, to: ["next"] },
      { edgeId: "merge-unsat", from: "merge", when: { outcome: "join_unsatisfiable" }, to: ["unsat"] }
    ],
    terminals: [
      { nodeId: "merge", outcome: "odd" },
      { nodeId: "next", outcome: "done" },
      { nodeId: "fallback", outcome: "done" },
      { nodeId: "unsat", outcome: "noted" }
    ]
  };
  const graph = seal(draft);
  const edges = Object.fromEntries(graph.edges.map((edge) => [edge.edgeId, plain(edge)]));
  assert.deepEqual(edges["merge-ok-flag"], { edgeId: "merge-ok-flag", from: "merge::review", when: { outcome: "accepted:ok", where: [{ pointer: "/payload/flag", equals: true }] }, to: ["fallback"] });
  assert.deepEqual(edges["merge-any"].when, { anyOf: ["accepted:ok"] });
  assert.equal(edges["merge-unsat"].from, "merge");
  assert.deepEqual(edges["merge::review.in"].when, { anyOf: ["ok", "odd"] });
  assert.ok(plain(graph.terminals).some((terminal) => terminal.nodeId === "merge::review" && terminal.outcome === "accepted:odd"));
  const merge = graph.nodes.find((candidate) => candidate.nodeId === "merge");
  assert.deepEqual(plain(merge.join.inbound), ["start-a", "start-b"]);
  assert.equal(graph.nodes.find((candidate) => candidate.nodeId === "merge::review").kind, "human");
  compileGraph(graph);
  // Mixing the engine outcome with reviewed ones on one edge is refused.
  const mixed = clone(draft);
  mixed.edges[4].when = { anyOf: ["join_unsatisfiable", "odd"] };
  mixed.terminals = mixed.terminals.filter((terminal) => terminal.outcome !== "odd");
  assert.throws(() => seal(mixed), /routes join_unsatisfiable together with reviewed outcomes of merge; split it/);
});

test("expansion: routes into an approved node enter its approval, including onDeny/onReject targets", () => {
  const draft = qaDraft({ review: { by: ACTORS.reviewer, onReject: { to: "escalate" } } });
  draft.nodes.find((candidate) => candidate.nodeId === "publish").approval = { by: ACTORS.human, onDeny: "terminal" };
  draft.nodes.find((candidate) => candidate.nodeId === "escalate").approval = { by: ACTORS.human, onDeny: "terminal" };
  const graph = seal(draft);
  const edges = Object.fromEntries(graph.edges.map((edge) => [edge.edgeId, edge]));
  assert.deepEqual(plain(edges["draft-done"].to), ["publish::approval"]);
  assert.deepEqual(plain(edges["draft::review.rejected"].to), ["escalate::approval"]);
  compileGraph(graph);
});

test("expansion: onReject retry is an unbounded loop without a rework outcome", () => {
  const graph = seal(qaDraft({ review: { by: ACTORS.human, onReject: { retry: true } } }));
  const review = graph.nodes.find((candidate) => candidate.nodeId === "draft::review");
  assert.equal(review.ref.id, "fixture.draft::review.human.retry");
  assert.deepEqual(plain(review.outcomes.outcomes), ["accepted:done", "rejected"]);
  assert.deepEqual(plain(review.outputs), { "accepted:done": CONTRACTS.answer, rejected: "switchyard.rework.v1" });
  assert.equal(graph.nodes.find((candidate) => candidate.nodeId === "draft").review.maxRounds, undefined);
  assert.deepEqual(plain(graph.edges.find((edge) => edge.edgeId === "draft::review.rejected").to), ["draft::rework"]);
  const budget = graphTurnBudget(graph);
  assert.equal(budget.acyclic, false);
  assert.deepEqual(plain(budget.cycleEdges), [{ edgeId: "draft::rework.out", from: "draft::rework", to: "draft::review" }]);
});

test("budget: a bounded review loop is counted by maxRounds, not reported as a cycle", () => {
  const graph = seal(qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal", maxRounds: 3 } }));
  const budget = graphTurnBudget(graph);
  assert.equal(budget.acyclic, true);
  assert.deepEqual(plain(budget.cycleEdges), []);
  const occurrences = Object.fromEntries(Object.values(budget.nodes).map((entry) => [entry.nodeId, [entry.maxOccurrences, entry.depth]]));
  assert.deepEqual(occurrences, {
    draft: [1, 0],
    "draft::review": [3, 5],
    "draft::rework": [2, 4],
    publish: [1, 6]
  });
  assert.equal(budget.maxTurnsByKind.model, (1 + 3 + 2) * TURN.maxAttempts);
});

test("graph store: one node definition reviewed differently in two graphs publishes without conflict", async () => {
  const store = new MemoryGraphStore();
  await store.publishGraph(seal(qaDraft({ graphId: "fixture.qa-a", review: { by: ACTORS.human, onReject: "terminal" } })));
  await store.publishGraph(seal(qaDraft({ graphId: "fixture.qa-b", review: { by: ACTORS.reviewer, onReject: "terminal", maxRounds: 1 } })));
  await store.publishGraph(seal(qaDraft({ graphId: "fixture.qa-c", approval: { by: ACTORS.screen, onDeny: "terminal" } })));
  await store.publishGraph(seal(qaDraft({ graphId: "fixture.qa-d" })));
});

test("refusal: invalid settings fail loudly", () => {
  const cases = [
    [{ approval: { by: { kind: "agent", principal: { id: "x" } }, onDeny: "terminal" } }, /approval\.by\.kind: must be "human" \| "model"/],
    [{ approval: { by: { kind: "model", principal: { id: "x" } }, onDeny: "terminal" } }, /approval\.by: missing required key\(s\) "binding"/],
    [{ approval: { by: ACTORS.human } }, /approval: missing required key\(s\) "onDeny"/],
    [{ approval: { by: ACTORS.screen, onDeny: { retry: true } } }, /accepted only for a human approver/],
    [{ approval: { by: ACTORS.human, onDeny: "later" } }, /onDeny: must be a plain object|onDeny: must be "terminal"/],
    [{ approval: { by: ACTORS.human, onDeny: { retry: false } } }, /onDeny\.retry: must be true/],
    [{ review: { by: ACTORS.reviewer, onReject: { retry: true }, maxRounds: 3 } }, /omit maxRounds/],
    [{ review: { by: ACTORS.reviewer, onReject: "terminal", maxRounds: 0 } }, /maxRounds/],
    [{ review: { by: ACTORS.reviewer, onReject: "terminal", maxRounds: 11 } }, /maxRounds: must be an integer in 1\.\.10/],
    [{ review: { by: ACTORS.reviewer, onReject: "terminal", extra: 1 } }, /unknown key\(s\) "extra"/],
    [{ review: { by: ACTORS.reviewer, onReject: { to: "nowhere" } } }, /review\.onReject \{ to: nowhere \} references unknown node nowhere/],
    [{ review: { by: ACTORS.reviewer, onReject: { to: "draft" } } }, /cannot route back to the node itself; use \{ retry: true \}/],
    [{ approval: { by: ACTORS.human, onDeny: { to: "draft::review" } }, review: { by: ACTORS.reviewer, onReject: "terminal" } }, /names a synthesized node/]
  ];
  for (const [settings, pattern] of cases) {
    assert.throws(() => seal(qaDraft(settings)), pattern, JSON.stringify(settings));
  }
  // onReject / onDeny targets must accept what is carried to them.
  const wrongTarget = qaDraft({ review: { by: ACTORS.reviewer, onReject: { to: "publish" } } });
  assert.throws(() => compileGraph(seal(wrongTarget)), /draft::review\.rejected carries outcome "rejected" .* as switchyard\.review-rejected\.v1, but target node publish accepts fixture\.answer\.v1/);
  const wrongDeny = qaDraft({ approval: { by: ACTORS.human, onDeny: { to: "publish" } } });
  assert.throws(() => compileGraph(seal(wrongDeny)), /draft::approval\.denied carries outcome "denied" .* but target node publish accepts fixture\.answer\.v1/);
  // Placement rules.
  const joined = fanoutDraft();
  joined.nodes.find((candidate) => candidate.nodeId === "gather").approval = { by: ACTORS.human, onDeny: "terminal" };
  assert.throws(() => seal(joined), /approval on a join node is not supported/);
  const agent = qaDraft();
  Object.assign(agent.nodes[0], { kind: "agent", principal: { id: "v2_agent" }, review: { by: ACTORS.human, onReject: "terminal" } });
  delete agent.nodes[0].binding;
  assert.throws(() => seal(agent), /review on an agent node is not supported/);
  // An outcome of the reviewed node must still be covered by the author.
  const uncovered = qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal" } });
  uncovered.edges = [];
  uncovered.nodes = uncovered.nodes.filter((candidate) => candidate.nodeId !== "publish");
  uncovered.terminals = [];
  assert.throws(() => compileGraph(seal(uncovered)), /draft::review outcome "accepted:done" is uncovered/);
});

test("refusal: reserved ids and tampered expansions are refused", () => {
  const collide = qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal" } });
  collide.nodes.push(node("draft::rework", ["x"]));
  assert.throws(() => seal(collide), /Graph node draft::rework is reserved for the settings of node draft and differs from its expansion/);
  const collideEdge = qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal" } });
  collideEdge.edges[0].edgeId = "draft::review.in";
  assert.throws(() => seal(collideEdge), /Graph edge draft::review\.in is reserved|differs from its expansion/);
  const intoTwin = qaDraft({ review: { by: ACTORS.reviewer, onReject: "terminal" } });
  intoTwin.edges[0].to = ["draft::rework"];
  assert.throws(() => seal(intoTwin), /targets synthesized node draft::rework; route to draft instead/);

  const graph = seal(qaDraft(BOTH));
  const tampered = unseal(graph);
  tampered.nodes.find((candidate) => candidate.nodeId === "draft::review").principal = { id: "someone_else" };
  assert.throws(() => compileGraph(forge(tampered)), /Graph node draft::review is reserved for the settings of node draft and differs from its expansion/);
  const dropped = unseal(graph);
  dropped.edges = dropped.edges.filter((edge) => edge.edgeId !== "draft::approval.approved");
  assert.throws(() => compileGraph(forge(dropped)), /not the approval\/review expansion of its own settings/);
  const skipped = unseal(graph);
  skipped.entry = "draft";
  assert.throws(() => compileGraph(forge(skipped)), /not the approval\/review expansion of its own settings/);
});

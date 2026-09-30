// The goal manifest (graph/goals) and the goal-closure projection
// (store/goal-closures): a non-executable document that proves, from the
// compiled graph alone, that a unit entering a goal closes it exactly once,
// and the runtime count of what one unit actually did.

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "@scshafe/switchyard/contracts/digest";
import { createGraphDefinition, graphDefinitionRef } from "@scshafe/switchyard/graph/definition";
import {
  createGoalManifest,
  GOAL_MANIFEST_SCHEMA_VERSION,
  validateGoalManifest,
  validateGoalManifestDocument
} from "@scshafe/switchyard/graph/goals";
import { GOAL_CLOSURES_SCHEMA_VERSION, projectGoalClosures } from "@scshafe/switchyard/store/goal-closures";
import { UNIT_PATH_SCHEMA_VERSION } from "@scshafe/switchyard/store/unit-path";
import { fixtureGraphs, node } from "./fixtures/switchyard/node-graph-v2-fixtures.mjs";
import {
  SUPPORT_TRIAGE_GOAL_MANIFEST,
  SUPPORT_TRIAGE_GOALS_DRAFT,
  SUPPORT_TRIAGE_GRAPH,
  SUPPORT_TRIAGE_GRAPH_DRAFT,
  SUPPORT_TRIAGE_MONOLITH_GRAPH
} from "./fixtures/switchyard/support-triage-example.mjs";

/** Prototype-free frozen records compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const clone = (value) => structuredClone(value);
const graphOf = (draft) => createGraphDefinition(draft);
const manifestOf = (graph, goals) => createGoalManifest(graph, { schemaVersion: GOAL_MANIFEST_SCHEMA_VERSION, goals });
const sealExample = (goals) => createGoalManifest(SUPPORT_TRIAGE_GRAPH, { schemaVersion: GOAL_MANIFEST_SCHEMA_VERSION, goals });
const exampleDraft = () => clone(SUPPORT_TRIAGE_GOALS_DRAFT);

test("goal manifest: seals the draft against the exact graph and re-validates it", () => {
  const manifest = SUPPORT_TRIAGE_GOAL_MANIFEST;
  assert.equal(manifest.schemaVersion, GOAL_MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(plain(manifest.graph), plain(graphDefinitionRef(SUPPORT_TRIAGE_GRAPH)));
  assert.equal(
    manifest.manifestDigest,
    digest({ schemaVersion: manifest.schemaVersion, graph: manifest.graph, goals: manifest.goals })
  );
  assert.deepEqual(plain(validateGoalManifest(SUPPORT_TRIAGE_GRAPH, plain(manifest))), plain(manifest));
  assert.deepEqual(plain(validateGoalManifestDocument(plain(manifest))), plain(manifest));
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.goals[0].resolutions[0]), true);
  // Sealing is a pure function of the graph digest and the draft.
  assert.equal(createGoalManifest(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_GOALS_DRAFT).manifestDigest, manifest.manifestDigest);
});

test("goal manifest: identity is exact — another graph, a moved digest, or an edited document is refused", () => {
  assert.throws(
    () => validateGoalManifest(SUPPORT_TRIAGE_MONOLITH_GRAPH, SUPPORT_TRIAGE_GOAL_MANIFEST),
    /goal manifest: graph mismatch — manifest describes example\.support-triage@1 [0-9a-f]{64}, definition is example\.support-triage-monolith@1/
  );

  // Any definition change moves the graph digest, so the old seal no longer applies;
  // re-sealing the unchanged draft is the whole cost of the change.
  const reworded = clone(SUPPORT_TRIAGE_GRAPH_DRAFT);
  reworded.description = "Same topology, new words.";
  const resealed = createGraphDefinition(reworded);
  assert.notEqual(resealed.graphDigest, SUPPORT_TRIAGE_GRAPH.graphDigest);
  assert.throws(() => validateGoalManifest(resealed, SUPPORT_TRIAGE_GOAL_MANIFEST), /graph mismatch/);
  const moved = createGoalManifest(resealed, SUPPORT_TRIAGE_GOALS_DRAFT);
  assert.deepEqual(plain(moved.goals), plain(SUPPORT_TRIAGE_GOAL_MANIFEST.goals));
  assert.notEqual(moved.manifestDigest, SUPPORT_TRIAGE_GOAL_MANIFEST.manifestDigest);

  const edited = plain(SUPPORT_TRIAGE_GOAL_MANIFEST);
  edited.goals[0].resolutions[0].kind = "escalated";
  assert.throws(() => validateGoalManifestDocument(edited), /goal manifest: manifestDigest mismatch — sealed/);

  const stray = plain(SUPPORT_TRIAGE_GOAL_MANIFEST);
  stray.notes = "presentation words do not belong here";
  assert.throws(() => validateGoalManifestDocument(stray), /unknown key\(s\) "notes"/);

  assert.throws(
    () => createGoalManifest(SUPPORT_TRIAGE_GRAPH, { schemaVersion: "switchyard-goal-manifest.v2", goals: SUPPORT_TRIAGE_GOALS_DRAFT.goals }),
    /schemaVersion must be "switchyard-goal-manifest\.v1" \(got "switchyard-goal-manifest\.v2"\)/
  );
  // The graph ref comes from the definition, never from the draft.
  assert.throws(
    () => createGoalManifest(SUPPORT_TRIAGE_GRAPH, { ...SUPPORT_TRIAGE_GOALS_DRAFT, graph: SUPPORT_TRIAGE_GOAL_MANIFEST.graph }),
    /unknown key\(s\) "graph"/
  );
  // The definition is compiled, so a tampered graph fails before any goal is read.
  const tampered = plain(SUPPORT_TRIAGE_GRAPH);
  tampered.entry = "assemble";
  assert.throws(() => createGoalManifest(tampered, SUPPORT_TRIAGE_GOALS_DRAFT), /digest mismatch/);
});

test("goal manifest: members are real, disjoint, and entered only at the entry", () => {
  let draft = exampleDraft();
  draft.goals[0].members.push("ghost");
  assert.throws(
    () => sealExample(draft.goals),
    /goal manifest: goals\[0\] \(outage-escalation\): member ghost is not a node of example\.support-triage@1/
  );

  draft = exampleDraft();
  draft.goals.push({
    goalId: "second",
    entry: "assemble",
    members: ["assemble"],
    resolutions: [
      { nodeId: "assemble", outcome: "proposed", kind: "resolved" },
      { nodeId: "assemble", outcome: "invalid", kind: "escalated" }
    ]
  });
  assert.throws(() => sealExample(draft.goals), /goals\[1\] \(second\): member assemble already belongs to goal outage-escalation/);

  draft = exampleDraft();
  draft.goals[0].entry = "normalize";
  assert.throws(() => sealExample(draft.goals), /entry normalize is not a member/);

  // Admission is a way in: the graph entry inside a goal must be that goal's entry.
  draft = exampleDraft();
  draft.goals[0].members.unshift("normalize");
  assert.throws(
    () => sealExample(draft.goals),
    /graph entry normalize is a member, so it must be the goal entry \(got outage-signal\)/
  );

  draft = exampleDraft();
  draft.goals[0].entry = "ground-evidence";
  assert.throws(
    () => sealExample(draft.goals),
    /edge normalize-ready enters member outage-signal from normalize outside the goal; a goal is entered only at its entry ground-evidence/
  );

  draft = exampleDraft();
  draft.goals[0].members.push("assemble");
  assert.throws(() => sealExample(draft.goals), /members: node ids must be unique/);

  draft = exampleDraft();
  draft.goals[0].resolutions.push({ nodeId: "assemble", outcome: "invalid", kind: "resolved" });
  assert.throws(() => sealExample(draft.goals), /resolutions: node\/outcome pairs must be unique/);

  draft = exampleDraft();
  draft.goals.push(clone(draft.goals[0]));
  assert.throws(() => sealExample(draft.goals), /goal IDs must be unique/);

  assert.throws(() => sealExample([]), /goals: must be an array of 1\.\.256 goals \(got 0\)/);

  draft = exampleDraft();
  draft.goals[0].resolutions[0].kind = "valid";
  assert.throws(() => sealExample(draft.goals), /resolutions\[0\]\.kind/);
});

test("goal manifest: every member outcome continues inside or closes through a declared resolution", () => {
  const without = (nodeId, outcome) => {
    const draft = exampleDraft();
    draft.goals[0].resolutions = draft.goals[0].resolutions.filter(
      (resolution) => !(resolution.nodeId === nodeId && resolution.outcome === outcome)
    );
    return draft.goals;
  };
  const withExtra = (resolution) => {
    const draft = exampleDraft();
    draft.goals[0].resolutions.push(resolution);
    return draft.goals;
  };

  assert.throws(
    () => sealExample(without("assemble", "proposed")),
    /member outcome assemble:proposed leaves the goal by edge assemble-proposed to summarize without a declared resolution/
  );
  assert.throws(
    () => sealExample(without("outage-signal", "no")),
    /member outcome outage-signal:no is a graph terminal but not a declared resolution/
  );
  assert.throws(
    () => sealExample(withExtra({ nodeId: "outage-signal", outcome: "yes", kind: "resolved" })),
    /resolution outage-signal:yes continues inside the goal by edge signal-yes to member ground-evidence/
  );
  // An uncertain answer carried forward as a fact is not a closure.
  assert.throws(
    () => sealExample(withExtra({ nodeId: "blast-radius", outcome: "uncertain", kind: "escalated" })),
    /resolution blast-radius:uncertain continues inside the goal by edge blast-radius-assemble to member assemble/
  );
  assert.throws(
    () => sealExample(withExtra({ nodeId: "summarize", outcome: "summarized", kind: "resolved" })),
    /resolution summarize:summarized names a node that is not a member/
  );
  assert.throws(
    () => sealExample(withExtra({ nodeId: "assemble", outcome: "deferred", kind: "resolved" })),
    /resolution assemble:deferred is not a declared outcome of assemble/
  );

  // Both kinds are required: a goal decides by itself somewhere and escalates somewhere.
  const chain = graphOf(fixtureGraphs["filter-chain"]);
  const chainGoal = (pass, drop) => manifestOf(chain, [{
    goalId: "filter",
    entry: "filter",
    members: ["filter"],
    resolutions: [
      { nodeId: "filter", outcome: "pass", kind: pass },
      { nodeId: "filter", outcome: "drop", kind: drop }
    ]
  }]);
  assert.equal(chainGoal("resolved", "escalated").goals[0].goalId, "filter");
  assert.throws(() => chainGoal("resolved", "resolved"), /goals\[0\] \(filter\): declares no escalated resolution/);
  assert.throws(() => chainGoal("escalated", "escalated"), /goals\[0\] \(filter\): declares no resolved resolution/);
});

test("goal manifest: a goal is one thread — cycles, fan-out inside, and re-entry after closing are refused", () => {
  const looped = graphOf({
    graphId: "goal.loop",
    version: 1,
    description: "A retry loop inside a goal.",
    entry: "ask",
    nodes: [node("ask", ["next", "done"]), node("check", ["back", "ok"])],
    edges: [
      { edgeId: "ask-next", from: "ask", when: { outcome: "next" }, to: ["check"] },
      { edgeId: "check-back", from: "check", when: { outcome: "back" }, to: ["ask"] }
    ],
    terminals: [{ nodeId: "ask", outcome: "done" }, { nodeId: "check", outcome: "ok" }]
  });
  assert.throws(
    () => manifestOf(looped, [{
      goalId: "g",
      entry: "ask",
      members: ["ask", "check"],
      resolutions: [{ nodeId: "ask", outcome: "done", kind: "resolved" }, { nodeId: "check", outcome: "ok", kind: "escalated" }]
    }]),
    /goals\[0\] \(g\): edge check-back from check to ask closes a cycle inside the goal/
  );

  const forked = graphOf({
    graphId: "goal.fork",
    version: 1,
    description: "One outcome queues two branches.",
    entry: "split",
    nodes: [node("split", ["go", "skip"]), node("left", ["done"]), node("right", ["done"])],
    edges: [{ edgeId: "split-go", from: "split", when: { outcome: "go" }, to: ["left", "right"] }],
    terminals: [
      { nodeId: "split", outcome: "skip" },
      { nodeId: "left", outcome: "done" },
      { nodeId: "right", outcome: "done" }
    ]
  });
  assert.throws(
    () => manifestOf(forked, [{
      goalId: "g",
      entry: "split",
      members: ["split", "left", "right"],
      resolutions: [
        { nodeId: "split", outcome: "skip", kind: "escalated" },
        { nodeId: "left", outcome: "done", kind: "resolved" },
        { nodeId: "right", outcome: "done", kind: "resolved" }
      ]
    }]),
    /member outcome split:go fans out inside the goal to left, right; a goal runs as one thread/
  );
  // Fan-out out of a goal is fine: a resolution may queue several outside nodes.
  const exits = manifestOf(forked, [{
    goalId: "g",
    entry: "split",
    members: ["split"],
    resolutions: [{ nodeId: "split", outcome: "go", kind: "resolved" }, { nodeId: "split", outcome: "skip", kind: "escalated" }]
  }]);
  assert.deepEqual(plain(exits.goals[0].members), ["split"]);

  const reentrant = graphOf({
    graphId: "goal.reentry",
    version: 1,
    description: "A node after the goal can send the unit back into it.",
    entry: "ask",
    nodes: [node("ask", ["done", "stop"]), node("after", ["again", "end"])],
    edges: [
      { edgeId: "ask-done", from: "ask", when: { outcome: "done" }, to: ["after"] },
      { edgeId: "after-again", from: "after", when: { outcome: "again" }, to: ["ask"] }
    ],
    terminals: [{ nodeId: "ask", outcome: "stop" }, { nodeId: "after", outcome: "end" }]
  });
  assert.throws(
    () => manifestOf(reentrant, [{
      goalId: "g",
      entry: "ask",
      members: ["ask"],
      resolutions: [{ nodeId: "ask", outcome: "done", kind: "resolved" }, { nodeId: "ask", outcome: "stop", kind: "escalated" }]
    }]),
    /the goal can be re-entered after closing: edge after-again from after reaches member ask/
  );

  // A join may be a goal's entry, gathering outside branches; its synthesized
  // outcome is declared like any other.
  const joined = graphOf(fixtureGraphs.join);
  const joinGoal = (resolutions) => manifestOf(joined, [{ goalId: "gather", entry: "join", members: ["join"], resolutions }]);
  assert.equal(
    joinGoal([
      { nodeId: "join", outcome: "joined", kind: "resolved" },
      { nodeId: "join", outcome: "join_unsatisfiable", kind: "escalated" }
    ]).goals[0].entry,
    "join"
  );
  assert.throws(
    () => joinGoal([{ nodeId: "join", outcome: "joined", kind: "resolved" }]),
    /member outcome join:join_unsatisfiable is a graph terminal but not a declared resolution/
  );
});

test("goal closures: a path reports unentered goals, a close by a synthesized join outcome, and refuses a double close", () => {
  const joined = graphOf(fixtureGraphs.join);
  const manifest = manifestOf(joined, [{
    goalId: "gather",
    entry: "join",
    members: ["join"],
    resolutions: [
      { nodeId: "join", outcome: "joined", kind: "resolved" },
      { nodeId: "join", outcome: "join_unsatisfiable", kind: "escalated" }
    ]
  }]);
  const pathFor = (nodes, joins) => ({
    schemaVersion: UNIT_PATH_SCHEMA_VERSION,
    unitId: "unit-1",
    graph: graphDefinitionRef(joined),
    nodes,
    joins
  });
  const usage = { receipts: 0, chargedTokens: 0, chargedCostMicroUsd: 0 };
  const settledJoin = (outcome) => ({
    nodeId: "join",
    state: "settled",
    occurrences: [{
      queueId: "q-1",
      nodeId: "join",
      enqueueSequence: 4,
      queuedBySequence: 4,
      inboundEdgeIds: ["branch-a-to-join", "branch-b-to-join"],
      state: "settled",
      attempts: 1,
      failures: 0,
      outcome
    }],
    outcomes: [outcome],
    usage
  });

  const none = projectGoalClosures(manifest, pathFor({}, {}));
  assert.equal(none.schemaVersion, GOAL_CLOSURES_SCHEMA_VERSION);
  assert.equal(none.unitId, "unit-1");
  assert.equal(none.manifestDigest, manifest.manifestDigest);
  assert.deepEqual(plain(none.goals), {
    gather: { goalId: "gather", status: "unentered", openMembers: [], deadMembers: [], turns: 0, usage }
  });
  assert.equal(Object.getPrototypeOf(none.goals), null);

  const fired = projectGoalClosures(manifest, pathFor({ join: settledJoin("joined") }, {}));
  assert.equal(fired.goals.gather.status, "closed");
  assert.deepEqual(plain(fired.goals.gather.resolution), { nodeId: "join", outcome: "joined", kind: "resolved" });
  assert.equal(fired.goals.gather.turns, 1);

  // The engine synthesizes join_unsatisfiable without a turn; the join record carries it.
  const unsatisfiable = projectGoalClosures(
    manifest,
    pathFor({}, { join: { nodeId: "join", status: "unsatisfiable", edges: {}, lateOffers: 0 } })
  );
  assert.equal(unsatisfiable.goals.gather.status, "closed");
  assert.deepEqual(plain(unsatisfiable.goals.gather.resolution), { nodeId: "join", outcome: "join_unsatisfiable", kind: "escalated" });

  const twice = pathFor({ join: settledJoin("joined") }, { join: { nodeId: "join", status: "unsatisfiable", edges: {}, lateOffers: 0 } });
  assert.throws(
    () => projectGoalClosures(manifest, twice),
    /goal closures: goal gather closed 2 times in unit unit-1 \(join:joined, join:join_unsatisfiable\); the manifest does not describe this journey's graph/
  );

  // Identity is exact on both sides.
  assert.throws(
    () => projectGoalClosures(SUPPORT_TRIAGE_GOAL_MANIFEST, pathFor({}, {})),
    /goal closures: graph mismatch — manifest describes example\.support-triage@1 [0-9a-f]{64}, unit unit-1 ran on fixture\.join@1/
  );
  assert.throws(
    () => projectGoalClosures(manifest, { ...pathFor({}, {}), schemaVersion: "switchyard-unit-path.v2" }),
    /unit path schemaVersion must be "switchyard-unit-path\.v1"/
  );
  const tampered = plain(manifest);
  tampered.goals[0].goalId = "renamed";
  assert.throws(() => projectGoalClosures(tampered, pathFor({}, {})), /manifestDigest mismatch/);
});

import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import {
  evaluateJoinThreshold,
  isJoinSatisfiable,
  isJoinThresholdSatisfied,
  matchingOutcomeEdges,
  outcomePredicateMatches
} from "@scshafe/switchyard/store/routing";

const output = createArtifactEnvelope("routing-output.v1", {
  risk: "high",
  count: 1,
  enabled: false,
  nullable: null,
  list: [{ flag: true }, "1"],
  "a/b": { "~key": "sealed" }
});

test("routing predicates evaluate outcome, anyOf, and sealed envelope fields", () => {
  assert.equal(outcomePredicateMatches({ outcome: "done" }, "done"), true);
  assert.equal(outcomePredicateMatches({ outcome: "done" }, "other"), false);
  assert.equal(outcomePredicateMatches({ anyOf: ["done", "skipped"] }, "skipped"), true);
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/risk", equals: "high" }] },
      "done",
      output
    ),
    true
  );
  // The pointer root is the ArtifactEnvelope, not merely its payload.
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/contractId", equals: "routing-output.v1" }] },
      "done",
      output
    ),
    true
  );
});

test("conditional predicates are false without output while unconditional routes remain eligible", () => {
  const edges = [
    {
      edgeId: "conditional",
      from: "source",
      when: { outcome: "done", where: [{ pointer: "/payload/risk", equals: "high" }] },
      to: ["shadow"]
    },
    {
      edgeId: "fallback",
      from: "source",
      when: { outcome: "done" },
      to: ["primary"]
    },
    {
      edgeId: "any",
      from: "source",
      when: { anyOf: ["done", "other"] },
      to: ["audit"]
    }
  ];

  assert.deepEqual(
    matchingOutcomeEdges(edges, "done").map((edge) => edge.edgeId),
    ["fallback", "any"]
  );
  assert.deepEqual(
    matchingOutcomeEdges(edges, "done", output).map((edge) => edge.edgeId),
    ["conditional", "fallback", "any"]
  );
});

test("RFC6901 traversal supports arrays and escapes, uses own properties, and never coerces", () => {
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/list/0/flag", equals: true }] },
      "done",
      output
    ),
    true
  );
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/a~1b/~0key", equals: "sealed" }] },
      "done",
      output
    ),
    true
  );
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/list/01", equals: "1" }] },
      "done",
      output
    ),
    false
  );
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/count", equals: "1" }] },
      "done",
      output
    ),
    false
  );
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/enabled", equals: 0 }] },
      "done",
      output
    ),
    false
  );
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/nullable", equals: null }] },
      "done",
      output
    ),
    true
  );

  Object.defineProperty(Object.prototype, "routingInherited", {
    configurable: true,
    value: "must-not-match"
  });
  try {
    const empty = createArtifactEnvelope("routing-output.v1", {});
    assert.equal(
      outcomePredicateMatches(
        {
          outcome: "done",
          where: [{ pointer: "/payload/routingInherited", equals: "must-not-match" }]
        },
        "done",
        empty
      ),
      false
    );
  } finally {
    delete Object.prototype.routingInherited;
  }
});

test("artifact validation rejects accessors before routing can invoke them", () => {
  let getterCalls = 0;
  const payload = {};
  Object.defineProperty(payload, "risk", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "high";
    }
  });
  const hostile = {
    contractId: "routing-output.v1",
    digest: "0".repeat(64),
    payload
  };
  assert.throws(
    () => outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/risk", equals: "high" }] },
      "done",
      hostile
    ),
    /must be an enumerable data property/
  );
  assert.equal(getterCalls, 0);

  // Prove the guard does not reject the equivalent sealed data-property form.
  assert.equal(
    outcomePredicateMatches(
      { outcome: "done", where: [{ pointer: "/payload/risk", equals: "high" }] },
      "done",
      createArtifactEnvelope("routing-output.v1", { risk: "high" })
    ),
    true
  );
});

test("routing edge validation rejects accessors without invoking them", () => {
  let getterCalls = 0;
  const hostile = {
    edgeId: "hostile",
    from: "source",
    to: ["target"]
  };
  Object.defineProperty(hostile, "when", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { outcome: "done" };
    }
  });
  assert.throws(
    () => matchingOutcomeEdges([hostile], "done"),
    /routing edges\[0\]\.when must be an enumerable data property/
  );
  assert.equal(getterCalls, 0);

  assert.deepEqual(
    matchingOutcomeEdges([{
      edgeId: "corrected",
      from: "source",
      when: { outcome: "done" },
      to: ["target"]
    }], "done").map((edge) => edge.edgeId),
    ["corrected"]
  );
});

test("join threshold arithmetic distinguishes satisfied, pending, and impossible states", () => {
  const allPending = [
    { edgeId: "a", state: "offered" },
    { edgeId: "b", state: "pending" }
  ];
  assert.deepEqual(evaluateJoinThreshold("all", allPending), {
    required: 2,
    offered: 1,
    impossible: 0,
    pending: 1,
    thresholdSatisfied: false,
    satisfiable: true,
    unsatisfiable: false
  });
  assert.equal(isJoinThresholdSatisfied("all", allPending), false);
  assert.equal(isJoinSatisfiable("all", allPending), true);

  const allImpossible = [
    { edgeId: "a", state: "offered" },
    { edgeId: "b", state: "impossible" }
  ];
  assert.equal(evaluateJoinThreshold("all", allImpossible).unsatisfiable, true);

  const oneOf = [
    { edgeId: "a", state: "impossible" },
    { edgeId: "b", state: "offered" }
  ];
  assert.equal(isJoinThresholdSatisfied({ nOf: 1 }, oneOf), true);
  assert.equal(isJoinSatisfiable({ nOf: 1 }, oneOf), true);

  const twoOfImpossible = [
    { edgeId: "a", state: "offered" },
    { edgeId: "b", state: "impossible" },
    { edgeId: "c", state: "impossible" }
  ];
  assert.equal(evaluateJoinThreshold({ nOf: 2 }, twoOfImpossible).unsatisfiable, true);
});

test("join edge states are distinct and nOf cannot exceed inbound edges", () => {
  assert.throws(
    () => evaluateJoinThreshold("all", [
      { edgeId: "same", state: "offered" },
      { edgeId: "same", state: "impossible" }
    ]),
    /edge same appears more than once/
  );
  assert.throws(
    () => evaluateJoinThreshold({ nOf: 3 }, [
      { edgeId: "a", state: "pending" },
      { edgeId: "b", state: "pending" }
    ]),
    /cannot exceed 2 distinct inbound edges/
  );

  // Prove both guards accept the corrected distinct, satisfiable declaration.
  assert.deepEqual(
    evaluateJoinThreshold({ nOf: 2 }, [
      { edgeId: "a", state: "offered" },
      { edgeId: "b", state: "pending" }
    ]),
    {
      required: 2,
      offered: 1,
      impossible: 0,
      pending: 1,
      thresholdSatisfied: false,
      satisfiable: true,
      unsatisfiable: false
    }
  );
});

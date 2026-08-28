import test from "node:test";
import assert from "node:assert/strict";

import {
  artifactRef,
  createArtifactEnvelope
} from "mission-pipeline/contracts/artifact";
import {
  ENGINE_JOIN_UNSATISFIABLE_OUTCOME,
  MAX_AGENT_TURN_USAGE_RECEIPTS,
  NodeTurnCompletionSnapshotError,
  NodeTurnCompletionValidationError,
  snapshotNodePortResult,
  snapshotNodeTurnCompletion,
  snapshotWorkerNodeTurnContext,
  validateNodeTurnCompletion
} from "mission-pipeline/execute/ports";
import {
  MODEL_BINDING,
  node
} from "./fixtures/mission-pipeline/node-graph-v2-fixtures.mjs";

const RECEIPT = Object.freeze({
  schemaVersion: "usage-receipt.v1",
  trust: "provider_reported",
  observedInputTokens: 2,
  observedOutputTokens: 3,
  chargedTokens: 5,
  observedCostMicroUsd: 7,
  chargedCostMicroUsd: 7,
  durationMs: 11
});

const OUTPUT = createArtifactEnvelope("unit-artifact.v1", {
  status: "ready",
  nested: { keep: true }
});

const codeNode = node("code-work", ["ok", ENGINE_JOIN_UNSATISFIABLE_OUTCOME]);
const modelNode = node("model-work", ["classified"], {
  kind: "model",
  binding: MODEL_BINDING
});
const agentNode = node("agent-work", ["completed"], { kind: "agent" });
const humanNode = node("human-work", ["approved"], { kind: "human" });
const callbackNode = node("callback-work", ["received"], { kind: "callback" });

function workerContext(overrides = {}) {
  const input = createArtifactEnvelope("unit-artifact.v1", { seed: 1 });
  return {
    graph: {
      id: "fixture.ports",
      version: 1,
      digest: "a".repeat(64)
    },
    queueId: "queue-1",
    unitId: "unit-1",
    nodeId: codeNode.nodeId,
    nodeRef: { ...codeNode.ref },
    attemptNumber: 1,
    attemptIndex: 1,
    idempotencyKey: "b".repeat(64),
    inputArtifact: structuredClone(artifactRef(input)),
    ...overrides
  };
}

test("worker context: captures the minimal coordinates once and deeply freezes data", () => {
  const raw = workerContext();
  const context = snapshotWorkerNodeTurnContext(raw);

  raw.graph.id = "caller-mutated";
  raw.nodeRef.id = "caller-mutated";
  raw.inputArtifact.digest = "c".repeat(64);

  assert.equal(context.graph.id, "fixture.ports");
  assert.equal(context.nodeRef.id, codeNode.ref.id);
  assert.equal(context.inputArtifact.digest, artifactRef(createArtifactEnvelope("unit-artifact.v1", { seed: 1 })).digest);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.graph), true);
  assert.equal(Object.isFrozen(context.nodeRef), true);
  assert.equal(Object.isFrozen(context.inputArtifact), true);

  const signal = new AbortController().signal;
  assert.equal(snapshotWorkerNodeTurnContext(workerContext({ signal })).signal, signal);
});

test("worker context: rejects ambient authority, unsafe attempts, and accessor capabilities before invocation", () => {
  assert.throws(
    () => snapshotWorkerNodeTurnContext({ ...workerContext(), leaseToken: "secret" }),
    /unknown key\(s\) "leaseToken"/
  );
  assert.throws(
    () => snapshotWorkerNodeTurnContext(workerContext({ attemptNumber: Number.MAX_SAFE_INTEGER + 1 })),
    /attemptNumber: must be a safe positive integer/
  );
  assert.throws(
    () => snapshotWorkerNodeTurnContext(workerContext({ attemptIndex: 0 })),
    /attemptIndex: must be a safe positive integer/
  );
  assert.throws(
    () => snapshotWorkerNodeTurnContext(workerContext({ signal: {} })),
    /signal must be a non-Proxy AbortSignal/
  );

  let getterCalls = 0;
  const hostile = workerContext();
  Object.defineProperty(hostile, "unitId", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "forged";
    }
  });
  assert.throws(
    () => snapshotWorkerNodeTurnContext(hostile),
    /unitId must be an enumerable data property/
  );
  assert.equal(getterCalls, 0);
  assert.throws(
    () => snapshotWorkerNodeTurnContext(new Proxy(workerContext(), {})),
    /plain non-Proxy data object/
  );
});

test("code completion: validates the declared outcome and sealed output, then returns a detached frozen snapshot", () => {
  const raw = {
    outcome: "ok",
    outputArtifact: structuredClone(OUTPUT)
  };
  const completion = validateNodeTurnCompletion(codeNode, raw);
  raw.outcome = "caller-mutated";
  raw.outputArtifact.payload.nested.keep = false;

  assert.equal(completion.outcome, "ok");
  assert.equal(completion.outputArtifact.payload.nested.keep, true);
  assert.equal(Object.isFrozen(completion), true);
  assert.equal(Object.isFrozen(completion.outputArtifact), true);
  assert.equal(Object.isFrozen(completion.outputArtifact.payload.nested), true);
  assert.deepEqual(snapshotNodePortResult(codeNode, { outcome: "ok" }), { outcome: "ok" });
});

test("completion output uses the artifact envelope depth budget, not the graph budget", () => {
  let nearLimitPayload = { leaf: true };
  for (let index = 0; index < 60; index += 1) {
    nearLimitPayload = { child: nearLimitPayload };
  }
  const nearLimitEnvelope = createArtifactEnvelope(
    "unit-artifact.v1",
    nearLimitPayload
  );
  const accepted = validateNodeTurnCompletion(codeNode, {
    outcome: "ok",
    outputArtifact: nearLimitEnvelope
  });
  let cursor = accepted.outputArtifact.payload;
  for (let index = 0; index < 60; index += 1) cursor = cursor.child;
  assert.deepEqual(cursor, { leaf: true });

  let tooDeepPayload = { leaf: true };
  for (let index = 0; index < 70; index += 1) {
    tooDeepPayload = { child: tooDeepPayload };
  }
  assert.throws(
    () => snapshotNodeTurnCompletion({
      outcome: "ok",
      outputArtifact: {
        contractId: "unit-artifact.v1",
        digest: "0".repeat(64),
        payload: tooDeepPayload
      }
    }),
    (error) => {
      assert.equal(error instanceof NodeTurnCompletionSnapshotError, true);
      assert.match(error.message, /maximum depth of 64/);
      return true;
    }
  );
});

test("receipt-first snapshot: validated model usage remains available when ordinary completion validation fails", () => {
  const raw = {
    outcome: "not-declared",
    usage: [structuredClone(RECEIPT)]
  };
  const snapshot = snapshotNodeTurnCompletion(raw);
  raw.outcome = "classified";
  raw.usage[0].chargedTokens = 999;

  assert.equal(snapshot.hasUsage, true);
  assert.equal(snapshot.usage.length, 1);
  assert.equal(snapshot.usage[0].chargedTokens, 5);
  assert.equal(Object.isFrozen(snapshot.usage[0]), true);
  assert.throws(() => validateNodeTurnCompletion(modelNode, snapshot), (error) => {
    assert.equal(error instanceof NodeTurnCompletionValidationError, true);
    assert.equal(error.usage.length, 1);
    assert.equal(error.usage[0].chargedTokens, 5);
    assert.match(error.message, /node model-work returned undeclared outcome "not-declared"/);
    return true;
  });
});

test("receipt-first snapshot: hostile ordinary output fails with its already validated receipts attached", () => {
  let deep = { leaf: true };
  for (let index = 0; index < 80; index += 1) deep = { child: deep };
  assert.throws(() => snapshotNodeTurnCompletion({
    outcome: "classified",
    outputArtifact: deep,
    usage: [RECEIPT]
  }), (error) => {
    assert.equal(error instanceof NodeTurnCompletionSnapshotError, true);
    assert.equal(error.usage.length, 1);
    assert.equal(error.usage[0].chargedCostMicroUsd, 7);
    assert.match(error.message, /maximum depth/);
    return true;
  });

  assert.throws(() => validateNodeTurnCompletion(modelNode, {
    outcome: "classified",
    outputArtifact: { ...OUTPUT, digest: "0".repeat(64) },
    usage: [RECEIPT]
  }), (error) => {
    assert.equal(error instanceof NodeTurnCompletionValidationError, true);
    assert.equal(error.usage.length, 1);
    assert.match(error.message, /digest mismatch/);
    return true;
  });
});

test("receipt-first snapshot preserves the validated prefix before a later bad receipt or ordinary accessor", () => {
  assert.throws(
    () => snapshotNodeTurnCompletion({
      outcome: "completed",
      usage: [RECEIPT, { ...RECEIPT, chargedTokens: 0 }]
    }),
    (error) => {
      assert.equal(error instanceof NodeTurnCompletionSnapshotError, true);
      assert.equal(error.usage.length, 1);
      assert.equal(error.usage[0].chargedTokens, 5);
      assert.match(error.message, /chargedTokens \(0\) must cover observed token total/);
      return true;
    }
  );

  let outcomeReads = 0;
  const accessor = { usage: [RECEIPT] };
  Object.defineProperty(accessor, "outcome", {
    enumerable: true,
    get() {
      outcomeReads += 1;
      return "completed";
    }
  });
  assert.throws(
    () => snapshotNodeTurnCompletion(accessor),
    (error) => {
      assert.equal(error instanceof NodeTurnCompletionSnapshotError, true);
      assert.equal(error.usage.length, 1);
      assert.match(error.message, /outcome must be an enumerable data property/);
      return true;
    }
  );
  assert.equal(outcomeReads, 0);
});

test("usage receipt count is rejected before any element descriptor or value is touched", () => {
  const oversized = [];
  oversized.length = MAX_AGENT_TURN_USAGE_RECEIPTS + 1;
  let getterCalls = 0;
  Object.defineProperty(oversized, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return RECEIPT;
    }
  });
  assert.throws(
    () => snapshotNodeTurnCompletion({ outcome: "completed", usage: oversized }),
    /at most 256 receipts are allowed/
  );
  assert.equal(getterCalls, 0);
});

test("completion descriptor lookup ignores ambient optional usage", () => {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, "usage");
  let getterCalls = 0;
  try {
    Object.defineProperty(Object.prototype, "usage", {
      configurable: true,
      get() {
        getterCalls += 1;
        return [RECEIPT];
      }
    });
    const completion = validateNodeTurnCompletion(codeNode, { outcome: "ok" });
    assert.equal(Object.hasOwn(completion, "usage"), false);
  } finally {
    if (original === undefined) delete Object.prototype.usage;
    else Object.defineProperty(Object.prototype, "usage", original);
  }
  assert.equal(getterCalls, 0);
});

test("model completion: requires exactly one valid receipt", () => {
  const completion = validateNodeTurnCompletion(modelNode, {
    outcome: "classified",
    usage: [RECEIPT]
  });
  assert.equal(completion.usage.length, 1);
  assert.equal(Object.isFrozen(completion.usage), true);

  assert.throws(
    () => validateNodeTurnCompletion(modelNode, { outcome: "classified" }),
    /must return exactly one usage receipt \(got none\)/
  );
  assert.throws(
    () => validateNodeTurnCompletion(modelNode, {
      outcome: "classified",
      usage: [RECEIPT, RECEIPT]
    }),
    /must return exactly one usage receipt \(got 2\)/
  );
  assert.throws(
    () => snapshotNodeTurnCompletion({
      outcome: "classified",
      usage: [{ ...RECEIPT, chargedTokens: 0 }]
    }),
    /chargedTokens \(0\) must cover observed token total \(5\)/
  );
});

test("agent completion: admits only explicit bounded receipt collection", () => {
  assert.deepEqual(
    validateNodeTurnCompletion(agentNode, { outcome: "completed" }),
    { outcome: "completed" }
  );
  assert.deepEqual(
    validateNodeTurnCompletion(agentNode, { outcome: "completed", usage: [] }),
    { outcome: "completed", usage: [] }
  );
  const metered = validateNodeTurnCompletion(agentNode, {
    outcome: "completed",
    usage: [RECEIPT]
  });
  assert.equal(metered.usage[0].chargedCostMicroUsd, 7);
  assert.throws(
    () => snapshotNodeTurnCompletion({
      outcome: "completed",
      usage: Array.from({ length: MAX_AGENT_TURN_USAGE_RECEIPTS + 1 }, () => RECEIPT)
    }),
    /at most 256 receipts are allowed/
  );
});

test("unmetered completion: code, human, and callback ports cannot smuggle usage", () => {
  for (const current of [codeNode, humanNode, callbackNode]) {
    assert.throws(
      () => validateNodeTurnCompletion(current, {
        outcome: current.outcomes.outcomes[0],
        usage: []
      }),
      new RegExp(`${current.kind} node ${current.nodeId} must not return usage receipts`)
    );
  }
});

test("ordinary port completion: engine-reserved and undeclared outcomes fail with exact node/outcome", () => {
  assert.throws(
    () => validateNodeTurnCompletion(codeNode, {
      outcome: ENGINE_JOIN_UNSATISFIABLE_OUTCOME
    }),
    /node code-work outcome "join_unsatisfiable" is engine-reserved/
  );
  assert.throws(
    () => validateNodeTurnCompletion(codeNode, { outcome: "mystery" }),
    /node code-work returned undeclared outcome "mystery"/
  );
});

test("ordinary port completion: routing, spawning, timing, and malformed artifact fields are closed out", () => {
  for (const forbidden of ["routing", "successors", "spawn", "units", "timer", "timeoutMs"]) {
    assert.throws(
      () => validateNodeTurnCompletion(codeNode, {
        outcome: "ok",
        [forbidden]: true
      }),
      new RegExp(`unknown key\\(s\\) "${forbidden}"`)
    );
  }
  assert.throws(
    () => validateNodeTurnCompletion(codeNode, {
      outcome: "ok",
      outputArtifact: { ...OUTPUT, digest: "0".repeat(64) }
    }),
    /digest mismatch/
  );
  assert.throws(
    () => validateNodeTurnCompletion(codeNode, {
      outcome: "ok",
      outputArtifact: undefined
    }),
    /outputArtifact is present but undefined/
  );
});

test("ordinary port completion: accessors, Proxies, symbols, and post-snapshot mutation cannot switch evidence", () => {
  let outcomeReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "outcome", {
    enumerable: true,
    get() {
      outcomeReads += 1;
      return "ok";
    }
  });
  assert.throws(
    () => snapshotNodeTurnCompletion(accessor),
    /outcome must be an enumerable data property/
  );
  assert.equal(outcomeReads, 0);
  assert.throws(
    () => snapshotNodeTurnCompletion(new Proxy({ outcome: "ok" }, {})),
    /plain non-Proxy object|Proxies are not accepted|must not contain Proxies/
  );
  assert.throws(
    () => snapshotNodeTurnCompletion({ outcome: "ok", [Symbol("authority")]: true }),
    /symbol keys/
  );

  const raw = { outcome: "ok" };
  const snapshot = snapshotNodeTurnCompletion(raw);
  raw.outcome = "mystery";
  assert.deepEqual(validateNodeTurnCompletion(codeNode, snapshot), { outcome: "ok" });
});

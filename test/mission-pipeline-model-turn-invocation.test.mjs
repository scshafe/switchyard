// The v2 model invocation request: built from exactly what a ModelNodePort
// receives, bound to the sealed binding the node's ref names, and passed
// through a verified resolved binding unchanged.

import test from "node:test";
import assert from "node:assert/strict";

import { artifactRef, createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import { digest } from "mission-pipeline/contracts/digest";
import { snapshotWorkerNodeTurnContext } from "mission-pipeline/execute/ports";
import {
  createInferenceProfileRef,
  createModelStageBinding,
  modelStageBindingRef
} from "mission-pipeline/model/binding";
import {
  modelTurnInvocationRequest,
  verifyResolvedModelBinding
} from "mission-pipeline/model/invoker";

/** Prototype-free frozen records compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function sealedBinding(bindingId) {
  return createModelStageBinding({
    schemaVersion: "model-stage-binding.v2",
    bindingId,
    version: 1,
    kind: "model",
    modelRevisionRef: { id: "judge.model", version: 1, digest: digest({ model: "judge" }) },
    inferenceProfileRef: createInferenceProfileRef({
      id: `${bindingId}.profile`,
      version: 1,
      parameters: {
        temperature: 0,
        seed: 7,
        thinking: "off",
        timeoutMs: 30_000,
        maxOutputTokens: 64,
        maxOutputBytes: 65_536,
        maxConcurrency: 1,
        toolPolicy: "none",
        responseContract: "judge-answer.v1"
      }
    })
  });
}

const BINDING = sealedBinding("judge.binding");
const INPUT = createArtifactEnvelope("judge-input.v1", { question: "Is this an outage?" });

function contextDraft(overrides = {}) {
  return {
    graph: { id: "example.judge", version: 1, digest: "b".repeat(64) },
    queueId: "queue-7",
    unitId: "unit-42",
    nodeId: "judge",
    nodeRef: { id: "judge.node", version: 3 },
    attemptNumber: 2,
    attemptIndex: 2,
    idempotencyKey: "c".repeat(64),
    inputArtifact: artifactRef(INPUT),
    ...overrides
  };
}

const USAGE = Object.freeze({
  schemaVersion: "usage-receipt.v1",
  trust: "provider_reported",
  observedInputTokens: 10,
  observedOutputTokens: 2,
  chargedTokens: 12,
  observedCostMicroUsd: 0,
  chargedCostMicroUsd: 0,
  durationMs: 5
});

test("model turn invocation: the request is built from the snapshot context and the exact sealed binding", () => {
  const context = snapshotWorkerNodeTurnContext(contextDraft());
  const request = modelTurnInvocationRequest({
    context,
    input: INPUT.payload,
    bindingRef: modelStageBindingRef(BINDING),
    binding: BINDING
  });
  assert.deepEqual(plain(request), {
    unitId: "unit-42",
    queueId: "queue-7",
    nodeId: "judge",
    nodeRef: { id: "judge.node", version: 3 },
    attemptNumber: 2,
    attemptIndex: 2,
    idempotencyKey: "c".repeat(64),
    inputArtifact: plain(artifactRef(INPUT)),
    input: { question: "Is this an outage?" },
    binding: plain(BINDING)
  });
  // The payload is the engine's validated object, passed through by identity.
  assert.equal(request.input, INPUT.payload);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.hasOwn(request, "runId"), false);
  assert.equal(Object.hasOwn(request, "stage"), false);
});

test("model turn invocation: a forged context, a stray field, and a ref for another binding are refused", () => {
  const fields = (overrides) => ({
    context: snapshotWorkerNodeTurnContext(contextDraft()),
    input: INPUT.payload,
    bindingRef: modelStageBindingRef(BINDING),
    binding: BINDING,
    ...overrides
  });

  const { queueId: _dropped, ...partial } = contextDraft();
  assert.throws(
    () => modelTurnInvocationRequest(fields({ context: partial })),
    /model turn invocation context\.queueId is required/
  );
  assert.throws(
    () => modelTurnInvocationRequest(fields({ context: contextDraft({ stage: { id: "judge", version: 1 } }) })),
    /model turn invocation context: unknown key\(s\) "stage"/
  );
  assert.throws(
    () => modelTurnInvocationRequest({ ...fields({}), runId: "run-1" }),
    /model turn invocation: unknown key\(s\) "runId"/
  );
  assert.throws(
    () => modelTurnInvocationRequest(fields({ bindingRef: { ...modelStageBindingRef(BINDING), bindingDigest: "a".repeat(64) } })),
    /model binding resolution: digest mismatch for judge\.binding@1/
  );
  assert.throws(
    () => modelTurnInvocationRequest(fields({ binding: sealedBinding("judge.other") })),
    /model binding resolution: ref judge\.binding@1 does not name binding judge\.other@1/
  );
  // The context is captured, never trusted: an accessor is refused unread.
  let reads = 0;
  const hostile = contextDraft();
  Object.defineProperty(hostile, "unitId", { enumerable: true, get() { reads += 1; return "unit-42"; } });
  assert.throws(() => modelTurnInvocationRequest(fields({ context: hostile })), /unitId must be an enumerable data property/);
  assert.equal(reads, 0);
});

test("model turn invocation: a verified resolved binding passes either request shape through unchanged", async () => {
  const calls = [];
  const resolved = verifyResolvedModelBinding({
    async invoke(request, signal) {
      calls.push({ request, signal });
      return { output: { answer: "yes" }, usage: USAGE };
    }
  }, BINDING);

  const request = modelTurnInvocationRequest({
    context: snapshotWorkerNodeTurnContext(contextDraft()),
    input: INPUT.payload,
    bindingRef: modelStageBindingRef(BINDING),
    binding: BINDING
  });
  const controller = new AbortController();
  const result = await resolved.invoke(request, controller.signal);
  assert.deepEqual(result.output, { answer: "yes" });
  assert.equal(calls[0].request, request);
  assert.equal(calls[0].signal, controller.signal);

  // Hosts that still send the pre-1.1.0 shape reach the same resolver.
  const legacy = Object.freeze({
    runId: "unit-42",
    itemId: "queue-7",
    nodeId: "judge",
    stage: { id: "judge.node", version: 3 },
    attempt: 2,
    idempotencyKey: "c".repeat(64),
    input: INPUT.payload,
    binding: BINDING
  });
  await resolved.invoke(legacy);
  assert.equal(calls[1].request, legacy);
  assert.equal(calls[1].signal, undefined);
});

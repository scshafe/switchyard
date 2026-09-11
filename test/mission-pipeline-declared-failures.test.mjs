import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactEnvelope, artifactRef } from "mission-pipeline/contracts/artifact";
import { createGraphDefinition, graphDefinitionRef } from "mission-pipeline/graph/definition";
import { ExecutionFailureError } from "mission-pipeline/execute/failure";
import { withDeclaredFailureOutcomes } from "mission-pipeline/execute/declared-failures";
import { executeNodeTurnAttempt, isNodeTurnInvocationUncertainError, nodeExecutionFingerprint, nodeTurnIdempotencyKey, nodeTurnResultErrorUsage } from "mission-pipeline/execute/turn";
import { runNextUnitTurn, NODE_TURN_USAGE_EVENT_TYPE } from "mission-pipeline/execute/unit-runner";
import { MemoryGraphStore } from "mission-pipeline/store/memory-graph-store";
import { MemoryUnitStore } from "mission-pipeline/store/memory-unit-store";

const BINDING = { kind: "model", bindingId: "test.binding", version: 1, bindingDigest: "b".repeat(64) };
const TURN = { idempotency: "per (unitId, nodeId, attemptNumber)", leaseMs: 300, maxAttempts: 1, retryTaxonomy: "retryable vs terminal, as v1 durable-stage" };
const receipt = (overrides = {}) => ({ schemaVersion: "usage-receipt.v1", trust: "provider_reported", observedInputTokens: 2, observedOutputTokens: 3, chargedTokens: 5, observedCostMicroUsd: 7, chargedCostMicroUsd: 7, durationMs: 11, ...overrides });
const ceiling = () => receipt({ trust: "estimated_tier_ceiling", observedInputTokens: null, observedOutputTokens: null, observedCostMicroUsd: null, chargedTokens: 99, chargedCostMicroUsd: 100 });
const zero = () => receipt({ observedInputTokens: 0, observedOutputTokens: 0, chargedTokens: 0, observedCostMicroUsd: 0, chargedCostMicroUsd: 0, durationMs: 0 });
const refusal = () => new ExecutionFailureError("provider_refused", false);
const artifact = ({ input, evidence }) => createArtifactEnvelope("unit-artifact.v1", { ...input, admission: evidence.admission });
const options = (kind, overrides = {}) => ({ kind, outcomes: { provider_refused: "review" }, artifact, ...(kind === "model" ? { receipt: () => [ceiling()] } : {}), ...overrides });
function graph(kind = "model") {
  const node = (nodeId, kind, outcomes) => ({ nodeId, ref: { id: `test.${kind}.${nodeId}`, version: 1 }, kind, input: "unit-artifact.v1", outcomes: { version: 1, outcomes }, principal: { id: "v2_worker" }, ...(kind === "model" ? { binding: BINDING } : {}), turn: TURN });
  return createGraphDefinition({ graphId: `test.declared.${kind}`, version: 1, description: "Declared failure policies with real journal evidence.", entry: "work", nodes: [node("work", kind, ["done", "review"]), node("review", "code", ["done"])], edges: [{ edgeId: "to-review", from: "work", when: { outcome: "review" }, to: ["review"] }], terminals: [{ nodeId: "work", outcome: "done" }, { nodeId: "review", outcome: "done" }] });
}
function direct(kind = "model", unitId = "unit-1", extra = {}) {
  const definition = graph(kind);
  const node = definition.nodes.find((node) => node.nodeId === "work");
  const inputArtifact = createArtifactEnvelope("unit-artifact.v1", { unitId });
  const context = { graph: graphDefinitionRef(definition), queueId: `queue-${unitId}`, unitId, nodeId: "work", nodeRef: node.ref, attemptNumber: 1, attemptIndex: 1, inputArtifact: artifactRef(inputArtifact), idempotencyKey: nodeTurnIdempotencyKey({ unitId, nodeId: node.nodeId, attemptNumber: 1, nodeRef: node.ref, fingerprint: nodeExecutionFingerprint(node), inputDigest: inputArtifact.digest }), ...extra };
  return { node, context, inputArtifact };
}
async function harness(kind = "model", unitId = "unit-1") {
  const graphStore = new MemoryGraphStore();
  const clock = { epoch: Date.parse("2026-09-11T12:00:00.000Z") };
  let id = 0;
  const store = new MemoryUnitStore({ graphStore, now: () => new Date(clock.epoch), idFactory: (kind) => `declared-${kind}-${++id}` });
  const definition = graph(kind);
  await graphStore.publishGraph(definition);
  await store.admitUnit({ unitId, graph: graphDefinitionRef(definition), seedArtifact: createArtifactEnvelope("unit-artifact.v1", { unitId }), admittedAt: new Date(clock.epoch).toISOString(), principalId: "v2_admitter" });
  const run = (port, extra = {}) => runNextUnitTurn({ store, principalId: "v2_worker", leaseOwner: "declared-worker", nodeId: "work", ports: { [kind]: port }, now: () => new Date(clock.epoch), ...extra });
  return { store, clock, run };
}
function assertFrozenData(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), null);
  for (const child of Object.values(value)) assertFrozenData(child);
}

test("declared code failure routes a fallback artifact and captures immutable capabilities", async () => {
  let calls = 0;
  const body = { async run(input, context, evidence) { calls++; assertFrozenData(input); assertFrozenData(context); assertFrozenData(evidence); throw refusal(); } };
  const policies = options("code");
  const port = withDeclaredFailureOutcomes(body, policies);
  body.run = async () => { throw new Error("mutated body called"); };
  policies.outcomes.provider_refused = "done";
  policies.artifact = () => { throw new Error("mutated artifact called"); };
  assert.equal(Object.getPrototypeOf(port), null);
  const h = await harness("code");
  assert.equal((await h.run(port)).status, "succeeded");
  assert.equal(calls, 1);
  const state = h.store.stateSnapshot();
  assert.equal(state.failures.length, 0);
  assert.equal(state.queues.some((row) => row.nodeId === "review"), true);
  assert.equal(state.outbox.filter((row) => row.eventType === NODE_TURN_USAGE_EVENT_TYPE).length, 0);
});

test("model policy distinguishes explicit pre-dispatch and admitted unknown attempts without invented telemetry", async () => {
  for (const admission of ["not_admitted", "admitted", "unknown"]) {
    let seen;
    const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { if (admission !== "unknown") evidence.setAdmission(admission); throw refusal(); } }, options("model", { receipt: (invocation) => { seen = invocation; return [admission === "not_admitted" ? zero() : ceiling()]; } }));
    const h = await harness();
    assert.equal((await h.run(port)).status, "succeeded");
    assertFrozenData(seen);
    assert.equal(seen.evidence.admission, admission);
    assert.equal(seen.binding.bindingDigest, BINDING.bindingDigest);
    assert.equal(seen.input.unitId, "unit-1");
    const state = h.store.stateSnapshot();
    assert.equal(state.failures.length, 0);
    assert.equal(state.cachedCompletions[0].completion.usage[0].chargedTokens, admission === "not_admitted" ? 0 : 99);
    assert.equal(state.outbox.length, 1);
  }
});

test("captured model telemetry wins over fallback policy, and artifact failure retains exact-attempt receipts", async () => {
  const captured = receipt();
  let policyCalls = 0;
  const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { evidence.setAdmission("admitted"); evidence.recordUsage(captured); captured.chargedTokens = 999; throw refusal(); } }, options("model", { receipt() { policyCalls++; throw new Error("must not replace telemetry"); }, artifact() { throw new Error("fallback construction failed"); } }));
  const h = await harness();
  assert.equal((await h.run(port)).status, "terminal");
  const state = h.store.stateSnapshot();
  assert.equal(policyCalls, 0);
  assert.equal(state.failures[0].usage[0].chargedTokens, 5);
  assert.equal(state.outbox.length, 1);
  assert.equal(state.cachedCompletions.length, 0);
  assert.equal(state.queues.some((row) => row.nodeId === "review"), false);
});

test("policy receipt survives fallback rejection and cannot be replayed under another attempt", async () => {
  const port = withDeclaredFailureOutcomes({ async invoke() { throw refusal(); } }, options("model", { artifact() { throw new Error("fallback construction failed"); } }));
  const first = direct();
  let failure;
  await assert.rejects(executeNodeTurnAttempt({ ...first, ports: { model: port } }), (error) => { failure = error; return true; });
  assert.equal(nodeTurnResultErrorUsage(failure, "work", first.context.idempotencyKey)[0].chargedTokens, 99);
  assert.equal(nodeTurnResultErrorUsage(failure, "other", first.context.idempotencyKey), undefined);
  assert.equal(nodeTurnResultErrorUsage(failure, "work", "f".repeat(64)), undefined);
  const second = await harness("model", "unit-2");
  assert.equal((await second.run({ async invoke() { throw failure; } })).status, "terminal");
  assert.equal(second.store.stateSnapshot().failures[0].usage.length, 0);
  assert.equal(second.store.stateSnapshot().outbox.length, 0);
});

test("unmapped failures pass through by identity and thrown usage never grants receipt evidence", async () => {
  for (const failure of [new ExecutionFailureError("unmapped", false), Object.assign(new Error("unmapped"), { usage: [receipt()] }), new Proxy({}, { get() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); }, getPrototypeOf() { throw new Error("trap"); } })]) {
    const port = withDeclaredFailureOutcomes({ async invoke() { throw failure; } }, options("model"));
    const call = direct();
    let actual;
    try { await port.invoke(call.inputArtifact.payload, BINDING, call.context); assert.fail("expected original rejection"); }
    catch (error) { actual = error; }
    assert.equal(actual, failure);
  }
  const h = await harness();
  await h.run(withDeclaredFailureOutcomes({ async invoke() { throw Object.assign(new ExecutionFailureError("unmapped", false), { usage: [receipt()] }); } }, options("model")));
  assert.equal(h.store.stateSnapshot().failures[0].usage.length, 0);
});

test("policy rejection has no invented receipt and a malformed agent policy retains its validated prefix", async () => {
  const h = await harness();
  await h.run(withDeclaredFailureOutcomes({ async invoke() { throw refusal(); } }, options("model", { receipt() { throw new Error("no evidence policy available"); } })));
  assert.equal(h.store.stateSnapshot().failures[0].usage.length, 0);
  const a = await harness("agent");
  const port = withDeclaredFailureOutcomes({ async submitTurnIntent() {}, async awaitSettledResult() { throw refusal(); } }, options("agent", { receipt: () => [receipt(), { invalid: true }] }));
  await a.run(port);
  assert.equal(a.store.stateSnapshot().failures[0].usage.length, 1);
  assert.equal(a.store.stateSnapshot().outbox.length, 1);
});

test("pre-dispatch paid receipt contradictions are rejected without journaling contradictory usage", async () => {
  for (const capture of [true, false]) {
    const h = await harness();
    const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { evidence.setAdmission("not_admitted"); if (capture) evidence.recordUsage(receipt()); throw refusal(); } }, options("model"));
    assert.equal((await h.run(port)).status, "terminal");
    assert.equal(h.store.stateSnapshot().failures[0].usage.length, 0);
    assert.equal(h.store.stateSnapshot().outbox.length, 0);
    assert.equal(h.store.stateSnapshot().cachedCompletions.length, 0);
  }
});

test("agent definite submission and await failures become declared completions with bounded receipts", async () => {
  for (const phase of ["submit", "await"]) {
    let awaits = 0;
    const h = await harness("agent");
    const port = withDeclaredFailureOutcomes({ async submitTurnIntent(input, context, evidence) { evidence.setAdmission("admitted"); evidence.recordUsage(receipt()); if (phase === "submit") throw refusal(); }, async awaitSettledResult(context, evidence) { awaits++; evidence.recordUsage(receipt({ chargedTokens: 10 })); throw refusal(); } }, options("agent"));
    assert.equal((await h.run(port)).status, "succeeded");
    assert.equal(awaits, phase === "submit" ? 0 : 1);
    assert.equal(h.store.stateSnapshot().cachedCompletions[0].completion.usage.length, phase === "submit" ? 1 : 2);
    assert.equal(h.store.stateSnapshot().outbox.length, phase === "submit" ? 1 : 2);
  }
});

test("agent transport uncertainty, cancellation, and marked unresolved work stay reclaimable with the same attempt key", async () => {
  for (const reason of ["submit", "await", "abort", "typed_abort", "unresolved"]) {
    const h = await harness("agent");
    const controller = new AbortController();
    const keys = [];
    let first = true;
    const port = withDeclaredFailureOutcomes({ async submitTurnIntent(input, context, evidence) { keys.push(context.idempotencyKey); if (first && reason === "submit") throw new Error("connection lost"); if (first && reason === "unresolved") { evidence.markUnresolved(); throw refusal(); } }, async awaitSettledResult() { if (!first) return { outcome: "done" }; if (reason === "abort") controller.abort(); if (reason === "typed_abort") throw new ExecutionFailureError("cancelled", false); if (reason === "await") throw new Error("connection lost"); throw refusal(); } }, options("agent", { outcomes: { provider_refused: "review", dependency_unavailable: "review", cancelled: "review" } }));
    await assert.rejects(h.run(port, { signal: controller.signal }), isNodeTurnInvocationUncertainError);
    const before = h.store.stateSnapshot();
    assert.equal(before.failures.length, 0);
    assert.equal(before.cachedCompletions.length, 0);
    assert.equal(before.outbox.length, 0);
    first = false;
    h.clock.epoch += 1_000;
    assert.equal((await h.run(port)).status, "succeeded");
    assert.equal(keys[0], keys[1]);
  }
});

test("concurrent model invocations isolate evidence and close captured capabilities", async () => {
  const ready = [];
  const scopes = [];
  const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { scopes.push(evidence); evidence.setAdmission("admitted"); evidence.recordUsage(receipt({ chargedTokens: input.unitId === "unit-1" ? 11 : 22 })); await new Promise((resolve) => ready.push(resolve)); throw refusal(); } }, options("model"));
  const a = direct("model", "unit-1"); const b = direct("model", "unit-2");
  const first = port.invoke(a.inputArtifact.payload, BINDING, a.context);
  const second = port.invoke(b.inputArtifact.payload, BINDING, b.context);
  ready[1](); ready[0]();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.usage[0].chargedTokens), [11, 22]);
  for (const result of results) assertFrozenData(result);
  assert.notEqual(scopes[0], scopes[1]);
  for (const scope of scopes) assert.throws(() => scope.recordUsage(receipt()), /closed/);
});

test("strict construction rejects hostile options and captures methods without getters or Proxy calls", () => {
  let traps = 0;
  const hostile = new Proxy({}, { get() { traps++; }, ownKeys() { traps++; }, getPrototypeOf() { traps++; } });
  const getter = { get run() { traps++; return async () => ({ outcome: "done" }); } };
  const body = { async run() { return { outcome: "done" }; } };
  assert.throws(() => withDeclaredFailureOutcomes(body, hostile), /non-Proxy/);
  assert.throws(() => withDeclaredFailureOutcomes(getter, options("code")), /data property/);
  assert.throws(() => withDeclaredFailureOutcomes({ run: new Proxy(body.run, {}) }, options("code")), /non-Proxy/);
  assert.throws(() => withDeclaredFailureOutcomes(body, options("code", { artifact: hostile })), /function/);
  assert.throws(() => withDeclaredFailureOutcomes(body, options("code", { outcomes: hostile })), /non-Proxy/);
  assert.throws(() => withDeclaredFailureOutcomes(body, options("code", { receipt: undefined })), /must not supply/);
  assert.throws(() => withDeclaredFailureOutcomes({ invoke: body.run }, { kind: "model", outcomes: {}, artifact }), /require a receipt/);
  assert.throws(() => withDeclaredFailureOutcomes(body, options("code", { outcomes: { provider_refused: "join_unsatisfiable" } })), /engine-reserved/);
  assert.throws(() => withDeclaredFailureOutcomes(body, { ...options("code"), unexpected: true }), /unknown key/);
  assert.equal(traps, 0);
});

test("invalid returned completion retains engine receipt validation rather than remapping it", async () => {
  const h = await harness();
  const original = { outcome: "not_declared", usage: [receipt()] };
  const port = withDeclaredFailureOutcomes({ async invoke() { return original; } }, options("model", { artifact() { assert.fail("returned validation failures are engine-owned"); } }));
  assert.equal((await h.run(port)).status, "terminal");
  const state = h.store.stateSnapshot();
  assert.equal(state.failures[0].usage[0].chargedTokens, 5);
  assert.equal(state.outbox.length, 1);
});

test("unmapped object failures retain captured usage while preserving identity; unmapped primitives preserve identity only", async () => {
  const original = new ExecutionFailureError("unmapped", false);
  const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { evidence.recordUsage(receipt()); throw original; } }, options("model"));
  const call = direct();
  await assert.rejects(port.invoke(call.inputArtifact.payload, BINDING, call.context), (error) => error === original);
  assert.equal(nodeTurnResultErrorUsage(original, "work", call.context.idempotencyKey)[0].chargedTokens, 5);
  const h = await harness();
  await h.run(port);
  assert.equal(h.store.stateSnapshot().failures[0].usage[0].chargedTokens, 5);
  assert.equal(h.store.stateSnapshot().outbox.length, 1);
  const primitive = "unmapped primitive";
  const primitivePort = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { evidence.recordUsage(receipt()); throw primitive; } }, options("model"));
  await assert.rejects(primitivePort.invoke(call.inputArtifact.payload, BINDING, call.context), (error) => error === primitive);
  assert.equal(nodeTurnResultErrorUsage(primitive, "work", call.context.idempotencyKey), undefined);
});

test("cancellation after asynchronous receipt or artifact policy never emits a fallback completion", async () => {
  for (const kind of ["model", "agent"]) for (const phase of ["receipt", "artifact"]) {
    const controller = new AbortController();
    let artifactCalls = 0;
    const body = kind === "model"
      ? { async invoke() { throw refusal(); } }
      : { async submitTurnIntent() {}, async awaitSettledResult() { throw refusal(); } };
    const port = withDeclaredFailureOutcomes(body, options(kind, {
      receipt: async () => { await Promise.resolve(); if (phase === "receipt") controller.abort(); return [receipt()]; },
      artifact: async (invocation) => { artifactCalls++; await Promise.resolve(); controller.abort(); return artifact(invocation); }
    }));
    const h = await harness(kind);
    if (kind === "agent") await assert.rejects(h.run(port, { signal: controller.signal }), isNodeTurnInvocationUncertainError);
    else assert.equal((await h.run(port, { signal: controller.signal })).status, "terminal");
    const state = h.store.stateSnapshot();
    assert.equal(artifactCalls, phase === "receipt" ? 0 : 1);
    assert.equal(state.cachedCompletions.length, 0);
    assert.equal(state.queues.some((row) => row.nodeId === "review"), false);
    if (kind === "model") {
      assert.equal(state.failures[0].usage[0].chargedTokens, 5);
      assert.equal(state.outbox.length, 1);
    } else {
      assert.equal(state.failures.length, 0);
      assert.equal(state.outbox.length, 0);
    }
  }
});

test("agent capture spans both phases, cannot cross context identities, and enforces the receipt bound", async () => {
  let scope;
  const port = withDeclaredFailureOutcomes({ async submitTurnIntent(input, context, evidence) { scope = evidence; }, async awaitSettledResult(context, evidence) { assert.equal(evidence, scope); for (let index = 0; index < 256; index++) evidence.recordUsage(receipt()); assert.throws(() => evidence.recordUsage(receipt()), /at most 256/); throw refusal(); } }, options("agent"));
  const call = direct("agent");
  await port.submitTurnIntent(call.inputArtifact.payload, call.context);
  scope.setAdmission("admitted");
  await assert.rejects(port.awaitSettledResult({ ...call.context }), /submitted context/);
  const result = await port.awaitSettledResult(call.context);
  assert.equal(result.usage.length, 256);
  assert.throws(() => scope.setAdmission("unknown"), /closed/);
  await assert.rejects(port.awaitSettledResult(call.context), /submitted context/);
});

test("receipt lookup treats node and attempt as distinct coordinates even for colon-bearing node IDs", async () => {
  const original = new ExecutionFailureError("unmapped", false);
  const port = withDeclaredFailureOutcomes({ async invoke(input, binding, context, evidence) { evidence.recordUsage(receipt()); throw original; } }, options("model"));
  const call = direct("model", "unit-1", { nodeId: "work:prefix" });
  await assert.rejects(port.invoke(call.inputArtifact.payload, BINDING, call.context), (error) => error === original);
  assert.equal(nodeTurnResultErrorUsage(original, "work:prefix", call.context.idempotencyKey).length, 1);
  assert.equal(nodeTurnResultErrorUsage(original, "work", `prefix:${call.context.idempotencyKey}`), undefined);
  let calls = 0;
  const hostileCoordinate = { toJSON() { calls++; return "work:prefix"; } };
  assert.equal(nodeTurnResultErrorUsage(original, hostileCoordinate, call.context.idempotencyKey), undefined);
  assert.equal(nodeTurnResultErrorUsage(original, "work:prefix", hostileCoordinate), undefined);
  assert.equal(calls, 0);
});

test("agent aborted between submit and await retains submitted receipts on its rejected object", async () => {
  const controller = new AbortController();
  const port = withDeclaredFailureOutcomes({ async submitTurnIntent(input, context, evidence) { evidence.recordUsage(receipt()); }, async awaitSettledResult() { assert.fail("must not await after cancellation"); } }, options("agent"));
  const call = direct("agent", "unit-1", { signal: controller.signal });
  await port.submitTurnIntent(call.inputArtifact.payload, call.context);
  controller.abort();
  let rejection;
  await assert.rejects(port.awaitSettledResult(call.context), (error) => { rejection = error; return error.name === "AbortError"; });
  assert.equal(nodeTurnResultErrorUsage(rejection, "work", call.context.idempotencyKey)[0].chargedTokens, 5);
});

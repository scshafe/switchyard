// mission-restructure B6 — the frozen agent-step contract + executor port +
// agent node invoker. Covers: schema mirror pins; request built faithfully from
// a compiled agent node; deadline → timed_out (retryable); output-contract
// coupling; required-receipts-array with the non-silent-zero floor; status
// routing (failed terminal / timed_out + infra_error retryable); e2e on the
// memory store through the model→gate→agent fallback chain; and the
// descriptor-carrier round-trip (the fail-closed ⊆-check is the EAL's, not ours).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  validateAgentStepRequest,
  validateAgentStepResult,
  AGENT_STEP_REQUEST_SCHEMA_VERSION,
  AGENT_STEP_RESULT_SCHEMA_VERSION
} from "mission-pipeline/agent/step";
import {
  createAgentNodeInvoker,
  createAgentReceiptLedger,
  AGENT_USAGE_RECEIPT_EVENT_TYPE
} from "mission-pipeline/agent/executor-port";
import { createFakeAgentStepExecutor, fakeUsageReceipt } from "mission-pipeline/agent/fake-executor";
import { PipelineStageError } from "mission-pipeline/execute/durable-stage";
import { digest } from "mission-pipeline/contracts/digest";
import { createPipelineDefinition } from "mission-pipeline/definition";
import { StageCatalog } from "mission-pipeline/catalog";
import { compilePipeline } from "mission-pipeline/compile";
import { MemoryPipelineStore } from "mission-pipeline/memory-store";
import { runOneShard } from "mission-pipeline/execute/shard-runner";
import { createModelNodeInvoker } from "mission-pipeline/model/invoker";

const mirror = (rel) => new URL(`../schemas/${rel}`, import.meta.url);
const fixture = (rel) => new URL(`./fixtures/mission-pipeline/${rel}`, import.meta.url);

const ENV = {
  schemaVersion: "environment-descriptor.v1",
  network: "model-endpoint",
  capabilities: ["network:model"],
  mounts: [],
  secretRefs: [],
  io: { inputContract: "routed-item.v1", outputContract: "draft.v1" }
};

const KNOWN = ["routed-item.v1", "draft.v1"];
const fakeContracts = () => ({
  knows: (id) => KNOWN.includes(id),
  validate: (id, value) => (KNOWN.includes(id) ? { ok: true, value } : { ok: false, issues: [{ message: `unknown ${id}` }] })
});

// ── 1. Frozen-schema mirror pins ──────────────────────────────────────────

for (const name of ["agent-step-request.v1.schema.json", "agent-step-result.v1.schema.json"]) {
  test(`frozen-schema pin: ${name} byte-equals the checked-in fixture`, () => {
    assert.equal(readFileSync(mirror(name), "utf8"), readFileSync(fixture(name), "utf8"),
      `${name}: the package mirror drifted from the frozen fixture`);
  });
}

// ── 2. Request/result validators ──────────────────────────────────────────

const goodRequest = () => ({
  schemaVersion: AGENT_STEP_REQUEST_SCHEMA_VERSION,
  stage: { stageId: "draft.reply", version: 1 },
  environment: ENV,
  brief: { instructions: "Draft a reply.", inputArtifacts: [], outputContract: "draft.v1" },
  idempotencyKey: "run-1:i1:draft:1",
  deadlineMs: 30000
});

test("validateAgentStepRequest: accepts a good request; rejects a non-descriptor environment", () => {
  const req = validateAgentStepRequest(goodRequest());
  assert.equal(req.brief.outputContract, "draft.v1");
  // environment carrier must name the descriptor keys + version — but capability
  // semantics are NOT checked here (that is the EAL adapter's ⊆-assert).
  assert.throws(() => validateAgentStepRequest({ ...goodRequest(), environment: { network: "none" } }),
    /not an environment-descriptor\.v1 value — missing required key/);
  assert.throws(() => validateAgentStepRequest({ ...goodRequest(), environment: { ...ENV, schemaVersion: "environment-descriptor.v2" } }),
    /schemaVersion must be "environment-descriptor\.v1"/);
});

test("validateAgentStepResult: completed⇔output coupling + required-usage floor", () => {
  const ok = validateAgentStepResult({
    schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
    status: "completed",
    output: { d: 1 },
    usage: [fakeUsageReceipt()]
  });
  assert.equal(ok.status, "completed");
  // completed without output
  assert.throws(() => validateAgentStepResult({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", usage: [fakeUsageReceipt()] }),
    /status "completed" requires an output/);
  // non-completed with output
  assert.throws(() => validateAgentStepResult({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "failed", output: {}, usage: [fakeUsageReceipt()] }),
    /must not carry an output/);
  // empty usage only allowed for infra_error
  assert.throws(() => validateAgentStepResult({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "failed", usage: [], failure: { kind: "x", detail: "y" } }),
    /usage may be empty ONLY for status "infra_error"/);
  const infra = validateAgentStepResult({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "infra_error", usage: [], failure: { kind: "spawn", detail: "no node" } });
  assert.equal(infra.usage.length, 0);
  // a silent-zero receipt is rejected by the per-element floor
  assert.throws(() => validateAgentStepResult({
    schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", output: {},
    usage: [fakeUsageReceipt({ trust: "unavailable", observedInputTokens: null, observedOutputTokens: null, observedCostMicroUsd: null, chargedTokens: 0, chargedCostMicroUsd: 0 })]
  }));
});

// ── 3. Invoker: request construction + routing ─────────────────────────────

function agentInvokerSetup(handler, invokerOpts = {}) {
  const seenRequests = [];
  const executor = createFakeAgentStepExecutor({
    onRequest: (req) => seenRequests.push(req),
    default: handler
  });
  const invoker = createAgentNodeInvoker({
    executor,
    specs: [{ stage: { id: "draft.reply", version: 1 }, instructions: "Draft a reply.", environment: ENV, deadlineMs: 50 }],
    catalogContracts: fakeContracts(),
    ...invokerOpts
  });
  return { invoker, seenRequests };
}

const agentNode = () => ({
  nodeId: "draft",
  stage: { id: "draft.reply", version: 1 },
  inputs: [{ slot: "item", source: { kind: "pipeline_input" }, contract: "routed-item.v1" }],
  kind: "agent",
  outputContract: "draft.v1",
  capabilities: [],
  deliverySemantics: "at_least_once_idempotent",
  bindingFingerprint: "none"
});

const AGENT_STAGE_IDEMPOTENCY_KEY = digest({ test: "agent-stage-action" });
const invocation = (over = {}) => ({
  runId: "run-1",
  itemId: "i1",
  node: agentNode(),
  input: { item: "hi" },
  attempt: 1,
  idempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY,
  ...over
});

test("agent invoker: builds a faithful request (instructions, sealed input artifact, outputContract, idempotencyKey)", async () => {
  const receipts = [];
  const { invoker, seenRequests } = agentInvokerSetup(
    () => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", output: { drafted: true }, usage: [fakeUsageReceipt()] }),
    { onReceipt: (r) => receipts.push(r) }
  );
  const out = await invoker.invoke(invocation());
  assert.deepEqual(out, { drafted: true });
  const req = seenRequests[0];
  assert.equal(req.brief.instructions, "Draft a reply.");
  assert.equal(req.brief.outputContract, "draft.v1");
  assert.equal(req.idempotencyKey, digest({
    schemaVersion: "agent-provider-attempt-idempotency.v1",
    stageIdempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY,
    attempt: 1
  }));
  assert.equal(req.brief.inputArtifacts.length, 1);
  assert.equal(req.brief.inputArtifacts[0].contractId, "routed-item.v1");
  assert.equal(req.brief.inputArtifacts[0].digest, digest({ item: "hi" }), "the composed input is sealed content-addressed");
  // environment round-trips into the executor UNCHANGED (the ⊆-check is the EAL's)
  assert.deepEqual(req.environment, ENV);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt.trust, "provider_reported");
});

test("agent invoker snapshots invocation and freezes the exact provider request before await", async () => {
  const receipts = [];
  let requestMutationRejected = false;
  const invoker = createAgentNodeInvoker({
    executor: {
      async execute(request) {
        assert.ok(Object.isFrozen(request));
        assert.ok(Object.isFrozen(request.brief));
        try {
          request.idempotencyKey = "f".repeat(64);
        } catch (error) {
          requestMutationRejected = error instanceof TypeError;
        }
        await Promise.resolve();
        return {
          schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
          status: "completed",
          output: { drafted: true },
          usage: [fakeUsageReceipt()]
        };
      }
    },
    specs: [{
      stage: { id: "draft.reply", version: 1 },
      instructions: "Draft a reply.",
      environment: ENV,
      deadlineMs: 50
    }],
    catalogContracts: fakeContracts(),
    onReceipt: (record) => receipts.push(record)
  });
  const result = await invoker.invoke(invocation());
  assert.deepEqual(result, { drafted: true });
  assert.equal(requestMutationRejected, true);
  const expectedProviderKey = digest({
    schemaVersion: "agent-provider-attempt-idempotency.v1",
    stageIdempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY,
    attempt: 1
  });
  assert.equal(receipts[0].providerIdempotencyKey, expectedProviderKey);
  assert.equal(receipts[0].attempt, 1);

  let attemptReads = 0;
  const hostile = invocation();
  Object.defineProperty(hostile, "attempt", {
    enumerable: true,
    get() {
      attemptReads += 1;
      return attemptReads === 1 ? 1 : 2;
    }
  });
  await assert.rejects(
    invoker.invoke(hostile),
    /node invocation\.attempt must be an enumerable data property/
  );
  assert.equal(attemptReads, 0);
});

test("agent factory options and receipt-ledger contexts reject accessors without reading them", () => {
  let specsReads = 0;
  const options = {
    executor: { execute: async () => ({}) },
    catalogContracts: fakeContracts()
  };
  Object.defineProperty(options, "specs", {
    enumerable: true,
    get() {
      specsReads += 1;
      return [];
    }
  });
  assert.throws(
    () => createAgentNodeInvoker(options),
    /createAgentNodeInvoker options\.specs must be an enumerable data property/
  );
  assert.equal(specsReads, 0);

  const ledger = createAgentReceiptLedger();
  ledger.onReceipt({
    runId: "run-1",
    itemId: "i1",
    nodeId: "draft",
    stage: { id: "draft.reply", version: 1 },
    attempt: 1,
    idempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY,
    providerIdempotencyKey: digest({ provider: 1 }),
    receiptIndex: 0,
    receipt: fakeUsageReceipt()
  });
  let runReads = 0;
  const context = {
    itemId: "i1",
    node: agentNode(),
    attempt: 1,
    idempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY
  };
  Object.defineProperty(context, "runId", {
    enumerable: true,
    get() {
      runReads += 1;
      return runReads === 1 ? "run-1" : "run-2";
    }
  });
  assert.throws(
    () => ledger.outboxEventsFor(context),
    /agent receipt outbox context\.runId must be an enumerable data property/
  );
  assert.equal(runReads, 0);
  const batch = ledger.outboxEventsFor({
    runId: "run-1",
    itemId: "i1",
    node: agentNode(),
    attempt: 1,
    idempotencyKey: AGENT_STAGE_IDEMPOTENCY_KEY
  });
  assert.equal(batch.length, 1, "the rejected dynamic context did not drain pending evidence");
});

test("agent invoker: unknown agent stage is LOUD shard-scoped (closed catalog)", async () => {
  const { invoker } = agentInvokerSetup(() => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", output: {}, usage: [fakeUsageReceipt()] }));
  const node = { ...agentNode(), stage: { id: "unregistered.stage", version: 1 } };
  await assert.rejects(() => invoker.invoke(invocation({ node })), (e) => {
    assert.ok(e instanceof PipelineStageError);
    assert.equal(e.code, "agent_spec_unresolved");
    assert.equal(e.scope, "shard");
    assert.equal(e.retryable, false);
    return true;
  });
});

test("agent invoker: status routing — failed terminal, timed_out + infra_error retryable", async () => {
  const failed = agentInvokerSetup(() => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "failed", usage: [fakeUsageReceipt()], failure: { kind: "refusal", detail: "no" } }));
  await assert.rejects(() => failed.invoker.invoke(invocation()), (e) => {
    assert.equal(e.code, "agent_step_failed");
    assert.equal(e.scope, "item");
    assert.equal(e.retryable, false);
    return true;
  });

  const infra = agentInvokerSetup(() => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "infra_error", usage: [], failure: { kind: "spawn", detail: "docker down" } }));
  await assert.rejects(() => infra.invoker.invoke(invocation()), (e) => {
    assert.equal(e.code, "agent_step_infra_error");
    assert.equal(e.retryable, true);
    return true;
  });

  const timedByStatus = agentInvokerSetup(() => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "timed_out", usage: [fakeUsageReceipt()], failure: { kind: "deadline", detail: "slow" } }));
  await assert.rejects(() => timedByStatus.invoker.invoke(invocation()), (e) => {
    assert.equal(e.code, "agent_step_timed_out");
    assert.equal(e.retryable, true);
    return true;
  });
});

test("agent invoker: a non-cooperative executor that overruns the deadline is mapped to timed_out (retryable)", async () => {
  // The spec deadline is 50ms; this executor never resolves, so the invoker's
  // own deadline race must fire. Inject a non-unref'd timer so this isolated
  // test keeps the loop alive (production's default timer is unref'd — correct
  // there, where the shard heartbeat holds the loop open).
  const realSetTimer = (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; };
  const { invoker } = agentInvokerSetup(() => new Promise(() => {}), { setTimer: realSetTimer });
  await assert.rejects(() => invoker.invoke(invocation()), (e) => {
    assert.ok(e instanceof PipelineStageError);
    assert.equal(e.code, "agent_step_timed_out");
    assert.equal(e.retryable, true);
    assert.equal(e.scope, "item");
    return true;
  });
});

test("agent invoker: a completed result WITHOUT a usage receipt is rejected (non-silent-zero at the envelope)", async () => {
  // The fake returns a raw (unvalidated) envelope with empty usage on completed —
  // validateAgentStepResult rejects it as malformed.
  const { invoker } = agentInvokerSetup(() => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", output: {}, usage: [] }));
  await assert.rejects(() => invoker.invoke(invocation()), (e) => {
    assert.equal(e.code, "agent_result_malformed");
    assert.equal(e.scope, "item");
    return true;
  });
});

test("agent invoker: a thrown executor is retryable infra (never usably ran)", async () => {
  const { invoker } = agentInvokerSetup(() => { throw new Error("connect ECONNREFUSED"); });
  await assert.rejects(() => invoker.invoke(invocation()), (e) => {
    assert.equal(e.code, "agent_executor_threw");
    assert.equal(e.retryable, true);
    return true;
  });
});

test("agent invoker: wrong kind delegates to the fallback (model→gate→agent chain)", async () => {
  let fellBack = false;
  const { invoker } = agentInvokerSetup(
    () => ({ schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION, status: "completed", output: {}, usage: [fakeUsageReceipt()] }),
    { fallback: { invoke: async () => { fellBack = true; return { fallback: true }; } } }
  );
  const codeNode = { ...agentNode(), kind: "code" };
  const out = await invoker.invoke(invocation({ node: codeNode }));
  assert.deepEqual(out, { fallback: true });
  assert.ok(fellBack);
});

// ── 4. End-to-end on the memory store through the fallback chain ───────────

test("agent node end-to-end: failed and successful attempt receipts each ride their atomic append", async () => {
  const contracts = fakeContracts();
  const catalog = new StageCatalog({
    contracts,
    registrations: [
      {
        descriptor: {
          stageId: "draft.reply", version: 1, kind: "agent",
          inputs: [{ slot: "item", contract: "routed-item.v1" }],
          outputContract: "draft.v1", capabilities: ["network:model"],
          deliverySemantics: "at_least_once_idempotent"
        },
        executable: { id: "draft.reply", version: 1 }
      }
    ]
  });
  const definition = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: "draft.pipeline", version: 1,
    description: "B6 agent-node e2e",
    inputContract: "routed-item.v1",
    nodes: [{ nodeId: "draft", stage: { id: "draft.reply", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] }],
    outputs: ["draft"]
  });
  const compiled = compilePipeline(definition, catalog);
  assert.equal(compiled.nodes[0].kind, "agent");
  assert.equal(compiled.nodes[0].bindingFingerprint, "none", "agent nodes carry no binding");

  const store = new MemoryPipelineStore();
  const ledger = createAgentReceiptLedger();
  let executorAttempt = 0;
  const executor = createFakeAgentStepExecutor({
    default: () => ++executorAttempt === 1
      ? {
          schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
          status: "timed_out",
          usage: [fakeUsageReceipt()],
          failure: { kind: "deadline", detail: "first attempt timed out" }
        }
      : {
          schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
          status: "completed",
          output: { drafted: "ok" },
          usage: [fakeUsageReceipt()]
        }
  });
  const agentInvoker = createAgentNodeInvoker({
    executor,
    specs: [{ stage: { id: "draft.reply", version: 1 }, instructions: "Draft.", environment: ENV, deadlineMs: 1000 }],
    catalogContracts: contracts,
    onReceipt: ledger.onReceipt
  });
  // Prove the chain: model arm first, agent arm as fallback.
  const invoker = createModelNodeInvoker({ resolver: { resolve: () => { throw new Error("no model here"); } }, bindings: [], catalogContracts: contracts, fallback: agentInvoker });

  await store.createRun({
    run: { runId: "run-1", compiled, createdAt: "2026-07-23T00:00:00.000Z" },
    items: [{ itemId: "i1", ordinal: 1, input: { item: "hello" }, inputDigest: digest({ item: "hello" }) }],
    shards: [{ shardId: "shard-1", itemIds: ["i1"] }]
  });
  const outcome = await runOneShard({
    store, catalog, invoker, leaseOwner: "w1",
    maxAttempts: 2,
    outboxEventsFor: ledger.outboxEventsFor,
    failureOutboxEventsFor: ledger.failureOutboxEventsFor
  });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.itemCount, 1);
  // Both provider-bearing attempts rode their respective atomic appends.
  const receiptEvents = store.outboxEventRecords.filter((e) => e.eventType === AGENT_USAGE_RECEIPT_EVENT_TYPE);
  assert.deepEqual(receiptEvents.map((event) => event.payload.attempt), [1, 2]);
  for (const event of receiptEvents) {
    assert.match(
      event.dedupeKey,
      new RegExp(`^agent-receipt:run-1:i1:draft:${event.payload.attempt}:0:action:[a-f0-9]{64}:call:[a-f0-9]{64}:evidence:[a-f0-9]{64}$`)
    );
  }
  assert.deepEqual(
    ledger.failureOutboxEventsFor({
      runId: "run-1",
      itemId: "i1",
      node: compiled.nodes[0],
      attempt: 1,
      idempotencyKey: receiptEvents[0].payload.idempotencyKey
    }),
    []
  );
});

// mission-pipeline-durable.test.mjs — B3 of the STANDALONE mission-pipeline
// package: the PipelineStore port + MemoryPipelineStore (fencing, append-only,
// atomic transactional outbox), the durable stage executor (idempotency-key
// reuse, bounded retries, dead-letter exactly once, retryable-vs-terminal
// taxonomy), and the one-shard runner (per-item isolation, heartbeats,
// finalization states, crash-safe reclaim).
//
// All hermetic (no network, no DB, no real Postgres). Time is injected — the
// crash/reclaim scenarios advance a fake clock instead of sleeping.

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { digest } from "mission-pipeline/contracts/digest";
import { createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import { createPipelineDefinition } from "mission-pipeline/definition";
import { StageCatalog } from "mission-pipeline/catalog";
import { compilePipeline } from "mission-pipeline/compile";
import { ShardLeaseLostError, WorkLeaseLostError } from "mission-pipeline/store";
import { MemoryPipelineStore } from "mission-pipeline/memory-store";
import {
  ContractViolationError,
  PipelineStageError,
  classifyStageFailure,
  composeStageInput,
  executeDurableStage,
  stageIdempotencyKey
} from "mission-pipeline/execute/durable-stage";
import {
  PipelineShardCancelledError,
  PipelineShardDeferredError
} from "mission-pipeline/execute/control";
import { createFakeNodeInvoker, runOneShard } from "mission-pipeline/execute/shard-runner";

// ── Fixtures ──────────────────────────────────────────────────────────────

const KNOWN_CONTRACTS = ["item.v1", "step-a.v1", "step-b.v1", "pipeline-node-input.v1", "classified.v1"];

// The fake ContractValidator: knows the listed contracts; rejects any value
// carrying `__invalid` (the poison the contract-violation tests use).
const fakeContracts = () => ({
  knows: (contractId) => KNOWN_CONTRACTS.includes(contractId),
  validate: (contractId, value) => {
    if (!KNOWN_CONTRACTS.includes(contractId)) {
      return { ok: false, issues: [{ message: `unknown contract ${contractId}` }] };
    }
    if (value !== null && typeof value === "object" && value.__invalid === true) {
      return { ok: false, issues: [{ path: "__invalid", message: "poisoned value" }] };
    }
    return { ok: true, value };
  }
});

const descriptor = (stageId, kind, inputContract, outputContract, extra = {}) => ({
  stageId,
  version: 1,
  kind,
  inputs: [{ slot: "item", contract: inputContract }],
  outputContract,
  deliverySemantics: "at_least_once_idempotent",
  ...extra
});

// Builds catalog + sealed definition + compiled pipeline + store + run.
// `stageA`/`stageB` are the run() implementations of the two code stages
// (a → b in series); items become one shard unless shards are given.
function setup({ stageA, stageB, items, shards, now, contracts = fakeContracts(), nodes } = {}) {
  const runsA = [];
  const runsB = [];
  const catalog = new StageCatalog({
    contracts,
    registrations: [
      {
        descriptor: descriptor("step.a", "code", "item.v1", "step-a.v1"),
        executable: {
          id: "step.a",
          version: 1,
          run: async (input, ctx) => {
            runsA.push({ input, ctx });
            return stageA ? stageA(input, ctx) : { value: input.value * 2 };
          }
        }
      },
      {
        descriptor: descriptor("step.b", "code", "step-a.v1", "step-b.v1"),
        executable: {
          id: "step.b",
          version: 1,
          run: async (input, ctx) => {
            runsB.push({ input, ctx });
            return stageB ? stageB(input, ctx) : { value: input.value + 1 };
          }
        }
      },
      {
        descriptor: descriptor("classify.model", "model", "step-a.v1", "classified.v1", { capabilities: ["network:model"] }),
        executable: { id: "classify.model", version: 1 }
      }
    ]
  });
  const definition = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: "test.pipeline",
    version: 1,
    description: "B3 durable-execution fixture",
    inputContract: "item.v1",
    nodes: nodes ?? [
      { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
      { nodeId: "b", stage: { id: "step.b", version: 1 }, inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }] }
    ],
    outputs: nodes ? [nodes[nodes.length - 1].nodeId] : ["b"]
  });
  const compiled = compilePipeline(definition, catalog);
  const store = new MemoryPipelineStore(now ? { now } : {});
  const runItems = (items ?? [{ value: 1 }]).map((input, index) => ({
    itemId: `i${index + 1}`,
    ordinal: index + 1,
    input,
    inputDigest: digest(input)
  }));
  return {
    catalog,
    definition,
    compiled,
    store,
    runsA,
    runsB,
    runItems,
    async createRun() {
      await store.createRun({
        run: { runId: "run-1", compiled, createdAt: "2026-07-23T00:00:00.000Z" },
        items: runItems,
        shards: shards ?? [{ shardId: "shard-1", itemIds: runItems.map((item) => item.itemId) }]
      });
    }
  };
}

const nodeById = (compiled, nodeId) => compiled.nodes.find((node) => node.nodeId === nodeId);

const slotFor = (item) => [{ slot: "item", contract: "item.v1", value: item.input }];

function durableInput(ctx, claim, node, item, overrides = {}) {
  return {
    store: ctx.store,
    contracts: ctx.catalog.contracts,
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    node,
    slots: slotFor(item),
    invoke: (input, stageCtx) => ctx.catalog.resolveExecutable(node.stage.id, node.stage.version).run(input, stageCtx),
    ...overrides
  };
}

// ── The idempotency key ───────────────────────────────────────────────────

test("stage idempotency key derives from the compiled node alone and shifts with each identity field", () => {
  const { compiled } = setup();
  const node = nodeById(compiled, "a");
  const base = { runId: "r", itemId: "i", node, inputDigest: digest({ value: 1 }) };
  const key = stageIdempotencyKey(base);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(stageIdempotencyKey(base), key, "deterministic");
  assert.notEqual(stageIdempotencyKey({ ...base, runId: "r2" }), key);
  assert.notEqual(stageIdempotencyKey({ ...base, itemId: "i2" }), key);
  assert.notEqual(stageIdempotencyKey({ ...base, inputDigest: digest({ value: 2 }) }), key);
  // fingerprint participates: a binding change changes the key.
  const rebound = { ...node, bindingFingerprint: "a".repeat(64) };
  assert.notEqual(stageIdempotencyKey({ ...base, node: rebound }), key);
  const reconfigured = { ...node, configurationFingerprint: "b".repeat(64) };
  assert.notEqual(stageIdempotencyKey({ ...base, node: reconfigured }), key);
});

test("composeStageInput: one slot passes the bare value; several compose by slot under the promoted marker contract", () => {
  const single = composeStageInput([{ slot: "item", contract: "item.v1", value: { value: 7 } }]);
  assert.deepEqual(single, { input: { value: 7 }, inputContract: "item.v1" });
  const multi = composeStageInput([
    { slot: "left", contract: "item.v1", value: 1 },
    { slot: "right", contract: "step-a.v1", value: 2 }
  ]);
  assert.deepEqual(multi, { input: { left: 1, right: 2 }, inputContract: "pipeline-node-input.v1" });
});

// ── Cached-success reuse ──────────────────────────────────────────────────

test("re-running a succeeded stage reuses the cached result (reused=true, nothing re-invoked)", async () => {
  const ctx = setup();
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];

  const first = await executeDurableStage(durableInput(ctx, claim, node, item));
  assert.equal(first.status, "succeeded");
  assert.equal(first.reused, false);
  assert.deepEqual(first.output, { value: 2 });
  assert.equal(ctx.runsA.length, 1);

  const second = await executeDurableStage(durableInput(ctx, claim, node, item));
  assert.equal(second.status, "succeeded");
  assert.equal(second.reused, true, "second run must reuse the persisted success");
  assert.deepEqual(second.output, { value: 2 });
  assert.equal(second.outputDigest, first.outputDigest);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(ctx.runsA.length, 1, "the stage must not execute again");
});

// ── Retry budget → dead letter, exactly once ──────────────────────────────

test("retry budget exhaustion dead-letters exactly once and terminal replays stop at the same node", async () => {
  const ctx = setup({ stageA: () => { throw new Error("boom the stage broke"); } });
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];

  const result = await executeDurableStage(durableInput(ctx, claim, node, item, { maxAttempts: 2 }));
  assert.equal(result.status, "terminal");
  assert.equal(result.errorCode, "stage_execution_failed");
  assert.equal(ctx.runsA.length, 2, "exactly maxAttempts executions");
  const attempts = ctx.store.attemptsForKey(result.idempotencyKey);
  assert.deepEqual(attempts.map((a) => [a.status, a.terminal]), [["failed", false], ["failed", true]]);
  assert.equal(ctx.store.deadLetterRecords.length, 1, "exactly one dead letter");
  const [deadLetter] = ctx.store.deadLetterRecords;
  assert.equal(deadLetter.idempotencyKey, result.idempotencyKey);
  assert.equal(deadLetter.attempts, 2);
  assert.equal(deadLetter.error.code, "stage_execution_failed");

  // Replay: prepare reports terminal — no new attempt, no second dead letter.
  const replay = await executeDurableStage(durableInput(ctx, claim, node, item, { maxAttempts: 2 }));
  assert.equal(replay.status, "terminal");
  assert.equal(ctx.runsA.length, 2, "replay must not re-execute");
  assert.equal(ctx.store.deadLetterRecords.length, 1, "replay must not re-dead-letter");
  assert.equal(ctx.store.attemptsForKey(result.idempotencyKey).length, 2);

  // recordDeadLetter checks the shard fence before its append-once lookup.
  await assert.rejects(
    ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: claim.shardId,
      leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef"
    }),
    ShardLeaseLostError
  );
  const dup = await ctx.store.recordDeadLetter({
    ...deadLetter,
    shardId: claim.shardId,
    leaseToken: claim.leaseToken
  });
  assert.deepEqual(dup, { created: false });
  assert.equal(ctx.store.deadLetterRecords.length, 1);
});

test("standalone dead-letter recording rejects expired and reclaimed shard fences before duplicate lookup", async () => {
  let t = Date.parse("2026-07-23T00:00:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({ now });
  await ctx.createRun();
  const firstClaim = await ctx.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 1_000
  });
  assert.ok(firstClaim);
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];
  const deadLetter = {
    runId: firstClaim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: { id: node.stage.id, version: node.stage.version },
    idempotencyKey: stageIdempotencyKey({
      runId: firstClaim.runId,
      itemId: item.itemId,
      node,
      inputDigest: digest(item.input)
    }),
    input: item.input,
    error: { code: "payload_unprocessable", message: "fixture" },
    attempts: 1,
    createdAt: now().toISOString()
  };

  await assert.rejects(
    ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: firstClaim.shardId,
      leaseToken: firstClaim.leaseToken
    }),
    /has no prepared stage execution/
  );
  const prepared = await ctx.store.prepareStageExecution({
    shardId: firstClaim.shardId,
    leaseToken: firstClaim.leaseToken,
    runId: firstClaim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: node.stage,
    idempotencyKey: deadLetter.idempotencyKey,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(prepared.disposition, "reserved");
  if (prepared.disposition !== "reserved") return;
  await ctx.store.persistStageFailure({
    shardId: firstClaim.shardId,
    leaseToken: firstClaim.leaseToken,
    executionId: prepared.executionId,
    idempotencyKey: deadLetter.idempotencyKey,
    runId: firstClaim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    attempt: prepared.attempt,
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    errorCode: "dependency_unavailable",
    retryable: true,
    scope: "item",
    terminal: false
  });

  assert.deepEqual(
    await ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: firstClaim.shardId,
      leaseToken: firstClaim.leaseToken
    }),
    { created: true }
  );

  t += 1_001;
  await assert.rejects(
    ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: firstClaim.shardId,
      leaseToken: firstClaim.leaseToken
    }),
    ShardLeaseLostError,
    "even an existing idempotency key must reject an expired fence"
  );

  const reclaimed = await ctx.store.claimNextShard({
    leaseOwner: "worker-2",
    leaseDurationMs: 60_000
  });
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseToken, firstClaim.leaseToken);
  await assert.rejects(
    ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: reclaimed.shardId,
      leaseToken: firstClaim.leaseToken
    }),
    ShardLeaseLostError,
    "the reclaimed shard must reject its former token before duplicate lookup"
  );
  assert.deepEqual(
    await ctx.store.recordDeadLetter({
      ...deadLetter,
      shardId: reclaimed.shardId,
      leaseToken: reclaimed.leaseToken
    }),
    { created: false }
  );
  assert.equal(ctx.store.deadLetterRecords.length, 1);
  assert.equal("shardId" in ctx.store.deadLetterRecords[0], false);
  assert.equal("leaseToken" in ctx.store.deadLetterRecords[0], false);
});

test("a crash-replay past the budget dead-letters idempotently without a new attempt", async () => {
  // Stage a history of two non-terminal failed attempts (as if a bigger budget
  // was configured and the worker crashed between the last failure and its
  // terminalization), then replay under maxAttempts 2.
  const ctx = setup();
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];
  const key = stageIdempotencyKey({ runId: claim.runId, itemId: item.itemId, node, inputDigest: digest(item.input) });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prepared = await ctx.store.prepareStageExecution({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      runId: claim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      stage: { id: node.stage.id, version: node.stage.version },
      idempotencyKey: key,
      inputContract: "item.v1",
      input: item.input,
      inputDigest: digest(item.input)
    });
    assert.equal(prepared.disposition, "reserved");
    assert.equal(prepared.attempt, attempt);
    await ctx.store.persistStageFailure({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      executionId: prepared.executionId,
      idempotencyKey: key,
      runId: claim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      attempt,
      startedAt: "2026-07-23T00:00:01.000Z",
      finishedAt: "2026-07-23T00:00:02.000Z",
      errorCode: "dependency_unavailable",
      retryable: true,
      scope: "item",
      terminal: false
    });
  }

  const result = await executeDurableStage(durableInput(ctx, claim, node, item, { maxAttempts: 2 }));
  assert.equal(result.status, "terminal");
  assert.equal(result.errorCode, "retry_budget_exhausted");
  assert.equal(ctx.runsA.length, 0, "no execution past the budget");
  assert.equal(ctx.store.attemptsForKey(key).length, 2, "no third attempt appended");
  assert.equal(ctx.store.deadLetterRecords.length, 1);
  assert.equal(ctx.store.deadLetterRecords[0].error.code, "retry_budget_exhausted");

  // The replay of the replay changes nothing (append-once dead letter).
  const again = await executeDurableStage(durableInput(ctx, claim, node, item, { maxAttempts: 2 }));
  assert.equal(again.status, "terminal");
  assert.equal(ctx.store.deadLetterRecords.length, 1);
});

test("an item-terminal failure cannot append without its atomic dead letter", async () => {
  const ctx = setup();
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({
    leaseOwner: "w1",
    leaseDurationMs: 60_000
  });
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];
  const key = stageIdempotencyKey({
    runId: claim.runId,
    itemId: item.itemId,
    node,
    inputDigest: digest(item.input)
  });
  const prepared = await ctx.store.prepareStageExecution({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: node.stage,
    idempotencyKey: key,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(prepared.disposition, "reserved");

  await assert.rejects(
    ctx.store.persistStageFailure({
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      executionId: prepared.executionId,
      idempotencyKey: key,
      runId: claim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      attempt: prepared.attempt,
      startedAt: "2026-07-23T00:00:01.000Z",
      finishedAt: "2026-07-23T00:00:02.000Z",
      errorCode: "payload_unprocessable",
      retryable: false,
      scope: "item",
      terminal: true
    }),
    /requires its atomic dead letter/
  );
  assert.equal(ctx.store.attemptsForKey(key).length, 0);
  assert.equal(ctx.store.deadLetterRecords.length, 0);
});

test("failed-attempt outbox events roll back atomically on duplicate dedupe and stale fences", async () => {
  let t = Date.parse("2026-07-23T00:30:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({ now });
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 1_000
  });
  assert.ok(claim);
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];

  // Seed one unrelated outbox dedupe key.
  const seedKey = "e".repeat(64);
  const seed = await ctx.store.prepareStageExecution({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: "seed",
    stage: { id: "step.a", version: 1 },
    idempotencyKey: seedKey,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(seed.disposition, "reserved");
  if (seed.disposition !== "reserved") return;
  const seedOutput = { seeded: true };
  await ctx.store.persistStageSuccess(
    {
      shardId: claim.shardId,
      leaseToken: claim.leaseToken,
      executionId: seed.executionId,
      idempotencyKey: seedKey,
      runId: claim.runId,
      itemId: item.itemId,
      nodeId: "seed",
      attempt: seed.attempt,
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      outputContract: "step-a.v1",
      output: seedOutput,
      outputDigest: digest(seedOutput)
    },
    [{
      eventType: "usage_receipt",
      payload: { seed: true },
      dedupeKey: "receipt:already-recorded"
    }]
  );

  const key = stageIdempotencyKey({
    runId: claim.runId,
    itemId: item.itemId,
    node,
    inputDigest: digest(item.input)
  });
  const prepared = await ctx.store.prepareStageExecution({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: node.stage,
    idempotencyKey: key,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(prepared.disposition, "reserved");
  if (prepared.disposition !== "reserved") return;
  const terminalFailure = {
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    executionId: prepared.executionId,
    idempotencyKey: key,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    attempt: prepared.attempt,
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    errorCode: "provider_output_invalid",
    retryable: false,
    scope: "item",
    terminal: true,
    deadLetter: {
      runId: claim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      stage: node.stage,
      idempotencyKey: key,
      input: item.input,
      error: {
        code: "provider_output_invalid",
        message: "provider returned an invalid payload"
      },
      attempts: prepared.attempt,
      createdAt: now().toISOString()
    }
  };

  await assert.rejects(
    ctx.store.persistStageFailure(
      terminalFailure,
      [{
        eventType: "usage_receipt",
        payload: { attempt: 1 },
        dedupeKey: "receipt:already-recorded"
      }]
    ),
    /already recorded.*atomic outbox/
  );
  assert.equal(ctx.store.attemptsForKey(key).length, 0);
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(ctx.store.outboxEventRecords.length, 1);

  // Expiry and reclaim fence the old token before any failure/outbox evidence.
  t += 1_001;
  const reclaimed = await ctx.store.claimNextShard({
    leaseOwner: "worker-2",
    leaseDurationMs: 60_000
  });
  assert.ok(reclaimed);
  await assert.rejects(
    ctx.store.persistStageFailure(
      terminalFailure,
      [{
        eventType: "usage_receipt",
        payload: { attempt: 1 },
        dedupeKey: "receipt:unique"
      }]
    ),
    ShardLeaseLostError
  );
  assert.equal(ctx.store.attemptsForKey(key).length, 0);
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(ctx.store.outboxEventRecords.length, 1);

  await ctx.store.persistStageFailure(
    { ...terminalFailure, leaseToken: reclaimed.leaseToken },
    [{
      eventType: "usage_receipt",
      payload: { attempt: 1 },
      dedupeKey: "receipt:unique"
    }]
  );
  assert.equal(ctx.store.attemptsForKey(key).length, 1);
  assert.equal(ctx.store.deadLetterRecords.length, 1);
  assert.deepEqual(
    ctx.store.outboxEventRecords.map((event) => event.dedupeKey),
    ["receipt:already-recorded", "receipt:unique"]
  );
});

test("durable failure remains compatible with a one-argument PipelineStore implementation", async () => {
  const ctx = setup({
    stageA: () => {
      throw new PipelineStageError(
        "fixture_terminal",
        false,
        undefined,
        "item"
      );
    }
  });
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000
  });
  assert.ok(claim);
  const calls = [];
  const legacyStore = new Proxy(ctx.store, {
    get(target, property) {
      if (property === "persistStageFailure") {
        return function legacyPersistStageFailure(input) {
          calls.push(arguments.length);
          return target.persistStageFailure(input);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const result = await executeDurableStage({
    ...durableInput(
      ctx,
      claim,
      nodeById(ctx.compiled, "a"),
      ctx.runItems[0],
      { maxAttempts: 1 }
    ),
    store: legacyStore
  });
  assert.equal(result.status, "terminal");
  assert.deepEqual(calls, [1], "the absent additive hook preserves the legacy call shape");
});

// ── Fencing: stale lease tokens ───────────────────────────────────────────

test("a stale leaseToken is rejected LOUDLY on heartbeat/complete/fail/prepare, and expiry fences too", async () => {
  let t = Date.parse("2026-07-23T01:00:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({ now });
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  assert.ok(claim);

  const stale = { shardId: claim.shardId, leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef" };
  await assert.rejects(ctx.store.heartbeatShard({ ...stale, extendByMs: 60_000 }), ShardLeaseLostError);
  await assert.rejects(ctx.store.completeShard({ ...stale }), ShardLeaseLostError);
  await assert.rejects(ctx.store.failShard({ ...stale, retryable: true, errorCode: "x" }), ShardLeaseLostError);
  await assert.rejects(
    ctx.store.prepareStageExecution({
      ...stale,
      runId: claim.runId,
      itemId: "i1",
      nodeId: "a",
      stage: { id: "step.a", version: 1 },
      idempotencyKey: "f".repeat(64),
      inputContract: "item.v1",
      input: { value: 1 },
      inputDigest: digest({ value: 1 })
    }),
    ShardLeaseLostError
  );

  // The REAL token still works…
  await ctx.store.heartbeatShard({ shardId: claim.shardId, leaseToken: claim.leaseToken, extendByMs: 60_000 });
  // …until the lease expires: the same token is then fenced out.
  t += 120_000;
  await assert.rejects(
    ctx.store.heartbeatShard({ shardId: claim.shardId, leaseToken: claim.leaseToken, extendByMs: 60_000 }),
    ShardLeaseLostError
  );
  await assert.rejects(
    ctx.store.completeShard({ shardId: claim.shardId, leaseToken: claim.leaseToken }),
    ShardLeaseLostError
  );
});

// ── Transactional outbox atomicity ────────────────────────────────────────

test("outbox events are atomic with the stage success in the memory store", async () => {
  const ctx = setup();
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];
  const key = stageIdempotencyKey({ runId: claim.runId, itemId: item.itemId, node, inputDigest: digest(item.input) });

  const prepared = await ctx.store.prepareStageExecution({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: { id: node.stage.id, version: node.stage.version },
    idempotencyKey: key,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(prepared.disposition, "reserved");

  const successInput = (leaseToken) => ({
    shardId: claim.shardId,
    leaseToken,
    executionId: prepared.executionId,
    idempotencyKey: key,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    attempt: 1,
    startedAt: "2026-07-23T00:00:01.000Z",
    finishedAt: "2026-07-23T00:00:02.000Z",
    outputContract: node.outputContract,
    output: { value: 2 },
    outputDigest: digest({ value: 2 })
  });
  const events = [
    { eventType: "proposal.recorded", payload: { value: 2 }, dedupeKey: "proposal:i1" },
    { eventType: "audit.trace", payload: { node: "a" } }
  ];

  // A fenced-out persist appends NOTHING: no result, no events.
  await assert.rejects(
    ctx.store.persistStageSuccess(successInput("0f0f0f0f-dead-beef-dead-beefdeadbeef"), events),
    ShardLeaseLostError
  );
  assert.equal(ctx.store.outboxEventRecords.length, 0, "no event without the result");
  const rePrepared = await ctx.store.prepareStageExecution({
    shardId: claim.shardId,
    leaseToken: claim.leaseToken,
    runId: claim.runId,
    itemId: item.itemId,
    nodeId: node.nodeId,
    stage: { id: node.stage.id, version: node.stage.version },
    idempotencyKey: key,
    inputContract: "item.v1",
    input: item.input,
    inputDigest: digest(item.input)
  });
  assert.equal(rePrepared.disposition, "reserved", "the fenced persist must not have appended a result");

  // The real persist lands result + events together.
  const persisted = await ctx.store.persistStageSuccess(successInput(claim.leaseToken), events);
  assert.equal(persisted.created, true);
  assert.equal(ctx.store.outboxEventRecords.length, 2);
  assert.deepEqual(
    ctx.store.outboxEventRecords.map((event) => [event.eventType, event.idempotencyKey]),
    [["proposal.recorded", key], ["audit.trace", key]]
  );

  // A duplicate success appends NOTHING more — events ride exactly-once.
  const duplicate = await ctx.store.persistStageSuccess(successInput(claim.leaseToken), events);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.output, { value: 2 });
  assert.equal(ctx.store.outboxEventRecords.length, 2, "no duplicate events for a duplicate success");
});

// ── Failure taxonomy routing ──────────────────────────────────────────────

test("classifyStageFailure promotes the inbox taxonomy", () => {
  assert.deepEqual(classifyStageFailure(new PipelineStageError("custom", false, undefined, "item")), {
    code: "custom", retryable: false, scope: "item"
  });
  assert.deepEqual(classifyStageFailure(new ShardLeaseLostError("s")), {
    code: "shard_lease_lost", retryable: true, scope: "shard"
  });
  assert.deepEqual(classifyStageFailure(new WorkLeaseLostError("k")), {
    code: "work_lease_lost", retryable: true, scope: "shard"
  });
  assert.deepEqual(classifyStageFailure(new ContractViolationError("x", "item.v1", [])), {
    code: "immutable_stage_contract_rejected", retryable: false, scope: "shard"
  });
  assert.deepEqual(classifyStageFailure(new Error("compiled digest mismatch")), {
    code: "immutable_configuration_rejected", retryable: false, scope: "shard"
  });
  assert.deepEqual(classifyStageFailure(new Error("connect ECONNREFUSED 127.0.0.1")), {
    code: "dependency_unavailable", retryable: true, scope: "item"
  });
  assert.deepEqual(classifyStageFailure(new Error("boom")), {
    code: "stage_execution_failed", retryable: true, scope: "item"
  });
});

test("retryable failures burn budget then succeed; terminal failures dead-letter immediately", async () => {
  // Flaky: fails once retryably, then succeeds → 2 attempts, no dead letter.
  let calls = 0;
  const flaky = setup({
    stageA: (input) => {
      calls += 1;
      if (calls === 1) throw new Error("connect ECONNREFUSED upstream");
      return { value: input.value * 2 };
    }
  });
  await flaky.createRun();
  const flakyClaim = await flaky.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const flakyResult = await executeDurableStage(
    durableInput(flaky, flakyClaim, nodeById(flaky.compiled, "a"), flaky.runItems[0], { maxAttempts: 3 })
  );
  assert.equal(flakyResult.status, "succeeded");
  assert.equal(flakyResult.attempts, 2);
  assert.deepEqual(
    flaky.store.attemptsForKey(flakyResult.idempotencyKey).map((a) => [a.status, a.errorCode ?? null]),
    [["failed", "dependency_unavailable"], ["succeeded", null]]
  );
  assert.equal(flaky.store.deadLetterRecords.length, 0);

  // Deliberate non-retryable item failure: one attempt, immediate dead letter.
  const fatal = setup({
    stageA: () => { throw new PipelineStageError("payload_unprocessable", false, undefined, "item"); }
  });
  await fatal.createRun();
  const fatalClaim = await fatal.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const fatalResult = await executeDurableStage(
    durableInput(fatal, fatalClaim, nodeById(fatal.compiled, "a"), fatal.runItems[0], { maxAttempts: 5 })
  );
  assert.equal(fatalResult.status, "terminal");
  assert.equal(fatalResult.errorCode, "payload_unprocessable");
  assert.equal(fatal.store.attemptsForKey(fatalResult.idempotencyKey).length, 1, "no retry of a terminal failure");
  assert.equal(fatal.store.deadLetterRecords.length, 1);
  assert.equal(fatal.store.deadLetterRecords[0].error.code, "payload_unprocessable");
});

test("an immutable contract violation is immediately terminal, shard-scoped, and never dead-letters the item", async () => {
  const ctx = setup({ stageA: () => ({ __invalid: true }) }); // output rejected by the validator
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  await assert.rejects(
    executeDurableStage(durableInput(ctx, claim, nodeById(ctx.compiled, "a"), ctx.runItems[0], { maxAttempts: 5 })),
    ContractViolationError
  );
  assert.equal(ctx.runsA.length, 1, "no retry of an immutable failure");
  assert.equal(ctx.store.deadLetterRecords.length, 0, "shard-scoped failures are not item dead letters");
  const key = stageIdempotencyKey({
    runId: claim.runId,
    itemId: "i1",
    node: nodeById(ctx.compiled, "a"),
    inputDigest: digest(ctx.runItems[0].input)
  });
  const attempts = ctx.store.attemptsForKey(key);
  assert.deepEqual(attempts.map((a) => [a.status, a.errorCode, a.scope, a.terminal]), [
    ["failed", "immutable_stage_contract_rejected", "shard", true]
  ]);
});

test("an at_most_once node is never retried even with budget left", async () => {
  const ctx = setup({ stageA: () => { throw new Error("boom once"); } });
  await ctx.createRun();
  const claim = await ctx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  const node = { ...nodeById(ctx.compiled, "a"), deliverySemantics: "at_most_once" };
  const result = await executeDurableStage(durableInput(ctx, claim, node, ctx.runItems[0], { maxAttempts: 5 }));
  assert.equal(result.status, "terminal");
  assert.equal(ctx.runsA.length, 1, "at_most_once ⇒ exactly one attempt");
  assert.equal(ctx.store.deadLetterRecords.length, 1);
});

// ── Per-item isolation + finalization states (the runner) ─────────────────

test("one poisoned item terminalizes alone: downstream skipped for it, other items complete, shard partial", async () => {
  const ctx = setup({
    items: [{ value: 1 }, { value: 13 }, { value: 3 }],
    stageA: (input) => {
      if (input.value === 13) throw new Error("boom poisoned item");
      return { value: input.value * 2 };
    }
  });
  await ctx.createRun();
  const outcome = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000,
    heartbeatEveryMs: 10_000,
    maxAttempts: 2
  });
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.itemCount, 3);
  assert.equal(outcome.completedItemCount, 2);
  assert.equal(outcome.terminalItemCount, 1);
  assert.equal(ctx.runsB.length, 2, "the poisoned item's downstream node must be skipped");
  assert.equal(ctx.store.deadLetterRecords.length, 1);
  assert.equal(ctx.store.deadLetterRecords[0].itemId, "i2");
  assert.deepEqual(ctx.store.deadLetterRecords[0].input, { value: 13 });

  // A conclusively finalized (partial) shard is not claimable again.
  assert.equal(await ctx.store.claimNextShard({ leaseOwner: "worker-2", leaseDurationMs: 60_000 }), undefined);
});

test("a clean run completes: all nodes execute per item, the shard finalizes completed, the lease is released", async () => {
  const ctx = setup({ items: [{ value: 1 }, { value: 2 }] });
  await ctx.createRun();
  const outcome = await runOneShard({ store: ctx.store, catalog: ctx.catalog, leaseOwner: "worker-1" });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.itemCount, 2);
  assert.equal(outcome.stageExecutionCount, 4);
  assert.equal(outcome.reusedStageCount, 0);
  assert.equal(ctx.store.shardLeaseSnapshot("shard-1"), undefined, "finalization releases the lease");
  assert.equal(await ctx.store.claimNextShard({ leaseOwner: "worker-2", leaseDurationMs: 60_000 }), undefined);
});

test("a shard-scoped failure fails the whole shard; non-retryable shards are never reclaimed, retryable ones are", async () => {
  const ctx = setup({ stageA: () => ({ __invalid: true }) }); // immutable contract violation → shard scope
  await ctx.createRun();
  const outcome = await runOneShard({ store: ctx.store, catalog: ctx.catalog, leaseOwner: "worker-1" });
  assert.deepEqual(outcome, {
    status: "failed",
    runId: "run-1",
    shardId: "shard-1",
    retryable: false,
    errorCode: "immutable_stage_contract_rejected"
  });
  assert.equal(
    await ctx.store.claimNextShard({ leaseOwner: "worker-2", leaseDurationMs: 60_000 }),
    undefined,
    "a non-retryable shard failure is conclusive"
  );

  // Retryable shard failure → the shard returns to the pool.
  const retryCtx = setup();
  await retryCtx.createRun();
  const claim = await retryCtx.store.claimNextShard({ leaseOwner: "w1", leaseDurationMs: 60_000 });
  await retryCtx.store.failShard({ shardId: claim.shardId, leaseToken: claim.leaseToken, retryable: true, errorCode: "dependency_unavailable" });
  const reclaimed = await retryCtx.store.claimNextShard({ leaseOwner: "w2", leaseDurationMs: 60_000 });
  assert.ok(reclaimed, "a retryable shard failure leaves the shard claimable");
  assert.notEqual(reclaimed.leaseToken, claim.leaseToken, "a fresh claim mints a fresh fence");
});

test("retryable shard-scoped stage failures exhaust at the shard boundary without terminalizing an item", async () => {
  const ctx = setup({
    stageA: () => {
      throw new PipelineStageError(
        "shard_dependency_unavailable",
        true,
        undefined,
        "shard"
      );
    }
  });
  await ctx.createRun();

  const first = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-1",
    maxAttempts: 2
  });
  assert.deepEqual(first, {
    status: "failed",
    runId: "run-1",
    shardId: "shard-1",
    retryable: true,
    errorCode: "shard_dependency_unavailable"
  });

  const second = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-2",
    maxAttempts: 2
  });
  assert.deepEqual(second, {
    status: "failed",
    runId: "run-1",
    shardId: "shard-1",
    retryable: false,
    errorCode: "shard_dependency_unavailable"
  });

  const node = nodeById(ctx.compiled, "a");
  const key = stageIdempotencyKey({
    runId: "run-1",
    itemId: "i1",
    node,
    inputDigest: digest(ctx.runItems[0].input)
  });
  assert.deepEqual(
    ctx.store.attemptsForKey(key).map((attempt) => [
      attempt.status,
      attempt.errorCode,
      attempt.scope,
      attempt.terminal
    ]),
    [
      ["failed", "shard_dependency_unavailable", "shard", false],
      ["failed", "shard_dependency_unavailable", "shard", true]
    ]
  );
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(
    await ctx.store.claimNextShard({
      leaseOwner: "worker-3",
      leaseDurationMs: 60_000
    }),
    undefined,
    "the exhausted shard retry budget is conclusive"
  );
});

test("a crash after shard-terminal attempt persistence replays to conclusive failShard without re-invocation", async () => {
  let t = Date.parse("2026-07-23T03:00:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({
    now,
    stageA: () => ({ __invalid: true })
  });
  await ctx.createRun();
  const firstClaim = await ctx.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 1_000
  });
  assert.ok(firstClaim);
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];

  await assert.rejects(
    executeDurableStage(
      durableInput(ctx, firstClaim, node, item, { maxAttempts: 5, now })
    ),
    ContractViolationError
  );
  assert.equal(ctx.runsA.length, 1);
  const key = stageIdempotencyKey({
    runId: firstClaim.runId,
    itemId: item.itemId,
    node,
    inputDigest: digest(item.input)
  });
  assert.deepEqual(
    ctx.store.attemptsForKey(key).map((attempt) => [
      attempt.errorCode,
      attempt.scope,
      attempt.terminal
    ]),
    [["immutable_stage_contract_rejected", "shard", true]]
  );

  // Simulate the worker crashing before runOneShard could call failShard.
  t += 1_001;
  const replay = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-2",
    leaseDurationMs: 60_000,
    maxAttempts: 5,
    now
  });
  assert.deepEqual(replay, {
    status: "failed",
    runId: "run-1",
    shardId: "shard-1",
    retryable: false,
    errorCode: "immutable_stage_contract_rejected"
  });
  assert.equal(ctx.runsA.length, 1, "terminal shard evidence must prevent re-invocation");
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(
    await ctx.store.claimNextShard({
      leaseOwner: "worker-3",
      leaseDurationMs: 60_000
    }),
    undefined,
    "replayed terminal shard evidence must produce a conclusive shard outcome"
  );
});

test("a lowered retry budget preserves prior shard scope and never dead-letters or partial-finalizes the item", async () => {
  let t = Date.parse("2026-07-23T04:00:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({ now });
  await ctx.createRun();
  const firstClaim = await ctx.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 1_000
  });
  assert.ok(firstClaim);
  const node = nodeById(ctx.compiled, "a");
  const item = ctx.runItems[0];
  const key = stageIdempotencyKey({
    runId: firstClaim.runId,
    itemId: item.itemId,
    node,
    inputDigest: digest(item.input)
  });

  // These attempts were valid under an earlier maxAttempts=3 policy.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prepared = await ctx.store.prepareStageExecution({
      shardId: firstClaim.shardId,
      leaseToken: firstClaim.leaseToken,
      runId: firstClaim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      stage: node.stage,
      idempotencyKey: key,
      inputContract: "item.v1",
      input: item.input,
      inputDigest: digest(item.input)
    });
    assert.equal(prepared.disposition, "reserved");
    assert.equal(prepared.attempt, attempt);
    await ctx.store.persistStageFailure({
      shardId: firstClaim.shardId,
      leaseToken: firstClaim.leaseToken,
      executionId: prepared.executionId,
      idempotencyKey: key,
      runId: firstClaim.runId,
      itemId: item.itemId,
      nodeId: node.nodeId,
      attempt,
      startedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      errorCode: "shard_dependency_unavailable",
      retryable: true,
      scope: "shard",
      terminal: false
    });
  }

  // Crash/reclaim under a lower maxAttempts=2 policy: the persisted prior
  // scope must route back to failShard, never to the item dead-letter path.
  t += 1_001;
  const replay = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-2",
    leaseDurationMs: 60_000,
    maxAttempts: 2,
    now
  });
  assert.deepEqual(replay, {
    status: "failed",
    runId: "run-1",
    shardId: "shard-1",
    retryable: false,
    errorCode: "shard_dependency_unavailable"
  });
  assert.equal(ctx.runsA.length, 0, "no attempt may run past the lowered budget");
  assert.equal(ctx.store.attemptsForKey(key).length, 2);
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(
    await ctx.store.claimNextShard({
      leaseOwner: "worker-3",
      leaseDurationMs: 60_000
    }),
    undefined,
    "the lowered shard budget must finalize failed, not partial"
  );
});

// ── Non-code kinds go through the NodeInvoker port ────────────────────────

test("non-code nodes dispatch through the injected NodeInvoker (fake: identity by default, overridable)", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();

  // Without an invoker the model node is a LOUD non-retryable configuration failure.
  const noInvoker = await runOneShard({ store: ctx.store, catalog: ctx.catalog, leaseOwner: "w1" });
  assert.equal(noInvoker.status, "failed");
  assert.equal(noInvoker.retryable, false);
  assert.equal(noInvoker.errorCode, "immutable_configuration_rejected");

  // With the fake invoker (custom handler) the shard completes.
  const ctx2 = setup({ nodes });
  await ctx2.createRun();
  const invocations = [];
  const invoker = createFakeNodeInvoker({
    "classify.model": (invocation) => {
      invocations.push(invocation);
      return { label: "clean", from: invocation.input.value };
    }
  });
  const outcome = await runOneShard({ store: ctx2.store, catalog: ctx2.catalog, invoker, leaseOwner: "w1" });
  assert.equal(outcome.status, "completed");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].node.kind, "model");
  assert.equal(invocations[0].node.bindingFingerprint, "c".repeat(64));
  assert.deepEqual(invocations[0].input, { value: 2 });
});

test("a deferred shard requeues without failed-attempt evidence or retry-budget burn", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();
  let modelCalls = 0;
  const invoker = createFakeNodeInvoker({
    "classify.model": () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        throw new PipelineShardDeferredError("decision_invocation_busy");
      }
      return { label: "clean" };
    }
  });

  const first = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    invoker,
    leaseOwner: "worker-1"
  });
  assert.deepEqual(first, {
    status: "deferred",
    runId: "run-1",
    shardId: "shard-1",
    reasonCode: "decision_invocation_busy"
  });
  const modelKey = stageIdempotencyKey({
    runId: "run-1",
    itemId: "i1",
    node: nodeById(ctx.compiled, "classify"),
    inputDigest: digest({ value: 2 })
  });
  assert.equal(ctx.store.attemptsForKey(modelKey).length, 0);
  assert.equal(ctx.store.deadLetterRecords.length, 0);

  const resumed = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    invoker,
    leaseOwner: "worker-2"
  });
  assert.equal(resumed.status, "completed");
  assert.equal(ctx.runsA.length, 1, "the success before deferral is reused");
  assert.equal(modelCalls, 2);
  assert.deepEqual(
    ctx.store.attemptsForKey(modelKey).map((attempt) => [attempt.attempt, attempt.status]),
    [[1, "succeeded"]],
    "the resumed invocation still owns attempt one"
  );
});

test("a cancelled shard is conclusive without false failed-attempt or dead-letter evidence", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();
  const invoker = createFakeNodeInvoker({
    "classify.model": () => {
      throw new PipelineShardCancelledError("processing_input_superseded");
    }
  });

  const outcome = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    invoker,
    leaseOwner: "worker-1"
  });
  assert.deepEqual(outcome, {
    status: "cancelled",
    runId: "run-1",
    shardId: "shard-1",
    reasonCode: "processing_input_superseded"
  });
  const modelKey = stageIdempotencyKey({
    runId: "run-1",
    itemId: "i1",
    node: nodeById(ctx.compiled, "classify"),
    inputDigest: digest({ value: 2 })
  });
  assert.equal(ctx.store.attemptsForKey(modelKey).length, 0);
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(
    await ctx.store.claimNextShard({
      leaseOwner: "worker-2",
      leaseDurationMs: 60_000
    }),
    undefined,
    "cancelled work is never reclaimed"
  );
});

test("a supersession discovered during success persistence cancels without landing a result or outbox", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();
  const store = new Proxy(ctx.store, {
    get(target, property) {
      if (property === "persistStageSuccess") {
        return (input, outboxEvents) => {
          if (input.nodeId === "classify") {
            throw new PipelineShardCancelledError("processing_input_superseded");
          }
          return target.persistStageSuccess(input, outboxEvents);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const invoker = createFakeNodeInvoker({
    "classify.model": () => ({ label: "clean" })
  });

  const outcome = await runOneShard({
    store,
    catalog: ctx.catalog,
    invoker,
    leaseOwner: "worker-1",
    outboxEventsFor: ({ node }) => node.nodeId === "classify"
      ? [{
          eventType: "proposal.externalize",
          payload: { proposalId: "must-not-land" },
          dedupeKey: "proposal:must-not-land"
        }]
      : []
  });
  assert.equal(outcome.status, "cancelled");
  const modelKey = stageIdempotencyKey({
    runId: "run-1",
    itemId: "i1",
    node: nodeById(ctx.compiled, "classify"),
    inputDigest: digest({ value: 2 })
  });
  assert.equal(ctx.store.attemptsForKey(modelKey).length, 0);
  assert.equal(ctx.store.outboxEventRecords.length, 0);
  assert.equal(
    await ctx.store.getArtifact({
      contractId: "classified.v1",
      digest: digest({ label: "clean" })
    }),
    undefined
  );
});

test("deferShard and cancelShard are token-fenced settlement operations", async () => {
  const deferred = setup();
  await deferred.createRun();
  const deferredClaim = await deferred.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000
  });
  await assert.rejects(
    deferred.store.deferShard({
      shardId: deferredClaim.shardId,
      leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef",
      reasonCode: "decision_invocation_busy"
    }),
    ShardLeaseLostError
  );
  await assert.rejects(
    deferred.store.deferShard({
      shardId: deferredClaim.shardId,
      leaseToken: deferredClaim.leaseToken,
      reasonCode: "not a stable reason"
    }),
    /reasonCode must be a 1\.\.200 character identifier/
  );
  await deferred.store.deferShard({
    shardId: deferredClaim.shardId,
    leaseToken: deferredClaim.leaseToken,
    reasonCode: "decision_invocation_busy"
  });
  assert.ok(
    await deferred.store.claimNextShard({
      leaseOwner: "worker-2",
      leaseDurationMs: 60_000
    }),
    "a correctly fenced deferral releases the shard for reclaim"
  );

  const cancelled = setup();
  await cancelled.createRun();
  const cancelledClaim = await cancelled.store.claimNextShard({
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000
  });
  await assert.rejects(
    cancelled.store.cancelShard({
      shardId: cancelledClaim.shardId,
      leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef",
      reasonCode: "processing_input_superseded"
    }),
    ShardLeaseLostError
  );
  await assert.rejects(
    cancelled.store.cancelShard({
      shardId: cancelledClaim.shardId,
      leaseToken: cancelledClaim.leaseToken,
      reasonCode: "not a stable reason"
    }),
    /reasonCode must be a 1\.\.200 character identifier/
  );
  await cancelled.store.cancelShard({
    shardId: cancelledClaim.shardId,
    leaseToken: cancelledClaim.leaseToken,
    reasonCode: "processing_input_superseded"
  });
  assert.equal(
    await cancelled.store.claimNextShard({
      leaseOwner: "worker-2",
      leaseDurationMs: 60_000
    }),
    undefined
  );
});

test("the runner never reports a control outcome whose settlement lost the shard fence", async () => {
  for (const scenario of [
    {
      method: "deferShard",
      error: new PipelineShardDeferredError("decision_invocation_busy")
    },
    {
      method: "cancelShard",
      error: new PipelineShardCancelledError("processing_input_superseded")
    }
  ]) {
    const nodes = [
      { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
      {
        nodeId: "classify",
        stage: { id: "classify.model", version: 1 },
        inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
        binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
      }
    ];
    const ctx = setup({ nodes });
    await ctx.createRun();
    const store = new Proxy(ctx.store, {
      get(target, property) {
        if (property === scenario.method) {
          return (input) => {
            throw new ShardLeaseLostError(input.shardId);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const invoker = createFakeNodeInvoker({
      "classify.model": () => {
        throw scenario.error;
      }
    });

    await assert.rejects(
      runOneShard({
        store,
        catalog: ctx.catalog,
        invoker,
        leaseOwner: "worker-1"
      }),
      ShardLeaseLostError
    );
  }
});

// ── Heartbeats while running ──────────────────────────────────────────────

test("the runner heartbeats the shard lease while a stage runs", async () => {
  const ctx = setup({ stageA: async (input) => { await sleep(80); return { value: input.value * 2 }; } });
  await ctx.createRun();
  let heartbeats = 0;
  const spy = new Proxy(ctx.store, {
    get(target, property) {
      if (property === "heartbeatShard") {
        return (...args) => {
          heartbeats += 1;
          return target.heartbeatShard(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const outcome = await runOneShard({
    store: spy,
    catalog: ctx.catalog,
    leaseOwner: "w1",
    leaseDurationMs: 60_000,
    heartbeatEveryMs: 10
  });
  assert.equal(outcome.status, "completed");
  assert.ok(heartbeats >= 1, `expected at least one heartbeat, saw ${heartbeats}`);
});

test("authoritative heartbeat cancellation wins over a concurrent stage deferral", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();
  const settlements = { heartbeat: 0, defer: 0, cancel: 0, fail: 0 };
  const store = new Proxy(ctx.store, {
    get(target, property) {
      if (property === "heartbeatShard") {
        return async () => {
          settlements.heartbeat += 1;
          throw new PipelineShardCancelledError("processing_input_superseded");
        };
      }
      if (property === "deferShard") {
        return (...args) => {
          settlements.defer += 1;
          return target.deferShard(...args);
        };
      }
      if (property === "cancelShard") {
        return (...args) => {
          settlements.cancel += 1;
          return target.cancelShard(...args);
        };
      }
      if (property === "failShard") {
        return (...args) => {
          settlements.fail += 1;
          return target.failShard(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const invoker = createFakeNodeInvoker({
    "classify.model": async () => {
      await sleep(30);
      throw new PipelineShardDeferredError("decision_invocation_busy");
    }
  });

  const outcome = await runOneShard({
    store,
    catalog: ctx.catalog,
    invoker,
    leaseOwner: "worker-1",
    leaseDurationMs: 60_000,
    heartbeatEveryMs: 5
  });
  assert.deepEqual(outcome, {
    status: "cancelled",
    runId: "run-1",
    shardId: "shard-1",
    reasonCode: "processing_input_superseded"
  });
  assert.ok(settlements.heartbeat >= 1);
  assert.deepEqual(
    settlements,
    {
      heartbeat: settlements.heartbeat,
      defer: 0,
      cancel: 1,
      fail: 0
    }
  );
});

test("authoritative cancellation discovered by failShard replaces the false failure outcome", async () => {
  const nodes = [
    { nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] },
    {
      nodeId: "classify",
      stage: { id: "classify.model", version: 1 },
      inputs: [{ slot: "item", source: { kind: "node_output", nodeId: "a" } }],
      binding: { kind: "model", bindingId: "haiku-binding", version: 1, bindingDigest: "c".repeat(64) }
    }
  ];
  const ctx = setup({ nodes });
  await ctx.createRun();
  const settlements = { fail: 0, cancel: 0 };
  const store = new Proxy(ctx.store, {
    get(target, property) {
      if (property === "failShard") {
        return async () => {
          settlements.fail += 1;
          throw new PipelineShardCancelledError(
            "processing_input_superseded"
          );
        };
      }
      if (property === "cancelShard") {
        return (...args) => {
          settlements.cancel += 1;
          return target.cancelShard(...args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const outcome = await runOneShard({
    store,
    catalog: ctx.catalog,
    leaseOwner: "worker-1"
  });
  assert.deepEqual(outcome, {
    status: "cancelled",
    runId: "run-1",
    shardId: "shard-1",
    reasonCode: "processing_input_superseded"
  });
  assert.deepEqual(settlements, { fail: 1, cancel: 1 });
  assert.equal(ctx.store.deadLetterRecords.length, 0);
  assert.equal(
    await ctx.store.claimNextShard({
      leaseOwner: "worker-2",
      leaseDurationMs: 60_000
    }),
    undefined
  );
});

// ── Crash-safe reclaim ────────────────────────────────────────────────────

test("crash-safe reclaim: expire the lease, re-claim, cached stages reused, unfinished work resumes", async () => {
  let t = Date.parse("2026-07-23T02:00:00.000Z");
  const now = () => new Date(t);
  const ctx = setup({ items: [{ value: 1 }, { value: 2 }], now });
  await ctx.createRun();

  // Worker 1 claims, finishes ONE node of ONE item, then "crashes".
  const claim1 = await ctx.store.claimNextShard({ leaseOwner: "worker-1", leaseDurationMs: 60_000 });
  const first = await executeDurableStage(durableInput(ctx, claim1, nodeById(ctx.compiled, "a"), ctx.runItems[0]));
  assert.equal(first.status, "succeeded");
  assert.equal(first.reused, false);

  // While the lease is live the shard is contended.
  assert.equal(await ctx.store.claimNextShard({ leaseOwner: "worker-2", leaseDurationMs: 60_000 }), undefined);

  // The lease expires; worker 2 reclaims and the dead worker's token is fenced.
  t += 120_000;
  const outcome = await runOneShard({
    store: ctx.store,
    catalog: ctx.catalog,
    leaseOwner: "worker-2",
    leaseDurationMs: 60_000,
    heartbeatEveryMs: 10_000,
    now
  });
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.itemCount, 2);
  assert.equal(outcome.stageExecutionCount, 4, "every node resolves for every item");
  assert.equal(outcome.reusedStageCount, 1, "the crashed worker's persisted success is reused, not re-run");
  assert.equal(ctx.runsA.length, 2, "item 1 node a ran once (before the crash), item 2 once — nothing re-run");
  assert.equal(ctx.runsB.length, 2);
  await assert.rejects(
    ctx.store.heartbeatShard({ shardId: claim1.shardId, leaseToken: claim1.leaseToken, extendByMs: 60_000 }),
    ShardLeaseLostError,
    "the crashed worker's stale token must be fenced out"
  );
});

// ── Port surface: definitions, artifacts, auxiliary leases ────────────────

test("publishDefinition is idempotent on the identical digest and LOUD on a conflicting republish", async () => {
  const ctx = setup();
  await ctx.store.publishDefinition(ctx.definition);
  await ctx.store.publishDefinition(ctx.definition); // idempotent
  const loaded = await ctx.store.loadDefinition("test.pipeline", 1);
  assert.deepEqual(loaded, ctx.definition);
  assert.equal(await ctx.store.loadDefinition("test.pipeline", 2), undefined);

  const conflicting = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: "test.pipeline",
    version: 1,
    description: "a DIFFERENT definition under the same identity",
    inputContract: "item.v1",
    nodes: [{ nodeId: "a", stage: { id: "step.a", version: 1 }, inputs: [{ slot: "item", source: { kind: "pipeline_input" } }] }],
    outputs: ["a"]
  });
  await assert.rejects(ctx.store.publishDefinition(conflicting), /append-only/);
});

test("artifacts are content-addressed, seal-verified, and idempotent; stage outputs become readable artifacts", async () => {
  const ctx = setup();
  const envelope = createArtifactEnvelope("item.v1", { value: 42 });
  const ref = await ctx.store.putArtifact(envelope);
  assert.deepEqual(await ctx.store.getArtifact(ref), envelope);
  assert.deepEqual(await ctx.store.putArtifact(envelope), ref); // idempotent re-put
  await assert.rejects(ctx.store.putArtifact({ ...envelope, digest: "0".repeat(64) }), /digest mismatch/);
  assert.equal(await ctx.store.getArtifact({ contractId: "item.v1", digest: "1".repeat(64) }), undefined);

  // A persisted stage success is readable back as a content-addressed artifact.
  await ctx.createRun();
  const outcome = await runOneShard({ store: ctx.store, catalog: ctx.catalog, leaseOwner: "w1" });
  assert.equal(outcome.status, "completed");
  const stageArtifact = await ctx.store.getArtifact({ contractId: "step-a.v1", digest: digest({ value: 2 }) });
  assert.deepEqual(stageArtifact?.payload, { value: 2 });
});

test("auxiliary work leases: contention, token-fenced heartbeat/release, expiry takeover, reserved shard prefix", async () => {
  let t = Date.parse("2026-07-23T03:00:00.000Z");
  const now = () => new Date(t);
  const store = new MemoryPipelineStore({ now });

  const lease = await store.acquireLease({ leaseKey: "inference:profile-1:slot-1", leaseOwner: "w1", leaseDurationMs: 30_000 });
  assert.ok(lease);
  assert.equal(await store.acquireLease({ leaseKey: "inference:profile-1:slot-1", leaseOwner: "w2", leaseDurationMs: 30_000 }), undefined, "live lease is contended");

  await store.heartbeatLease({ leaseKey: lease.leaseKey, leaseToken: lease.leaseToken, extendByMs: 30_000 });
  await assert.rejects(
    store.heartbeatLease({ leaseKey: lease.leaseKey, leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef", extendByMs: 30_000 }),
    WorkLeaseLostError
  );
  await assert.rejects(
    store.releaseLease({ leaseKey: lease.leaseKey, leaseToken: "0f0f0f0f-dead-beef-dead-beefdeadbeef" }),
    WorkLeaseLostError,
    "never release a foreign fence"
  );

  // Expiry: a dead owner's lease is replaced; its token is fenced afterwards.
  t += 120_000;
  const takeover = await store.acquireLease({ leaseKey: lease.leaseKey, leaseOwner: "w2", leaseDurationMs: 30_000 });
  assert.ok(takeover, "an expired lease is claimable");
  await assert.rejects(
    store.heartbeatLease({ leaseKey: lease.leaseKey, leaseToken: lease.leaseToken, extendByMs: 30_000 }),
    WorkLeaseLostError
  );
  await store.releaseLease({ leaseKey: takeover.leaseKey, leaseToken: takeover.leaseToken });
  await store.releaseLease({ leaseKey: takeover.leaseKey, leaseToken: takeover.leaseToken }); // absent → no-op

  await assert.rejects(
    store.acquireLease({ leaseKey: "shard:sneaky", leaseOwner: "w1", leaseDurationMs: 30_000 }),
    /reserved for shard claims/
  );
});

// ── Store construction invariants ─────────────────────────────────────────

test("createRun enforces sealed compiled pipeline, digest-true items, and exact shard partition", async () => {
  const ctx = setup({ items: [{ value: 1 }, { value: 2 }] });
  const base = {
    run: { runId: "run-x", compiled: ctx.compiled, createdAt: "2026-07-23T00:00:00.000Z" },
    items: [
      { itemId: "i1", ordinal: 1, input: { value: 1 }, inputDigest: digest({ value: 1 }) },
      { itemId: "i2", ordinal: 2, input: { value: 2 }, inputDigest: digest({ value: 2 }) }
    ],
    shards: [{ shardId: "sx", itemIds: ["i1", "i2"] }]
  };
  // Tampered compiled pipeline → digest mismatch.
  await assert.rejects(
    ctx.store.createRun({ ...base, run: { ...base.run, compiled: { ...ctx.compiled, outputs: ["a"] } } }),
    /digest mismatch/
  );
  // Lying input digest.
  await assert.rejects(
    ctx.store.createRun({ ...base, items: [{ ...base.items[0], inputDigest: "0".repeat(64) }, base.items[1]] }),
    /does not match digest\(input\)/
  );
  // Shards must partition the items exactly.
  await assert.rejects(
    ctx.store.createRun({ ...base, shards: [{ shardId: "sx", itemIds: ["i1"] }] }),
    /unsharded item/
  );
  await assert.rejects(
    ctx.store.createRun({ ...base, shards: [{ shardId: "sx", itemIds: ["i1", "i2"] }, { shardId: "sy", itemIds: ["i2"] }] }),
    /more than one shard/
  );
  // The clean shape lands; duplicate runId is append-only LOUD.
  await ctx.store.createRun(base);
  await assert.rejects(ctx.store.createRun(base), /already exists/);
});

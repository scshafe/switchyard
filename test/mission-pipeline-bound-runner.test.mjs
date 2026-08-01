import test from "node:test";
import assert from "node:assert/strict";

import { StageCatalog } from "mission-pipeline/catalog";
import { compilePipeline } from "mission-pipeline/compile";
import { digest } from "mission-pipeline/contracts/digest";
import { createPipelineDefinition } from "mission-pipeline/definition";
import {
  PipelineControlOutcomeError
} from "mission-pipeline/execute/control";
import {
  executeBoundDurableStage,
  PipelineStageError,
  StageEvidenceAssemblyError
} from "mission-pipeline/execute/durable-stage";
import {
  createBoundPipelineExecutionIdentity,
  executeClaimedShard,
  runBoundShard,
  validateBoundPipelineExecutionIdentity
} from "mission-pipeline/execute/shard-runner";
import { MemoryPipelineStore } from "mission-pipeline/memory-store";
import {
  BoundEvidencePersistenceError,
  ExternalFenceRejectedError
} from "mission-pipeline/store";
import {
  createModelReceiptLedger,
  MODEL_USAGE_RECEIPT_EVENT_TYPE
} from "mission-pipeline/model/invoker";
import {
  createGateEscalationLedger,
  GATE_HUMAN_ESCALATION_EVENT_TYPE
} from "mission-pipeline/gate/executor";
import { combineOutboxEvents } from "mission-pipeline/execute/outbox";

const CONTRACTS = ["item.v1", "step-a.v1", "step-b.v1"];

function contracts() {
  return {
    knows: (contractId) => CONTRACTS.includes(contractId),
    validate: (contractId, value) =>
      CONTRACTS.includes(contractId)
        ? { ok: true, value }
        : {
            ok: false,
            issues: [{ message: `unknown contract ${contractId}` }]
          }
  };
}

function descriptor(
  stageId,
  inputContract,
  outputContract,
  deliverySemantics = "at_least_once_idempotent"
) {
  return {
    stageId,
    version: 1,
    kind: "code",
    inputs: [{ slot: "item", contract: inputContract }],
    outputContract,
    deliverySemantics
  };
}

async function fixture({
  stageA,
  items = [{ value: 2 }],
  deliverySemantics = "at_least_once_idempotent"
} = {}) {
  const invocations = [];
  const catalog = new StageCatalog({
    contracts: contracts(),
    registrations: [
      {
        descriptor: descriptor(
          "step.a",
          "item.v1",
          "step-a.v1",
          deliverySemantics
        ),
        executable: {
          id: "step.a",
          version: 1,
          async run(input, context) {
            invocations.push(["a", input, context]);
            return stageA
              ? stageA(input, context)
              : { value: input.value * 2 };
          }
        }
      },
      {
        descriptor: descriptor(
          "step.b",
          "step-a.v1",
          "step-b.v1",
          deliverySemantics
        ),
        executable: {
          id: "step.b",
          version: 1,
          async run(input, context) {
            invocations.push(["b", input, context]);
            return { value: input.value + 1 };
          }
        }
      }
    ]
  });
  const definition = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: "bound-runner.fixture",
    version: 1,
    description: "Externally fenced runner fixture",
    inputContract: "item.v1",
    nodes: [
      {
        nodeId: "a",
        stage: { id: "step.a", version: 1 },
        inputs: [
          { slot: "item", source: { kind: "pipeline_input" } }
        ]
      },
      {
        nodeId: "b",
        stage: { id: "step.b", version: 1 },
        inputs: [
          {
            slot: "item",
            source: { kind: "node_output", nodeId: "a" }
          }
        ]
      }
    ],
    outputs: ["b"]
  });
  const compiled = compilePipeline(definition, catalog);
  const runItems = items.map((input, index) => ({
    itemId: `item-${index + 1}`,
    ordinal: index + 1,
    input,
    inputDigest: digest(input)
  }));
  const store = new MemoryPipelineStore();
  await store.createRun({
    run: {
      runId: "run-bound",
      compiled,
      createdAt: "2026-07-28T00:00:00.000Z"
    },
    items: runItems,
    shards: [
      {
        shardId: "shard-bound",
        itemIds: runItems.map(({ itemId }) => itemId)
      }
    ]
  });
  const claim = await store.claimNextShard({
    leaseOwner: "host-scheduler",
    leaseDurationMs: 60_000
  });
  assert.ok(claim);
  return {
    catalog,
    store,
    claim,
    invocations,
    shard: {
      runId: claim.runId,
      shardId: claim.shardId,
      compiled: claim.compiled,
      items: claim.items
    }
  };
}

async function singleKindFixture(kind) {
  const catalog = new StageCatalog({
    contracts: contracts(),
    registrations: [{
      descriptor: {
        stageId: `${kind}.stage`,
        version: 1,
        kind,
        inputs: [{ slot: "item", contract: "item.v1" }],
        outputContract: "step-a.v1",
        capabilities: kind === "code" ? ["none"] : ["network:model"],
        deliverySemantics: "at_least_once_idempotent"
      },
      executable: kind === "code"
        ? {
            id: `${kind}.stage`,
            version: 1,
            async run(input) {
              return { kind, value: input.value };
            }
          }
        : { id: `${kind}.stage`, version: 1 }
    }]
  });
  const binding = kind === "model"
    ? {
        kind: "model",
        bindingId: "model.binding",
        version: 1,
        bindingDigest: "a".repeat(64)
      }
    : kind === "gate"
      ? {
          kind: "decision",
          bindingId: "gate.binding",
          version: 1,
          bindingDigest: "b".repeat(64)
        }
      : undefined;
  const definition = createPipelineDefinition({
    schemaVersion: "pipeline-definition.v2",
    pipelineId: `bound-${kind}`,
    version: 1,
    description: `Bound ${kind} fixture`,
    inputContract: "item.v1",
    nodes: [{
      nodeId: kind,
      stage: { id: `${kind}.stage`, version: 1 },
      inputs: [{ slot: "item", source: { kind: "pipeline_input" } }],
      ...(binding === undefined ? {} : { binding })
    }],
    outputs: [kind]
  });
  const compiled = compilePipeline(definition, catalog);
  const item = {
    itemId: "item-kind",
    ordinal: 1,
    input: { value: 9 },
    inputDigest: digest({ value: 9 })
  };
  const store = new MemoryPipelineStore();
  await store.createRun({
    run: {
      runId: `run-${kind}`,
      compiled,
      createdAt: "2026-08-01T00:00:00.000Z"
    },
    items: [item],
    shards: [{ shardId: `shard-${kind}`, itemIds: [item.itemId] }]
  });
  const claim = await store.claimNextShard({
    leaseOwner: "host",
    leaseDurationMs: 60_000
  });
  assert.ok(claim);
  return {
    catalog,
    store,
    claim,
    shard: {
      runId: claim.runId,
      shardId: claim.shardId,
      compiled: claim.compiled,
      items: claim.items
    }
  };
}

function bindEvidenceStore(store, claim, fence, executionIdentity, options = {}) {
  const observedFences = [];
  const observedIdentities = [];
  const ownershipCalls = [];
  const operations = [];
  const assertFence = (presented, operation, input, outboxEvents) => {
    observedFences.push(presented);
    operations.push(operation);
    if (
      options.rejectFence
      || options.reject?.({ operation, input, outboxEvents })
      || presented !== fence
    ) {
      throw new ExternalFenceRejectedError("host task lease is stale");
    }
  };
  const legacyFence = {
    shardId: claim.shardId,
    leaseToken: claim.leaseToken
  };
  const assertExecutionIdentity = (presented) => {
    observedIdentities.push(presented);
    assert.deepEqual(
      presented,
      executionIdentity,
      "the sealed execution identity must preserve every field"
    );
    assert.ok(Object.isFrozen(presented));
    assert.ok(Object.isFrozen(presented.pipeline));
  };
  return {
    observedFences,
    observedIdentities,
    operations,
    ownershipCalls,
    evidenceStore: {
      async prepareStageExecution({
        fence: presented,
        executionIdentity: presentedIdentity,
        ...input
      }) {
        assertFence(presented, "prepare", input);
        assertExecutionIdentity(presentedIdentity);
        return store.prepareStageExecution({ ...legacyFence, ...input });
      },
      async persistStageSuccess(
        {
          fence: presented,
          executionIdentity: presentedIdentity,
          ...input
        },
        outboxEvents
      ) {
        assertFence(presented, "success", input, outboxEvents);
        assertExecutionIdentity(presentedIdentity);
        return store.persistStageSuccess(
          { ...legacyFence, ...input },
          outboxEvents
        );
      },
      async persistStageFailure(
        {
          fence: presented,
          executionIdentity: presentedIdentity,
          ...input
        },
        outboxEvents
      ) {
        assertFence(
          presented,
          input.deadLetter === undefined ? "failure" : "dead-letter",
          input,
          outboxEvents
        );
        assertExecutionIdentity(presentedIdentity);
        return store.persistStageFailure(
          { ...legacyFence, ...input },
          outboxEvents
        );
      },
      async recordDeadLetter({
        fence: presented,
        executionIdentity: presentedIdentity,
        ...input
      }) {
        assertFence(presented, "standalone-dead-letter", input);
        assertExecutionIdentity(presentedIdentity);
        return store.recordDeadLetter({ ...legacyFence, ...input });
      },

      // Deliberate extra methods: the new port does not expose these, and this
      // tripwire proves the runner never reaches for them dynamically.
      async claimNextShard() {
        ownershipCalls.push("claimNextShard");
        throw new Error("ownership call forbidden");
      },
      async heartbeatShard() {
        ownershipCalls.push("heartbeatShard");
        throw new Error("ownership call forbidden");
      },
      async completeShard() {
        ownershipCalls.push("completeShard");
        throw new Error("ownership call forbidden");
      },
      async failShard() {
        ownershipCalls.push("failShard");
        throw new Error("ownership call forbidden");
      },
      async deferShard() {
        ownershipCalls.push("deferShard");
        throw new Error("ownership call forbidden");
      },
      async cancelShard() {
        ownershipCalls.push("cancelShard");
        throw new Error("ownership call forbidden");
      },
      async releaseLease() {
        ownershipCalls.push("releaseLease");
        throw new Error("ownership call forbidden");
      }
    }
  };
}

test("runBoundShard executes and reuses evidence without any ownership call", async () => {
  const ctx = await fixture();
  const fence = {
    taskLeaseId: "5ee2221f-d538-4fe5-a036-0bb79286c720",
    generation: 4
  };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-happy",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    fence,
    executionIdentity
  );

  const first = await runBoundShard({
    shard: ctx.shard,
    fence,
    executionIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.deepEqual(first, {
    status: "completed",
    runId: "run-bound",
    shardId: "shard-bound",
    itemCount: 1,
    stageExecutionCount: 2,
    reusedStageCount: 0
  });
  assert.deepEqual(bound.ownershipCalls, []);
  assert.ok(bound.observedFences.length >= 4);
  assert.ok(
    bound.observedFences.every((presented) => presented === fence),
    "the exact opaque host fence must reach every evidence call"
  );
  assert.equal(
    bound.observedIdentities.length,
    bound.observedFences.length
  );
  assert.equal(
    new Set(bound.observedIdentities).size,
    1,
    "one canonical validated snapshot is reused for every append in a run"
  );

  const replay = await executeClaimedShard({
    shard: ctx.shard,
    fence,
    executionIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.equal(replay.status, "completed");
  assert.equal(replay.reusedStageCount, 2);
  assert.equal(ctx.invocations.length, 2, "cached replay invokes no stage");
  assert.deepEqual(bound.ownershipCalls, []);

  // The host fence remains live and unfinalized. Only this explicit host-side
  // settlement releases it.
  const finalization = await ctx.store.completeShard({
    shardId: ctx.claim.shardId,
    leaseToken: ctx.claim.leaseToken
  });
  assert.deepEqual(finalization, {
    status: "completed",
    itemCount: 1,
    completedItemCount: 1,
    terminalItemCount: 0
  });
});

test("runBoundShard returns partial evidence for host settlement without finalizing", async () => {
  const ctx = await fixture({
    items: [{ value: 1 }, { value: 2 }],
    stageA(input) {
      if (input.value === 1) throw new Error("payload cannot be processed");
      return { value: input.value * 2 };
    }
  });
  const fence = { taskLeaseId: "lease-partial" };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-partial",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);

  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
    executionIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog,
    maxAttempts: 1
  });
  assert.deepEqual(outcome, {
    status: "partial",
    runId: "run-bound",
    shardId: "shard-bound",
    itemCount: 2,
    completedItemCount: 1,
    terminalItemCount: 1,
    stageExecutionCount: 3,
    reusedStageCount: 0
  });
  assert.deepEqual(bound.ownershipCalls, []);

  const finalization = await ctx.store.completeShard({
    shardId: ctx.claim.shardId,
    leaseToken: ctx.claim.leaseToken
  });
  assert.equal(finalization.status, "partial");
});

test("runBoundShard returns an opaque control payload verbatim and never parks work", async () => {
  const control = {
    dependencies: [{ kind: "task", id: "task-9" }],
    continuationRef: "continuation-7",
    deliverySemantics: "resume_same_node"
  };
  const ctx = await fixture({
    stageA() {
      throw new PipelineControlOutcomeError(control);
    }
  });
  const fence = { taskLeaseId: "lease-control" };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-control",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);

  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
    executionIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.equal(outcome.status, "control");
  assert.deepEqual(outcome.control, control, "control payload preserves the opaque value");
  assert.notEqual(outcome.control, control, "the outcome must not retain caller-owned mutable state");
  assert.ok(Object.isFrozen(outcome.control));
  assert.deepEqual(bound.ownershipCalls, []);
});

test("runBoundShard never mistakes a Proxy-wrapped control error for a trusted host outcome", async () => {
  const hostile = new Proxy(
    new PipelineControlOutcomeError({ forged: true }),
    {
      get() {
        throw new Error("proxy control getter must not run");
      }
    }
  );
  const ctx = await fixture({
    stageA() {
      throw hostile;
    }
  });
  const fence = { taskLeaseId: "lease-proxy-control" };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-proxy-control",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);

  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog,
      maxAttempts: 1
    }),
    (error) =>
      error instanceof StageEvidenceAssemblyError
      && error.operation === "failure_metadata"
  );
  assert.deepEqual(bound.ownershipCalls, []);
});

test("a Proxy-wrapped persistence error is wrapped as genuine bound-authority failure", async () => {
  const ctx = await fixture();
  const fence = { taskLeaseId: "lease-proxy-persistence" };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-proxy-persistence",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
  const hostile = new Proxy(
    new BoundEvidencePersistenceError("persist_success", new Error("inner")),
    {
      get() {
        throw new Error("proxy persistence getter must not run");
      }
    }
  );
  const evidenceStore = {
    ...bound.evidenceStore,
    persistStageSuccess() {
      throw hostile;
    }
  };

  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore,
      catalog: ctx.catalog
    }),
    (error) =>
      error instanceof BoundEvidencePersistenceError
      && error.operation === "persist_success"
      && error.cause === hostile
  );
  assert.deepEqual(bound.ownershipCalls, []);
});

test("runBoundShard propagates a typed external-fence rejection unchanged", async () => {
  const ctx = await fixture();
  const fence = { taskLeaseId: "stale-lease" };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-stale",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity, {
    rejectFence: true
  });

  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog
    }),
    (error) =>
      error instanceof ExternalFenceRejectedError
      && error.code === "external_fence_rejected"
  );
  assert.equal(ctx.invocations.length, 0);
  assert.deepEqual(bound.ownershipCalls, []);
});

test("runBoundShard rejects a tampered sealed input before evidence or invocation", async () => {
  const ctx = await fixture();
  const fence = { taskLeaseId: "lease-tampered" };
  const shard = {
    ...ctx.shard,
    items: [
      {
        ...ctx.shard.items[0],
        input: { value: 999 }
      }
    ]
  };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-tampered",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    fence,
    executionIdentity
  );

  await assert.rejects(
    runBoundShard({
      shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog
    }),
    /items\[0\]\.inputDigest does not match input/
  );
  assert.deepEqual(bound.observedFences, []);
  assert.equal(ctx.invocations.length, 0);
  assert.deepEqual(bound.ownershipCalls, []);
});

test("bound execution identity seals host action, run, shard, definition, compiled DAG, and ordered items", async () => {
  const ctx = await fixture();
  const identity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-identity",
    shard: ctx.shard
  });
  const validated = validateBoundPipelineExecutionIdentity(identity, ctx.shard);
  assert.deepEqual(validated, identity);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.pipeline));
  const untrusted = structuredClone(identity);
  const snapshotted = validateBoundPipelineExecutionIdentity(untrusted, ctx.shard);
  untrusted.hostActionId = "mutated-after-validation";
  untrusted.pipeline.id = "mutated.pipeline";
  assert.equal(snapshotted.hostActionId, "host-action-identity");
  assert.equal(snapshotted.pipeline.id, "bound-runner.fixture");
  assert.equal(identity.runId, ctx.shard.runId);
  assert.equal(identity.shardId, ctx.shard.shardId);
  assert.equal(identity.pipeline.definitionDigest, ctx.shard.compiled.pipeline.digest);
  assert.equal(identity.compiledDigest, ctx.shard.compiled.compiledDigest);
  assert.equal(identity.itemCount, ctx.shard.items.length);
  assert.match(identity.itemSetDigest, /^[a-f0-9]{64}$/);
  assert.match(identity.identityDigest, /^[a-f0-9]{64}$/);

  const fence = { generation: 1 };
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, identity);
  const tamperedIdentity = { ...identity, hostActionId: "substituted-action" };
  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
    executionIdentity: tamperedIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.deepEqual(outcome, {
    status: "failed",
    runId: "run-bound",
    shardId: "shard-bound",
    retryable: false,
    errorCode: "immutable_configuration_rejected"
  });
  assert.deepEqual(bound.operations, []);
  assert.equal(ctx.invocations.length, 0);
});

test("direct bound-stage execution validates and canonicalizes its sealed identity before evidence", async () => {
  const ctx = await fixture();
  const node = ctx.shard.compiled.nodes[0];
  const item = ctx.shard.items[0];
  const fence = { taskLeaseId: "direct-stage-fence" };
  const calls = [];
  const rejectingStore = {
    async prepareStageExecution() {
      calls.push("prepare");
      throw new Error("evidence must not be reached");
    },
    async persistStageSuccess() {
      calls.push("success");
      throw new Error("evidence must not be reached");
    },
    async persistStageFailure() {
      calls.push("failure");
      throw new Error("evidence must not be reached");
    },
    async recordDeadLetter() {
      calls.push("dead-letter");
      throw new Error("evidence must not be reached");
    }
  };

  await assert.rejects(
    executeBoundDurableStage({
      evidenceStore: rejectingStore,
      fence,
      executionIdentity: {
        identityDigest: "d".repeat(64),
        marker: "forged"
      },
      contracts: ctx.catalog.contracts,
      runId: ctx.shard.runId,
      itemId: item.itemId,
      node,
      slots: [{ slot: "item", contract: "item.v1", value: item.input }],
      invoke: async () => {
        throw new Error("invoke must not be reached");
      }
    }),
    /bound execution identity.*(?:missing|unexpected|schemaVersion)/
  );
  assert.deepEqual(calls, []);

  const originalIdentity = structuredClone(createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-direct-stage",
    shard: ctx.shard
  }));
  const observedIdentities = [];
  const observedFences = [];
  const evidenceStore = {
    async prepareStageExecution(input) {
      observedIdentities.push(input.executionIdentity);
      observedFences.push(input.fence);
      assert.ok(Object.isFrozen(input.executionIdentity));
      assert.ok(Object.isFrozen(input.executionIdentity.pipeline));
      assert.throws(
        () => { input.executionIdentity.hostActionId = "callback-mutation"; },
        TypeError
      );
      originalIdentity.hostActionId = "caller-mutated-after-capture";
      originalIdentity.pipeline.id = "caller-mutated.pipeline";
      return { disposition: "reserved", executionId: "direct-execution", attempt: 1 };
    },
    async persistStageSuccess(input) {
      observedIdentities.push(input.executionIdentity);
      observedFences.push(input.fence);
      assert.equal(input.executionIdentity.hostActionId, "host-action-direct-stage");
      assert.equal(input.executionIdentity.pipeline.id, "bound-runner.fixture");
      return {
        output: input.output,
        outputDigest: input.outputDigest,
        created: true
      };
    },
    async persistStageFailure() {
      assert.fail("failure evidence must not be written for a successful direct stage");
    },
    async recordDeadLetter() {
      assert.fail("dead-letter evidence must not be written for a successful direct stage");
    }
  };

  const result = await executeBoundDurableStage({
    evidenceStore,
    fence,
    executionIdentity: originalIdentity,
    contracts: ctx.catalog.contracts,
    runId: ctx.shard.runId,
    itemId: item.itemId,
    node,
    slots: [{ slot: "item", contract: "item.v1", value: item.input }],
    invoke: async (input) => ({ value: input.value * 2 }),
    now: () => new Date("2026-08-01T00:00:00.000Z")
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, { value: 4 });
  assert.equal(new Set(observedIdentities).size, 1);
  assert.ok(observedIdentities.every((identity) => Object.isFrozen(identity)));
  assert.ok(observedFences.every((presented) => presented === fence));
});

test("bound execution rejects at_most_once nodes before evidence or invocation", async () => {
  const ctx = await fixture({ deliverySemantics: "at_most_once" });
  const fence = { generation: 1 };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-at-most-once",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
    executionIdentity,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.deepEqual(outcome, {
    status: "failed",
    runId: "run-bound",
    shardId: "shard-bound",
    retryable: false,
    errorCode: "at_most_once_execution_unsupported"
  });
  assert.deepEqual(bound.operations, []);
  assert.equal(ctx.invocations.length, 0);
});

test("stale external fences are propagated at every evidence persistence boundary", async (t) => {
  const cases = [
    {
      name: "prepare",
      reject: ({ operation }) => operation === "prepare"
    },
    {
      name: "success",
      reject: ({ operation, outboxEvents }) =>
        operation === "success" && (outboxEvents?.length ?? 0) === 0
    },
    {
      name: "failure",
      stageA: () => { throw new Error("retryable dependency timeout"); },
      maxAttempts: 2,
      reject: ({ operation }) => operation === "failure"
    },
    {
      name: "atomic dead-letter",
      stageA: () => {
        throw new PipelineStageError("terminal_payload", false, undefined, "item");
      },
      reject: ({ operation }) => operation === "dead-letter"
    },
    {
      name: "receipt",
      events: [{
        eventType: MODEL_USAGE_RECEIPT_EVENT_TYPE,
        payload: { receipt: true },
        dedupeKey: "receipt:stale"
      }],
      reject: ({ operation, outboxEvents }) =>
        operation === "success"
        && outboxEvents?.some((event) => event.eventType === MODEL_USAGE_RECEIPT_EVENT_TYPE)
    },
    {
      name: "projection outbox",
      events: [{
        eventType: "generic_projection",
        payload: { projection: true },
        dedupeKey: "projection:stale"
      }],
      reject: ({ operation, outboxEvents }) =>
        operation === "success"
        && outboxEvents?.some((event) => event.eventType === "generic_projection")
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const ctx = await fixture({ stageA: scenario.stageA });
      const fence = { scenario: scenario.name };
      const executionIdentity = createBoundPipelineExecutionIdentity({
        hostActionId: `host-action-${scenario.name}`,
        shard: ctx.shard
      });
      const bound = bindEvidenceStore(
        ctx.store,
        ctx.claim,
        fence,
        executionIdentity,
        { reject: scenario.reject }
      );
      await assert.rejects(
        runBoundShard({
          shard: ctx.shard,
          fence,
          executionIdentity,
          evidenceStore: bound.evidenceStore,
          catalog: ctx.catalog,
          ...(scenario.maxAttempts === undefined
            ? {}
            : { maxAttempts: scenario.maxAttempts }),
          ...(scenario.events === undefined
            ? {}
            : { outboxEventsFor: () => scenario.events })
        }),
        (error) =>
          error instanceof ExternalFenceRejectedError
          && error.code === "external_fence_rejected"
      );
      assert.deepEqual(bound.ownershipCalls, []);
    });
  }
});

test("standalone crash-replay dead-letter persistence is externally fenced", async () => {
  const ctx = await fixture({
    stageA: () => { throw new Error("retryable timeout"); }
  });
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-standalone-dead-letter",
    shard: ctx.shard
  });
  const firstFence = { generation: 1 };
  const firstBound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    firstFence,
    executionIdentity
  );
  const originalPersistFailure = firstBound.evidenceStore.persistStageFailure;
  firstBound.evidenceStore.persistStageFailure = async (...args) => {
    await originalPersistFailure(...args);
    throw new Error("simulated process crash after first failed-attempt commit");
  };
  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence: firstFence,
      executionIdentity,
      evidenceStore: firstBound.evidenceStore,
      catalog: ctx.catalog,
      maxAttempts: 2
    }),
    BoundEvidencePersistenceError
  );

  const takeoverFence = { generation: 2 };
  const takeover = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    takeoverFence,
    executionIdentity,
    { reject: ({ operation }) => operation === "standalone-dead-letter" }
  );
  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence: takeoverFence,
      executionIdentity,
      evidenceStore: takeover.evidenceStore,
      catalog: ctx.catalog,
      maxAttempts: 1
    }),
    ExternalFenceRejectedError
  );
  assert.ok(takeover.operations.includes("standalone-dead-letter"));
  assert.equal(ctx.store.deadLetterRecords.length, 0);
});

test("non-stale evidence failures propagate typed and never become a settleable failed outcome", async () => {
  const ctx = await fixture();
  const fence = { generation: 1 };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-storage-failure",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
  bound.evidenceStore.persistStageSuccess = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog
    }),
    (error) =>
      error instanceof BoundEvidencePersistenceError
      && error.code === "bound_evidence_persistence_failed"
      && error.operation === "persist_success"
      && error.cause instanceof Error
      && error.cause.message === "database unavailable"
  );
});

test("bound outbox assembly failures after invocation propagate typed without false settlement", async (t) => {
  await t.test("success evidence hook", async () => {
    const ctx = await fixture();
    const fence = { generation: 1 };
    const executionIdentity = createBoundPipelineExecutionIdentity({
      hostActionId: "host-action-success-hook-error",
      shard: ctx.shard
    });
    const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
    await assert.rejects(
      runBoundShard({
        shard: ctx.shard,
        fence,
        executionIdentity,
        evidenceStore: bound.evidenceStore,
        catalog: ctx.catalog,
        outboxEventsFor() {
          throw new Error("projection assembly failed");
        }
      }),
      (error) =>
        error instanceof BoundEvidencePersistenceError
        && error.operation === "assemble_success_outbox"
    );
    assert.equal(ctx.invocations.length, 1, "provider/stage invocation occurred");
    assert.deepEqual(bound.operations, ["prepare"]);
  });

  await t.test("failure evidence hook", async () => {
    const ctx = await fixture({
      stageA() {
        throw new Error("provider failed after billable invocation");
      }
    });
    const fence = { generation: 1 };
    const executionIdentity = createBoundPipelineExecutionIdentity({
      hostActionId: "host-action-failure-hook-error",
      shard: ctx.shard
    });
    const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
    await assert.rejects(
      runBoundShard({
        shard: ctx.shard,
        fence,
        executionIdentity,
        evidenceStore: bound.evidenceStore,
        catalog: ctx.catalog,
        failureOutboxEventsFor() {
          throw new Error("receipt assembly failed");
        }
      }),
      (error) =>
        error instanceof BoundEvidencePersistenceError
        && error.operation === "assemble_failure_outbox"
    );
    assert.equal(ctx.invocations.length, 1, "provider/stage invocation occurred");
    assert.deepEqual(bound.operations, ["prepare"]);
  });
});

test("takeover between invocation and persistence never reports false completion and preserves the stable key", async () => {
  const observedKeys = [];
  const ctx = await fixture({
    stageA(_input, stageContext) {
      observedKeys.push(stageContext.idempotencyKey);
      return { value: 4 };
    }
  });
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-takeover",
    shard: ctx.shard
  });
  const oldFence = { generation: 1 };
  const oldBound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    oldFence,
    executionIdentity,
    { reject: ({ operation }) => operation === "success" }
  );
  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence: oldFence,
      executionIdentity,
      evidenceStore: oldBound.evidenceStore,
      catalog: ctx.catalog
    }),
    ExternalFenceRejectedError
  );

  const newFence = { generation: 2 };
  const newBound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    newFence,
    executionIdentity
  );
  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence: newFence,
    executionIdentity,
    evidenceStore: newBound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.equal(outcome.status, "completed");
  assert.equal(observedKeys.length, 2);
  assert.equal(observedKeys[0], observedKeys[1]);
  assert.match(observedKeys[0], /^[a-f0-9]{64}$/);
});

test("bound retry, crash replay, exhaustion, and dead-letter replay are deterministic", async () => {
  let invocation = 0;
  const retryCtx = await fixture({
    stageA() {
      invocation += 1;
      if (invocation === 1) throw new Error("transient timeout");
      return { value: 4 };
    }
  });
  const retryFence = { generation: 1 };
  const retryIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-retry",
    shard: retryCtx.shard
  });
  const retryBound = bindEvidenceStore(
    retryCtx.store,
    retryCtx.claim,
    retryFence,
    retryIdentity
  );
  const retryOutcome = await runBoundShard({
    shard: retryCtx.shard,
    fence: retryFence,
    executionIdentity: retryIdentity,
    evidenceStore: retryBound.evidenceStore,
    catalog: retryCtx.catalog,
    maxAttempts: 2
  });
  assert.equal(retryOutcome.status, "completed");
  assert.equal(invocation, 2);

  let crashInvocation = 0;
  const crashCtx = await fixture({
    stageA() {
      crashInvocation += 1;
      if (crashInvocation === 1) throw new Error("transient timeout");
      return { value: 4 };
    }
  });
  const crashIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-crash-replay",
    shard: crashCtx.shard
  });
  const crashFence = { generation: 1 };
  const crashBound = bindEvidenceStore(
    crashCtx.store,
    crashCtx.claim,
    crashFence,
    crashIdentity
  );
  const persistFailure = crashBound.evidenceStore.persistStageFailure;
  crashBound.evidenceStore.persistStageFailure = async (...args) => {
    await persistFailure(...args);
    throw new Error("simulated crash after committed failure");
  };
  await assert.rejects(
    runBoundShard({
      shard: crashCtx.shard,
      fence: crashFence,
      executionIdentity: crashIdentity,
      evidenceStore: crashBound.evidenceStore,
      catalog: crashCtx.catalog,
      maxAttempts: 2
    }),
    BoundEvidencePersistenceError
  );
  const replayFence = { generation: 2 };
  const replayBound = bindEvidenceStore(
    crashCtx.store,
    crashCtx.claim,
    replayFence,
    crashIdentity
  );
  const replay = await runBoundShard({
    shard: crashCtx.shard,
    fence: replayFence,
    executionIdentity: crashIdentity,
    evidenceStore: replayBound.evidenceStore,
    catalog: crashCtx.catalog,
    maxAttempts: 2
  });
  assert.equal(replay.status, "completed");
  assert.equal(crashInvocation, 2);

  let exhaustedInvocations = 0;
  const exhaustedCtx = await fixture({
    stageA() {
      exhaustedInvocations += 1;
      throw new Error("permanent payload failure");
    }
  });
  const exhaustedFence = { generation: 1 };
  const exhaustedIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-exhaustion",
    shard: exhaustedCtx.shard
  });
  const exhaustedBound = bindEvidenceStore(
    exhaustedCtx.store,
    exhaustedCtx.claim,
    exhaustedFence,
    exhaustedIdentity
  );
  const exhausted = await runBoundShard({
    shard: exhaustedCtx.shard,
    fence: exhaustedFence,
    executionIdentity: exhaustedIdentity,
    evidenceStore: exhaustedBound.evidenceStore,
    catalog: exhaustedCtx.catalog,
    maxAttempts: 2
  });
  assert.equal(exhausted.status, "partial");
  assert.equal(exhaustedInvocations, 2);
  assert.equal(exhaustedCtx.store.deadLetterRecords.length, 1);
  const exhaustedReplay = await runBoundShard({
    shard: exhaustedCtx.shard,
    fence: exhaustedFence,
    executionIdentity: exhaustedIdentity,
    evidenceStore: exhaustedBound.evidenceStore,
    catalog: exhaustedCtx.catalog,
    maxAttempts: 2
  });
  assert.equal(exhaustedReplay.status, "partial");
  assert.equal(exhaustedInvocations, 2, "terminal replay invokes nothing");
  assert.equal(exhaustedCtx.store.deadLetterRecords.length, 1);
});

test("receipt peek is acknowledged only after persistence and survives stale rejection", async () => {
  const receiptLedger = createModelReceiptLedger();
  let actionIdempotencyKey;
  const ctx = await fixture({
    stageA(_input, stageContext) {
      actionIdempotencyKey = stageContext.idempotencyKey;
      receiptLedger.onReceipt({
        runId: stageContext.runId,
        itemId: stageContext.itemId,
        nodeId: "a",
        stage: { id: "step.a", version: 1 },
        attempt: stageContext.attempt,
        idempotencyKey: stageContext.idempotencyKey,
        providerIdempotencyKey: digest({
          test: "receipt-peek-provider-call",
          actionIdempotencyKey: stageContext.idempotencyKey,
          attempt: stageContext.attempt
        }),
        bindingDigest: "d".repeat(64),
        receipt: {
          schemaVersion: "usage-receipt.v1",
          trust: "provider_reported",
          observedInputTokens: 1,
          observedOutputTokens: 1,
          observedCostMicroUsd: 1,
          chargedTokens: 2,
          chargedCostMicroUsd: 1,
          durationMs: 1
        }
      });
      return { value: 4 };
    }
  });
  const fence = { generation: 1 };
  const executionIdentity = createBoundPipelineExecutionIdentity({
    hostActionId: "host-action-receipt-peek",
    shard: ctx.shard
  });
  const bound = bindEvidenceStore(
    ctx.store,
    ctx.claim,
    fence,
    executionIdentity,
    {
      reject: ({ operation, outboxEvents }) =>
        operation === "success"
        && outboxEvents?.some(
          (event) => event.eventType === MODEL_USAGE_RECEIPT_EVENT_TYPE
        )
    }
  );
  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog,
      outboxEventsFor: receiptLedger.outboxEventsFor
    }),
    ExternalFenceRejectedError
  );
  const pending = receiptLedger.outboxEventsFor({
    runId: "run-bound",
    itemId: "item-1",
    node: ctx.shard.compiled.nodes[0],
    attempt: 1,
    idempotencyKey: actionIdempotencyKey
  });
  assert.equal(pending.length, 1, "stale persistence did not erase evidence");
  pending.acknowledge();
  assert.equal(
    receiptLedger.outboxEventsFor({
      runId: "run-bound",
      itemId: "item-1",
      node: ctx.shard.compiled.nodes[0],
      attempt: 1,
      idempotencyKey: actionIdempotencyKey
    }).length,
    0
  );
});

test("bound adapter executes code, model, and gate nodes with receipt, escalation, and projection evidence", async (t) => {
  await t.test("code plus generic projection", async () => {
    const ctx = await singleKindFixture("code");
    const fence = { generation: 1 };
    const executionIdentity = createBoundPipelineExecutionIdentity({
      hostActionId: "host-action-code",
      shard: ctx.shard
    });
    const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
    const outcome = await runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog,
      outboxEventsFor: ({ node, attempt }) => [{
        eventType: "generic_projection",
        payload: { nodeId: node.nodeId, attempt },
        dedupeKey: `projection:${node.nodeId}:${attempt}`
      }]
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(
      ctx.store.outboxEventRecords.map((event) => event.eventType),
      ["generic_projection"]
    );
  });

  await t.test("model usage receipt plus projection", async () => {
    const ctx = await singleKindFixture("model");
    const receiptLedger = createModelReceiptLedger();
    const fence = { generation: 1 };
    const executionIdentity = createBoundPipelineExecutionIdentity({
      hostActionId: "host-action-model",
      shard: ctx.shard
    });
    const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
    let actionIdempotencyKey;
    const invoker = {
      async invoke(invocation) {
        assert.match(invocation.idempotencyKey, /^[a-f0-9]{64}$/);
        actionIdempotencyKey = invocation.idempotencyKey;
        receiptLedger.onReceipt({
          runId: invocation.runId,
          itemId: invocation.itemId,
          nodeId: invocation.node.nodeId,
          stage: invocation.node.stage,
          attempt: invocation.attempt,
          idempotencyKey: invocation.idempotencyKey,
          providerIdempotencyKey: digest({
            test: "bound-model-provider-call",
            actionIdempotencyKey: invocation.idempotencyKey,
            attempt: invocation.attempt
          }),
          bindingDigest: invocation.node.bindingFingerprint,
          receipt: {
            schemaVersion: "usage-receipt.v1",
            trust: "provider_reported",
            observedInputTokens: 2,
            observedOutputTokens: 1,
            chargedTokens: 3,
            observedCostMicroUsd: 2,
            chargedCostMicroUsd: 2,
            durationMs: 1
          }
        });
        return { kind: "model", value: invocation.input.value };
      }
    };
    const outcome = await runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog,
      invoker,
      outboxEventsFor: (context) => combineOutboxEvents(
        receiptLedger.outboxEventsFor(context),
        [{
          eventType: "generic_projection",
          payload: { nodeId: context.node.nodeId },
          dedupeKey: `projection:${context.node.nodeId}:${context.attempt}`
        }]
      )
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(
      ctx.store.outboxEventRecords.map((event) => event.eventType).sort(),
      [MODEL_USAGE_RECEIPT_EVENT_TYPE, "generic_projection"].sort()
    );
    assert.equal(
      receiptLedger.outboxEventsFor({
        runId: "run-model",
        itemId: "item-kind",
        node: ctx.shard.compiled.nodes[0],
        attempt: 1,
        idempotencyKey: actionIdempotencyKey
      }).length,
      0,
      "successful atomic persistence acknowledges the receipt peek"
    );
  });

  await t.test("decision gate escalation plus projection", async () => {
    const ctx = await singleKindFixture("gate");
    const escalationLedger = createGateEscalationLedger();
    const fence = { generation: 1 };
    const executionIdentity = createBoundPipelineExecutionIdentity({
      hostActionId: "host-action-gate",
      shard: ctx.shard
    });
    const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, executionIdentity);
    const invoker = {
      async invoke(invocation) {
        escalationLedger.onEscalation({
          runId: invocation.runId,
          itemId: invocation.itemId,
          nodeId: invocation.node.nodeId,
          stage: invocation.node.stage,
          attempt: invocation.attempt,
          idempotencyKey: invocation.idempotencyKey,
          flow: {
            id: "review.flow",
            version: 1,
            compiledDigest: "c".repeat(64)
          },
          certificateDigest: "d".repeat(64),
          reasonCode: "human_review",
          sourceStepId: "review",
          outcomeCode: "escalate",
          budgetSpent: {
            chargedTokens: 1,
            chargedCostMicroUsd: 1,
            modelCalls: 1,
            stepExecutions: 1
          }
        });
        return { kind: "gate", disposition: "human_escalation" };
      }
    };
    const outcome = await runBoundShard({
      shard: ctx.shard,
      fence,
      executionIdentity,
      evidenceStore: bound.evidenceStore,
      catalog: ctx.catalog,
      invoker,
      outboxEventsFor: (context) => combineOutboxEvents(
        escalationLedger.outboxEventsFor(context),
        [{
          eventType: "generic_projection",
          payload: { nodeId: context.node.nodeId },
          dedupeKey: `projection:${context.node.nodeId}:${context.attempt}`
        }]
      )
    });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(
      ctx.store.outboxEventRecords.map((event) => event.eventType).sort(),
      [GATE_HUMAN_ESCALATION_EVENT_TYPE, "generic_projection"].sort()
    );
  });
});

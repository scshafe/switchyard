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
  executeClaimedShard,
  runBoundShard
} from "mission-pipeline/execute/shard-runner";
import { MemoryPipelineStore } from "mission-pipeline/memory-store";
import {
  ExternalFenceRejectedError
} from "mission-pipeline/store";

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

function descriptor(stageId, inputContract, outputContract) {
  return {
    stageId,
    version: 1,
    kind: "code",
    inputs: [{ slot: "item", contract: inputContract }],
    outputContract,
    deliverySemantics: "at_least_once_idempotent"
  };
}

async function fixture({ stageA, items = [{ value: 2 }] } = {}) {
  const invocations = [];
  const catalog = new StageCatalog({
    contracts: contracts(),
    registrations: [
      {
        descriptor: descriptor("step.a", "item.v1", "step-a.v1"),
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
        descriptor: descriptor("step.b", "step-a.v1", "step-b.v1"),
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

function bindEvidenceStore(store, claim, fence, options = {}) {
  const observedFences = [];
  const ownershipCalls = [];
  const assertFence = (presented) => {
    observedFences.push(presented);
    if (options.rejectFence || presented !== fence) {
      throw new ExternalFenceRejectedError("host task lease is stale");
    }
  };
  const legacyFence = {
    shardId: claim.shardId,
    leaseToken: claim.leaseToken
  };
  return {
    observedFences,
    ownershipCalls,
    evidenceStore: {
      async prepareStageExecution({ fence: presented, ...input }) {
        assertFence(presented);
        return store.prepareStageExecution({ ...legacyFence, ...input });
      },
      async persistStageSuccess(
        { fence: presented, ...input },
        outboxEvents
      ) {
        assertFence(presented);
        return store.persistStageSuccess(
          { ...legacyFence, ...input },
          outboxEvents
        );
      },
      async persistStageFailure(
        { fence: presented, ...input },
        outboxEvents
      ) {
        assertFence(presented);
        return store.persistStageFailure(
          { ...legacyFence, ...input },
          outboxEvents
        );
      },
      async recordDeadLetter({ fence: presented, ...input }) {
        assertFence(presented);
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
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence);

  const first = await runBoundShard({
    shard: ctx.shard,
    fence,
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

  const replay = await executeClaimedShard({
    shard: ctx.shard,
    fence,
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
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence);

  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
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
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence);

  const outcome = await runBoundShard({
    shard: ctx.shard,
    fence,
    evidenceStore: bound.evidenceStore,
    catalog: ctx.catalog
  });
  assert.equal(outcome.status, "control");
  assert.equal(outcome.control, control, "control payload is opaque identity");
  assert.deepEqual(bound.ownershipCalls, []);
});

test("runBoundShard propagates a typed external-fence rejection unchanged", async () => {
  const ctx = await fixture();
  const fence = { taskLeaseId: "stale-lease" };
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence, {
    rejectFence: true
  });

  await assert.rejects(
    runBoundShard({
      shard: ctx.shard,
      fence,
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
  const bound = bindEvidenceStore(ctx.store, ctx.claim, fence);
  const shard = {
    ...ctx.shard,
    items: [
      {
        ...ctx.shard.items[0],
        input: { value: 999 }
      }
    ]
  };

  const outcome = await runBoundShard({
    shard,
    fence,
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
  assert.deepEqual(bound.observedFences, []);
  assert.equal(ctx.invocations.length, 0);
  assert.deepEqual(bound.ownershipCalls, []);
});

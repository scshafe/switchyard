import {
  MemoryPipelineStore,
  StageCatalog,
  compilePipeline,
  createPipelineDefinition,
  digest,
  runOneShard
} from "mission-pipeline";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validators = new Map([
  ["task.v1", (value) =>
    isRecord(value)
    && typeof value.title === "string"
    && Number.isInteger(value.urgency)],
  ["normalized-task.v1", (value) =>
    isRecord(value)
    && typeof value.title === "string"
    && value.title === value.title.trim()
    && Number.isInteger(value.urgency)],
  ["prioritized-task.v1", (value) =>
    isRecord(value)
    && typeof value.title === "string"
    && (value.priority === "normal" || value.priority === "high")]
]);

const contracts = {
  knows: (contractId) => validators.has(contractId),
  validate: (contractId, value) => {
    const validate = validators.get(contractId);
    return validate?.(value)
      ? { ok: true, value }
      : {
          ok: false,
          issues: [{ message: `payload does not satisfy ${contractId}` }]
        };
  }
};

const catalog = new StageCatalog({
  contracts,
  registrations: [
    {
      descriptor: {
        stageId: "normalize.task",
        version: 1,
        kind: "code",
        inputs: [{ slot: "task", contract: "task.v1" }],
        outputContract: "normalized-task.v1",
        deliverySemantics: "at_least_once_idempotent"
      },
      executable: {
        id: "normalize.task",
        version: 1,
        run: async (task) => ({
          title: task.title.trim(),
          urgency: task.urgency
        })
      }
    },
    {
      descriptor: {
        stageId: "prioritize.task",
        version: 1,
        kind: "code",
        inputs: [{ slot: "task", contract: "normalized-task.v1" }],
        outputContract: "prioritized-task.v1",
        deliverySemantics: "at_least_once_idempotent"
      },
      executable: {
        id: "prioritize.task",
        version: 1,
        run: async (task) => ({
          title: task.title,
          priority: task.urgency >= 8 ? "high" : "normal"
        })
      }
    }
  ]
});

const definition = createPipelineDefinition({
  schemaVersion: "pipeline-definition.v2",
  pipelineId: "tasks.prioritize",
  version: 1,
  description: "Normalize incoming tasks and assign a priority.",
  inputContract: "task.v1",
  nodes: [
    {
      nodeId: "normalize",
      stage: { id: "normalize.task", version: 1 },
      inputs: [
        { slot: "task", source: { kind: "pipeline_input" } }
      ]
    },
    {
      nodeId: "prioritize",
      stage: { id: "prioritize.task", version: 1 },
      inputs: [
        {
          slot: "task",
          source: { kind: "node_output", nodeId: "normalize" }
        }
      ]
    }
  ],
  outputs: ["prioritize"]
});

const compiled = compilePipeline(definition, catalog);
const input = { title: "  Review application  ", urgency: 9 };
const store = new MemoryPipelineStore();

await store.publishDefinition(definition);
await store.createRun({
  run: {
    runId: "run-task-demo",
    compiled,
    createdAt: new Date().toISOString()
  },
  items: [
    {
      itemId: "task-1",
      ordinal: 1,
      input,
      inputDigest: digest(input)
    }
  ],
  shards: [{ shardId: "shard-task-demo", itemIds: ["task-1"] }]
});

const outcome = await runOneShard({
  store,
  catalog,
  leaseOwner: "example-worker",
  runId: "run-task-demo",
  shardId: "shard-task-demo",
  outboxEventsFor: ({ runId, itemId, node, output }) =>
    node.nodeId === "prioritize"
      ? [{
          eventType: "task.prioritized.v1",
          payload: { itemId, output },
          dedupeKey: `${runId}:${itemId}:${node.nodeId}`
        }]
      : []
});

console.log(JSON.stringify({
  outcome,
  finalEvent: store.outboxEventRecords.at(-1)?.payload
}, null, 2));

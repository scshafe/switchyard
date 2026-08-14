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
  ["order.v1", (value) =>
    isRecord(value)
    && typeof value.orderId === "string"
    && typeof value.total === "number"],
  ["validated-order.v1", (value) =>
    isRecord(value)
    && typeof value.orderId === "string"
    && typeof value.total === "number"
    && value.valid === true],
  ["priced-order.v1", (value) =>
    isRecord(value)
    && typeof value.orderId === "string"
    && typeof value.total === "number"
    && value.currency === "USD"],
  ["risk-result.v1", (value) =>
    isRecord(value)
    && typeof value.orderId === "string"
    && (value.risk === "low" || value.risk === "review")],
  ["payment-decision.v1", (value) =>
    isRecord(value)
    && typeof value.orderId === "string"
    && typeof value.approved === "boolean"
    && typeof value.executionKey === "string"]
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

const codeStage = ({ stageId, inputContract, outputContract, run }) => ({
  descriptor: {
    stageId,
    version: 1,
    kind: "code",
    inputs: [{ slot: "order", contract: inputContract }],
    outputContract,
    deliverySemantics: "at_least_once_idempotent"
  },
  executable: { id: stageId, version: 1, run }
});

const catalog = new StageCatalog({
  contracts,
  registrations: [
    codeStage({
      stageId: "validate.order",
      inputContract: "order.v1",
      outputContract: "validated-order.v1",
      run: async (order) => ({ ...order, valid: true })
    }),
    codeStage({
      stageId: "price.order",
      inputContract: "validated-order.v1",
      outputContract: "priced-order.v1",
      run: async (order) => ({
        orderId: order.orderId,
        total: order.total,
        currency: "USD"
      })
    }),
    codeStage({
      stageId: "score.order-risk",
      inputContract: "validated-order.v1",
      outputContract: "risk-result.v1",
      run: async (order) => ({
        orderId: order.orderId,
        risk: order.total > 1_000 ? "review" : "low"
      })
    }),
    {
      descriptor: {
        stageId: "authorize.payment",
        version: 1,
        kind: "code",
        inputs: [
          { slot: "order", contract: "priced-order.v1" },
          { slot: "risk", contract: "risk-result.v1" }
        ],
        outputContract: "payment-decision.v1",
        deliverySemantics: "at_least_once_idempotent"
      },
      executable: {
        id: "authorize.payment",
        version: 1,
        run: async ({ order, risk }, context) => ({
          orderId: order.orderId,
          approved: risk.risk === "low",
          executionKey: context.idempotencyKey
        })
      }
    }
  ]
});

const fromNode = (nodeId) => ({ kind: "node_output", nodeId });
const definition = createPipelineDefinition({
  schemaVersion: "pipeline-definition.v2",
  pipelineId: "orders.authorize",
  version: 1,
  description: "Validate, price, score, and authorize an order.",
  inputContract: "order.v1",
  nodes: [
    {
      nodeId: "validate",
      stage: { id: "validate.order", version: 1 },
      inputs: [
        { slot: "order", source: { kind: "pipeline_input" } }
      ]
    },
    {
      nodeId: "price",
      stage: { id: "price.order", version: 1 },
      inputs: [{ slot: "order", source: fromNode("validate") }]
    },
    {
      nodeId: "risk",
      stage: { id: "score.order-risk", version: 1 },
      inputs: [{ slot: "order", source: fromNode("validate") }]
    },
    {
      nodeId: "authorize",
      stage: { id: "authorize.payment", version: 1 },
      inputs: [
        { slot: "order", source: fromNode("price") },
        { slot: "risk", source: fromNode("risk") }
      ]
    }
  ],
  outputs: ["authorize"]
});

const compiled = compilePipeline(definition, catalog);
const input = { orderId: "order-100", total: 175 };
const store = new MemoryPipelineStore();

await store.publishDefinition(definition);
await store.createRun({
  run: {
    runId: "run-order-demo",
    compiled,
    createdAt: new Date().toISOString()
  },
  items: [
    {
      itemId: "order-100",
      ordinal: 1,
      input,
      inputDigest: digest(input)
    }
  ],
  shards: [{ shardId: "shard-order-demo", itemIds: ["order-100"] }]
});

const outcome = await runOneShard({
  store,
  catalog,
  leaseOwner: "example-worker",
  runId: "run-order-demo",
  shardId: "shard-order-demo",
  outboxEventsFor: ({ runId, itemId, node, output }) =>
    node.nodeId === "authorize"
      ? [{
          eventType: "payment.decision.v1",
          payload: { itemId, output },
          dedupeKey: `${runId}:${itemId}:${node.nodeId}`
        }]
      : []
});

console.log(JSON.stringify({
  compiledOrder: compiled.nodes.map(({ nodeId }) => nodeId),
  outcome,
  finalEvent: store.outboxEventRecords.at(-1)?.payload
}, null, 2));

# Example: a linear code pipeline

This example turns an incoming task into a normalized task and then assigns a
priority. It is the smallest useful end-to-end assembly: two contracts between
three artifacts, two registered code stages, one sealed definition, and one
durable run.

```mermaid
flowchart LR
    Input([task.v1]) -->|task| Normalize[normalize<br/>normalize.task@1]
    Normalize -->|normalized-task.v1| Prioritize[prioritize<br/>prioritize.task@1]
    Prioritize --> Output([prioritized-task.v1])
```

The arrow labels are contracts, not TypeScript types. The host's
`ContractValidator` decides whether a runtime payload satisfies each named
contract.

## 1. Register contracts and stages

Each catalog registration is atomic: its descriptor and executable must have
the same stage ID and version. The descriptor is data; the executable is code.

```js
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
```

Because both stages have one input slot, their `run()` methods receive the
source artifact directly. The slot still matters: it is checked during
compilation and is part of the compiled node.

## 2. Wire and compile the graph

The first node reads the pipeline input. The second node names `normalize` as
its source, creating the dependency edge.

```js
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
```

`createPipelineDefinition` normalizes and digest-seals the definition.
`compilePipeline` then proves that `normalize.task@1` produces exactly the
contract expected by `prioritize.task@1`, orders the nodes topologically, and
seals the compiled result.

## 3. Create and execute a run

Runs contain items and shards. Item digests prove the inputs did not change;
the shards must partition the item set exactly.

```js
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
  shardId: "shard-task-demo"
});
```

One `runOneShard` call claims at most one shard. A production worker normally
calls it repeatedly until it receives `{ status: "idle" }`. The memory store
is useful for tests and examples; a production adapter implements the same
`PipelineStore` port with fenced leases and atomic evidence appends.

The complete runnable source is
[linear-code-pipeline.mjs](linear-code-pipeline.mjs).

[Back to the guide](../README.md)

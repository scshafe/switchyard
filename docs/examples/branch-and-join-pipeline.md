# Example: a branch-and-join pipeline

A DAG does not have to be a straight line. This example validates an order,
passes the validated artifact to independent pricing and risk stages, and then
joins both results into a payment decision.

```mermaid
flowchart LR
    Input([order.v1]) --> Validate[validate<br/>validate.order@1]
    Validate -->|validated-order.v1| Price[price<br/>price.order@1]
    Validate -->|validated-order.v1| Risk[risk<br/>score.order-risk@1]
    Price -->|priced-order.v1<br/>slot: order| Authorize[authorize<br/>authorize.payment@1]
    Risk -->|risk-result.v1<br/>slot: risk| Authorize
    Authorize --> Output([payment-decision.v1])
```

The two middle nodes both name `validate` as their source. The `authorize`
node has two named slots, so it cannot run until both source artifacts exist.
This is graph fan-out and dependency ordering; the current shard runner walks
the compiled topological order for each item and does not promise parallel
execution of sibling nodes.

## Describe the join stage

The stage descriptor gives each incoming edge a contract and a local slot
name. A stage with more than one slot receives an object keyed by those names.

```js
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
      // Use this stable key when an external operation needs idempotency.
      executionKey: context.idempotencyKey
    })
  }
}
```

If this stage called a payment provider, it would pass
`context.idempotencyKey` to that provider. Mission Pipeline may retry
`at_least_once_idempotent` work after a failure or lease takeover.

## Wire the branches and join

```js
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
      inputs: [
        {
          slot: "order",
          source: { kind: "node_output", nodeId: "validate" }
        }
      ]
    },
    {
      nodeId: "risk",
      stage: { id: "score.order-risk", version: 1 },
      inputs: [
        {
          slot: "order",
          source: { kind: "node_output", nodeId: "validate" }
        }
      ]
    },
    {
      nodeId: "authorize",
      stage: { id: "authorize.payment", version: 1 },
      inputs: [
        {
          slot: "order",
          source: { kind: "node_output", nodeId: "price" }
        },
        {
          slot: "risk",
          source: { kind: "node_output", nodeId: "risk" }
        }
      ]
    }
  ],
  outputs: ["authorize"]
});
```

The source node IDs create the topology. Array order is only the deterministic
tie-breaker for nodes that are otherwise ready at the same time; it cannot
override dependencies. `compilePipeline` will produce the order `validate`,
`price`, `risk`, `authorize` for this definition.

Compilation also proves both join edges:

| Source node | Produces | Join slot | Expects |
| --- | --- | --- | --- |
| `price` | `priced-order.v1` | `order` | `priced-order.v1` |
| `risk` | `risk-result.v1` | `risk` | `risk-result.v1` |

Changing the `risk` source to a node that produces another contract fails at
compile time. Removing either slot also fails because a node must supply the
stage's exact slot set.

To expose the two branches without a join, omit `authorize` and use
`outputs: ["price", "risk"]`. Pipeline definitions may have multiple outputs.

The complete runnable source is
[branch-and-join-pipeline.mjs](branch-and-join-pipeline.mjs).

[Back to the guide](../README.md)

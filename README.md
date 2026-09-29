# @scshafe/mission-pipeline

Mission Pipeline is a dependency-free, digest-sealed node-graph engine for
durable unit journeys. Every node has its own queue. Completing one node turn
atomically appends evidence, evaluates deterministic outcome edges, advances
join state, queues every satisfied successor, appends outbox events, and
releases the turn lease.

Version 1.0 is the node-graph-only major release. There is no compatibility
execution path for the retired traversal engine.

## Install

The package is private and published to GitHub Packages. Map the scope in the
consumer's committed `.npmrc` (this line only, never a credential):

```ini
@scshafe:registry=https://npm.pkg.github.com
```

Authenticate in user-level npm/pnpm config or through `NODE_AUTH_TOKEN` in CI,
then depend on an exact version:

```sh
pnpm add --save-exact @scshafe/mission-pipeline@1.0.1
```

Import specifiers are `@scshafe/mission-pipeline` and
`@scshafe/mission-pipeline/<subpath>`.

## Runtime boundary

The package imports Node.js built-ins and its own files only. It never imports
database clients, provider SDKs, credential loaders, or host frameworks.
Consumers implement the exported store and node-kind ports.

Supported runtimes:

- Node.js `>=22.22.0 <23`
- Node.js `>=24.18.0 <25`

## Graph contracts

```js
import {
  compileGraph,
  createGraphDefinition
} from "@scshafe/mission-pipeline";

const graph = createGraphDefinition({
  graphId: "example.review",
  version: 1,
  description: "Route clean units to review.",
  entry: "filter",
  nodes: [
    {
      nodeId: "filter",
      ref: { id: "example.filter", version: 1 },
      kind: "code",
      input: "example-input.v1",
      outcomes: { version: 1, outcomes: ["clean", "blocked"] },
      principal: { id: "worker" },
      turn: {
        idempotency: "per (unitId, nodeId, attemptNumber)",
        leaseMs: 30_000,
        maxAttempts: 2,
        retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
      }
    },
    {
      nodeId: "review",
      ref: { id: "example.review", version: 1 },
      kind: "human",
      input: "example-input.v1",
      outcomes: { version: 1, outcomes: ["approved", "rejected"] },
      principal: { id: "console" },
      turn: {
        idempotency: "per (unitId, nodeId, attemptNumber)",
        leaseMs: 30_000,
        maxAttempts: 1,
        retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
      }
    }
  ],
  edges: [
    {
      edgeId: "clean-to-review",
      source: "filter",
      target: "review",
      when: { outcome: "clean" }
    }
  ],
  terminals: [
    { nodeId: "filter", outcome: "blocked" },
    { nodeId: "review", outcome: "approved" },
    { nodeId: "review", outcome: "rejected" }
  ]
});

const compiled = compileGraph(graph);
console.log(compiled.graph.digest);
```

`compileGraph` fails loudly unless every declared outcome routes or is
explicitly terminal. It also validates reachability, bindings, edge predicates,
join inbound declarations, join satisfiability outcomes, and bounded hostile
input shapes. A node outcome vocabulary changes only by publishing a new node
version.

The closed edge-predicate language is:

- `{ outcome }`
- `{ anyOf: [...] }`
- `{ outcome, where: [{ pointer, equals }] }`

Joins support `all` and `nOf` over declared inbound edge IDs. A join fires at
most once per unit. Unsatisfiable joins emit the declared engine outcome;
offers arriving after a fired join are journey-recorded no-ops.

## Execution and stores

The v2 execution modules are:

- `execute/ports` — code, model, agent, human, and callback boundaries.
- `execute/turn` — one physical node-turn attempt, stable idempotency identity,
  output/usage validation, and retryable-versus-terminal failure taxonomy.
- `execute/unit-runner` — claim a homogeneous per-node batch and request the
  store's one atomic settlement mutation.
- `store/graph-store` — immutable graph publication and exact version/digest
  resolution.
- `store/unit-store` — admission, queues, leases, journeys, joins, settlement,
  outbox, and dead-letter evidence.
- `store/memory-graph-store` and `store/memory-unit-store` — the hermetic
  executable specification.

The store owns routing. A node body receives no graph, store, lease token,
credentials, admission capability, or successor-selection authority. The
settlement invariant is one transaction: journey append, output retention,
edge evaluation, join progress, successor enqueue, outbox append, and lease
release.

Claim fairness is FIFO within a node and round-robin across graph lanes at
claim. There are no engine-level timeouts for human waits; escalation and timer
behavior are authored as nodes and edges.

## Host-facing helpers

- `contracts/` provides canonical-JSON SHA-256 digests, artifact envelopes,
  artifact refs, and usage receipts.
- `model/binding` and `prompt/` provide sealed model/prompt identities.
- `model/invoker` provides the exact resolver boundary and prompt-identity
  verification used inside a host's model node port.
- `agent/step` and `agent/executor-port` provide the frozen one-agent-turn
  request/result contract and executor seam.
- `gate/contracts`, `gate/compiler`, and `gate/certificate` remain
  traversal-neutral policy-definition helpers. Human waiting and routing are
  graph nodes, not a gate executor.

## Verification

```sh
npm run check
```

The gate builds from a clean output directory, runs the v1-deletion guard and
the complete test suite, checks the exact package payload, proves reproducible
release bytes, installs the packed artifact into a fresh consumer, and runs
JavaScript plus TypeScript import smokes.

The ratified design and phase evidence are in
[`docs/DESIGN-NODE-GRAPH-V2.md`](docs/DESIGN-NODE-GRAPH-V2.md) and
[`docs/PLAN-NODE-GRAPH-V2.md`](docs/PLAN-NODE-GRAPH-V2.md).

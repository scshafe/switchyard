# mission-pipeline

Mission Pipeline is a dependency-free, digest-sealed node-graph engine for
durable unit journeys. Every node has its own queue. Completing one node turn
atomically appends evidence, evaluates deterministic outcome edges, advances
join state, queues every satisfied successor, appends outbox events, and
releases the turn lease.

Version 1.0 is the node-graph-only major release. There is no compatibility
execution path for the retired traversal engine.

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
} from "mission-pipeline";

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

A node may declare `outputs`, the contract its body emits per outcome.
`compileGraph` then proves that every edge carrying that outcome lands on a
node whose input accepts it, and a completion carrying any other contract is
refused before it is cached. Declared outputs are definition data: they move
the graph digest and the node definition signature. A node may also pin a
`configuration` ref (`{ id, version, digest }`) naming the host-side policy
it runs under; the digest enters the graph digest and the node execution
fingerprint, and the worker context hands the ref to the body.

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

- `graph/display` provides `projectGraphDisplay`: a pure structural projection
  of a compiled graph with its exact digest, depth, merged arrows, marking
  nodes, fan-outs, joins, and terminals. Presentation words stay with the host.
- `graph/diff` provides `graphDefinitionDiff`: a sealed-definition comparison
  by node, edge, and terminal identity, carrying both graph digests and
  machine-readable field changes, including outputs and configuration refs.
- `graph/budget` provides `graphTurnBudget`: the back edges of a sealed graph
  and, for an acyclic graph, the worst-case queue occurrences and turns per
  node, per kind, and in total.
- `store/unit-path` provides `projectUnitPath`: a pure, fail-closed projection
  of one unit journey into per-node state, outcomes, open queues, join
  progress, edges taken, and usage totals. Delivery state is the host's.
- `graph/goals` provides `createGoalManifest` and `validateGoalManifest`: a
  non-executable goal manifest sealed against the exact graph digest, proving
  that a unit entering a goal closes it exactly once through a declared
  `resolved` or `escalated` resolution.
- `store/goal-closures` provides `projectGoalClosures`: per unit and per goal,
  unentered, open, dead, or closed with the closing resolution, plus the turns
  and receipts charged inside the goal.
- `execute/code-port` provides `codeNodePortByNode`: one code body per node
  behind the kind-keyed worker port; an unregistered node fails terminally
  before any body runs.
- `contracts/` provides canonical-JSON SHA-256 digests, artifact envelopes,
  artifact refs, and usage receipts.
- `model/binding` and `prompt/` provide sealed model/prompt identities.
- `model/invoker` provides the exact resolver boundary and prompt-identity
  verification used inside a host's model node port, and
  `modelTurnInvocationRequest`, which builds the provider request from the
  port's own arguments so the provider boundary receives the journey's
  attempt identity.
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

A payload change ships with a regenerated release manifest. Run
`npm run build && npm run release:manifest && npm run check` in that order:
the manifest script packs without rebuilding and writes
`release/mission-pipeline-<version>.payload.sha256`, which the gate pins.

The ratified design and phase evidence are in
[`docs/DESIGN-NODE-GRAPH-V2.md`](docs/DESIGN-NODE-GRAPH-V2.md) and
[`docs/PLAN-NODE-GRAPH-V2.md`](docs/PLAN-NODE-GRAPH-V2.md). Application
guidance for building pipelines from focused objectives, a runnable example,
the interface review, and the frontend SDK design are indexed in
[`docs/README.md`](docs/README.md).

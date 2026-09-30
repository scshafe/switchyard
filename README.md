# @scshafe/switchyard

Switchyard is a dependency-free, digest-sealed node-graph engine for durable
unit journeys. Units move through a graph of `code`, `model`, `agent`, `human`
and `callback` nodes the way cars move through a rail yard: every node is a
track with its own durable queue, a completed turn's outcome throws the
switches (the sealed outcome edges) that send the unit on, and a join couples
arrivals from several inbound edges before the unit proceeds. Completing one
node turn atomically appends evidence, evaluates deterministic outcome edges,
advances join state, queues every satisfied successor, appends outbox events,
and releases the turn lease.

Version 2.0 is the rename from `@scshafe/mission-pipeline` (1.0.1) to
`@scshafe/switchyard`: engine semantics are those of 1.0, while the package
name, the `MissionPipeline*` exports and the stored identifiers changed, with
no compatibility aliases. [`CHANGELOG.md`](CHANGELOG.md) lists every old and
new name. There is no compatibility execution path for the retired v1
traversal engine.

## Install

The package is private and published to GitHub Packages. Map the scope in the
consumer's committed `.npmrc` (this line only, never a credential):

```ini
@scshafe:registry=https://npm.pkg.github.com
```

Authenticate in user-level npm/pnpm config or through `NODE_AUTH_TOKEN` in CI,
then depend on an exact version:

```sh
pnpm add --save-exact @scshafe/switchyard@2.0.0
```

Import specifiers are `@scshafe/switchyard` and
`@scshafe/switchyard/<subpath>`.

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
} from "@scshafe/switchyard";

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
      from: "filter",
      when: { outcome: "clean" },
      to: ["review"]
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
pnpm install --frozen-lockfile
pnpm run verify
```

The gate builds from a clean output directory, runs the v1-deletion guard and
the complete test suite, checks the exact package payload, proves reproducible
release bytes, installs the packed artifact into a fresh consumer, and runs
JavaScript plus TypeScript import smokes.

`pnpm run test:fresh-clone` repeats the install, build and verify in a fresh
clone of the committed `HEAD` (it requires a clean working tree). `lib/` is
build output and is not committed.

## Releasing

1. On a branch: bump `version` in `package.json`, add a `## <x.y.z> — <date>`
   section to `CHANGELOG.md`, run `pnpm run build && pnpm run release:manifest`
   to write `release/scshafe-switchyard-<x.y.z>.payload.sha256`, run
   `pnpm run verify`, and merge to `main`.
2. After CI is green on `main`, push the annotated tag `v<x.y.z>` on that
   commit. `.github/workflows/publish.yml` refuses a tag that is not on
   `main` or does not equal `package.json`'s version, verifies, publishes to
   GitHub Packages, installs the published version back, compares its
   integrity with a local pack, and creates the GitHub Release with the
   tarball and manifest digests.
3. Published versions are immutable: a bad release is superseded by a higher
   patch version with a changelog note. Nobody runs `pnpm publish` by hand.

`workflow_dispatch` of `publish.yml` with `dry_run` set stops at
`pnpm publish --dry-run`.

The ratified design and phase evidence are in
[`docs/DESIGN-NODE-GRAPH-V2.md`](docs/DESIGN-NODE-GRAPH-V2.md) and
[`docs/PLAN-NODE-GRAPH-V2.md`](docs/PLAN-NODE-GRAPH-V2.md).

# Changelog

All notable changes to `@scshafe/switchyard` are recorded here. Versions
follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused. Versions up to and
including 1.0.1 were published as `@scshafe/mission-pipeline`; their entries
below are kept as written.

## 2.4.0 — unreleased (draft: readable failures)

Additive. No graph, digest, store contract, schema or wire change: a store
that implements the 2.3.0 `UnitStore` contract (switchyard-postgres 0.2.0
included) works unchanged. From the second fresh-eyes run of the first-run
guide.

- **Failures carry a readable message.** `ExecutionFailureError` takes an
  optional fourth argument, `message`; without it the message is the
  `message` of an `Error` `cause` (read through data properties only), else
  the code, as before. The runner already recorded `error.message` as the
  failed attempt's `errorMessage` (in `recordTurnFailure` and the
  `turn_failed` journey record; switchyard-postgres keeps it in
  `turn_failures.error_message`), but the engine's own failures passed their
  explanation only as the `cause`, so the stored message was the bare code.
  Now every engine failure built with an `Error` cause stores that cause's
  text, and so does a host's `new ExecutionFailureError(code, retryable,
  providerError)`: pass `message` to choose what is stored instead (a plain
  thrown `Error` was always stored with its message). A terminal `runClaimedUnitTurn` / `runNextUnitTurns` result has
  `errorMessage` next to `errorCode` when that run recorded the failure, and
  the `failureOutboxEvents` context has `errorMessage`.
- **`fakeModelPort` names the missing rule**: a model node without a rule
  still fails terminally with `immutable_configuration_rejected`, with the
  message `no fake-model rule for node "in-scope"; it has rules for
  "is-question", "draft-answer". Add a rule keyed by the node id to
  fakeModelPort({ ... })`.
- **`runWorker` runs only the graph versions it was given.** With `graphs`,
  a claimed turn of a graph (or graph version) not among them is not run:
  nothing is recorded, the unit waits, and `onSkipped({ principalId,
  queueId, unitId, nodeId, graph, given, message })` reports it, e.g.
  `unit u6 waits at compose-reply::rework: it runs on graph
  first-switchyard v1, which this worker was not given (it has
  first-switchyard v2). Pass that version in the worker's graphs to run
  it.` Without `onSkipped`, one process warning
  (`SWITCHYARD_WORKER_GRAPH_NOT_GIVEN`) per such version. The result counts
  them as `skipped`. Before, such a unit ran with ports built for another
  version and its reviewed nodes failed for good with
  `immutable_stage_contract_rejected`. A claim is per principal and returns
  one node of one graph lane; the store contract has no graph filter and no
  lease release, so the worker claims such a batch, withholds it and claims
  again in the same pass (the store then offers the next lane). The
  withheld turns stay leased until their `leaseMs` lapses, which delays a
  worker that does have that version by up to that long. Behaviour change
  for hosts that passed `graphs` only to name principals while running other
  graphs too: pass `principals` without `graphs` to run every claimed turn,
  as in 2.3.0.
- **`withApprovalReviewPorts`** fails an `X::review` or `X::rework` turn of a
  graph version it was not given before the body runs (so no model is
  called), with `withApprovalReviewPorts was not given graph
  first-switchyard v1, the version unit u6 runs on, so it cannot build the
  record for compose-reply::rework (it has first-switchyard v2). Pass every
  graph version with units in flight in options.graphs`. The code is still
  `immutable_stage_contract_rejected`; before, the turn ran and failed on
  the contract with a message that did not name the version. Other nodes of
  graphs it was not given pass through, as before.
- **`GraphPublicationConflictError`** (a changed graph published under a
  version that is already published) adds: `A published version never
  changes: publish the changed graph under a new version (units admitted to
  first-switchyard@1 keep running on it)`. switchyard-postgres throws this
  class, so its `publishGraph` says the same.

Not in this version (they need a store contract or schema change):

- **A claim filtered by graph version.** `ClaimUnitTurnsInput` would take
  the graph versions a worker runs (`MemoryUnitStore` would restrict its
  lane choice to them; switchyard-postgres would pass the filter to it and
  could narrow its `claim_worker` hydration and `hasClaimableWorkerTurns`
  pre-check), so `runWorker` would never lease a turn it will not run. A
  `releaseTurnLease` (fenced by the lease token, no attempt consumed) would
  serve hosts that decide after claiming.
- **Readable failures in switchyard-postgres's views.** The message is
  already stored (`turn_failures.error_message`); the `turns` view has only
  `error_code` and `unit_positions` only `last_error_code`. Adding
  `error_message` / `last_error_message` there is a view-only migration.
  `UnitDeadLetterRecord` has no `errorMessage`; adding it is a store
  contract change (and a `dead_letters` column).
- **Retrying or retiring a failed unit.** Evidence is append-only and no
  store operation reopens a terminally failed queue or closes a unit; a host
  admits the input again under a new unit id.

## 2.3.0 — unreleased (W4: first-run helpers)

Additive. No graph, digest, runner, store or wire change.

- `runWorker({ store, ports, leaseOwner, graphs | principals, batch?, idleMs?,
  untilIdle?, signal?, onSettled? })` is the polling worker loop every host
  wrote around `runNextUnitTurns`: it claims a batch for each worker
  principal in turn, reports each settlement, sleeps when a pass claims
  nothing, and returns on `signal` (between passes; claimed turns finish) or,
  with `untilIdle`, after the first empty pass. `workerPrincipals(graphs)`
  lists the principals of a graph's code, model and agent nodes.
- `fakeModelPort(rules)` is a deterministic `ModelNodePort` for first runs
  and tests: per node an outcome, a completion or a function of the input,
  with the required usage receipt attached. `unavailableUsageReceipt(ms)` is
  that receipt (trust `unavailable`, charging the policy floor).
- `providerReportedUsageReceipt({ inputTokens, outputTokens,
  chargedCostMicroUsd, durationMs? })` is the receipt for a model turn whose
  provider reported its token counts (trust `provider_reported`, charged
  tokens = their sum; a local server may charge 0 micro-USD). A turn with no
  reported usage uses `unavailableUsageReceipt`, never zeros.
- `humanNodeAnswers(graph, nodeId)` gives the answers a person gives at a
  node (`approved | denied` at an approval, `accepted | rejected` at a
  review, the node's outcomes elsewhere), to pair with
  `approvalReviewHumanDecision`.
- `latestReviewNotes(record)` reads the reviewer's latest `reviewNotes`
  from a `switchyard.rework.v1` (or review-request) record, so a rework body
  does not dig through `history`. The record types `ReviewRequestPayload`,
  `ReworkPayload`, `ReviewHistoryEntry` and `EmbeddedArtifact` and the
  contract-id constants were already exported; the guide now documents them.
- Clearer errors on a first run (messages only; codes, classes and stored
  identities unchanged):
  - `approvalReviewHumanDecision` checks a person's answer against
    `humanNodeAnswers` first: `human answer at node compose-reply::review:
    "accept" is not an answer here; answer one of accepted | rejected`
    (before, a mistyped review answer was reported as a node "body result").
  - Every "returned undeclared outcome" error lists the node's outcomes.
  - `admitUnit`'s `TurnEvidenceConflictError` names the admission fields
    that differ (graph, seed artifact, `admittedAt`, `principalId`) and says
    that only an identical admission replays as `created: false`.
- `MemoryUnitStore` compiles each unit's sealed graph once per graph object
  instead of once per queue, attempt and settlement row (a graph with
  approval or review settings is resealed on every compile). switchyard-
  postgres rebuilds this state on every operation, so the guide's first
  worker run drops from about 5 s to 1.5 s of CPU. `admitUnit` keeps its
  own validated copy of the loaded graph.
- `docs/FIRST-GRAPH.md`, "Your first switchyard": from an empty directory to
  a unit moving through a three-node graph in PostgreSQL, on 2.3.0 and
  switchyard-postgres 0.1.1, with the project in
  `docs/first-graph-example/` (kept equal to the guide by a test). It
  documents what approval, review and rework nodes receive and return.
  `docs/PROPOSAL-ADMISSION-REPLAY.md` proposes (does not implement) letting
  a retried admission replay regardless of `admittedAt`.

## 2.2.0 — unreleased (W1: approval and review settings)

Additive. Graphs without the new settings seal and run exactly as in 2.1.0,
with the same digests.

- Nodes accept `approval: { by, onDeny }` and `review: { by, onReject,
  maxRounds? }`, where `by` is a `SwitchyardActor`
  (`{ kind: "human", principal }` or `{ kind: "model", binding, principal }`)
  and routes are `"terminal"`, `{ retry: true }` or `{ to: nodeId }`.
  `createGraphDefinition` seals them as ordinary nodes and edges
  (`<id>::approval`, `<id>::review`, `<id>::rework`); `compileGraph` refuses a
  sealed graph that is not exactly that expansion. New contracts:
  `switchyard.review-request.v1`, `switchyard.rework.v1`,
  `switchyard.review-rejected.v1`, `switchyard.review-notes.v1`. See
  `docs/DESIGN-APPROVAL-REVIEW.md`.
- `withApprovalReviewPorts`, `approvalReviewHumanDecision`,
  `applyApprovalReviewCompletion` and `reviewNotes` compose the review and
  rework records host-side. No runner, store or conformance-suite change.
- `binaryQuestion` builds a `yes | no | unsure` model node with escalation
  tiers; `validateSwitchyardActor` validates an actor.
- `graphTurnBudget` bounds a review loop by `maxRounds` instead of reporting
  the graph as cyclic.

### Known limitation

- Rework rounds do not pass back through the node's approval, so a reviewer's feedback reaches the
  node unscreened. Pair `approval` with reviewers that may see only what the node may see.
  (Deferred; see `docs/DESIGN-APPROVAL-REVIEW.md` §11.)

## 2.1.0 — 2026-09-30

The additive engine work first prepared as 1.1.0, rebased onto 2.0.0 with
the Switchyard names: graph display projection and definition diff, unit
path and goal manifest/closure projections, turn budget, code port by node,
declared node outputs and configuration refs, join input envelopes
(`switchyard.join-input.v1`) and declared failure recovery, plus the
separately packaged, unpublished `switchyard-graphpaper` 0.1.0 SDK. New
schema versions use the `switchyard-` prefix (`switchyard-graph-display.v1`,
`switchyard-graph-definition-diff.v1`, `switchyard-unit-path.v1`,
`switchyard-goal-manifest.v1`, `switchyard-goal-closures.v1`; SDK:
`switchyard-presentation.v1`, `switchyard-diagram.v1`).

The graphpaper renderer is now the registry package `@scshafe/graphpaper`
from GitHub Packages: an exact `0.5.2` root dev dependency (replacing the Git
pin of the 0.5.0 source, whose renderer, types and stylesheet 0.5.2 matches
byte for byte) and the SDK's optional peer `^0.5.2`. The SDK imports and
`viewerAssets()` resolve `@scshafe/graphpaper`; the served asset names are
unchanged. The engine's runtime dependencies are still none. CI reads
`@scshafe/*` with the workflow's `GITHUB_TOKEN`. The release manifest is
`release/scshafe-switchyard-2.1.0.payload.sha256`.

## 2.0.0 — 2026-09-30

Breaking rename: the package is now **Switchyard**. The name "mission" came
from the library's origin as a Mission Control component, and Mission Control
is being retired. Engine semantics are unchanged: graphs, outcome edges, joins,
per-node queues, settlement and evidence behave exactly as in 1.0.1. There are
no compatibility aliases for any old name.

### Package

- The package is `@scshafe/switchyard` (was `@scshafe/mission-pipeline`), and
  the repository is `https://github.com/scshafe/switchyard`. Consumers replace
  the dependency and change every `@scshafe/mission-pipeline` and
  `@scshafe/mission-pipeline/<subpath>` import specifier to
  `@scshafe/switchyard` and `@scshafe/switchyard/<subpath>`; the subpaths are
  unchanged. `@scshafe/mission-pipeline` 1.0.1 stays published and receives no
  further releases.
- The release manifest is
  `release/scshafe-switchyard-2.0.0.payload.sha256`.
- Release tooling environment variables: `MISSION_PIPELINE_SMOKE_CONSUMER` is
  now `SWITCHYARD_SMOKE_CONSUMER`, and `MISSION_PIPELINE_V1_GUARD_PROBE_ROOT` is
  now `SWITCHYARD_V1_GUARD_PROBE_ROOT`.

### API renames

Every exported `MissionPipeline*` name drops the prefix `MissionPipeline` for
`Switchyard`, and every `MISSION_PIPELINE_*` constant becomes `SWITCHYARD_*`;
the rest of each name, its module and its shape are unchanged.

| 1.x name | 2.0.0 name | Module |
| --- | --- | --- |
| `MissionPipelineNode` | `SwitchyardNode` | `graph/definition` |
| `MissionPipelineNodeRef` | `SwitchyardNodeRef` | `graph/definition` |
| `MissionPipelineNodeBindingRef` | `SwitchyardNodeBindingRef` | `graph/definition` |
| `MissionPipelineNodeKind` | `SwitchyardNodeKind` | `graph/definition` |
| `MissionPipelineNodeTurn` | `SwitchyardNodeTurn` | `graph/definition` |
| `MissionPipelineJoin` | `SwitchyardJoin` | `graph/definition` |
| `MISSION_PIPELINE_NODE_KINDS` | `SWITCHYARD_NODE_KINDS` | `graph/definition` |
| `MISSION_PIPELINE_ENGINE_PRINCIPAL_ID` | `SWITCHYARD_ENGINE_PRINCIPAL_ID` | `graph/definition` |
| `validateMissionPipelineNode` | `validateSwitchyardNode` | `graph/definition` |
| `validateMissionPipelineNodeBindingRef` | `validateSwitchyardNodeBindingRef` | `graph/definition` |
| `MissionPipelineUnit` | `SwitchyardUnit` | `store/unit-store` |
| `MISSION_PIPELINE_UNIT_SCHEMA_VERSION` | `SWITCHYARD_UNIT_SCHEMA_VERSION` | `store/unit-store` |

All of them are also re-exported from the package root, as before.

### Wire and stored identifiers

Version suffixes are kept; only the `mission-pipeline` / `mission_pipeline`
prefix changes.

| 1.x value | 2.0.0 value | Where it appears |
| --- | --- | --- |
| `mission_pipeline.engine` | `switchyard.engine` | `SWITCHYARD_ENGINE_PRINCIPAL_ID`: the reserved engine principal on synthesized journey records |
| `mission-pipeline.join-unsatisfiable.v1` | `switchyard.join-unsatisfiable.v1` | `JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT`: contract ID and payload `schemaVersion` of the engine's join-unsatisfiable artifact, and the required `input` of any node that receives `join_unsatisfiable` |
| `mission-pipeline-unit.v2` | `switchyard-unit.v2` | `SWITCHYARD_UNIT_SCHEMA_VERSION`: every stored unit's `schemaVersion` |
| `mission-pipeline-memory-unit-store-state.v1` | `switchyard-memory-unit-store-state.v1` | `MEMORY_UNIT_STORE_STATE_SNAPSHOT_SCHEMA_VERSION`: memory unit store snapshots |
| `https://mission-pipeline.local/agent/…` | `https://switchyard.local/agent/…` | `$id` of `schemas/agent-step-request.v1.schema.json` and `schemas/agent-step-result.v1.schema.json` |

These values are hashed into evidence, so the following digests differ from
1.x for otherwise identical input: unit `admissionDigest` (covers
`schemaVersion`), sealed `join_unsatisfiable` journey records (cover the
engine principal and the artifact ref), join-unsatisfiable artifact digests,
and the `graphDigest` of any graph whose recovery node declares the
join-unsatisfiable contract as its `input`. Node execution fingerprints,
idempotency keys and settlement digests of ordinary node turns do not
contain any renamed value and are unchanged; the checked-in golden vectors
did not change.

**Data persisted by 1.x consumers is not readable as-is.** 2.0.0 rejects stored
units whose `schemaVersion` is `mission-pipeline-unit.v2`, snapshots whose
`schemaVersion` is `mission-pipeline-memory-unit-store-state.v1`, and graphs
that declare `mission-pipeline.join-unsatisfiable.v1` as a recovery node's
input; journey evidence sealed by 1.x does not verify against 2.0.0 digests.
There is no migration: start 2.0.0 stores empty, or rewrite the identifiers
and re-seal the evidence in the consumer.

### Other

- `validateSwitchyardNode`'s default error label is `switchyard node` (was
  `mission pipeline node`).
- README and source comments describe the package as Switchyard. The README
  graph example now uses the real edge keys (`from`, `when`, `to`); the 1.x
  example's `source`/`target` keys were rejected by the strict validator.
- `docs/DESIGN-NODE-GRAPH-V2.md` and `docs/PLAN-NODE-GRAPH-V2.md` are dated
  records and keep the 1.x names, under a note that maps them to 2.0.0.

## 1.0.1 — 2026-09-29

First version published to GitHub Packages. No API or runtime behaviour change
from 1.0.0: `src/`, `lib/` and `schemas/` are byte-identical to 1.0.0; only
`package.json`, `README.md` and `CHANGELOG.md` differ in the payload.

- Renamed to `@scshafe/mission-pipeline` and published to
  `https://npm.pkg.github.com`. Consumers change `mission-pipeline/<subpath>`
  import specifiers to `@scshafe/mission-pipeline/<subpath>` and map the
  `@scshafe` scope to GitHub Packages in their `.npmrc`.
- `repository.url` is the HTTPS GitHub URL (GitHub Packages requires it to
  match the repository).
- Toolchain: pnpm 10 (`packageManager: pnpm@10.34.5`, `pnpm-lock.yaml`)
  replaces npm.
- `lib/` is no longer committed; it is built from `src/` by `prepack`, CI and
  the publish workflow. Reproducibility is proven by packing twice.
- The payload now includes `CHANGELOG.md`; the release manifest is
  `release/scshafe-mission-pipeline-1.0.1.payload.sha256`, and the payload
  scan also rejects token-shaped strings.

## 1.0.0

Node-graph-only major release (never published to a registry; consumed by
git commit and vendored bytes). The 1.0.0 payload manifest remains in git
history at `release/mission-pipeline-1.0.0.payload.sha256`.

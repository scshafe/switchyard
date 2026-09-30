# Changelog

All notable changes to `@scshafe/switchyard` are recorded here. Versions
follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused. Versions up to and
including 1.0.1 were published as `@scshafe/mission-pipeline`; their entries
below are kept as written.

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

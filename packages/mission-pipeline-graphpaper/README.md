# mission-pipeline-graphpaper

Unreleased **0.1.0**: a separately packaged, static diagram-model core for
mission-pipeline 1.1.0 and the `scshafe/graphpaper` renderer. It lives in the
engine repository but is not included in the engine's published payload.

Implemented exports: `buildPipelineDiagram`, `validatePresentation`,
`pipelineLegend("static")`, `PIPELINE_RENDER_OPTIONS`, presentation and input
types, and the presentation/diagram schema constants. The core produces data:
no DOM, fetch, timers, provider calls, store reads, credentials, or effects.
It currently uses the engine's Node-based validation and digest helpers; it
does not claim to be a browser bundle.

Server/browser adapters, run overlays, metrics, proposal diagrams, details
panels, deep links, CSS assets, goal scopes, and live Inbox adoption remain
proposed. There are no `/server` or `/browser` exports. Unsupported fields
such as `overlay` and `metrics` are rejected, not silently ignored.

## Installation and package identity

Both this package and engine 1.1.0 are unreleased. Build and pack the two local
packages for evaluation; do not assume either version is on npm.

The intended renderer is **scshafe/graphpaper**, tested at commit
`89240f15c171a26009430ad7eb45eb85ac2567aa` (package version 0.5.0).
The npm registry's unrelated package named `graphpaper` is not this renderer.
The renderer peer is optional to prevent npm from automatically installing
that unrelated package. Install the intended renderer explicitly when using
its types or rendering the returned model:

```sh
npm install 'git+https://github.com/scshafe/graphpaper.git#89240f15c171a26009430ad7eb45eb85ac2567aa'
```

The repository's dev dependency and lockfile pin that exact source; the SDK
does not bundle it. The engine still has zero runtime dependencies. Supported
Node versions match the engine: `>=22.22.0 <23 || >=24.18.0 <25`.

## Static model

```ts
import { compileGraph, projectGraphDisplay } from "@scshafe/switchyard";
import {
  buildPipelineDiagram, validatePresentation,
  PIPELINE_PRESENTATION_SCHEMA_VERSION,
  type PipelinePresentation
} from "mission-pipeline-graphpaper";

// `graph` is a consumer-owned sealed GraphDefinition.
const projection = projectGraphDisplay(compileGraph(graph));
const presentation: PipelinePresentation = {
  schemaVersion: PIPELINE_PRESENTATION_SCHEMA_VERSION,
  title: "Review",
  nodes: Object.fromEntries(projection.nodes.map(node => [node.nodeId, {
    name: node.nodeId // Replace identifiers with consumer-authored names.
  }])),
  endpoints: [],
  terminals: [{ id: "done", name: "Finished", ends: projection.terminals }]
};
const problems = validatePresentation(projection, presentation, { definition: graph });
if (problems.length > 0) throw new Error(problems.join("; "));
const model = buildPipelineDiagram({ projection, presentation, definition: graph });
```

All returned records are detached, deeply frozen, and prototype-free; arrays
are frozen ordinary arrays. Runtime inputs are captured descriptor-first,
bounded, and validated without invoking accessors, Proxies, or `toJSON`.
Malformed/schema-invalid data throws. `validatePresentation` returns frozen
coverage diagnostics; `buildPipelineDiagram` rejects coverage errors except
unclaimed terminals, which receive explicit fallback sinks and structured
entries in `metadata.pipeline.unclaimedTerminals`.

Each projection and presentation has an independent admission limit of depth
24, 1,000,000 values, and 33,554,432 string code units. This is an SDK rendering
limit, not a promise to accept every possible engine fan-out expansion.
Presentation text is bounded to 8,192 characters per field and rows to 64.

The model carries the exact graph reference and a canonical-JSON SHA-256 of
the complete presentation at `metadata.pipeline`, with schema
`mission-pipeline-diagram.v1` and mode `static`. A graph digest carried in a
copied projection is **not** a seal of the projection payload. Without
`definition`, validation checks shape and coverage only; pass the original
sealed definition to recompile it and require exact projection equality.
It verifies self-consistency, not publisher authorization.

## Consumer presentation and rendering rules

`PipelinePresentation` uses schema `mission-pipeline-presentation.v1`:

- `nodes` must cover exactly the projection's node IDs. Names, summaries,
  questions, and extra rows are consumer text. `model: { bindingDigest, name }`
  is accepted only for that node's exact binding digest; it performs no catalog
  lookup and authenticates no claimed model name. Without it a binding ID row
  is shown. Prompts, receipts, and artifact payloads do not belong here.
- Optional `arrows["from->to"]` groups must partition the merged arrow's
  outcomes exactly once. Notes and labels are consumer words. Conditional
  routing always gets an explicit condition notice. Fan-out prose uses the
  engine's per-edge outcome data; older v1 projections lacking that optional
  data get edge-only wording, without guessing outcome provenance.
- `endpoints` claim terminal tuples through `exits`. Optional `waits` explicitly
  connect human nodes without asserting a runtime wait, readiness, or delivery.
  Endpoint `system`, `kind`, `via`, `outboxEventTypes`, and `rows` are presentation
  only; no outbox is read. `terminals` group quiet ends through `ends`. A terminal
  tuple may be claimed once, and both sink-ID lists must be unique independently.
- Optional `goals` labels require both `definition` and `goalManifest` inputs.
  The engine verifies the manifest seal and graph; listed `members` must equal
  manifest membership. Goal grouping/rendering is not implemented.
- `unitNoun` defaults to `unit`; `id`, `description`, and `publication` are
  optional presentation seams. Depth labels are one-based engine depth, not
  ELK layers. Small outcome vocabularies on a single successor split into one
  arrow per outcome, preserving Inbox's static builder. Joins have a badge and
  join-edge type; no readiness is inferred.
- `historical: true` adds graphpaper's lifecycle badge metadata. The consumer
  decides whether a version is historical; the SDK reads no publication state.
  Authored IDs remain readable; synthetic ID collisions get stable `~1`, `~2`
  suffixes, including multiple terminal outcomes from one source to one sink.

The static class vocabulary follows graphpaper's public type mapping:
`node-type-code|model|human|agent|callback|endpoint|terminal` and
`edge-kind-outcome|exit|join`. This package does not ship `pipeline.css` or
runtime-status styles. Pass `PIPELINE_RENDER_OPTIONS` and the static legend
to graphpaper explicitly; its layout/SVG implementations remain unchanged.

## Verification and provenance

From the repository root, run in this order:

```sh
npm run build && npm run release:manifest && npm run check
```

The build compiles both packages. The manifest writer packs without rebuilding
and writes separate engine and SDK manifests under root `release/`. The full
check tests exact/reproducible payloads and installs all three exact tarballs
offline into a temporary consumer. It runs SDK tests, strict TypeScript export
checks, and graphpaper built-in layout/SVG smoke checks without a browser.

The Inbox graph8 golden is an independent capture of Inbox's existing static
builder. Its source fixture contains a sealed graph, presentation words, and
five exact model-binding names, not prompts or implementations. Provenance and
hashes are in `test/fixtures/inbox-graph8.provenance.json` in the repository;
tests exclude only the new `metadata.pipeline` block when comparing the model.
The support-triage static golden is a second, provider-free fixture witness.
Tests and private development tooling are not shipped in the SDK tarball.

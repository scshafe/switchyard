# mission-pipeline-graphpaper

Unreleased **0.1.0**: a separately packaged, static diagram SDK for
mission-pipeline 1.1.0 and the `scshafe/graphpaper` renderer. It lives in the
engine repository but is not included in the engine's published payload.

Implemented exports: `buildPipelineDiagram`, `validatePresentation`,
`pipelineLegend("static")`, `PIPELINE_RENDER_OPTIONS`, presentation and input
types, and the presentation/diagram schema constants. The core produces data:
no DOM, fetch, timers, provider calls, store reads, credentials, or effects.
It currently uses the engine's Node-based validation and digest helpers; it
does not claim to be a browser bundle.

The `/server` entry implements `renderPipelineFigure` and `viewerAssets`;
`/browser` implements `mountPipelineViewer`, static selection/deep links, and
an optional authorized details panel. These adapters have automated coverage and a local Browser witness for ELK,
mouse/keyboard selection, responsive layout, identity/races, and teardown.
Reduced-motion activation remains unverified; the connected Browser exposes
no media override. Run overlays, metrics, proposal diagrams, live model updates,
goal scopes, and live Inbox adoption remain proposed. Unsupported fields such
as `overlay`, `metrics`, and `update` are not accepted.

## Installation and package identity

Both this package and engine 1.1.0 are unreleased. Build and pack the two local
packages for evaluation; do not assume either version is on npm.

The intended renderer is **scshafe/graphpaper**, tested at commit
`89240f15c171a26009430ad7eb45eb85ac2567aa` (package version 0.5.0).
The npm registry's unrelated package named `graphpaper` is not this renderer.
The renderer peer is optional to prevent npm from automatically installing
that unrelated package. Install the intended renderer explicitly when using
its types or either adapter. ELK is optional for model building and fallback
server rendering, but is required by the complete `viewerAssets()` set:

```sh
npm install 'git+https://github.com/scshafe/graphpaper.git#89240f15c171a26009430ad7eb45eb85ac2567aa'
npm install elkjs@0.10.2
```

The repository's dev dependency and lockfile pin that exact source; the SDK
does not bundle it. The engine still has zero runtime dependencies. Supported
Node versions match the engine: `>=22.22.0 <23 || >=24.18.0 <25`.

## Static model

```ts
import { compileGraph, projectGraphDisplay } from "mission-pipeline";
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

All core data records are detached, deeply frozen, and prototype-free; arrays
are frozen ordinary arrays. Core inputs are captured descriptor-first,
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
  join-edge type; no readiness is inferred. Optional sealed `join.compose`
  metadata is preserved. Envelope joins add the static row “join input:
  accepted branch payload envelope”; existing select/omitted composition
  models keep their prior rendering.
- `historical: true` adds graphpaper's lifecycle badge metadata. The consumer
  decides whether a version is historical; the SDK reads no publication state.
  Authored IDs remain readable; synthetic ID collisions get stable `~1`, `~2`
  suffixes, including multiple terminal outcomes from one source to one sink.

The static class vocabulary follows graphpaper's public type mapping:
`node-type-code|model|human|agent|callback|endpoint|terminal` and
`edge-kind-outcome|exit|join`. The shipped `pipeline.css` styles those classes,
selection/focus, and the optional panel; runtime-status styling remains
proposed. Adapters supply the static defaults and legend to graphpaper;
its layout/SVG/selection implementations remain unchanged. A browser adapter
compatibility listener releases graphpaper 0.5.0's SVG pointer capture for
primary mouse presses on nodes so Chromium delivers the click to the node;
the renderer still owns selection and drag detection. Touch/pen capture is
unchanged. The canvas stays within the server's natural diagram width, and
the key and zoom controls sit below the drawing so they do not cover nodes.

## Static server and browser adapters

After building a model as above, a Node host can render a complete figure:

```ts
import ELK from "elkjs/lib/elk.bundled.js";
import { renderPipelineFigure, viewerAssets } from "mission-pipeline-graphpaper/server";

const figure = await renderPipelineFigure(model, {
  layoutEngine: new ELK(), // Optional; graphpaper has a built-in fallback.
  figureId: "pipeline-diagram"
});
const assets = viewerAssets();
```

`renderPipelineFigure` validates the static SDK model, captures an injected
layout method once, and produces SVG plus inert, escaped JSON. It inserts no
executable scripts or stylesheet loaders. Invalid or throwing injected layout
results get a generic error before graphpaper logs and falls back; hostile
thrown objects and private messages are not forwarded to its logger. Figure
geometry is also checked after layout; unusable final bounds cause a render
rejection rather than invalid SVG. Figure
IDs must be unique on a page; the embedded model ID defaults to the resolved
figure ID plus `-model`. Both IDs can be specified explicitly.

`viewerAssets()` returns a cached, deeply frozen prototype-free mapping of
eight names to `{ body, contentType, etag }`: `viewer.js`, `viewer-data.js`,
`viewer-defaults.js`, `types.js`, `graphpaper.js`, `diagram.css`, `pipeline.css`,
and `elk.js`. Each ETag is the quoted SHA-256 of the exact UTF-8 bytes. The
browser module's renderer import is rewritten to its sibling `graphpaper.js`;
all module dependencies are in that set, without Node/engine/CDN imports.
The function reads installed files only; the host chooses authorized routes,
cache headers, and CSP. Serve the names together at a consumer-owned URL.

For example, with assets served at `/pipeline/assets/`, the host can include
both CSS files, load `elk.js` as a classic script if ELK layout is wanted, and
run this module after the figure is in the document:

```js
import { mountPipelineViewer } from "/pipeline/assets/viewer.js";

const viewer = await mountPipelineViewer(document.getElementById("pipeline-diagram"), {
  // Consumer-owned authorization, route, and error handling; SDK never fetches.
  details: async (nodeId) => {
    const response = await fetch(`/authorized-details/${encodeURIComponent(nodeId)}`);
    return response.ok ? response.text() : undefined;
  }
});
viewer.select("review"); // false for an unknown ID; use a node in your model.
// viewer.destroy(); // Removes owned wiring/panel and restores original SVG.
```

The mount requires a connected element and exactly one embedded model script,
unless `model` is supplied explicitly. It returns a frozen prototype-free
handle with `select(nodeId | null)` and idempotent `destroy()`, not `update`.
`onSelect` receives a frozen selection snapshot. Deep links default to the
hash parameter `node`; use `deepLink: false` or `{ param: "pipelineNode" }`.
Selection preserves unrelated hash parameters and existing history state.
`legendVisible` and a trusted `layoutEngine` are the other optional controls.
Overlapping mounts sharing a canvas are refused; destroy permits a fresh
mount. Repeated figures receive distinct hydrated SVG marker IDs.

The optional details callback receives sealed engine node IDs, not synthetic
endpoint/terminal IDs. Its response must match the figure's exact graph
ID/version/digest, selected node ID, and drawn kind. `NodeDetails` is an
exported data type: sealed node facts, optional declared outputs, optional
exact-binding model information with either a prompt or a withheld reason,
optional implementation references, and a question. The host must authorize
the request and resolve binding/prompt identity exactly; matching context is
not proof that the provider's facts are authentic. The viewer renders text
only, refuses malformed/mismatched details with a generic message, and ignores
late responses after a new selection or teardown. No receipt/artifact payload
is fetched implicitly. Keyboard selection focuses the panel; closing it or
pressing Escape restores node focus. The panel is non-modal, with no focus
trap. It stays fixed inside the viewport as a side panel, becoming a bottom
sheet at widths of 680 px or less. Its body scrolls on short screens.

### Browser trust boundary

Use JSON **text** for untrusted `model` and details responses; the viewer
parses it internally and creates bounded, frozen prototype-free snapshots.
Live browser objects, the DOM, options/callbacks, and the layout engine are
trusted capabilities. Ordinary data accessors are rejected descriptor-first,
but browser JavaScript cannot detect a live Proxy without triggering traps;
the Node core/server's stronger Proxy rejection is not claimed here. Neither
adapter accepts arbitrary graphpaper models: only the static SDK schema is
admitted, with no runtime status, flow animation, stages, or scope callbacks.
The browser boundary caps each JSON text at 33,554,432 code units, depth at
24, values at 1,000,000, and aggregate string data at 33,554,432 code units.
These are admission limits, not a universal engine-size guarantee.

## Verification and provenance

From the repository root, run in this order:

```sh
npm run build && npm run release:manifest && npm run check
```

The build compiles both packages. The manifest writer packs without rebuilding
and writes separate engine and SDK manifests under root `release/`. The full
check tests exact/reproducible payloads and installs all four exact tarballs
offline into a temporary consumer. It runs SDK tests, strict TypeScript export
checks, graphpaper built-in and real-ELK server rendering, asset closure checks,
and isolated fake-DOM browser-wiring tests. Fake DOM does not establish actual
graphpaper browser behavior or visual accessibility. The local Browser witness
is recorded in `docs/VERIFY-GRAPHPAPER-STATIC-ADAPTERS.md` in the repository;
reduced-motion activation, assistive-technology/cross-browser checks, and deployed
consumer verification are not claimed. No merge-readiness claim follows.
The clean-commit `npm run test:fresh-clone` gate permits dependency fetching
during `npm ci` only (lifecycle scripts disabled), then runs verification
offline. Bootstrapping the pinned renderer requires Git repository read access;
an anonymous archive request may return 404 and cannot be assumed cacheable.

The Inbox graph8 golden is an independent capture of Inbox's existing static
builder. Its source fixture contains a sealed graph, presentation words, and
five exact model-binding names, not prompts or implementations. Provenance and
hashes are in `test/fixtures/inbox-graph8.provenance.json` in the repository;
tests exclude only the new `metadata.pipeline` block when comparing the model.
The support-triage static golden is a second, provider-free fixture witness.
Tests and private development tooling are not shipped in the SDK tarball.

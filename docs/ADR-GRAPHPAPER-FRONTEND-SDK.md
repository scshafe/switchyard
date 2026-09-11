# ADR: a standard graphpaper frontend SDK for mission-pipeline graphs

**Status: static SDK core and adapters implemented; browser witness pending (2026-09-10).**
The separately packaged SDK lives at
[`packages/mission-pipeline-graphpaper`](../packages/mission-pipeline-graphpaper/README.md),
version 0.1.0 unreleased, outside the engine payload. All engine exports it relies on are implemented in
unreleased 1.1.0: `projectGraphDisplay`, `projectUnitPath`, the goal manifest,
`projectGoalClosures`, and `graphDefinitionDiff`; see
[`REVIEW-INTERFACE-FRICTION.md`](REVIEW-INTERFACE-FRICTION.md). The SDK and
consumer interfaces below remain proposals unless explicitly marked otherwise.
Static building, presentation validation, static legend/render options,
historical model metadata, server figures/assets, browser selection/deep links,
the authorized details seam, and static CSS exist today. Automated checks cover
these adapters; a real-browser witness remains pending because this session's
browser runtime list is empty. This is not a merge-readiness or Inbox-adoption
claim. Run overlays, metrics, proposal rendering, viewer updates, and goal
scopes remain proposed.

## Context

Inbox draws its pipeline with graphpaper through about 4,100 lines in eight
modules under `src/node-graph-v2/` (repository `inbox-pipeline`). Read for
this ADR:

| Module | Lines | What it does | Generic or Inbox-specific |
| --- | --- | --- | --- |
| `pipeline-diagram.ts` | 852 | Builds a graphpaper `DiagramModel` from the sealed graph, a presentation table, optional store counts, and an optional per-email highlight; merges arrows per node pair; detects marking nodes; proves arrow groups partition the sealed vocabulary; draws every declared terminal even when unpresented; renders SVG on the server with ELK in-process; ships the hydration script and static assets | Mostly generic. Inbox-specific: the model-catalog lookup by binding digest, the outbox event types that count hand-offs, the CSP asset routes |
| `email-graph-presentation.ts` | 759 | Names, summaries, extra rows per node; arrow groups with notes; endpoints (JobTrack, push, unsubscribe, mailbox, human console) with transports and outbox event types; quiet ends; longest-path ranks; mailbox write state derivation | Presentation is consumer-owned by design. `layoutGraph` (ranks) and the arrow-group partition rule are generic |
| `graph-console.ts` | 313 | One registry entry per sealed graph: definition, presentation, proposal, output contract bindings, human questions, implementation pointers, prompt views; exact (id, version, digest) lookup including frozen historical snapshots; enrolled versus registered | The registry shape is generic; its contents are consumer data |
| `pipeline-node-panel.ts` | 486 | The slide-over panel: server-rendered empty shell beside the figure, DOM-built browser module that reads one node API, refuses a payload whose graph identity differs, never paints a stale answer over a newer pick | Generic shell and stale-fetch rule; Inbox-specific sections (action candidates, decisions) |
| `model-prompt-view.ts` | 369 | The exact prompt and inference parameters for a model node, shown only when the lane's binding equals the sealed binding digest; otherwise withheld with the reason | The honesty rule is generic; catalog resolution is consumer-owned |
| `graph-proposal-diff.ts` | 259 | Pure diff of two `GraphDefinition`s by identity (node id, edge id, terminal pair) | Entirely generic; imports only from mission-pipeline |
| `pipeline-proposal-diagram.ts` | 219 | Union of sealed and candidate definitions with added/removed/changed marks, one edge per declared edge, candidate roles from the candidate definition | Generic |
| `pipeline-http.ts` | 898 | Routes; exact graph identity from the unit, never the URL; version-unavailable responses; per-unit visit derivation from the console projection; endpoint delivery states from outbox and relay rows | Routes and authorization are consumer-owned; the identity and "unavailable, not substituted" rules are generic |

Inbox's simplification plan (milestone M1) and its implementation record
already moved to exact version and digest lookup, candidate-owned names and
roles, and version-scoped counters. The next consumer would have to rebuild
all of it. The graph definition is already the single source of topology;
the picture must stay derived from it.

graphpaper 0.5.0 provides everything the rendering needs and nothing the
pipeline needs: a neutral `DiagramModel`; `layoutDiagram` with an injectable
ELK engine (server-safe); `renderDiagramSvg` (no DOM); `hydrateDiagram` with
popovers, pan and zoom, a legend, node selection (`onNodeSelect`,
`selectDiagramNode`, `clearDiagramNodeSelection`), drill-down scopes, staged
diagrams, lifecycle marking; a stable CSS class contract
(`node-type-<type>`, `component-status-<status>`, `edge-kind-<kind>`,
`edge-flavor-<flavor>`, `map-edge-flow`, `node-visual-group-<group>`,
`diagram-node-selected` with `aria-current`); and keyboard access
(`tabindex="0"` on nodes and edges, Enter and Space to pick, Escape to clear,
reduced-motion fallbacks).

## Decision

Introduce a framework-independent SDK package between the engine and
graphpaper. The engine provides the pure projections the static SDK consumes
and its proposed runtime modes would use.

```
mission-pipeline (engine, dependency-free)
  projectGraphDisplay(compiled)   -> GraphDisplayProjection      [implemented, unreleased 1.1.0]
  projectUnitPath(journey)        -> UnitPathProjection          [implemented, 1.1.0]
  createGoalManifest(graph, draft)-> GoalManifest                 [implemented, 1.1.0; consumer-authored, engine-sealed]
  projectGoalClosures(manifest, path) -> GoalClosureProjection   [implemented, 1.1.0]
  graphDefinitionDiff(a, b)       -> GraphDefinitionDiff         [implemented, unreleased 1.1.0; adapted from Inbox]
          │
          ▼
mission-pipeline-graphpaper (SDK, peer-depends on both; no DOM in core)
  core:    buildPipelineDiagram, validatePresentation, static legend/options [implemented, 0.1.0]
           buildProposalDiagram, overlays and metrics [proposed]
  server:  renderPipelineFigure (SSR, optional injected ELK), viewerAssets [implemented, 0.1.0]
  browser: mountPipelineViewer (static hydrate, select, deep link, details seam) [implemented, 0.1.0; browser witness pending]
          │
          ▼
graphpaper (unchanged: layout, SVG, popovers, selection, pan/zoom, a11y)
          ▲
consumer: presentation words, goal manifest, endpoints; run overlays; metrics;
          authorized details provider; routes, auth, assets, styling
```

### Ownership boundaries

| Concern | Owner | Never |
| --- | --- | --- |
| Topology, kinds, contracts, outcomes, bindings, joins, terminals | mission-pipeline (`GraphDefinition`) | duplicated in the SDK or the consumer |
| Display projection of a compiled graph (depth, merged arrows, marks, fan-outs, joins) | mission-pipeline, pure function | computed differently per consumer |
| Execution state of one unit (settled, pending, failed, dead, join progress) | mission-pipeline, pure over the journey | inferred from a picture |
| Delivery, outbox, relay, and "reached" states | consumer, supplied explicitly | inferred by the SDK |
| Names, summaries, questions, goal names, endpoints, quiet ends, arrow notes | consumer presentation | placed in the graph definition |
| Goal membership, entries, and resolutions | consumer-authored goal manifest, sealed and validated by mission-pipeline (`createGoalManifest`) | inferred from names or from a presentation grouping |
| Model, prompt, contract, implementation details | consumer, through an authorized provider callback | bundled into the viewer or fetched by it |
| Metrics per graph version | consumer, with unavailable distinct from zero | invented by the SDK |
| Layout, SVG, popovers, selection gestures, pan and zoom, keyboard, reduced motion | graphpaper | forked or reimplemented in the SDK |
| Turning projections plus presentation plus overlays into a `DiagramModel`; coverage checks; figure markup; hydration wiring; deep links | the SDK | reaching into a database, credential, or provider |

## Contracts

### From the engine (implemented in unreleased 1.1.0)

`projectGraphDisplay(compiled)` in `src/graph/display.ts` returns a
serializable, digest-carrying `GraphDisplayProjection` of one compiled graph.
It contains no presentation words, only structure:

```ts
interface GraphDisplayProjection {
  readonly schemaVersion: "mission-pipeline-graph-display.v1";
  readonly graph: GraphDefinitionRef;                       // id, version, digest
  readonly entry: string;
  readonly nodes: readonly {
    readonly nodeId: string; readonly kind: MissionPipelineNodeKind;
    readonly ref: MissionPipelineNodeRef; readonly input: ContractId;
    readonly outcomes: readonly string[]; readonly outputs?: Readonly<Record<string, ContractId>>;
    readonly binding?: MissionPipelineNodeBindingRef; readonly configuration?: MissionPipelineNodeConfigurationRef;
    readonly join?: MissionPipelineJoin; readonly maxAttempts: number;
    readonly depth: number;                                  // longest path from entry; any cycle: BFS depth for all nodes
    readonly marks: boolean;                                 // multiple outcomes, identical guaranteed successors, no terminals or conditional-only extras
  }[];
  readonly arrows: readonly {                                // one per (from, to) pair
    readonly from: string; readonly to: string;
    readonly outcomes: readonly string[]; readonly edgeIds: readonly string[];
    readonly conditional: boolean;                           // any contributing edge has a where arm
    readonly fanOut: readonly { readonly edgeId: string; readonly coTargets: readonly string[]; readonly outcomes?: readonly string[] }[];
  }[];
  readonly terminals: readonly TerminalOutcome[];
  readonly joins: readonly { readonly nodeId: string; readonly require: JoinRequirement; readonly inbound: readonly string[] }[];
}
```

The argument must be the immutable result of `compileGraph` from the same
package instance. Copied, forged, and JSON-deserialized compiled objects are
rejected before reading their properties: the compiled shape omits the graph
description and therefore cannot independently revalidate the full graph
digest. To cross a process or package-instance boundary, transport the sealed
`GraphDefinition` and compile it again. The returned display projection is
detached and can itself round-trip through JSON.

Nodes and terminals retain authored order; arrows are merged by `(from, to)`
in first-seen edge/target order, with distinct outcomes and contributing edge
IDs. `conditional` is true if any contributing edge has a `where` arm.
`fanOut` lists each contributing multi-target edge, its other targets, and
its own predicate outcomes before merging. `outcomes` is an additive optional
v1 key: current projections emit it, older v1 projections may omit it;
separate edges are not treated as one fan-out. In an acyclic graph, `depth`
is the longest path from the entry. If any cycle exists, every node uses its
shortest breadth-first distance from the entry instead.

A marking node has at least two outcomes, no terminal outcomes, and the same
nonempty guaranteed successor set for every outcome. A conditional edge to
an additional target prevents marking; a conditional edge to an already
guaranteed target does not. This reports structural routing, without choosing
labels or explaining application policy. All returned records are frozen and
prototype-free, including nested definition data.

`UnitPathProjection` (implemented in `src/store/unit-path.ts`) is the per-run
execution state, derived only from journey records: per-node state
(`pending`, `failed`, `dead`, `settled`; absent means never queued) with every
occurrence, outcomes, edges taken, join progress, open queues, and usage.

`graphDefinitionDiff(a, b)` in `src/graph/diff.ts` compares two sealed graph
definitions. `GraphDefinitionDiff` carries the schema
`mission-pipeline-graph-definition-diff.v1`, both exact identities as `sealed`
and `candidate` (`graphId`, `version`, `digest`), `sameFamily`, graph-level
`description` and `entry` changes, `nodes`, `edges`, `terminals`, `unchanged`
counts, and `empty`.

The comparison uses Inbox's identity rules: nodes by node ID, edges by edge
ID, terminals by `(nodeId, outcome)`. Reordering those arrays or a node's
outcome vocabulary does not create a change. Edge target order and
predicate/join array order remain structural. Identity metadata is reported
separately: a new graph version alone can have `empty: true`, and a different
graph ID has `sameFamily: false`.

The engine adaptation adds declared `outputs` and `configuration` comparison,
seal and hostile-input validation, and frozen, prototype-free output. Field
changes carry machine-readable paths and canonical JSON strings in `from`
and `to`, using the literal `undefined` for an absent optional field. Existing
authored values, including graph descriptions, are comparison data; the
engine supplies no display labels, unit suffixes, or other presentation
phrases. Both definitions must validate, but the candidate need not compile,
so a structurally valid sealed proposal can be inspected before it is runnable.

### From the consumer

The presentation subset below is implemented in SDK 0.1.0. Its full exported
type also includes optional consumer model-name/binding-digest pairs, unit
noun, diagram ID/description/publication, and endpoint wording/metadata;
see [`types.ts`](../packages/mission-pipeline-graphpaper/src/types.ts).
Goal labels require a validated manifest and original sealed definition;
membership is checked but goal scopes are not rendered. `NodeDetails` is the
implemented authorized-provider subset in
[`viewer-types.ts`](../packages/mission-pipeline-graphpaper/src/viewer-types.ts).
The overlay and metrics contracts in this block remain proposed.

```ts
interface PipelinePresentation {                            // implemented static subset, 0.1.0
  readonly schemaVersion: "mission-pipeline-presentation.v1";
  readonly title: string; readonly subtitle?: string;
  readonly nodes: Readonly<Record<string, { name: string; summary?: string; question?: string; rows?: readonly { label: string; value: string }[] }>>;
  readonly arrows?: Readonly<Record<`${string}->${string}`, readonly { outcomes: readonly string[]; label?: string; note?: string }[]>>;
  readonly goals?: Readonly<Record<string, { name: string; members?: readonly string[] }>>;   // membership comes from the goal manifest; a listed `members` must equal it
  readonly endpoints: readonly { id: string; name: string; system?: string; summary?: string; exits: readonly { nodeId: string; outcome: string }[]; waits?: readonly string[] }[];
  readonly terminals: readonly { id: string; name: string; summary?: string; ends: readonly { nodeId: string; outcome: string }[] }[];
}

interface ExecutionOverlay {                                // proposed; one unit
  readonly unit: { readonly unitId: string; readonly graph: GraphDefinitionRef };
  readonly path: UnitPathProjection;                        // from the engine
  readonly goals?: GoalClosureProjection;                   // from the engine: projectGoalClosures over the same path and the graph's sealed manifest
  readonly endpointStates?: Readonly<Record<string, {       // consumer-supplied, never inferred
    readonly state: "planned" | "pending" | "delivered" | "failed" | "awaiting_person" | "decided";
    readonly label: string; readonly at?: string;
  }>>;
}

interface VersionMetrics {                                  // proposed; one graph version
  readonly graph: GraphDefinitionRef;
  readonly window: { readonly label: string; readonly start: string | null; readonly asOf: string };
  readonly firstAdmittedAt: string | null;
  readonly nodes: Readonly<Record<string, NodeMetrics | { readonly available: false; readonly reason: string }>>;
  readonly sinks: Readonly<Record<string, { readonly reached: { window: number; allTime: number } } | { readonly available: false; readonly reason: string }>>;
}
interface NodeMetrics {
  readonly available: true;
  readonly settled: readonly { outcome: string; window: number; allTime: number }[];
  readonly deadLetters: readonly { errorCode: string; window: number; allTime: number }[];
  readonly retried: { window: number; allTime: number };
  readonly waiting: { count: number; oldestQueuedAt: string | null };
}

interface NodeDetails {                                     // implemented static details seam, 0.1.0
  readonly graph: GraphDefinitionRef; readonly nodeId: string;
  readonly sealed: { ref: MissionPipelineNodeRef; kind: "code" | "model" | "human" | "agent" | "callback"; input: ContractId; outcomes: readonly string[]; maxAttempts: number; leaseMs: number; binding?: MissionPipelineNodeBindingRef };
  readonly outputs?: readonly { outcome: string; contractId: ContractId }[];
  readonly model?: { name: string; id: string; version: number; providerId?: string; parameters: Readonly<Record<string, string | number>>;
    prompt: { digest: string; systemPrompt: string } | { withheld: string } };
  readonly implementation?: { body: { module: string; symbol: string }; port: { module: string; symbol: string }; dispatch?: string };
  readonly question?: string;
}
```

The static model carries `metadata.pipeline` with mode `static`, the exact
graph reference, a canonical presentation digest, and structured
`unclaimedTerminals`. The expanded metadata contract below remains proposed:

```ts
{ schemaVersion: "mission-pipeline-diagram.v1", graph: GraphDefinitionRef,
  mode: "static" | "run" | "metrics" | "proposal", unitId?: string, presentationDigest: string }
```

## Public API today (unreleased SDK 0.1.0)

```ts
buildPipelineDiagram(input: {
  projection: GraphDisplayProjection; presentation: PipelinePresentation;
  definition?: GraphDefinition; goalManifest?: GoalManifest; historical?: boolean;
}): DiagramModel;
validatePresentation(projection: GraphDisplayProjection, presentation: PipelinePresentation,
  options?: { definition?: GraphDefinition; goalManifest?: GoalManifest }): readonly string[];
pipelineLegend(mode?: "static"): readonly DiagramLegendEntry[];
PIPELINE_RENDER_OPTIONS: DiagramRenderOptions;

// mission-pipeline-graphpaper/server (Node only)
renderPipelineFigure(model: DiagramModel, options?: {
  layoutEngine?: DiagramLayoutEngine; figureId?: string; modelElementId?: string;
}): Promise<string>;
viewerAssets(): Readonly<Record<string, { contentType: string; body: string; etag: string }>>;

// mission-pipeline-graphpaper/browser (ES module, no framework)
mountPipelineViewer(container: Element, options?: {
  model?: DiagramModel | string;                            // default: embedded inert model JSON
  onSelect?: (pick: { nodeId: string | null; node: DiagramNode | null; source: string }) => void;
  details?: (nodeId: string) => Promise<NodeDetails | string | undefined>;
  deepLink?: { param?: string } | false;                    // default "#node=<id>", replaceState
  legendVisible?: boolean;
  layoutEngine?: DiagramLayoutEngine;
}): Promise<{ select(nodeId: string | null): boolean; destroy(): void }>;
```

The core runs on the engine's supported Node versions, without DOM, fetch,
timers, providers, stores, or a runtime graphpaper import. It accepts copied
JSON projections after descriptor-safe shape/coverage checks; a carried graph
digest does not authenticate that projection's payload. Optional `definition`
recompiles the sealed source and demands exact projection equality. Optional
`goalManifest` requires `definition` and uses the engine's full manifest check.
Malformed input throws; coverage diagnostics are frozen strings. Building
refuses coverage errors except unclaimed terminals, which are drawn explicitly.
Outputs are detached, deeply frozen, prototype-free records.

The adapters accept the SDK's bounded static model schema, including its
exact graph aliases and static metadata. They reject unsupported execution
status, stage/scope/flow metadata, arbitrary renderer hooks, and future modes.
The Node server captures capabilities and snapshots model/layout data with
the engine's existing hostile-input helpers before calling graphpaper. Without
an injected layout engine it uses graphpaper's built-in layout; an engine
failure or invalid result also permits that fallback. The figure contains SVG
and escaped inert JSON, with no executable script or stylesheet loader.

The browser entry has no runtime engine or Node imports. Untrusted model and
details payloads must arrive as JSON strings, parsed and bounded inside the
viewer. Live objects, callbacks, DOM elements, and injected ELK capabilities
are trusted host inputs: ordinary accessors are refused, but browsers provide
no Proxy detector, so reflection can run Proxy traps. Both accepted data forms
become detached, frozen, prototype-free records. Matching graph/node identity
and kind prevents a stale details response from being shown for another pick;
it does not prove that provider-supplied contents match a sealed definition.
The provider still owns authorization and historical content resolution.

`viewerAssets()` reads a fixed installed asset set: `viewer.js`,
`viewer-data.js`, `viewer-defaults.js`, `types.js`, `graphpaper.js`,
`diagram.css`, `pipeline.css`, and `elk.js`. Each value carries its content
type and a quoted SHA-256 ETag for the exact served bytes. The helper requires
the installed graphpaper and ELK peers for the complete set; the consumer
serves the files together under its own routes, cache headers, and CSP.
The browser entry re-exports nothing from graphpaper.

The renderer is `scshafe/graphpaper`, pinned for development at commit
`89240f15c171a26009430ad7eb45eb85ac2567aa` (0.5.0), not the unrelated registry
package named `graphpaper`. The SDK's renderer peer is optional to avoid
auto-installing that unrelated package; consumers install the intended source
explicitly. Both packages have separate exact-payload manifests and gates.

## Extended public API (proposed; not shipped)

```ts
// mission-pipeline-graphpaper  (core: no DOM, no fetch, no timers)
buildPipelineDiagram(input: {
  projection: GraphDisplayProjection; presentation: PipelinePresentation;
  overlay?: ExecutionOverlay; metrics?: VersionMetrics; historical?: boolean;
}): DiagramModel;
validatePresentation(projection: GraphDisplayProjection, presentation: PipelinePresentation): readonly string[];  // [] when covered
buildProposalDiagram(input: { current: GraphDisplayProjection; candidate: GraphDisplayProjection; diff: GraphDefinitionDiff;
  presentation: { current: PipelinePresentation; candidate: PipelinePresentation } }): DiagramModel;
pipelineLegend(mode: "static" | "run" | "metrics" | "proposal"): readonly DiagramLegendEntry[];
PIPELINE_RENDER_OPTIONS: DiagramRenderOptions;              // direction DOWN, compact, tail labels, node width

// Proposed addition to the browser handle; no update method exists today.
interface ProposedPipelineViewerHandle {
  select(nodeId: string | null): boolean;
  update(overlay: ExecutionOverlay): Promise<void>;
  destroy(): void;
}
```

## Illustrative static consumer integration (implemented APIs)

Server side, one request:

```ts
import { compileGraph, projectGraphDisplay } from "mission-pipeline";
import { buildPipelineDiagram, validatePresentation } from "mission-pipeline-graphpaper";
import { renderPipelineFigure } from "mission-pipeline-graphpaper/server";
import { TRIAGE_PRESENTATION } from "./triage-presentation.js";                          // consumer words

const projection = projectGraphDisplay(compileGraph(graph));                            // consumer-resolved sealed graph
const problems = validatePresentation(projection, TRIAGE_PRESENTATION, { definition: graph });
if (problems.length > 0) throw new Error(problems.join("; "));                          // a test also asserts this

const model = buildPipelineDiagram({ projection, presentation: TRIAGE_PRESENTATION, definition: graph });
const html = await renderPipelineFigure(model, { figureId: "pipeline-diagram" });       // SVG + inert JSON; built-in layout
```

Browser side, one module the consumer serves under its own CSP:

```js
import { mountPipelineViewer } from "/pipeline/assets/viewer.js";
import { readAuthorizedNodeDetailsJson } from "./consumer-details.js";            // consumer callback, returns JSON text
const viewer = await mountPipelineViewer(document.getElementById("pipeline-diagram"), {
  details: readAuthorizedNodeDetailsJson
});
// When removing the view:
// viewer.destroy();
```

The consumer still owns: the route, the authorization on the details
endpoint, the asset paths and CSP, and every word in the presentation. This
integration is static; the consumer binds its details callback to the exact
graph identity used for this page. Runtime metrics and delivery-state overlays
remain proposed. It has not been installed into Inbox.

## Rendering rules

**Static graph — implemented.** Every node from the projection, typed `code`, `model`,
`human`, `agent`, or `callback`; title from the presentation with the depth
beside it (one-based engine depth, not layout layers); rows for outcomes (or
`marks` when the node marks), model binding ID or an exact-binding consumer
name when present, ref. One arrow per (from, to) pair labelled `always`, the
outcomes, `otherwise`, or a count, with the full list in the popover; the
consumer's arrow groups split a pair into several labelled arrows, and the SDK
throws unless the groups partition the sealed arrow's outcomes exactly once.
For an ungrouped single successor and at most three declared outcomes, the
builder preserves Inbox's one-arrow-per-outcome convention. Fan-out
is stated in the arrow description ("the same unit also goes to …"). Joins
render a badge (`join · all` or `join · 2 of 3`) and their inbound arrows wear
`edge-kind-join`. Every declared terminal becomes a dashed exit to a presented
sink; an unpresented terminal is drawn on its own and listed in
`metadata.pipeline.unclaimedTerminals` so it can never disappear. Older
projections without per-edge fan-out outcomes get edge-only wording, not
guessed outcome provenance. Conditional arrows always state their condition.

**Run overlay — proposed.** Node status from `UnitPathProjection` only: `settled`,
`pending`, `failed`, `dead`, and `idle` for a node the projection does not
list; subtitle `settled · <outcome>`. An arrow is `flow` when the projection
counts its edge id as taken, which the engine records at settlement, so the
viewer never infers a path from two adjacent states. A sink is `reached` only when the consumer supplied an endpoint
state, or the terminal's source settled that outcome. `awaiting_person` and
`decided` come from the overlay; the SDK never infers them from a human node's
existence.

**Metrics — proposed.** Counts appear as rows and badges, scoped to the model's graph
version. A node with `available: false` shows "unavailable: <reason>"; a node
with `allTime === 0` shows "never observed since <firstAdmittedAt>" and its
arrows take the `unobserved` flavor. Zero and unavailable are never the same
word. Family-wide history is not shown on a version-scoped picture.

**Proposal — proposed.** `buildProposalDiagram` draws the union of both projections, one
edge per declared edge, every element marked `added`, `removed`, `changed`, or
`unchanged` from the diff. A candidate-only node takes its role from the
candidate projection's kind, so a proposed model node is never drawn as code.
Removed nodes take their words from the current presentation, added ones from
the candidate presentation.

**Historical metadata and details seam — implemented.** A model the
consumer explicitly marks `historical: true` is
marked with graphpaper's lifecycle badge and watermark (`historical`), and the
consumer's details provider must answer from the intended historical snapshot
or return unavailable. The viewer checks identity and kind; it cannot prove
which catalog the provider read.

## Identity rules

Exact static metadata, optional sealed-source verification, details identity,
and deep links exist today. Current static input rejects all overlay and
metrics fields; identity matching for those future modes remains proposed.

- Every model carries the exact graph id, version, and digest in
  `metadata.pipeline.graph`.
- Proposed: `buildPipelineDiagram` refuses an overlay or metrics object whose
  graph identity differs from the projection's, with both identities in the error.
- `mountPipelineViewer` refuses details whose graph, node ID, or sealed kind
  differs from the selected node and shows "Details for this version are
  unavailable." A slower earlier response never paints over a newer pick,
  and responses after `destroy()` are ignored.
- Deep links carry the node id; the page that serves the model carries the
  identity. A link to a node the model does not draw selects nothing and
  leaves the URL alone.
- Consumer rule for a future run view: a unit's picture is drawn on its pinned
  graph, never on the graph a URL parameter names. That resolution is the
  consumer's, as Inbox does it.

## Selection, details, and deep links (implemented static wiring)

Selection is graphpaper's: click, Enter, or Space picks one node; Escape or a
background click clears; re-picking is a no-op. The SDK mirrors the pick into
the URL hash with `replaceState`, opens the details seam if a provider was
given, and calls `onSelect`. The details panel is a sibling of the figure,
outside the canvas graphpaper replaces. It uses DOM text operations and
renders only validated `NodeDetails` fields. Endpoint and terminal picks show
their supplied model words without invoking the node-details provider.
Consumers implementing their own panel omit `details` and handle `onSelect`.
`destroy()` removes owned listeners and panel state, tears down graphpaper
interactions, and restores the original server-rendered children. Failed
hydration also restores those children. A second mount on the same container
is refused until the first is destroyed.

## Accessibility, responsiveness, large graphs

Static adapter wiring and CSS are implemented with automated coverage.
Keyboard behavior, narrow-screen layout, and reduced-motion rendering still
need the real-browser witness described below.

- Keyboard: graphpaper's `tabindex="0"` on nodes and edges, Enter and Space to
  pick, Escape to clear; the SDK adds a visible focus ring for the selected
  node and keeps the panel focusable and closable by keyboard.
- Reduced motion: the SDK CSS disables panel/node animation and transitions
  under `prefers-reduced-motion`. Runtime flow styling remains proposed.
- Responsive: the figure carries its natural width and height as CSS
  variables so the page scales it down only on narrow screens; the panel
  becomes a bottom sheet under 680px (Inbox's rule, made default).
- Large graphs: compact nodes and tail-placed labels are current defaults;
  viewport fit still needs visual verification. Proposed: `goals` may
  render as drill-down scopes using graphpaper's `scope` feature, but the flat
  view remains the default and the scope node's badge states the exact number
  of model invocations inside, so grouping never hides a call.
- Server rendering: the same model renders to SVG without a DOM; hydration
  replaces it in place and falls back to the server picture on any error.

## What the SDK must not do

- Fetch anything on its own, read a database, or hold a credential.
- Bundle raw artifacts, provider receipts, prompts, or unit content into the
  model. Details arrive only through the consumer's provider callback.
- Infer join readiness, delivery success, human wait state, or "reached" from
  topology. State is supplied or absent.
- Store topology. The projection is derived from the compiled graph on every
  build; the model is a rendering, not a record.
- Fork graphpaper's layout or rendering. It consumes graphpaper's public API
  and CSS class contract only.

## Extension points

Presentation rows/groups/notes and legend data exist in the static core.
Static adapters also expose injected layout engines, selection callbacks,
authorized details providers, configurable/disabled deep links, and initial
legend visibility. They do not accept arbitrary renderer options.

- `presentation.arrows` groups and notes; `presentation.nodes[*].rows`.
- Proposed: `nodeRenderers` pass-through to graphpaper for custom node markup.
- Proposed: a `classify` hook `(node) => { type?: string; visualGroup?: string }` for
  consumers that want an extra visual class (for instance, `endpoint` versus
  `terminal` sub-kinds), constrained to class tokens.
- The details panel can be replaced by omitting `details` and handling
  `onSelect`; the deep-link parameter is configurable.
- Legends are data; consumers calling graphpaper directly may append entries.
  Custom adapter legends remain proposed.

## Compatibility and versioning

- The SDK is semver-versioned separately from the engine and from graphpaper,
  with peer ranges on both. It pins the `schemaVersion` strings it accepts and
  refuses others loudly.
- The `DiagramModel` it emits is part of its public contract: golden model
  fixtures for the support-triage example and for Inbox's frozen graph8
  snapshot must be checked in and compared byte for byte, so a rendering
  change is a visible diff.
- `pipeline.css` ships the static node kinds, `edge-kind-outcome|exit|join`,
  selected-node/focus styling, the details panel, and responsive/reduced-motion
  rules, listed in the SDK README. Runtime/proposal tokens
  (`component-status-settled|pending|failed|dead|reached|idle|added|removed|changed`
  and `edge-flavor-unobserved|removed|changed`) remain proposed.
- Breaking engine projection changes bump `schemaVersion`. Additive optional
  keys may remain v1 with an explicit compatibility policy: the SDK currently
  accepts `fanOut.outcomes` either present or absent and rejects unknown keys.

## Test strategy

Engine projection tests run today in
[`mission-pipeline-graph-display.test.mjs`](../test/mission-pipeline-graph-display.test.mjs)
and [`mission-pipeline-graph-diff.test.mjs`](../test/mission-pipeline-graph-diff.test.mjs):
golden projections and diffs over the fixture graphs and the support-triage
example, plus routing, depth, identity-comparison, seal-validation, and
hostile-input cases. The example's existing presentation coverage, Mermaid
diagram, and goal-manifest seals remain checked against the same unchanged
graph definitions.

Static SDK checks run today under
[`packages/mission-pipeline-graphpaper/test`](../packages/mission-pipeline-graphpaper/test/diagram.test.mjs)
through an offline installed-tarball consumer. They cover the independent
Inbox graph8 golden (only `metadata.pipeline` excluded), a support-triage
static golden, shape/coverage, hostile inputs, deterministic frozen records,
source/goal identity checks, and fallback sinks. The gate also checks the
exact SDK payload, manifest, import boundaries, strict TypeScript consumption,
and real graphpaper built-in layout/SVG compatibility. The existing Inbox and
support-triage core model goldens are unchanged by the adapter work.

Static adapter suites in
[`server.test.mjs`](../packages/mission-pipeline-graphpaper/test/server.test.mjs),
[`viewer-data.test.mjs`](../packages/mission-pipeline-graphpaper/test/viewer-data.test.mjs),
and [`browser.test.mjs`](../packages/mission-pipeline-graphpaper/test/browser.test.mjs)
cover escaped SSR/inert JSON, real ELK and fallback layout, fixed asset
bytes/ETags, strict model/details validation, exact selection identity, stale
asynchronous responses, deep links, keyboard panel wiring, and teardown/failed
hydration restoration. Browser adapter tests use a fake DOM and renderer seam;
those checks do not establish visual behavior in a real browser.

The contract cases below distinguish existing static behavior from proposed
runtime modes.

Contract tests (Node, no browser):

- Coverage (static implemented): every projection node is drawn with its kind;
  every `(edgeId, target)` contributes to its pair's arrows (fan-out is not a
  single-arrow invariant); outcomes partition within each merged pair, not
  globally across targets; every terminal lands on exactly one sink; the union of
  arrow groups equals the sealed arrow; unpresented terminals are drawn and
  listed.
- Proposed roles: candidate-only nodes take the candidate kind; removed nodes keep the
  current kind.
- Identity: static model/details checks are implemented; overlay/metrics
  identity checks remain proposed.
- Proposed state truthfulness: a settled node without a supplied endpoint state is not
  "reached"; a pending human node is `pending`, not `decided`; a terminal
  failure is `dead`; `available: false` renders "unavailable" and `allTime: 0`
  renders "never observed".
- Determinism: the same inputs produce the same model; the model round-trips
  through JSON.
- Proposed: golden models for the example graph in every runtime mode.

Real-browser witness (pending for these adapter changes): hydrate the
server figure with elkjs, pick a node by keyboard, follow a deep link, resize
to a narrow viewport, verify the reduced-motion query, and confirm the details
panel refuses a mismatched identity. On 2026-09-10 the available browser
runtime list was empty, so this witness was not run; passing automated tests
does not close it. graphpaper's own fake-DOM tests cover selection gestures;
the SDK's fake-DOM tests cover the wiring. A signed-in deployed witness
remains the consumer's release gate, as Inbox's plan states. No Inbox
adoption or deployed verification is claimed here.

## Extraction and adoption plan

1. **Engine projections — complete in unreleased 1.1.0** (this repository):
   `projectGraphDisplay`, `projectUnitPath`, the goal manifest,
   `projectGoalClosures`, and `graphDefinitionDiff`, with golden tests over
   the fixture graphs and the support-triage example. Additive exports; no
   store migration or graph-definition change.
2. **SDK core — implemented in unreleased 0.1.0**: port `buildPipelineDiagram` from Inbox's `pipeline-diagram.ts`
   onto the projection, keeping its arrow merging, marking detection, partition
   guard, and unclaimed-terminal rules; add `validatePresentation` (the
   example's `presentationCoverage` is the seed). Prove behaviour preservation
   with a golden test: the SDK's model for Inbox's frozen graph8 snapshot
   equals Inbox's current model modulo the new metadata block. Separate package
   at `packages/mission-pipeline-graphpaper`, not part of the engine payload.
3. **Static server and browser adapters — implementation and automated checks
   added in unreleased 0.1.0; real-browser witness pending**:
   `renderPipelineFigure`, `viewerAssets`, and `mountPipelineViewer` provide
   static SSR, assets/CSS, selection, the authorized details panel, deep links,
   and teardown. Models and graph/goal seals are unchanged. Complete the
   browser witness above before declaring this extraction step fully verified.
4. **Inbox adoption**: `pipeline-diagram.ts` becomes a thin call into the SDK
   with Inbox's presentation, endpoint-state derivation, metrics query, and
   details endpoint unchanged; delete the duplicated builder once the golden
   test holds.
5. **Proposal and metrics modes**: `buildProposalDiagram` on the promoted
   diff; `VersionMetrics` from Inbox's version-scoped projection.
6. **Second consumer — static fixture witness implemented with step 2**: draw the support-triage example graph from this
   repository's fixtures as the SDK's own smoke, proving no Inbox assumption
   leaked into the package.

Steps 1–3 make no change to a running consumer. Step 3's outstanding browser
witness is the next verification slice; Inbox adoption remains future work.

## Alternatives considered

- **Keep per-consumer integrations.** Rejected: the second consumer rebuilds
  about 4,100 lines and re-learns the identity and truthfulness rules.
- **Put rendering into mission-pipeline.** Rejected: the engine imports Node
  built-ins and its own files only, and its import-boundary test enforces it;
  graphpaper and elkjs are browser-shaped dependencies.
- **Fork graphpaper for pipeline-specific layout.** Rejected: graphpaper's
  public model, options, class contract, and accessibility work already fit;
  the SDK adds only the pipeline vocabulary on top.
- **A React wrapper first.** Rejected for now: Inbox renders on the server
  and hydrates with a vanilla module under a strict CSP; a `mission-pipeline-
  graphpaper/react` entry can wrap `mountPipelineViewer` later without
  changing the core, and should be added only when a consumer using React
  exists.

## Decisions settled for static SDK implementation

- Package location: the user selected a separate package in this repository.
  Root `npm pack` still excludes `packages/`; each package has its own exact
  payload manifest, and the root build/check gates verify both.
- Display engine structural depth plus one, retaining Inbox's one-based rank
  convention. Longest-path depth for acyclic graphs and breadth-first depth
  for cyclic graphs remain stable across renderers.
- Keep runtime modes outside the static adapters: overlays, metrics, proposal
  rendering, `update`, and goal scopes remain proposed. P8 receipt policy and
  P7 join-envelope work remain deferred independently of this SDK.

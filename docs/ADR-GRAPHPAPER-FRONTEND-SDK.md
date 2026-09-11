# ADR: a standard graphpaper frontend SDK for mission-pipeline graphs

**Status: proposed (2026-09-10).** The SDK package does not exist. Of the
engine exports it relies on, `projectUnitPath`, the goal manifest, and
`projectGoalClosures` shipped in 1.1.0; the display projection and the
promoted diff remain proposals; see
[`REVIEW-INTERFACE-FRICTION.md`](REVIEW-INTERFACE-FRICTION.md). Every other
API name below is a proposal.

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
graphpaper, and give the engine the two pure projections the SDK consumes.

```
mission-pipeline (engine, dependency-free)
  projectGraphDisplay(compiled)   -> GraphDisplayProjection      [proposed]
  projectUnitPath(journey)        -> UnitPathProjection          [implemented, 1.1.0]
  createGoalManifest(graph, draft)-> GoalManifest                 [implemented, 1.1.0; consumer-authored, engine-sealed]
  projectGoalClosures(manifest, path) -> GoalClosureProjection   [implemented, 1.1.0]
  graphDefinitionDiff(a, b)       -> GraphDefinitionDiff         [proposed; promoted from Inbox]
          │
          ▼
mission-pipeline-graphpaper (SDK, peer-depends on both; no DOM in core)
  core:    buildPipelineDiagram, validatePresentation, buildProposalDiagram, legends
  server:  renderPipelineFigure (SSR with an injected ELK), viewerAssets
  browser: mountPipelineViewer (hydrate, select, deep link, details seam)
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

### From the engine (proposed)

`GraphDisplayProjection` is a serializable, digest-carrying projection of one
compiled graph. It contains no words a reader sees, only structure:

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
    readonly depth: number;                                  // longest path from entry; cycles: BFS depth
    readonly marks: boolean;                                 // every outcome routes to the same successors, none terminal
  }[];
  readonly arrows: readonly {                                // one per (from, to) pair
    readonly from: string; readonly to: string;
    readonly outcomes: readonly string[]; readonly edgeIds: readonly string[];
    readonly conditional: boolean;                           // any contributing edge has a where arm
    readonly fanOut: readonly { readonly edgeId: string; readonly coTargets: readonly string[] }[];
  }[];
  readonly terminals: readonly TerminalOutcome[];
  readonly joins: readonly { readonly nodeId: string; readonly require: JoinRequirement; readonly inbound: readonly string[] }[];
}
```

`UnitPathProjection` (implemented in `src/store/unit-path.ts`) is the per-run
execution state, derived only from journey records: per-node state
(`pending`, `failed`, `dead`, `settled`; absent means never queued) with every
occurrence, outcomes, edges taken, join progress, open queues, and usage.
`GraphDefinitionDiff` is Inbox's `graphProposalDiff`, promoted unchanged.

### From the consumer

```ts
interface PipelinePresentation {                            // proposed
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

interface NodeDetails {                                     // proposed; returned by an authorized provider
  readonly graph: GraphDefinitionRef; readonly nodeId: string;
  readonly sealed: { ref: MissionPipelineNodeRef; kind: string; input: ContractId; outcomes: readonly string[]; maxAttempts: number; leaseMs: number; binding?: MissionPipelineNodeBindingRef };
  readonly outputs?: readonly { outcome: string; contractId: ContractId }[];
  readonly model?: { name: string; id: string; version: number; providerId?: string; parameters: Readonly<Record<string, string | number>>;
    prompt: { digest: string; systemPrompt: string } | { withheld: string } };
  readonly implementation?: { body: { module: string; symbol: string }; port: { module: string; symbol: string }; dispatch?: string };
  readonly question?: string;
}
```

The model the SDK emits carries `metadata.pipeline`:

```ts
{ schemaVersion: "mission-pipeline-diagram.v1", graph: GraphDefinitionRef,
  mode: "static" | "run" | "metrics" | "proposal", unitId?: string, presentationDigest: string }
```

## Public API (proposed names)

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

// mission-pipeline-graphpaper/server  (Node only)
renderPipelineFigure(model: DiagramModel, options: { layoutEngine: DiagramLayoutEngine; figureId?: string; modelElementId?: string }): Promise<string>;
viewerAssets(): Readonly<Record<string, { contentType: string; body: string; etag: string }>>;   // graphpaper.js, diagram.css, pipeline.css, elk.js, viewer.js

// mission-pipeline-graphpaper/browser  (ES module, no framework)
mountPipelineViewer(container: Element, options: {
  model?: DiagramModel;                                     // default: read the embedded <script type="application/json">
  onSelect?: (pick: { nodeId: string | null; node: DiagramNode | null; source: string }) => void;
  details?: (nodeId: string) => Promise<NodeDetails | undefined>;   // consumer-authorized; the SDK renders what it gets
  deepLink?: { param?: string } | false;                    // default "#node=<id>", replaceState
  legendVisible?: boolean;
}): Promise<{ select(nodeId: string | null): boolean; update(overlay: ExecutionOverlay): Promise<void>; destroy(): void }>;
```

The browser entry re-exports nothing from graphpaper; a consumer that wants
raw graphpaper calls imports graphpaper.

## Illustrative consumer integration (proposed API)

Server side, one request:

```ts
import { compileGraph, projectGraphDisplay, projectUnitPath } from "mission-pipeline";   // proposed exports
import { buildPipelineDiagram, validatePresentation } from "mission-pipeline-graphpaper";
import { renderPipelineFigure } from "mission-pipeline-graphpaper/server";
import { TRIAGE_PRESENTATION } from "./triage-presentation.js";                          // consumer words

const projection = projectGraphDisplay(compileGraph(graph));                            // exact graph the unit pinned
const problems = validatePresentation(projection, TRIAGE_PRESENTATION);
if (problems.length > 0) throw new Error(problems.join("; "));                          // a test also asserts this

const overlay = unit === undefined ? undefined : {
  unit: { unitId: unit.unitId, graph: unit.graph },
  path: projectUnitPath(await store.readJourney({ unitId: unit.unitId })),
  endpointStates: endpointStatesFromOutbox(unit)                                        // consumer: outbox + relay rows
};
const model = buildPipelineDiagram({ projection, presentation: TRIAGE_PRESENTATION, overlay });
const html = await renderPipelineFigure(model, { layoutEngine: new ELK() });          // SVG + inert model JSON
```

Browser side, one module the consumer serves under its own CSP:

```js
import { mountPipelineViewer } from "/pipeline/assets/viewer.js";
const viewer = await mountPipelineViewer(document.getElementById("pipeline-diagram"), {
  details: (nodeId) => fetch(`/api/pipeline/nodes/${encodeURIComponent(nodeId)}?graph=…&version=…&digest=…`)
    .then((response) => (response.ok ? response.json() : undefined)),               // the consumer decides who may read this
  onSelect: ({ nodeId }) => analytics.picked(nodeId)
});
```

The consumer still owns: the route, the authorization on the details
endpoint, the asset paths and CSP, the metrics query, the delivery-state
derivation, and every word in the presentation.

## Rendering rules

**Static graph.** Every node from the projection, typed `code`, `model`,
`human`, `agent`, or `callback`; title from the presentation with the depth
beside it; rows for outcomes (or `marks` when the node marks), model binding
id when present, ref. One arrow per (from, to) pair labelled `always`, the
outcomes, `otherwise`, or a count, with the full list in the popover; the
consumer's arrow groups split a pair into several labelled arrows, and the SDK
throws when a group names an outcome the sealed arrow does not carry. Fan-out
is stated in the arrow description ("the same unit also goes to …"). Joins
render a badge (`join · all` or `join · 2 of 3`) and their inbound arrows wear
`edge-kind-join`. Every declared terminal becomes a dashed exit to a presented
sink; an unpresented terminal is drawn on its own and listed in
`metadata.pipeline.unclaimedTerminals` so it can never disappear.

**Run overlay.** Node status from `UnitPathProjection` only: `settled`,
`pending`, `failed`, `dead`, and `idle` for a node the projection does not
list; subtitle `settled · <outcome>`. An arrow is `flow` when the projection
counts its edge id as taken, which the engine records at settlement, so the
viewer never infers a path from two adjacent states. A sink is `reached` only when the consumer supplied an endpoint
state, or the terminal's source settled that outcome. `awaiting_person` and
`decided` come from the overlay; the SDK never infers them from a human node's
existence.

**Metrics.** Counts appear as rows and badges, scoped to the model's graph
version. A node with `available: false` shows "unavailable: <reason>"; a node
with `allTime === 0` shows "never observed since <firstAdmittedAt>" and its
arrows take the `unobserved` flavor. Zero and unavailable are never the same
word. Family-wide history is not shown on a version-scoped picture.

**Proposal.** `buildProposalDiagram` draws the union of both projections, one
edge per declared edge, every element marked `added`, `removed`, `changed`, or
`unchanged` from the diff. A candidate-only node takes its role from the
candidate projection's kind, so a proposed model node is never drawn as code.
Removed nodes take their words from the current presentation, added ones from
the candidate presentation.

**Historical.** A model whose graph is not the currently published version is
marked with graphpaper's lifecycle badge and watermark (`historical`), and the
consumer's details provider is expected to answer from a frozen snapshot or
return "unavailable", never from the current catalog.

## Identity rules

- Every model carries the exact graph id, version, and digest in
  `metadata.pipeline.graph`.
- `buildPipelineDiagram` refuses an overlay or metrics object whose graph
  identity differs from the projection's, with the two identities in the
  error.
- `mountPipelineViewer` refuses a `NodeDetails` whose `graph` differs from the
  model's and shows "details for this version are unavailable"; a slower
  earlier response never paints over a newer pick.
- Deep links carry the node id; the page that serves the model carries the
  identity. A link to a node the model does not draw selects nothing and
  leaves the URL alone.
- A unit's picture is drawn on the unit's pinned graph, never on the graph a
  URL parameter names. That resolution is the consumer's, as Inbox does it.

## Selection, details, and deep links

Selection is graphpaper's: click, Enter, or Space picks one node; Escape or a
background click clears; re-picking is a no-op. The SDK mirrors the pick into
the URL hash with `replaceState`, opens the details seam if a provider was
given, and calls `onSelect`. The details panel is a sibling of the figure (the
figure is replaced on every hydrate), built with DOM calls, never markup
strings, and rendered from `NodeDetails` fields only. Consumers may replace the
panel entirely by passing `details` and handling `onSelect` themselves.

## Accessibility, responsiveness, large graphs

- Keyboard: graphpaper's `tabindex="0"` on nodes and edges, Enter and Space to
  pick, Escape to clear; the SDK adds a visible focus ring for the selected
  node and keeps the panel focusable and closable by keyboard.
- Reduced motion: graphpaper stops the flow-edge march and animated
  transitions under `prefers-reduced-motion`; the SDK's panel transition
  follows the same query.
- Responsive: the figure carries its natural width and height as CSS
  variables so the page scales it down only on narrow screens; the panel
  becomes a bottom sheet under 680px (Inbox's rule, made default).
- Large graphs: compact nodes, tail-placed edge labels, and one arrow per pair
  keep a dozen-deep graph on one screen. For more, `goals` may optionally
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

- `presentation.arrows` groups and notes; `presentation.nodes[*].rows`.
- `nodeRenderers` pass-through to graphpaper for custom node markup.
- A `classify` hook `(node) => { type?: string; visualGroup?: string }` for
  consumers that want an extra visual class (for instance, `endpoint` versus
  `terminal` sub-kinds), constrained to class tokens.
- The details panel is replaceable; the deep-link scheme is configurable.
- Legends are data; consumers may append entries.

## Compatibility and versioning

- The SDK is semver-versioned separately from the engine and from graphpaper,
  with peer ranges on both. It pins the `schemaVersion` strings it accepts and
  refuses others loudly.
- The `DiagramModel` it emits is part of its public contract: golden model
  fixtures for the support-triage example and for Inbox's frozen graph8
  snapshot are checked in and compared byte for byte, so a rendering change is
  a visible diff.
- CSS class tokens the SDK adds (`node-type-endpoint`, `node-type-terminal`,
  `component-status-settled|pending|failed|dead|reached|idle|added|removed|changed`,
  `edge-kind-outcome|exit|join`, `edge-flavor-unobserved|removed|changed`) are a
  public contract shipped in `pipeline.css` and listed in the README.
- Engine changes that alter `GraphDisplayProjection` or `UnitPathProjection`
  bump their `schemaVersion`; the SDK supports one major of each at a time.

## Test strategy

Contract tests (Node, no browser):

- Coverage: every projection node is drawn with its kind; every sealed edge
  appears in exactly one arrow; every declared outcome is on exactly one arrow
  label or one exit; every terminal lands on exactly one sink; the union of
  arrow groups equals the sealed arrow; unpresented terminals are drawn and
  listed.
- Roles: candidate-only nodes take the candidate kind; removed nodes keep the
  current kind.
- Identity: overlay, metrics, and details with a different graph identity are
  refused; the model's metadata equals the projection's identity.
- State truthfulness: a settled node without a supplied endpoint state is not
  "reached"; a pending human node is `pending`, not `decided`; a terminal
  failure is `dead`; `available: false` renders "unavailable" and `allTime: 0`
  renders "never observed".
- Determinism: the same inputs produce the same model; the model round-trips
  through JSON.
- Golden models for the example graph in every mode.

Browser checks (only when rendering or interaction changes): hydrate the
server figure with elkjs, pick a node by keyboard, follow a deep link, resize
to a narrow viewport, verify the reduced-motion query, and confirm the details
panel refuses a mismatched identity. graphpaper's own fake-DOM tests cover
selection gestures; the SDK's fake-DOM tests cover the wiring. A signed-in
deployed witness remains the consumer's release gate, as Inbox's plan states.

## Extraction and adoption plan

1. **Engine projections** (this repository): `projectUnitPath`, the goal
   manifest, and `projectGoalClosures` shipped in 1.1.0; `projectGraphDisplay`
   and `graphDefinitionDiff` remain, with golden tests over the fixture graphs
   and the support-triage example. Additive.
2. **SDK core**: port `buildPipelineDiagram` from Inbox's `pipeline-diagram.ts`
   onto the projection, keeping its arrow merging, marking detection, partition
   guard, and unclaimed-terminal rules; add `validatePresentation` (the
   example's `presentationCoverage` is the seed). Prove behaviour preservation
   with a golden test: the SDK's model for Inbox's frozen graph8 snapshot
   equals Inbox's current model modulo the new metadata block.
3. **Server and browser adapters**: `renderPipelineFigure`, `viewerAssets`,
   `mountPipelineViewer` with the panel shell and deep links, ported from
   Inbox's figure, hydration script, and panel module.
4. **Inbox adoption**: `pipeline-diagram.ts` becomes a thin call into the SDK
   with Inbox's presentation, endpoint-state derivation, metrics query, and
   details endpoint unchanged; delete the duplicated builder once the golden
   test holds.
5. **Proposal and metrics modes**: `buildProposalDiagram` on the promoted
   diff; `VersionMetrics` from Inbox's version-scoped projection.
6. **Second consumer**: draw the support-triage example graph from this
   repository's fixtures as the SDK's own smoke, proving no Inbox assumption
   leaked into the package.

Steps 1 and 2 can land without any change to a running consumer.

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

## Open questions to settle before implementation

- Package location: a separate repository following graphpaper's packaging is
  recommended, because this repository's release gate pins an exact payload of
  `src`, `lib`, and `schemas` only.
- Whether depth should be computed from the projection's longest path (Inbox)
  or from ELK's layer assignment; the projection carries the former so the
  number is stable across renderers.

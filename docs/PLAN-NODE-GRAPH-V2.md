# PLAN — Building the node-graph engine (v2)

**Status: DRAFT, 2026-08-27.** Executes `DESIGN-NODE-GRAPH-V2.md`.
**Operating stance (operator directive): full development mode.** No
uptime constraint, no data-preservation constraint, no compatibility
obligation to the v1 engine or any data it produced. Legacy execution
surfaces are deleted the moment v2 carries their flows. What is never
relaxed: the security/evidence invariants listed in DESIGN §8.

Phases are sized as arcs and decompose into turn-completable slices at
build time. Each phase names its repo(s), its deliverables, its evidence,
and any operator decision it needs. Cross-repo order of operations:
**engine (mission-pipeline) → store + node bodies (inbox-pipeline) →
intake + console → model path → dev deployment → deletion**.

A standing constraint from mission-pipeline itself: the package imports
`node:` builtins and its own files ONLY (import-boundary test). Everything
touching Postgres, providers, or credentials therefore lives in the
consumer repo, behind ports the package defines.

---

## N0 — Ratification and naming (operator, ~one sitting)

The DESIGN's §10 questions, decided before code:

1. **Names**: `MissionPipelineNode` / `MissionPipelineUnit` / `journey`
   (proposed: keep all three as the operator coined them).
2. **Join semantics**: joins declare `all` or `nOf`; a join that cannot
   complete (an inbound edge's unit went terminal upstream) resolves
   deterministically to a declared `join_unsatisfiable` outcome — which,
   like every outcome, must route or be terminal. No timeouts in v2.0;
   a `callback` timer node composes for time-based escape.
3. **Unit fan-out**: v2.0 turns may NOT emit new units — unit creation is
   admission-only. (One email → N tasks is expressed as one unit whose
   artifact carries N extractions; a later v2.x may lift this.)
4. **Human-queue policy**: no TTL in the engine. Escalation is graph-
   expressible (timer callback node + edge). The console owns ordering.
5. **Outcome evolution**: adding/removing an outcome is a NEW node
   version, full stop; the completeness check re-runs at graph seal.
6. **Fairness at shared nodes**: v2.0 = FIFO per node with per-graph
   round-robin at claim time; anything richer waits for evidence.

Deliverable: DESIGN §10 rewritten as §10 "Decisions", this plan's
assumptions confirmed. Evidence: none (a docs commit).

## N1 — Contracts core: outcomes, edges, graphs (mission-pipeline)

Pure data + validation, no storage, no execution. The v2 analog of B1/B2.

- `src/graph/outcome.ts` — `OutcomeVocabulary` (non-empty, unique,
  versioned with the node ref); LOUD hand-written validators (house
  style: no zod in this package).
- `src/graph/edge.ts` — `Edge {from, when, to[]}` and the predicate
  language, deliberately tiny and closed:
  `{outcome: "x"}` | `{anyOf: [...]}` | `{outcome, where: FieldMatch[]}`
  where `FieldMatch` is `{pointer: RFC6901, equals: json-scalar}` over the
  sealed output artifact. No regex, no ranges, no user code — v2.0 keeps
  routing decidable and diffable; richer predicates need a design rev.
- `src/graph/definition.ts` — `GraphDefinitionDraft {graphId, version,
  description, entry, nodes, edges, terminals}`; canonical-JSON sealed
  `GraphDefinition` with `graphDigest` (same digest rule as everything).
- `src/graph/compile.ts` — `compileGraph`:
  * every node's every declared outcome matches ≥1 edge or appears in
    `terminals` (the completeness check — the load-bearing one);
  * edges reference declared nodes and declared outcomes only;
  * `entry` exists; every node reachable from entry; joins declare
    `all|nOf` and only over their actual inbound edges; `nOf` ≤ inbound;
  * bindings resolve as in v1 (model nodes require a binding ref, code
    nodes forbid one, etc.);
  * output: a frozen `CompiledGraph` with per-node inbound/outbound
    indexes the executor consumes.
- Digest golden vectors for all new sealed shapes.

Evidence: hermetic suite — completeness violations fail sealed with exact
node/outcome named; a fixture graph for every DESIGN diagram shape
(filter chain, router, ladder, human-in-middle, join, shadow) compiles;
adversarial fixtures (unreachable node, uncovered outcome, join over
non-inbound edge, undeclared outcome in an edge) each rejected LOUDLY.
House rule applies: every guard test proves it bites.

## N2 — The turn executor and node-kind ports (mission-pipeline)

Generalize what exists; invent as little as possible.

- `src/execute/turn.ts` — promote `durable-stage.ts` into the node-turn
  executor: idempotency key = digest of `{unitId, nodeId, attemptNumber,
  nodeRef, fingerprint, inputDigest}` (+ `executionIdentityDigest` where
  externally bound, exactly as v1); cached-attempt reuse; bounded
  retries; the retryable-vs-terminal taxonomy verbatim.
- `src/execute/ports.ts` — the five node-kind execution ports the package
  DEFINES and hosts implement:
  * `CodeNodePort` — in-process body (v1 `Stage.run` shape; existing
    stages plug in unmodified).
  * `ModelNodePort` — async body with binding + usage receipt; the
    journal-first discipline stays host-side (as v1).
  * `AgentNodePort` — structural port only in v2.0 (submit turn intent /
    await settled result); MC binding is a consumer concern.
  * `HumanNodePort` — no body. The engine's role is queue + settle; the
    port is `recordDecision(unitId, nodeId, outcome, artifact?, actor)`,
    callable only under the node's principal.
  * `CallbackNodePort` — `admitEvent(unitId, nodeId, outcome, artifact)`,
    same shape, external-event flavored.
- `src/execute/unit-runner.ts` — replaces shard-runner's role: claim ONE
  turn (or a homogeneous batch, N3), execute via the kind port, settle
  atomically (journey append + edge evaluation + successor enqueue +
  outbox), release. Per-DESIGN §3 crash contract: before-commit ⇒ still
  claimably queued here; after ⇒ queued at successors. Nothing between.

Evidence: hermetic suite over the memory store (N3) — the crash-point
property test (kill between every pair of steps, re-run, exactly-once
settle), cached reuse, retry/dead-letter parity with the v1 suites, a
human turn settled via `recordDecision` routing a unit onward, a
callback turn doing the same, batching claims settling per-unit.

## N3 — GraphStore/UnitStore ports + memory implementation (mission-pipeline)

The store contract is the heart; the memory implementation is the
executable spec (v1's memory-store pattern).

- `src/store/graph-store.ts` — publish/load sealed graphs (immutable
  once published; same rule as v1 definitions).
- `src/store/unit-store.ts` — admit unit (seed artifact + graph ref);
  claim turn (lease-fenced, per node, FIFO + per-graph round-robin;
  optional `batch: N` homogeneous claim); settle turn (THE atomic op:
  append TurnRecord + artifact, evaluate compiled edges, enqueue
  successors honoring joins, emit outbox events, release lease — one
  transaction); heartbeat/extend; dead-letter; read journey; list queued
  units at a node (the console's read); join bookkeeping.
- Append-only enforced in the port docs and the memory impl (only leases
  mutate — v1's invariant, restated for journeys).
- `src/store/memory-unit-store.ts` — full in-memory implementation.

Evidence: the N2 suite runs entirely on this; plus store-focused
properties — join `all` and `nOf` firing exactly once, `join_unsatisfiable`
emission when an inbound leg dies, no successor enqueue without journey
append (and vice versa), lease expiry → reclaim → cached-attempt reuse.

## N4 — Postgres store (inbox-pipeline)

Fresh chain, fresh database — the dev-mode directive applied.

- New migration family `sql/postgres-v2/001_…` in inbox-pipeline (the
  1–39 chain is frozen history; it is not extended and nothing is
  imported from databases it built).
- Tables: `graphs` (sealed JSON + digest), `units`, `unit_journey`
  (append-only, trigger-enforced), `unit_queue` (claimable index —
  REBUILDABLE from journeys, and a test proves rebuild equivalence),
  `unit_leases`, `join_progress`, `outbox` (v1 transactional-outbox
  pattern), `dead_letters`.
- Principals, least-authority from day one (this is design, not
  ceremony): `v2_admitter` (admit units, publish graphs), `v2_worker`
  (claim/settle code+model turns; CANNOT settle human-node turns),
  `v2_console` (human-node settle + queue reads ONLY), `v2_callback`
  (callback settle only). Enforced with the house method — routine/table
  grants + a denial suite asserting by role, the way the substrate
  tenancy suites do.
- `PostgresUnitStore` implementing the N3 ports; the disposable-PG gate
  pattern (fresh loopback container, migrate, run, destroy) from day one.

Evidence: the ENTIRE N2/N3 hermetic suite re-run against Postgres (one
suite, two stores — the v1 discipline); role-denial suite (worker cannot
settle a human turn — proven as a 42501-class denial, not absence of a
code path); crash-point test against real transactions; queue-rebuild
equivalence.

## N5 — Node bodies: the email graph, re-expressed (inbox-pipeline)

Port the real processing onto v2 — no new intelligence, new arrangement.

- Wrap the five deterministic v2 code stages (normalize, security,
  route, notifications, jobtrack-proposal) as `code` nodes — bodies
  unmodified, outcome vocabularies DECLARED (e.g. security → `ok |
  hostile`; route’s category verdict becomes a declared outcome set
  instead of an artifact field the next stage sniffs).
- Model classification as a `model` node with the existing binding/
  profile machinery and the journal-first host.
- The hierarchical decision flow re-expressed as a sub-graph: model
  decision nodes chained by outcome edges, review cases as `human`
  nodes — the flagship proof that gate-terminality is gone. The v1
  DecisionRuntime's per-step logic becomes node bodies; its orchestration
  dissolves into edges.
- Author the production graph(s) as sealed definitions: the DESIGN's
  filter chain + outcome router + escalation ladder composed into
  `inbox.email-graph.v1` (v2 engine, graph version 1).
- Golden seeds: reuse existing per-stage golden vectors as node-body
  regression seeds (correctness of bodies, not engine equivalence).

Evidence: memory + Postgres runs of `inbox.email-graph.v1` over the seed
corpus: spam terminates at the filter with nothing downstream; each
declared category routes to its branch; a review case queues at a human
node, `recordDecision` routes it onward; the whole journey reproducible
from seed + graphDigest.

## N6 — Gmail intake as admission (inbox-pipeline)

The operator's intake decision (Gmail API + tokens, no Mac) lands here.

- Admission adapter: `gmail_gog` page port (exists) → seed artifacts →
  `unit-store.admit`, checkpointed per account exactly as the v1 intake
  checkpoint authority does; live-scan (recent) + full-scan (backfill)
  planners drive it as the two Gmail lanes.
- `config/accounts.json` remains the declarative grant registry;
  per-lane narrow tokens via the existing plan/ceremony/status tooling.
- Dev mode: one dev Gmail account/lane is enough to build against;
  fixture source stays first-class for tests.

Operator gates: which account(s), and the per-lane token consents (the
T2 ceremony, four consents outstanding).
Evidence: a real mailbox page admitted end-to-end into the graph on the
dev lane; duplicate-page replay admits zero duplicate units; checkpoint
crash/resume proven.

## N7 — The human console (inbox-pipeline)

The review surface over `human` nodes — deliberately thin in v2.0.

- CLI + dashboard lane: list units queued at human nodes (unit summary,
  the artifact that got it here, the node's outcome choices), decide →
  `recordDecision` under `v2_console`.
- Reuses the existing dashboard door/auth posture; no new exposure.

Evidence: end-to-end through a person: a unit queued at `approve draft?`
decided from the console, journey shows the actor principal, routing
proceeds; a `v2_worker` credential attempting the same settle is denied.

## N8 — Model path onto the substrate (inbox-pipeline ↔ MC, gated)

Two-stage by design, so engine work never waits on MC's P4:

- **Dev binding (immediate)**: `ModelNodePort` host → llama-swap direct
  over the tailnet (the lab's proven caller/guard), throughput-capped;
  acceptable while everything is dev-mode.
- **Production binding (the P4-02 ratification)**: the same host submits
  turns as substrate envelopes via mission-substrate-client (the exact
  pattern the Inbox lab's matrix cells already run live). One port, two
  hosts; the graph never knows.

Operator gate: the MC P4-02 consumer walk ratifies the substrate binding
(this plan's stance: dev = direct, production = substrate, no third path).
Evidence: same node, both hosts, identical journey/artifact digests
modulo usage receipts; substrate leg proves grant/settle round-trip.

## N9 — Dev deployment loop (inbox-pipeline + infra)

Development mode means a fast loop, not a commissioning ceremony.

- One compose stack on the laptop (house pattern): `v2-engine` worker
  process (claims code/model turns), `v2-admitter` intake lane,
  dashboard/console, fresh dedicated Postgres. Autodeploy-enrolled like
  every other stack; DEPLOY_READY probe on a real healthz.
- Engine healthz: units by node, queue depths, human-queue depth, lease
  stats, dead letters — the operational read from day one.
- Formal production commissioning (successor contract family replacing
  B03) is DEFERRED until the operator promotes the project out of
  development; a placeholder doc records what it will need (contracts,
  principals ceremony, service inventory) so nothing is forgotten.

Evidence: push → autodeploy → healthz green → a live email admitted,
classified, routed, one human decision made from the console.

## N10 — Delete the v1 execution surfaces

Dev-mode directive, applied with a blade:

- mission-pipeline: remove shard-runner traversal, gate-terminality
  compile rules, and chaining-era docs; `durable-stage` survives as the
  turn executor's core. Major-version the package (v1 consumers pin old
  SHAs; there are none in production).
- inbox-pipeline: remove the v1 `src/mission/` execution wiring
  (catalog/worker/scheduled lanes for the D3 plane) once
  `inbox.email-graph.v1` covers the flows; stage bodies live on as node
  bodies. The frozen migration chain 1–39 and protected pilot/D7
  evidence stay untouched (historical record, not runtime).

Evidence: both repos' full gates green after deletion; grep-zero for the
deleted surfaces (the house deletion-gate pattern).

---

## Sequencing and parallelism

```
N0 ─► N1 ─► N2 ─► N3 ─► N4 ─► N5 ─► N6 ─► N9 ─► N10
                   │           │      └ N7 (parallel with N6)
                   │           └ N8 dev-binding (parallel with N5 tail)
                   └ N8 substrate-binding waits on MC P4-02 (independent)
```

N1–N3 are one repo, hermetic, and fully parallelizable with the MC P4
work already in flight. The first end-to-end email through a human
decision (the model's proof moment) lands at N7; the first live-deployed
loop at N9.

## Operator decision points (collected)

| Where | Decision |
|-------|----------|
| N0    | §10 ratifications (names, joins, fan-out, TTL, evolution, fairness) |
| N6    | Dev account choice + per-lane token consents |
| N8    | P4-02: substrate as the production model path |
| N9    | When (if ever) to promote out of development → commissioning ceremony |
| N10   | The deletion commit (explicitly irreversible-ish; dev-mode says go) |

## Standing verification discipline

Every phase lands with: hermetic tests on the memory store where
applicable, the same suite against Postgres, bite-proofs for every guard,
role-denial tests asserted per principal, and the repos' full gates. No
phase's evidence is prose-only.

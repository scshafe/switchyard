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

## N0 — Ratification and naming — ✅ RATIFIED 2026-08-27

The operator ratified all six proposals as written; DESIGN §10 is now the
binding decision record (including the join at-most-once / late-arrival
no-op rule made explicit at ratification). Retained below as proposed:

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

Deliverable: DONE — DESIGN §10 rewritten as the ratified decision
record; this plan's assumptions stand confirmed. Next phase: N1.

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

### N1 implementation clarifications (recorded 2026-08-27)

These questions are below the ratified N0 decisions; they do not reopen
DESIGN §10. They were recorded before implementation because the illustrative
shapes above do not determine them completely.

1. **Does an `outcome + where` edge by itself satisfy outcome completeness?**
   Provisional answer: **no**. Its field predicate can be false at runtime, so
   counting it alone would violate the load-bearing rule that no declared
   outcome can fall silently. Every declared outcome must therefore have an
   unconditional `{outcome}` / `{anyOf}` route or be explicitly terminal.
   Declaring an outcome terminal while any edge also mentions it is rejected as
   contradictory (terminal means that completion enqueues no successor).
2. **How does a join name a declared inbound edge when the illustrative `Edge`
   shape has no identity field?** Provisional answer: add a stable,
   author-supplied `edgeId` to `Edge`, and declare a join as
   `{inbound: edgeId[], require: "all" | {nOf}}`. Array indexes, source-node
   IDs, and structural hashes are not stable/unambiguous enough for durable N3
   join progress when multiple predicates share a source. The compiler verifies
   that the declared IDs equal the node's actual inbound-edge set (no unnamed
   offers with undefined join semantics) and emits edge-ID indexes.
3. **May the admission `entry` node itself declare a join?** Provisional
   answer: **no**. Admission queues the new unit at `entry` without an inbound
   edge offer, so allowing a join there would either bypass its declared
   requirement or deadlock. `compileGraph` rejects an entry join; a cycle may
   still route back to an ordinary non-entry join node.
4. **Where is the binding decision that one `(node ref id, version)` always
   names one node definition enforced?** The definition-bound signature is
   `{kind, input contract, outcome set}`; `nodeId`, principal, binding, turn,
   and join are graph-instance configuration. N1 rejects inconsistent reuse of
   a ref/version inside one graph. Cross-graph comparison is necessarily
   stateful, so the N3 graph-publication store must atomically remember the
   first definition-bound signature for each ref/version and reject any later
   publish whose signature differs. The same store-conformance test must run
   against Postgres in N4. This is enforcement of DESIGN §10.5, not a soft
   evolution path; changing the outcome set always requires a new node version.

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

### N2 implementation clarifications (recorded 2026-08-27)

These answers are below N0 and do not reopen its binding decisions. They make
the execution/store seam precise enough to implement N2 before N3.

1. **How are retries distinguished from a later visit to the same node when
   cycles are legal?** Each durable queued occurrence has an opaque `queueId`.
   `attemptNumber` is allocated monotonically for `(unitId, nodeId)` across the
   whole journey and remains part of the binding N2 digest. A separate
   `attemptIndex` counts `1..maxAttempts` for this `queueId`; the retry budget
   never compares the global `attemptNumber` directly with `maxAttempts`.
2. **What is the node execution fingerprint?** It is exactly the v1 shape
   adapted to a v2 binding ref:
   `digest({bindingFingerprint: node.binding?.bindingDigest ?? "none",
   configurationFingerprint: "default"})`. The versioned `nodeRef` is already
   a separate idempotency-key component; principal, lease policy, join, and
   routing do not silently alter a physical attempt's identity.
3. **How can N2 compile before N3 owns `UnitStore`?** N2 declares narrow
   structural `WorkerTurnRunnerStore` and `ExternalTurnRunnerStore`
   capabilities (plus their combined `TurnRunnerStore`) for claim,
   prepare/recover, failed-attempt evidence where applicable, and the single
   atomic settle call. N3's `UnitStore` extends and implements them. N2 lands
   hostile fake-protocol evidence now; the phase's
   named memory-store/crash evidence becomes complete when the same suite runs
   through `MemoryUnitStore` in N3, and then through Postgres in N4.
4. **What flows onward when a completion omits `outputArtifact`?** The journey
   records no new output artifact and an unconditional routed offer carries the
   already-validated turn input. If an output artifact is present, that artifact
   is carried instead. A conditional `where` predicate still means exactly
   what DESIGN says—fields of the *output* artifact—so it does not match when
   no output artifact was produced. N3 settlement checks the effective carried
   artifact against each matched target's input contract inside the atomic
   transaction; no implicit coercion is permitted.
5. **Which artifact does a multi-offer join body receive?** Deferred explicitly
   to N3: the store supplies one already-resolved, digest-sealed turn input to
   N2. N3 must record a deterministic composition/provenance rule before its
   join implementation lands; the runner does not choose an inbound winner.
6. **May a node body return `join_unsatisfiable`?** No. It is an engine-reserved
   outcome synthesized only by join bookkeeping when declared inbound progress
   becomes impossible. N3 must record the reserved engine principal and
   timestamps used for that synthetic journey entry before implementation.
7. **How are agent turns with multiple provider receipts represented?** N2
   preserves the receipt collection; it never silently chooses or adds receipts.
   Model completions contain exactly one receipt, code/human/callback none, and
   agent completions may contain the ordered validated collection reported by
   their host. N3 will make `TurnRecord.usage` an ordered collection (the
   DESIGN §2.2 shape is illustrative) while the outbox retains one evidence
   event per receipt. Cached reuse produces neither a new invocation nor new
   receipt evidence.
8. **Where is routing evaluated?** The runner never accepts or computes
   worker-authored successors. Its sole success mutation is
   `settleTurn({queueId, leaseToken, completion, outboxEvents})`; the store
   re-evaluates the unit's sealed graph and effective artifact inside the same
   transaction that appends the journey, records the artifact, advances joins,
   queues successors, appends outbox rows, and releases the lease. An unknown
   or malformed response after that call is settlement uncertainty, never a
   failure/dead-letter append.
9. **What is the normative attempt state machine?** `prepareTurnAttempt`
   reserves one attempt for one `queueId`; reclaiming an unresolved reservation
   returns the exact same `attemptNumber`, `attemptIndex`, and idempotency key.
   From that reservation, exactly one of `cacheTurnCompletion` or
   `recordTurnFailure` may be created, and a contradictory repeat fails loudly.
   A nonterminal failed-attempt append is the only transition that advances to
   a new reservation: its queue-local `attemptIndex` increments exactly once,
   while its newly allocated global `(unitId, nodeId)` `attemptNumber` is
   strictly greater and may skip values allocated concurrently to another
   queued occurrence. A cached completion can transition only through
   `settleTurn`, which requires its exact completion and digest. A terminal
   preparation means the terminal failure and dead letter are already durable;
   it is not permission to execute or settle.
10. **What authority does `cacheTurnCompletion` have?** None over the unit's
    durable graph position. It may retain only the attempt's recovery bytes and
    exact conflict seal. It cannot append journey evidence, publish an output
    artifact, evaluate an edge, change queue or join state, append an outbox
    event, or release a lease. Only `settleTurn` makes a successful completion
    visible and advances graph position.
11. **What does a terminal execution failure terminate?** Only the queued
    occurrence identified by `queueId`, including its lane. In one transaction
    the store appends the failed-attempt evidence and dead letter, releases that
    occurrence's lease, makes only that occurrence's outbound offers
    impossible, and updates the affected joins. If those impossible offers make
    a declared join unsatisfiable, the store synthesizes its declared
    `join_unsatisfiable` outcome under the recorded engine principal and time.
    Other queued occurrences for the unit remain live; terminal failure does
    not cancel the unit or kill its other queues.
12. **How do external completions recover and validate?** A human or callback
    retry that exactly matches an already committed settlement—queue
    coordinates, authenticated principal, actor attribution, outcome,
    artifact, and exact outbox-event digest batch—returns that prior settlement
    instead of reporting "not queued". Any conflicting retry fails loudly.
    The read-only inspection metadata is retained for already-settled
    occurrences as well as queued ones so a response-loss retry can validate
    before reaching the settled-recovery claim arm. Before acquiring a
    completion lease, the adapter validates that sealed snapshot's exact
    unit/node coordinates, node kind, principal, outcome, artifact, and outbox
    batch; invalid input never claims the occurrence. External decisions/events
    settle their reserved attempt directly rather than entering the worker body
    cache. Actor attribution remains evidence and never substitutes for the
    authenticated principal.
13. **Does lease heartbeat introduce a timeout?** No. A heartbeat only extends
    the short-lived fenced lease used to coordinate an executing body. Its
    failure cannot become a node outcome, route an edge, resolve a join, or
    expire a human queue. The engine has no semantic timeout: delays and
    escalation remain graph-authored callback timer nodes under N0.

## N3 — GraphStore/UnitStore ports + memory implementation (mission-pipeline) ✅ COMPLETE 2026-08-27

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

### N3 implementation clarifications (recorded 2026-08-27)

These rules close the two questions deliberately deferred by N2 and the
occurrence-level details needed to make the memory store an unambiguous N4
specification. They are below N0 and do not reopen its binding decisions.

1. **What exactly counts as one join offer, including when cycles revisit a
   source node?** Join progress is per `(unitId, joinNodeId, inboundEdgeId)`.
   The first predicate-matching completion offers that edge; later duplicate
   or cyclic matches are append-only no-op evidence. An unmatched/terminal
   source occurrence does not prematurely kill the edge while another live
   occurrence can still offer it. After each atomic routing projection, a
   still-pending edge becomes impossible only when no unresolved queue
   occurrence has a structural graph path (including a zero-length path) to
   that edge's source node. This conservative liveness rule accounts for
   already-queued duplicates and possible cycle revisits without predicting a
   future outcome. The threshold counts distinct offered edge IDs, never turn
   count; once offered or impossible, an edge never changes state.
2. **Which artifact does the fired join receive?** All still-pending matched
   offers from one source settlement are applied in the sealed
   `join.inbound` order before any impossible resolutions from that same
   settlement. Once the requirement is met, the queued occurrence receives
   the artifact carried by the earliest accepted edge in that sealed order.
   The store validates every accepted artifact against the join node's input
   contract and seals the complete accepted-offer provenance (edge ID,
   source occurrence/evidence identity, artifact ref, and authored order) on
   the queue/journey evidence. Thus arrival order is durable evidence, while
   the selected input is deterministic for the accepted set. The join queues
   at most once; every later offer is an explicit journey-recorded no-op.
3. **Who and when synthesize `join_unsatisfiable`, and what can it route?** The
   reserved principal is `mission_pipeline.engine`; graph compilation rejects
   that principal on authored nodes. The synthetic journey outcome has no
   actor, body invocation, lease, cache row, attempt, or usage. Its effective
   time is exactly the canonical `failedAt`/`settledAt` of the causal durable
   event (both synthetic start and settle timestamps use that value), never a
   second wall-clock read. It emits a digest-sealed
   `mission-pipeline.join-unsatisfiable.v1` artifact containing the graph/unit,
   join requirement, accepted/impossible edge provenance, cause evidence
   digest, and resolution time. An authored successor of the unsatisfiable
   outcome must therefore declare that exact input contract; ordinary target
   contract validation remains atomic and LOUD. This handles both zero-offer
   and partial-offer unsatisfiability without privileging an unrelated seed or
   falsely labeling engine data as an application contract. `compileGraph`
   rejects a routed `join_unsatisfiable` target whose input is not that
   reserved contract, so the guard bites before publication as well as at the
   atomic store boundary.
4. **Can one completion enqueue the same ordinary target multiple times?** No.
   For a non-join target, all matched edge IDs from one source settlement are
   retained as provenance but create one queue occurrence for that target.
   Distinct later source settlements may create later occurrences. Join
   targets still count each distinct declared inbound edge independently.
5. **What are the transaction crash checkpoints?** The conformance driver
   names stable logical checkpoints after journey append, artifact retention,
   edge evaluation, join progress, successor queue projection, outbox append,
   and lease release, plus a post-commit reply-loss arm. A fault before commit
   exposes none of those staged writes; replay sees the source occurrence and
   its exact cached attempt. A fault after commit recovers the one settlement
   and its complete successor set. These names are test-driver hooks, not
   separately committable production operations.
6. **How is the round-robin cursor initialized and scoped?** A shared queue key
   is `(nodeId, nodeRef.id, nodeRef.version)`; the sealed graph ref is the lane.
   With no cursor, claim chooses the eligible lane with the oldest FIFO head
   (graph-ref lexical order breaks an exact sequence tie). Thereafter it picks
   the next eligible lane in stable graph-ref order after the last served lane.
   A homogeneous batch takes up to `N` FIFO occurrences from only that chosen
   graph/node lane, as the N2 runner requires. The last-served cursor is
   mutable short-lived claim coordination like a lease, never journey or
   evidence; changing it cannot alter durable unit position.

### N3 executable evidence (2026-08-27)

- `npm test` — 344 passed, 0 failed. This includes the complete N1/N2 suite,
  N3 publication/store/routing coverage, and every guard's prove-it-bites case.
- `node --test test/mission-pipeline-graph-store.test.mjs test/mission-pipeline-memory-unit-store.test.mjs test/mission-pipeline-store-routing.test.mjs`
  — 51 passed, 0 failed: 10 GraphStore cases, 34 MemoryUnitStore cases, and 7
  pure routing/join-arithmetic cases.
- The reusable `registerUnitStoreConformanceTests` contract contributes 33 of
  those memory cases: 25 backend-neutral scenarios plus one property case for
  each of the eight settle checkpoints. Every pre-commit crash exposes neither
  side of the position change; post-commit reply loss replays one settlement
  and the complete successor set.
- `node --test test/mission-pipeline-node-ports.test.mjs test/mission-pipeline-node-turn.test.mjs`
  — 65 passed, 0 failed against the N2 boundary.
- `npm run check`, `npm run verify`, and `npm run test:fresh-clone` — release
  payload, reproducible artifact, clean install, generated-output parity, and
  fresh-clone gates all passed at the phase boundary.

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

### N4 implementation clarifications (recorded 2026-08-28)

1. **How can the N3 engine package be consumed by Inbox's frozen Node 22
   runtime when Mission Control tests it on Node 24?** The implementation is
   compatible with both supported estate runtimes: the engine's complete 344-
   test suite passes under Node 22.23.2 as well as Node 24.18.0. Its package
   range is therefore the explicit disjunction `>=22.22.0 <23 || >=24.18.0
   <25`, and CI runs `verify` on both minimum versions. Inbox keeps its exact
   Node 22 contract; Mission Control keeps its exact Node 24 contract. Node 23
   remains unsupported rather than becoming an untested accidental promise.
2. **How is arbitrary sealed JSON represented without weakening the existing
   digest rule?** Artifact envelopes, graph definitions, unit definitions,
   journey records, queue records, join progress, outbox records, and dead
   letters are stored as bounded C-collated canonical-JSON `TEXT`. PostgreSQL
   `jsonb` cannot represent the otherwise valid JSON string escape `\u0000`;
   converting provider content to `jsonb` would therefore narrow the engine's
   hostile-content boundary. Typed relational columns and bounded `jsonb`
   metadata remain the query/constraint projection. The adapter validates
   canonical form and every seal both before persistence and after hydration.
3. **May a caller-supplied principal select database credentials?** No. A
   production `PostgresUnitStore` instance owns one pool already authenticated
   as exactly one startup-bound principal and checks `current_user` on each
   checkout. Principal IDs in port inputs are authorization assertions, never
   credential-routing input. The conformance-only composite delegates to four
   independently authenticated stores so the unchanged package suite can
   exercise all roles without introducing that authority pattern into runtime
   composition.
4. **What is the PostgreSQL settle and retry boundary?** Admission, claims,
   external inspection/claim, attempt preparation, failure recording, and
   settlement hydrate package state inside a `SERIALIZABLE` transaction and
   apply one normalized delta. Settlement retains the N3 boundary as one
   transaction: journey append, artifact retention, deterministic edge
   evaluation, join progress, successor enqueue, outbox append, and lease
   release commit together. A pre-commit `40001` retries the whole transaction
   with the original logical timestamp; no sub-step is retried, and no retry is
   attempted after COMMIT or simulated post-commit reply loss.
5. **What is the authoritative input for rebuilding the claimable queue?**
   Every queue insertion has an append-only `journey_queue_effects` row linked
   to its source journey sequence and digest. `unit_queue` is the mutable
   claimable projection of those effects. Only the owner maintenance authority
   may rebuild it, and only with zero active leases; runtime principals receive
   a real `42501`. Rebuild restores every physical queue column byte-for-byte,
   including terminal source occurrences retained as journey-position
   evidence.
6. **How are queue visibility and turn-kind authority separated?** A queue read
   is scoped by the store's sealed principal and requested node; it does not
   infer that a principal name is a node kind. Mutating routines independently
   enforce the graph node kind and capability role: workers handle code,
   model, and agent turns; the console handles human turns; callbacks handle
   callback turns; and the admitter alone publishes/adopts graphs and admits
   units. This keeps visibility policy from becoming an accidental settlement
   grant.

### N4 executable evidence (2026-08-28)

- In `mission-pipeline`, `npm run check` passed under Node 22.23.2 and
  Node 24.18.0: 351 passed and 0 failed on each runtime. The release payload
  contained exactly 150 files, and both runtimes produced the same package
  artifact SHA-256,
  `525d70d78c7dbe96dbb8a8a0ae7f3078d2cee3de095fb1c4d6ae8ce901eb00d8`.
- In `inbox-pipeline`, the exact phase gate
  `pnpm build && pnpm check && pnpm test && pnpm demo && pnpm test:postgres:disposable`
  exited 0 as one uninterrupted command. The hermetic suite reported 1,271 tests total:
  1,228 passed, 43 intentionally skipped, and 0 failed. The demo processed
  both fixture messages. The disposable command then passed the frozen-v1
  database gate followed by the fresh-v2 PostgreSQL 18 gate.
- PostgreSQL 18 applied only fresh v2 migrations `[1, 2]`; immediate replay
  applied none and remained at version 2. The exact migration checksums were
  `00994a175a97746c9aefb8156ab612153709128c178e59835ed58040d6276eaf`
  and `150a8b011e627ba372da049b48678257802feccc8b85baf7beb82d9fe9d41217`.
  The frozen v1 1–39 family was neither extended nor imported.
- `node --test --test-concurrency=1 dist/test/postgres-v2-*.test.js` reported
  72 passed, 0 failed, and 0 skipped. Its live shared-store portion used 46
  pristine per-case databases: 10 `GraphStore` cases and 36
  `PostgresUnitStore` cases.
- The 36 live unit-store cases include the unchanged 33-case N2/N3
  conformance contract (25 backend-neutral cases plus all eight named settle
  checkpoint scenarios) and dedicated hostile-content, authority, and rebuild
  proofs. Every pre-commit crash recovered with the unit claimable at its
  source or fully queued at its successors; post-commit reply loss recovered
  exactly one settlement and the complete successor set.
- The actual `v2_worker` principal received SQLSTATE `42501` when attempting
  to settle a human turn. Owner-only reconstruction restored every physical
  queue column byte-for-byte while runtime rebuild authority was denied
  without residue. A digest-sealed artifact containing U+0000 round-tripped
  through canonical-JSON `TEXT` exactly.

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

### N5 implementation clarification (recorded 2026-08-28)

**Where does the graph's required `spam` filter outcome come from when none
of the five frozen v2 code bodies classifies spam?** Answer used for N5: the
`filter` node wraps the unchanged normalize body and derives only its routing
outcome from provider evidence already present on the admitted seed. An exact
provider label of `SPAM` (compared case-insensitively) yields `spam`; otherwise
it yields `clean`. This adds no content heuristic and calls no provider. A
future content-derived spam rule is new intelligence and therefore requires a
new node version and graph digest. The `spam` outcome is explicitly terminal;
`clean` alone routes to security.

**What constitutes journal-first execution for the action-model nodes?** The
engine's durable turn-attempt reservation is necessary but is not the physical
provider-dispatch journal retained by the v1 host pattern. N5 therefore adds an
independent, append-only provider-attempt admission to the consumer's fresh v2
PostgreSQL chain (`sql/postgres-v2/003...`). The exact profile/model capacity
fence encloses that admission and `classifyWithEvidence`, in that order, so
capacity rejection happens before the journal and invents no usage. An exact
existing admission refuses a second physical call and records a non-success,
indeterminate turn with one tier-ceiling usage receipt because the earlier
provider effect may have occurred. The provider returns output and its real
usage receipt as one attempt-scoped value. Outside that recovery case, a
deliberately explicit `telemetry: unavailable` legacy arm is the only normal
post-provider path allowed to charge the published tier ceiling; an ordinary
pre-provider rejection invents no usage.

**Does the engine turn-attempt reservation satisfy classification's existing
journal-first requirement?** No. It proves engine execution identity, not the
physical provider boundary. N5 adds the parallel fresh-v2 classification
journal in `sql/postgres-v2/004...`; its capacity fence likewise encloses
durable admission and provider I/O. Across the corpus this produces 16 retained
classification admissions and 34 retained action admissions. Both journals
use the actual `v2_worker` principal, refuse conflicting or replayed physical
dispatch, and preserve one conservative receipt when a committed admission has
no known provider result.

**Where did the action flow's per-tier retry limits go when DecisionRuntime
orchestration dissolved?** Into the sealed node definitions. Deterministic and
validator nodes retain one attempt, Qwen recall/precision retain two each, and
the Mistral arbiter retains one. A generic worker default is not allowed to
widen the frozen decision budget.

**Where are action-model token and cost ceilings enforced after the historical
DecisionRuntime dissolves?** N5 transfers retry authority into each sealed
node's `maxAttempts` and guarantees receipt retention at the physical-call
boundary; it does not promote the historical DecisionRuntime budget ledger
into generic graph-engine policy. The N8 host must enforce the exact
binding/profile request limits, concurrency/capacity fence, and any token or
paid-spend admission policy before fresh-v2 provider-attempt admission and
provider I/O. A post-call policy violation must still retain the actual
validated receipt and terminalize without repeating the physical call. For an
admitted attempt whose result is unknown, the frozen usage-receipt contract
forbids silent zero accounting: the local tiers' conservative fallback
therefore charges the 2,048-token ceiling and a 1 micro-USD accounting floor.
That floor is neither observed cost nor paid-provider authority and does not
revise the current local tier's zero-cost policy. Introducing a paid provider,
a different ceiling, or different enforcement semantics requires a new exact
binding/profile, a new node version and graph digest, plus N8 prove-it-bites
evidence that denial occurs before journal/provider dispatch and that
already-incurred usage is never discarded.

**Why are the action node refs version 3 while the frozen action-pilot v2
handlers remain unchanged?** The graph adapter adds a durable
`action-decision-graph-state.v1` envelope that seals both source authority and
`inputArtifactId`, revalidates them on every turn, projects wall-clock duration
out of content identity, and carries provider receipts on the turn sidecar.
Those are executable node-boundary semantics, so they require new node
versions and a newly sealed graph even though the underlying v2 decision logic
is reused byte-for-byte.

**How do JobTrack and notification effects remain atomic without importing the
frozen v1 database chain?** The consumer maps exact successful node artifacts
to strict v2 source-outbox events before `settleTurn`. Those source events commit
in the engine's one settlement transaction with journey, artifact, routing,
successor queues, and lease release. Their payloads pin the existing proposal
event metadata and dedupe identity for a later delivery adapter; they grant no
automatic JobTrack transition or mail-send authority.

### N5 executable evidence (2026-08-28)

- In `inbox-pipeline`, the exact phase gate
  `pnpm build && pnpm check && pnpm test && pnpm demo && pnpm test:postgres:disposable`
  exited 0 as one uninterrupted command. The hermetic suite reported 1,348
  tests across 203 suites: 1,302 passed, 46 intentionally skipped, and 0 failed
  or cancelled. The demo processed both fixture messages. The same command then
  passed the frozen-v1 schema-39 disposable gate and the fresh-v2 PostgreSQL 18
  gate.
- The sealed `inbox.email-graph.v1` definition has digest
  `b795469f86890a27ef88e60bac9577ab7915ad58345c55c403e714ee10b96f27`:
  16 nodes, 23 outcome edges, nine explicit terminal node/outcome pairs, and 43
  exact output-contract bindings. Eight checked-in legacy vectors (all six eval
  cases plus both fixture messages) traverse all five unchanged deterministic
  bodies with canonical payload-byte, digest, contract, and size parity; the
  six eval vectors additionally pin exact risk, ordered flags, and category.
- The memory executable-spec run completed 17 seeded journeys and 164 settled
  turns. It retained one receipt for each of 50 model turns, proved 50 journal
  admissions immediately precede their exact 50 provider calls, emitted 52
  atomic source-outbox records, and reproduced all 17 sealed journey digests.
  Spam stopped at `filter/spam`; all six deterministic and seven declared model
  categories routed; hostile and defensive paths traversed real human queues.
  Wrong, foreign, and cross-unit human approvals were rejected before journey
  mutation while their queues remained intact.
- The identical corpus and the complete N2/N3 conformance contract then ran
  against PostgreSQL: 19/19 pristine tests plus 82/82 stateful tests, 101/101
  total. Canonical journey and outbox evidence was byte-identical to memory;
  the provider boundary retained 16 classification and 34 action admissions.
  All eight named settle crash points recovered exactly once with the unit at
  its source or complete successors, never between.
- Fresh-v2 migrations `[1, 2, 3, 4]` applied once, replayed with none newly
  applied, and sealed ledger summary `1:4:4:4:4`. Migration 003 has checksum
  `faa0eed2b9c4271572423e01f7688ec6801c3a1f4ce0b6d012286c8df04f405d`;
  migration 004 has checksum
  `2d931724bbb32b87ae432419a68c16d0898ac96684f22ee1a513157f56a6dbfb`.
  Actual `v2_worker`, `v2_console`, and `v2_callback` principals received real
  SQLSTATE `42501` denials outside their authority; owner mutation of both
  append-only journals received `55000`; conflicting replay received `23505`.
  The frozen v1 1–39 chain and fresh-v2 migrations 001–002 remained byte-for-byte
  unchanged.
- In `mission-pipeline`, `npm run check` passed with 351/351 source tests, both
  packed-install smokes, and the exact 150-file release payload. The packed
  `mission-pipeline-0.2.0.tgz` artifact SHA-256 remained
  `525d70d78c7dbe96dbb8a8a0ae7f3078d2cee3de095fb1c4d6ae8ce901eb00d8`.

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

Operator gates: resolved 2026-08-28 for the development slice —
`owner@example.com`, with per-lane consent approved. Generated live status
showed all four declared grants exact and zero undeclared grants, so no OAuth
rotation was needed; N6 uses only the active readonly grant and leaves send
inactive.
Evidence: a real mailbox page admitted end-to-end into the graph on the
dev lane; duplicate-page replay admits zero duplicate units; checkpoint
crash/resume proven.

### N6 implementation clarification (recorded 2026-08-28)

**What is the unit identity when the intentional one-second live overlap, or
live and historical scans, observe the same immutable email revision?** The
unit identity excludes scan, lane, and observation time. It seals the exact
graph reference, provider/account/message identity, and `ingested-email.v2`
seed artifact reference. The admission adapter looks up an existing unit and
reuses its retained `admittedAt` when calling `UnitStore.admitUnit`, making the
overlap an exact replay; a changed seed artifact is a distinct revision/unit.

**What commits with the lane checkpoint?** PostgreSQL initializes a sealed
per-account/per-lane plan before the provider read. A live lane first commits
its sealed window opening; for each returned page, one `SERIALIZABLE`
transaction checks the predecessor, applies every admission via the N3 memory
state machine and N4 normalized delta routine, appends the exact page-to-unit
receipts, and advances the append-only plan checkpoint. A pre-commit crash
exposes none of the page's units or successor checkpoint; a post-commit reply
loss replays the retained transition and admits zero new units. The frozen v1
chain remains untouched.

**May a page checkpoint advance past a deferred or quarantined content
hydration?** Implemented answer: **no**. N6 has no graph-authored hydration
retry or terminal node, so dropping that message while advancing the provider
cursor would make it unreachable. Every member of a checkpointed page must
have complete processing-input evidence; otherwise the whole page is rejected
before unit admission and the provider position remains retryable. A future
hydration lane must be an explicit graph/version change, not a hidden intake
timeout or side queue.

**How does the rolling live lane persist opening its next bounded window?**
Implemented answer: as an explicit append-only `live_window_opened` plan
transition, not as an ephemeral object and not as a synthetic provider page.
The transition seals the closed predecessor, next plan, start/end cutoffs,
query, and scan identity under `v2_admitter`; it must commit before the first
provider read in that window. Page transitions and window-open transitions
share the same per-plan predecessor fork fence, so a restart can resume the
opened window and a closed window can have at most one durable successor.

### N6 executable evidence (2026-08-28)

- The generated credential-edge status command exited zero with four declared
  grants exact and zero undeclared grants. The approved
  `owner@example.com` readonly lane was active; its send lane remained
  inactive. No OAuth rotation or send authorization was performed.
- The memory/account executable-spec slice passed 24/24 tests. It covers
  historical backfill, two reconstructed rolling live windows with the
  intentional one-second overlap, fixture/source parity, cross-lane immutable
  revision replay, closed account/bucket/scope/selector authority, whole-page
  rejection for incomplete hydration, exact replay, and all four pre-commit
  page crash points plus post-commit reply loss.
- A fresh PostgreSQL 18 instance passed the N6 intake suite 11/11 under the
  actual roles. Backend termination at both live-window commit sides and all
  five page transaction checkpoints recovered with the complete page, seed
  artifacts, entry queues, and admission journeys present exactly once or all
  absent. Direct runtime relation access and cross-principal routines returned
  real SQLSTATE `42501`; owner update/delete/truncate attempts returned
  `55000`. The same-transaction admitted-time/XID adversary returned `23514`
  and proved that exact guard bites independently.
- Fresh-v2 migration 005 is
  `17547ef213bfa4a47866759f5d23888d9f323653e1509969dd14638c58f9f1e5`;
  its manifest matched and migrations 001–004 remained byte-identical. The
  full fresh-v2 disposable gate passed 19/19 pristine corpus tests plus 94/94
  stateful/authority tests across 13 suites.
- The approved isolated real-mailbox proof admitted one inbox page/message to
  one unit queued at `filter`. Its exact replay created zero transitions and
  zero units and replayed the one retained unit. Graph, page, manifest,
  transition, and successor-plan digests were
  `b795469f86890a27ef88e60bac9577ab7915ad58345c55c403e714ee10b96f27`,
  `8c2cc08f05d34f726bed06013048626a73225d034637618c77531bc40901bb50`,
  `9102c32baca6540559c8c98916d8999d3d8848286b14834cac81fca980f83fc0`,
  `811485e1ba84cf0b7d468fe228dc62a11d434b88d3d708909b1b3a4dc60110c4`,
  and `09c5a0e6fd6cf3aa05e7d6c411015a284b19bce1800a40e95d0468877b138786`.
  The container mounted five readonly-lane credential files and no send
  credential, exposed no provider content/identifier, left the five selected
  source files byte-identical and the complete credential tree at 15 files / 4
  directories, and removed every temporary root.
- The exact consumer phase gate
  `pnpm build && pnpm check && pnpm test && pnpm demo && pnpm test:postgres:disposable`
  exited zero. The general corpus was 1,327 pass / 47 expected environment
  skips / 0 fail from 1,374 tests; the demo processed both fixtures; the frozen
  v1 disposable harness was 156/156 across 28 summary runs; fresh-v2 was
  113/113 (19 pristine + 94 remaining).

## N7 — The human console (inbox-pipeline)

The review surface over `human` nodes — deliberately thin in v2.0.

- CLI + dashboard lane: list units queued at human nodes (unit summary,
  the artifact that got it here, the node's outcome choices), decide →
  `recordDecision` under `v2_console`.
- Reuses the existing dashboard door/auth posture; no new exposure.

Evidence: end-to-end through a person: a unit queued at `approve draft?`
decided from the console, journey shows the actor principal, routing
proceeds; a `v2_worker` credential attempting the same settle is denied.

### N7 implementation clarifications (2026-08-28)

Two host-level questions are not engine-semantic changes and do not reopen
N0:

1. **What graph supplies the literal `approve draft?` evidence?** The sealed
   Inbox Email graph published in N5 has `action-context-review` and
   `action-validation-review`, not a draft-approval node. Provisional answer:
   the N7 end-to-end proof publishes a dedicated consumer fixture expressing
   N1's ratified human-in-the-middle shape (`draft` -> `approve-draft` ->
   `publish`). It exercises the same v2 store, console principal, decision
   executor, journey, and successor routing without changing the N5 production
   graph or its outcome vocabulary.
2. **Where does browser/CLI actor attribution come from?** The existing Inbox
   dashboard relies on its external Pocket ID/oauth2-proxy door and network
   boundary; its application currently uses the forwarded email only as
   chrome. Provisional answer: keep authority exclusively in the server-held
   `v2_console` database principal, accept door-provided identity only from the
   configured exact non-loopback proxy lane and exact HTTPS browser origin for
   browser attribution, and accept bounded explicit attribution only from the
   loopback CLI lane with a server-owned loopback-literal Host. Neither actor
   string is authority. Both clients use the same HTTP decision endpoint; the
   CLI never receives a database credential. Host/Origin checks and the
   prohibition on loopback trusted-proxy peers prevent DNS rebinding from
   entering either lane.

### N7 phase evidence (2026-08-28)

- Consumer commits `b41d4b6`, `bc86e19`, and `86b087e` add fresh-v2 migration
  `006`, the database-built safe projection, the isolated `v2_console`
  executor, one HTTP controller shared by the CLI and existing dashboard, and
  the architecture/security/operator documentation. Migration `006` is pinned
  at
  `0e61fd57924f8e448175a1d406f4d8a4e47ac9d13ea9e1239de79a28655ebe80`.
- The hermetic console suite passed 2/2. It proves FIFO safe list/detail,
  hostile-content exclusion, strict DTO rejection, exact coordinate/outcome/
  view-digest guards with zero journey/queue/outbox/dead-letter mutation,
  browser Origin and HMAC-CSRF rejection, DNS-rebinding rejection (`421`) with
  zero mutation, exact settlement replay, conflicting replay rejection, the
  shipped CLI subprocess list/show/decide path, and dashboard routing.
- The fresh PostgreSQL proof publishes the dedicated
  `draft -> approve-draft -> publish` graph, exercises both unknown-contract
  sealed identity and a known-contract bounded summary containing hostile extra
  fields, records `owner@example.com` as actor under the actual `v2_console`
  principal, and executes `publish`. An actual `v2_worker` connection receives
  SQLSTATE `42501` both when calling the review list routine and when substituted
  for final human settlement; the denied settlement leaves no human journey
  record.
- The checksum/static guard suite passed 14/14, including mutation-based
  prove-it-bites checks for the human-node fence, FIFO order, unknown-contract
  seal, known-contract allowlist, console session capability, settled-detail
  status, raw-envelope exclusion, and leaked worker EXECUTE authority.
- The exact consumer phase gate
  `pnpm build && pnpm check && pnpm test && pnpm demo && pnpm test:postgres:disposable`
  exited zero. The general corpus was 1,330 pass / 48 expected environment
  skips / 0 fail from 1,378 tests; the demo processed both fixtures; the frozen
  v1 disposable harness remained 156/156 across 28 summary runs; fresh v2 was
  115/115 (19 pristine + 96 stateful/authority tests).
- No laptop stack, live graph/database, credential, or door configuration was
  changed. The additive console remains dark until N9's first-live-enrollment
  approval.

## N8 — Model path onto the substrate (inbox-pipeline ↔ MC, gated)

Two-stage by design, so engine work never waits on MC's P4:

- **Dev binding (immediate)**: `ModelNodePort` host → llama-swap direct
  over the tailnet (the lab's proven caller/guard), throughput-capped;
  acceptable while everything is dev-mode. The N5 classification boundary
  exports a raw exact-catalog resolver for this host; N8 must bind its fresh-v2
  capacity port around that resolver and must not compose the frozen-v1
  `createInboxMissionCatalogModelResolver` attempt executor (which would
  double-fence and require the historical database).
- **Production binding (the P4-02 ratification)**: the same host submits
  turns as substrate envelopes via mission-substrate-client (the exact
  pattern the Inbox lab's matrix cells already run live). One port, two
  hosts; the graph never knows.

Operator gate: the MC P4-02 consumer walk ratifies the substrate binding
(this plan's stance: dev = direct, production = substrate, no third path).
Evidence: same node, both hosts, identical journey/artifact digests
modulo usage receipts; substrate leg proves grant/settle round-trip.

### N8 implementation clarifications (2026-08-28)

The following host decisions preserve the ratified graph and binding
semantics; they do not reopen N0:

1. **P4-02 is not yet ratified.** The immediate N8 slice implements and proves
   only the dev direct-llama host. The production substrate host, envelope
   submission, grants, and settle round-trip remain dark behind the P4-02
   operator gate. No Mission Control source, configuration, service, database,
   or live consumer binding changes as part of this slice.
2. **Logical endpoint identity versus dev transport.** The exact catalog
   profiles retain their sealed logical `runtimeHostRef` and loopback
   `endpointRef`; the graph binding is unchanged. A checked-in,
   canonical-JSON/SHA-256-sealed dev route manifest maps that logical endpoint
   to one exact private HTTPS tailnet URL. Its route digest is physical-attempt
   evidence only. It must appear in the provider-attempt fingerprint/journal
   and must never enter graph artifacts, so direct and substrate hosts remain
   content-addressably equivalent. The older clean-production prohibition on
   Tailscale Serve remains intact; this is the explicitly authorized N8 dev
   exception, not a production-policy change.
3. **A route is boot-fixed across admitted work.** Provider-attempt
   idempotency remains engine-owned and does not acquire a transport dimension.
   Therefore a direct host freezes one validated manifest for its lifetime,
   and operators must drain every admitted/open attempt before replacing that
   manifest. A route change is never a hot reload or an invitation to replay a
   journaled physical call.
4. **Fresh-v2 capacity is an exact paired lease.** Admission and physical I/O
   are enclosed by one worker-principal capacity lease over the immutable
   binding's model and inference-profile limits. The qwen model limit is shared
   by classification, recall, and precision; the Mistral limit is shared by
   arbiter calls. Ordinary contention waits while the claimed engine turn is
   heartbeated and does not deliberately consume another provider attempt;
   journal admission remains after capacity acquisition. Capacity
   infrastructure failure follows the normal retry taxonomy.

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
| N0    | ✅ ratified 2026-08-27 (names, joins, fan-out, TTL, evolution, fairness) |
| N6    | Dev account choice + per-lane token consents |
| N8    | P4-02: substrate as the production model path |
| N9    | When (if ever) to promote out of development → commissioning ceremony |
| N10   | The deletion commit (explicitly irreversible-ish; dev-mode says go) |

## Standing verification discipline

Every phase lands with: hermetic tests on the memory store where
applicable, the same suite against Postgres, bite-proofs for every guard,
role-denial tests asserted per principal, and the repos' full gates. No
phase's evidence is prose-only.

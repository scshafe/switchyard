# DESIGN — The node-graph execution model (v2)

> **Historical record (read with the 2.0.0 rename).** This document was
> written and ratified while the package was `mission-pipeline`, and it is
> kept as written. Since 2.0.0 the package is `@scshafe/switchyard`:
> `MissionPipelineNode`, `MissionPipelineUnit` and the other `MissionPipeline*`
> names are `SwitchyardNode`, `SwitchyardUnit` and so on, and the
> `mission_pipeline.*` / `mission-pipeline*` identifiers carry the
> `switchyard` prefix (see `CHANGELOG.md`, 2.0.0). The engine semantics
> recorded here are unchanged.

**Status: RATIFIED by the operator, 2026-08-27; N0 complete.** Direction set by the
operator: one abstract node interface, one abstract unit interface, per-turn
atomicity, and outcome-conditional routing evaluated after every turn — in the
engine, not in a layer above it. The v1 model remains available during the
additive phases and is retired only by the explicit N10 deletion commit.

## 1. Why

The v1 engine splits one idea across two layers with two semantics:

- **Inside a pipeline**: a static DAG, compiled and digest-sealed, executed
  whole under one bounded shard lease. Conditionality is expressed as
  early-terminal items or verdict-reading stages. Human gates must be
  pipeline *outputs* ("gates are terminal") because a lease cannot span a
  human's think-time.
- **Between pipelines**: code. The scheduled lanes, gate admission, and
  continuation wiring decide which pipeline an item enters next — real
  routing logic with no declarative representation.

The gate-terminal rule and the pipeline-chaining conventions are not domain
truths; they are artifacts of leasing whole traversals. The operator's model
removes the cause instead of managing the symptoms:

> The unit of execution is **one node turn**, not one pipeline traversal.
> Between turns, a unit's position in the graph is durable data. After every
> turn, the engine evaluates the declared edges against the turn's outcome
> and enqueues whatever matches. A human decision is a node like any other —
> its turn just completes from the console instead of a worker.

The operator's canonical articulation (2026-08-27), which this design must
always satisfy: **every node has its own queue. The completion of a node's
turn for a unit results in the unit being queued at every node whose
queuing conditions are satisfied by that completion.** Per-node queues are
literal in the store (claiming is per-node; the queue is an index over the
journey). "Queuing conditions" are declared in two places that together
cover the sentence: outcome edges (source-anchored — which completions
offer the unit onward, and where) and join requirements (target-anchored —
what a receiving node demands before the offer becomes a queued turn).
Evaluation is scoped to the just-completed node's outcome, exactly as the
sentence scopes it.

Under per-turn leasing there is nothing special about waiting: no suspended
execution, no lease held across days, no orchestrator that must survive.
Crash recovery is trivial because between turns nothing is running.

## 2. The two interfaces

Names per the operator's framing. Shapes are illustrative; exact TypeScript
lands with the implementation plan.

### 2.1 `MissionPipelineNode`

A node is the atom of processing. Everything is a node: a deterministic code
step, a fenced model call, a full agent run, a human decision, an external
callback.

```
MissionPipelineNode {
  nodeId: string              // stable identity within the graph
  ref:    { id, version }     // the versioned node definition it instantiates
  kind:   "code" | "model" | "agent" | "human" | "callback"
  input:  ContractId          // versioned input artifact contract
  outcomes: OutcomeVocabulary // §2.3 — the node's DECLARED, versioned outcome set
  principal: PrincipalRef     // who executes turns at this node (§5)
  binding?: BindingRef        // model/prompt/profile binding, digest-sealed (as today)
  turn: {                     // atomicity envelope
    idempotency: "per (unitId, nodeId, attemptNumber)"
    leaseMs: number           // bounds the TURN, never the wait
    maxAttempts: number
    retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
  }
}
```

Node-kind execution sources:

| kind     | turn is executed by                  | turn completes when            |
|----------|--------------------------------------|--------------------------------|
| code     | worker executor (in-process)         | function returns               |
| model    | fenced model host (journal-first)    | provider result settled        |
| agent    | agent-turn executor (e.g. MC turn)   | the agent turn settles         |
| human    | a person, via the review console     | the decision is recorded       |
| callback | an external event (webhook, timer)   | the event artifact is admitted |

For `human` and `callback` there is no lease at all while the unit waits —
the unit is simply *queued at the node*. The turn (recording the decision /
admitting the event) is a short transaction under the completing principal.

### 2.2 `MissionPipelineUnit`

A unit is the atomic item that moves through the graph — one email
observation, one message revision.

```
MissionPipelineUnit {
  unitId: string              // stable identity (account-scoped, as today)
  graph:  { graphId, version, graphDigest }   // sealed at admission
  seed:   ArtifactRef         // the immutable input artifact
  journey: TurnRecord[]       // APPEND-ONLY; the only source of position
}

TurnRecord {
  nodeId, attemptNumber
  inputDigest, outcome, outputArtifact?   // outcome ∈ the node's vocabulary
  principal, startedAt, settledAt
  usage?: UsageReceipt
}
```

A unit's "current position" is **derived** from its journey — never a
mutable pointer. The queue rows that make units claimable at nodes are an
index over the journey, rebuildable from it.

### 2.3 Outcomes and edges — routing as data

The v2-specific move: outcomes stop being ad-hoc fields inside artifacts and
become each node's **typed, versioned return vocabulary**.

```
OutcomeVocabulary = { outcomes: string[], version }   // e.g. ["spam","clean"]

Edge {
  from: nodeId
  when: OutcomePredicate      // deterministic, over the DECLARED outcome
                              // (and optionally sealed fields of the output artifact)
  to:   nodeId[]              // fan-out allowed
}

Join (a property of the target node) {
  inbound: edgeId[]
  require: "all" | { nOf: number }   // over its declared inbound edges
  compose?: "select" | "envelope"   // additive 1.1.0 revision; default select
}
```

A graph definition is `{ nodes, edges, entry }` — canonical-JSON
digest-sealed exactly like today's pipeline definitions. **Compile-time
completeness check** (the v2 analog of v1's parity checks): every declared
outcome of every node either matches at least one edge or is explicitly
declared terminal. No outcome can fall on the floor silently.

Terminality is therefore an *outcome property in the graph*, not a node
type: "spam" terminal at the filter, "approved" routing onward at a human
node. The v1 gate-terminal rule has no v2 equivalent.

## 3. Execution semantics

One turn, one transaction (the engine's whole hot loop):

1. Claim: lease ONE unit (or a batch, §6) queued at a node, under the node's
   principal. Idempotency key derived as in v1 durable-stage.
2. Execute the node body for its kind. For `human`/`callback` this step is
   the recording of an already-made decision/event.
3. Settle, atomically: append the TurnRecord + output artifact
   (append-only), evaluate the node's edges against the outcome, enqueue the
   unit at every matched target (respecting joins), release the lease. Same
   transaction — a crash before commit leaves the unit claimably queued at
   the same node; a crash after leaves it queued at its successors. There is
   no in-between.
4. Outbox effects (proposals, notifications) ride the same transaction, as
   v1's transactional outbox does today.

Retry, dead-letter, cached-attempt reuse, and the retryable-vs-terminal
taxonomy carry over from v1's durable-stage executor unchanged — that
machinery IS the turn executor.

## 4. Evidence and replay — the invariant that must not move

Everything the platform's audit posture rests on survives structurally:

- Canonical-JSON SHA-256 digests for every artifact, definition, binding,
  and now edge-set (B1 core, byte-identical rule).
- Append-only journey; append-only outbox; content-addressed artifacts.
- A unit's complete journey is reproducible from: seed artifact + sealed
  graph digest + the deterministic edge predicates + recorded outcomes.
  Nondeterminism enters only where it always did (model/agent/human turns),
  and lands as recorded evidence with usage receipts.

Edge predicates MUST be deterministic data (no user code in routing). That
is the line that keeps "arrange the pipeline via configuration" true and
keeps replay honest.

## 5. Authority

Per-node principals replace per-pipeline principals; every v1 boundary
survives, more precisely placed:

- `model` nodes execute under the fenced model host; models still hold zero
  authority (no tools, no credentials, no DB).
- Admission-privileged node kinds (v1's broker-only durable-gate admission)
  become nodes whose principal is the broker — the worker structurally
  cannot claim their turns.
- `human` turns complete only under the console principal; `callback` turns
  only under the admitting edge's principal.
- Graph definitions and edges are sealed at admission; runtime cannot mutate
  routing (the v1 "no runtime mutation of a published definition" rule,
  extended to edges).

## 6. Batching is an executor detail, not a graph concept

v1's 10-item shard was model-call economics promoted into the core model.
In v2, a model-node executor MAY claim up to N units queued at that node and
run them as one provider batch; each unit still gets its own TurnRecord,
outcome, and edge evaluation. The graph never sees shards. (This also fixes
the v1 tail-hostage problem: units of different categories no longer share a
traversal, so batches are naturally homogeneous per node.)

## 7. What survives, what retires (mission-pipeline package)

SURVIVES (most of the package, and all of the hard parts):
- `contracts/` digest + artifact core — unchanged.
- `execute/durable-stage.ts` — becomes the turn executor (rename at most).
- Model bindings, the journal-first model host pattern, usage receipts.
- The transactional outbox and store fencing patterns.
- Every existing stage implementation — a v1 stage is a v2 `code`/`model`
  node body verbatim.
- The memory-store hermetic-test pattern.

RETIRES (the parts that encoded traversal-scoped leasing):
- `compile.ts` gate-terminality and whole-DAG traversal validation
  (replaced by the outcome-completeness compile check).
- `execute/shard-runner.ts`'s claim-one-shard-run-all-nodes loop.
- The two-pipeline chaining conventions and the code-level routing seam.

EVOLVES:
- `PipelineStore` → a `GraphStore` (definitions/edges) + `UnitStore`
  (journeys, queues, leases) — same fencing discipline, new nouns. Postgres
  is the obvious home, as today.

## 8. Migration story — none, by operator directive

**Operator directive (2026-08-27): the project is entirely in development.
Collected data and uptime are explicitly unimportant. Build it the right
way; do not spend effort preserving what was built the wrong way.**

Consequences, taken literally:

- There is NO data migration. The v2 store starts from a fresh, empty
  database. No v1 rows are carried, translated, or dual-written.
- There is NO equivalence obligation. A v1 pipeline is still a degenerate
  v2 graph (linear chain, single "ok" outcomes), and per-stage golden
  vectors remain useful as cheap regression seeds for node BODIES — but
  byte-identity between the v1 and v2 ENGINES is not a gate, because
  nothing depends on the v1 engine's outputs.
- v1 execution surfaces (shard runner, gate terminality, chaining) are
  deleted as soon as v2 carries the flows — not deprecated, not shimmed.
- The Gmail redeploy targets v2 directly; the v1/D3 plane never ships.

What the directive does NOT relax (these are correctness, not compat):
hostile provider content, zero-authority models, least-authority per-node
principals, append-only evidence, digest-sealing, deterministic edges, no
send authority, and MC's scheduler-substrate freezes (a different system's
rules).

## 9. Relationship to the wider estate (context, not scope)

MC's turn scheduler already runs this exact model for agent work — turns as
atomically-leased tasks, typed dependency kinds including review and
clarification, waits as durable data. The scheduler substrate's envelope
dependency vocabulary (review/clarification kinds, currently fail-closed)
anticipates cross-system joins of the same shape. v2 deliberately matches
that model so a later decision could carry units as substrate envelopes —
but nothing here depends on it, and no substrate change is proposed.

## 10. Decisions (ratified by the operator, 2026-08-27)

N0 is complete. Each answer below is binding for v2.0; changing one later
is a design revision, not a drive-by.

**2026-09-11 additive revision, explicitly requested by the user:** P7 permits
`join.compose: "envelope"` with the reserved `mission-pipeline.join-input.v1`
input contract. It embeds accepted branch payloads without giving bodies store
access. Omitted/`select` composition retains the original selection behavior;
firing, unsatisfiability, late offers, and atomicity remain as ratified below.
P8 adds an explicit consumer-owned port wrapper for declared failure outcomes;
it does not add failure edges or settle uncertain agent work. See the
[implemented contracts](IMPLEMENTED-P7-P8.md) and adapter conformance requirements.

1. **Naming.** `MissionPipelineNode`, `MissionPipelineUnit`, and `journey`
   for the append-only turn history — the operator's coinages, kept.
2. **Joins.** A join declares `all` or `nOf` over its declared inbound
   edges and fires AT MOST ONCE per unit. A join that can never complete
   (an inbound leg reached a terminal outcome) deterministically resolves
   to the declared `join_unsatisfiable` outcome, which — like every
   outcome — must route or be terminal under the completeness check. A
   late inbound offer arriving after the join has fired is recorded in the
   journey and enqueues nothing (idempotent no-op). There are NO
   engine-level timeouts anywhere in routing; time-based escape is a
   `callback` timer node composed in the graph.
3. **Unit creation is admission-only in v2.0.** A turn may not emit new
   units. One-email-to-N-extractions is one unit whose artifact carries N
   entries. Mid-graph unit spawning (independent child journeys,
   provenance lineage, re-joining) is explicitly deferred to a future
   design revision — the first ceiling to revisit if per-extraction
   independent routing is wanted.
4. **Human queues never expire in the engine.** No TTL, no engine-side
   escalation. Time enters the graph only as a declared timer `callback`
   node whose firing is a recorded event routed by ordinary edges, so
   escalation policy is visible in the sealed graph. The console owns
   queue presentation/ordering.
5. **Outcome vocabularies are strict.** Adding or removing an outcome is a
   NEW node version, always; the graph re-seals and the completeness
   check re-runs. There is no additive/soft path and no default route.
6. **Fairness at shared nodes, v2.0**: FIFO per node with per-graph
   round-robin at claim time. Richer policy (priority classes, weights)
   waits for contention evidence and slots into the claim query without
   touching graph semantics; the production model path additionally rides
   the scheduler substrate, which owns its own fairness story.

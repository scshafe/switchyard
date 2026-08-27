# DESIGN — The node-graph execution model (v2)

**Status: DRAFT for operator review, 2026-08-27.** Direction set by the
operator: one abstract node interface, one abstract unit interface, per-turn
atomicity, and outcome-conditional routing evaluated after every turn — in the
engine, not in a layer above it. Nothing in the current engine is retired
until this is ratified; the v1 model keeps running everything it runs today.

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
  require: "all" | { nOf: number }   // over its declared inbound edges
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

## 8. Migration story

- A v1 pipeline is a degenerate v2 graph: a linear chain of code/model
  nodes, single "ok" outcomes edge-connected in order, terminal error
  outcomes. Mechanical translation.
- Equivalence proof strategy (the house method): run the v3 Inbox pipelines
  and their v2-graph translations over the same seed corpus and assert
  byte-identical output artifacts and digests, node for node — the same
  dual-run discipline that proved the D2/D3 slices.
- The Gmail redeploy (successor commissioning family) targets v2 directly —
  we are pre-commissioning, so nothing live migrates; the v1 plane simply
  never ships to production.

## 9. Relationship to the wider estate (context, not scope)

MC's turn scheduler already runs this exact model for agent work — turns as
atomically-leased tasks, typed dependency kinds including review and
clarification, waits as durable data. The scheduler substrate's envelope
dependency vocabulary (review/clarification kinds, currently fail-closed)
anticipates cross-system joins of the same shape. v2 deliberately matches
that model so a later decision could carry units as substrate envelopes —
but nothing here depends on it, and no substrate change is proposed.

## 10. Open questions for ratification

1. Naming: `MissionPipelineUnit` vs `MissionUnit`/`WorkUnit`; "journey" vs
   "trace".
2. Join semantics detail: n-of-m timeout behavior; late-arrival edges after
   a join fired.
3. Unit fan-out: may one turn EMIT new units (one email → N extracted
   tasks), or is unit creation admission-only in v2.0?
4. Human-node queue policy: TTL/expiry, escalation edges on timeout
   (a `callback` timer node composes for this — is that enough?).
5. Outcome vocabulary evolution: adding an outcome is a new node version
   (strict) — confirm no soft path.
6. Priority/fairness at shared nodes (many graphs, one model host).

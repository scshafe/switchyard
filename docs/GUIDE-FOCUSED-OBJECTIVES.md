# Guide: building model-driven pipelines from focused objectives

**Status: recommended application pattern (2026-09-10).** This guide changes no
engine semantics. Every claim about what the engine does is tagged:

- **Exists**: implemented and verified in this package's source and tests.
- **Pattern**: a recommended way to use what exists; the consumer owns it.
- **Proposed**: a framework change written up in
  [`REVIEW-INTERFACE-FRICTION.md`](REVIEW-INTERFACE-FRICTION.md); it does not
  exist yet.

The worked example that applies this guide is
[`EXAMPLE-SUPPORT-TRIAGE.md`](EXAMPLE-SUPPORT-TRIAGE.md). The motivating
consumer plan is Inbox's
`docs/PIPELINE_SIMPLIFICATION_PLAN.md`, whose classifier answers category,
urgency, action obligation, confidence, summary, and reasons in one response,
and whose binary action nodes still generate that whole payload.

Application policy stays with the consumer: which questions to ask, what
confidence bars mean, when a person must decide, which principal may settle a
node, and which effects an outcome may authorize. The engine supplies typed
outcomes, sealed identities, atomic settlement, and evidence.

## 1. Recognizing a node with too many responsibilities

A node is overloaded when its one answer is really several answers that
different consumers read independently. Signs, any two of which are enough:

- **Independent consumers of separate fields.** Inbox's notification planner
  reads only the action flag of the classification; JobTrack reads category and
  summary; the mailbox writer reads category. One node's error rate is then
  the union of three unrelated error rates.
- **A vocabulary that is a product of dimensions.** If the outcomes are
  `jobs`, `finance`, … but the payload also carries urgency and an action
  flag that later edges or bodies sniff, the routing vocabulary is hiding a
  second and third decision. The engine can only route on declared outcomes
  and sealed output fields (`{ outcome, where }`), so anything a later step
  branches on inside the payload is an undeclared decision.
- **A prompt that asks more than one question**, or asks for prose that no
  code checks. Prose is expensive to generate, impossible to validate, and
  tends to become "evidence" for the next step.
- **One confidence number for everything.** A confidence that covers category
  and urgency and action cannot be calibrated against any one label.
- **Errors with unrelated causes.** "The classifier was wrong" is not one
  bug when the category was right and the urgency was wrong.
- **Fixtures cannot vary one truth at a time.** If you cannot write a fixture
  that changes the urgency without changing the category and the summary, you
  cannot test the node.

The test is: can each thing this node decides be given its own fixture set,
its own validator, and its own positive and negative denominators? If not,
it is several objectives wearing one node.

## 2. Outcome count is not reasoning complexity

Two outcomes do not make a node simple, and seven do not make it hard.

- A binary node whose payload carries a field that later edges test with
  `{ outcome, where }` is still a multiclass decision; the graph has moved the
  branching into a field.
- A seven-way category question with pinned definitions can be one clean
  decision boundary. A chain of six binary gates that reconstructs it needs a
  precedence rule at every gate, and the precedence rules are policy that must
  be versioned and evaluated too.
- Gates compound errors. If a positive answer must pass three gates with
  recall 0.95 each, the chain's recall is at most 0.95³ ≈ 0.86, and a false
  negative at the first gate hides the correct answer from every later step.
  A negative answer short-circuits cheaply only when its false-negative cost
  has been measured and accepted.
- Shorter calls do not make a shorter workflow. Each call re-sends its
  context (see §8), and turns settle serially per unit.

Inbox's Stage 2 findings are a concrete case: three narrow calls raised
cross-model category agreement from 0.45 to 0.90, but the same experiment
changed the definitions and the projection length, and three 70B calls took
about as long as one broad call (107 s versus 110 s per message). The shape
helped agreement; it did not by itself buy speed, and the factors were
confounded. Design the decomposition for testability and evidence; treat
speed as a measurement.

## 3. When to separate, when binary, when multiclass, when code

| Choose | When | Avoid when |
| --- | --- | --- |
| **Separate objectives** into distinct nodes | The truths are independent; different consumers read them; each needs its own validator, threshold, budget, or model; each needs its own evaluation denominators | The answers are one decision seen from several angles (then it is one node with one vocabulary) |
| **A binary predicate** with an abstention | There is a natural yes/no with a cheap negative; it verifies a candidate; it is a conditional subquestion that only applies after another answer; the false-negative cost is measured | The "no" branch is a large heterogeneous class that later steps must classify again |
| **A multiclass node** | Categories are mutually exclusive with pinned definitions and one decision boundary; a binary tree would need precedence rules; early-gate misses are costly | The classes are independent dimensions (then separate them) |
| **Ordinary code** | The answer is computable: thresholds, dates, string grounding, dedupe, assembly, policy tables, contract validation; the result must be byte-reproducible; the model would only be looking something up | The rule is really a judgment that the code would fake with heuristics (then make it a declared model node with an uncertain outcome) |

Two rules hold regardless of the choice:

- **Every model invocation is its own node.** Kind `model`, its own binding,
  input contract, outcome vocabulary, attempt budget, and usage receipt, all
  visible in the journey. Never hide several calls inside one node body or
  one "orchestration" node. **Exists:** a model completion must carry exactly
  one usage receipt (`src/execute/ports.ts:364-369`), so one node is one
  physical call per attempt by construction.
- **Deterministic work is a code node, not a model side effect.** Validation,
  grounding, thresholds, assembly, and policy live in `code` nodes so they are
  replayable and their outcomes are declared.

## 4. Goals, steps, validators, and resolution

Vocabulary used here and in the example:

- A **goal** is a logical business objective: "does this ticket need an
  on-call escalation?" It closes exactly once, resolved by its own steps or
  escalated to a person.
- A **step** is one node in the goal: a model judgment, a deterministic check,
  a validator, or a human fallback.
- A **resolution** is the (node, outcome) pair that closes the goal. The
  validator's `proposed` and the first judgment's `no` resolve it; the
  escalating outcomes `uncertain`, `ungrounded`, and `invalid` hand it to a
  person, whose decision then closes the workflow, not the goal.

**Exists:** the engine has nodes, edges, terminals, and joins
(`src/graph/definition.ts`) and no runtime goal concept. A goal is declared
in a non-executable goal manifest (`createGoalManifest` in
`src/graph/goals.ts`) sealed against the exact graph digest: its members, its
single entry, and the (node, outcome) pairs that close it, each `resolved`
(the members decided) or `escalated` (they handed the decision out, usually
to a person). Sealing proves from the compiled graph that a unit entering
the goal closes it exactly once, and `projectGoalClosures`
(`src/store/goal-closures.ts`) reports per unit whether the goal was never
entered, is open, died, or closed, by which resolution, and what it cost.
Naming (Inbox's candidate graph prefixes every node `simplify-`) and
presentation groupings (the example's `goals` table) remain words; the
manifest is the fact they follow.

The relationship to insist on:

```
goal ─ entry step ─ judgment ─ deterministic check ─ judgment ─ validator ─ resolution
                      │              │                  │           │
                      └──────────────┴──── uncertain ───┴───────────┴──▶ human fallback ─ resolution
```

- The entry step consumes the goal's exact input artifact.
- Every later step consumes the exact previous step's output (§6).
- A validator is a `code` node that re-checks the whole chain before minting
  the resolution. Its refusal is a declared outcome that escalates; it is not a
  retry and not a dead letter.
- Human fallback is a `human` node with a bounded input contract. It records a
  decision; it does not re-run the ladder.
- A goal has no cycles and runs as one thread. **Exists:** cycles and fan-out
  are legal graph structure (`src/graph/compile.ts`), so the manifest refuses
  a cycle inside a goal, fan-out inside a goal, and any path that re-enters a
  goal after it closed. `graphTurnBudget` (`src/graph/budget.ts`) bounds the
  whole graph: every back edge and, for an acyclic graph, the worst-case
  occurrences and turns per node and per kind.

## 5. Uncertainty, bounded retries, escalation, and evidence

### Uncertainty is an outcome

Declare `uncertain` (or `unusable`, `unsupported`, whatever the question
needs) in the vocabulary and route it. **Exists:** the compiler refuses a
graph in which any declared outcome neither routes unconditionally nor is
terminal (`src/graph/compile.ts:251-269`); a conditional `where` arm does not
count as coverage. So an uncertain outcome can never fall on the floor.

Two valid destinations:

- **Escalate**: route to a human node with an escalation contract carrying the
  step, the reason, and the exact input digest.
- **Carry forward as an explicit fact**: when the downstream decision tolerates
  the gap, emit the ordinary contract with the fact marked unresolved. The
  example's `blast-radius:uncertain` does this. Never let code default an
  unknown to a lower class.

### Retries are attempts, not cycles

**Exists:** `turn.maxAttempts` (1..10) bounds physical attempts of one queued
occurrence; `attemptIndex` counts them and `attemptNumber` is global per
(unit, node) (`src/execute/unit-runner.ts:274-293`). A retryable failure
re-reserves the next attempt; the last attempt's failure is terminal
(`src/execute/unit-runner.ts:1288`). A cached completion from a crashed attempt
is reused without re-invoking the body. Do not model retries as graph edges
back to the same node.

### Lifecycle failure is not a semantic decision

**Exists:** a terminal failure appends a `turn_failed` record and a dead
letter, releases the lease, marks only that occurrence's outbound join legs
impossible, and enqueues no successor
(`src/store/memory-unit-store.ts:3266-3370`). There is no "on failure, route
to X" in the graph, and no human fallback is reached. A thrown error carries
no usage receipt (`src/execute/unit-runner.ts:1240-1251`).

**Pattern:** decide per failure class:

- Expected provider outcomes that a person should see (policy refusal,
  malformed output, indeterminate result): have the port return a declared
  outcome with a receipt and an evidence artifact, so the escalation ladder is
  the recovery lane. Inbox did this for its action models (`provider_*`
  outcomes, graph v2 and v4) and its candidate graph declares `unusable` on
  every model node with `maxAttempts: 1`. Keep the reason in the artifact so
  lifecycle causes stay distinguishable from semantic uncertainty.
- Infrastructure failures (transport, timeout): let the engine retry under the
  budget and dead-letter; the host re-admits or repairs. Charge usage for an
  admitted attempt whose result is unknown by returning a receipt of trust
  `estimated_tier_ceiling` or `unavailable` from the port instead of throwing,
  or the accounting is silently zero.

**Proposed:** a small port helper that maps classified failures to declared
outcomes with a receipt policy (review proposal P8), so consumers stop
re-implementing this.

### Evidence is immutable and sufficient for replay

**Exists:** every settlement journals the queue, node ref, attempt identity,
input and output artifact refs, outcome, usage receipts, principal, actor,
timestamps, a completion digest, a settlement digest, and the routing effects
it caused; every record is digest-sealed; artifacts are content-addressed
(`src/store/unit-store.ts:209-228`). Human decisions carry actor attribution
that never substitutes for the principal. The example's replay test shows the
same fixture producing identical journey digests in a fresh store.

## 6. Consuming exact preceding outputs and retaining provenance

**Exists:** a node's input contract is one contract identifier. At settlement
the store validates the effective artifact (the output, or the input carried
forward when the body emitted none) against every matched target's declared
input (`src/store/memory-unit-store.ts:2676-2680`, `:3507-3508`). Bodies
receive only their input payload and a minimal context; they cannot read
earlier artifacts (`src/execute/ports.ts:50-65`).

Two contract styles, both valid:

| Style | Distinct contract per step (the example) | One accumulating contract (Inbox's candidate graph) |
| --- | --- | --- |
| Ordering | enforced by contract identity at settlement; a step cannot run on the wrong predecessor | enforced only by the body's own history check |
| Fan-out and shared human nodes | every source of a shared target must emit that target's contract | trivial: everything speaks one contract |
| Contract churn | adding a fact changes one contract | adding a fact changes the one contract everyone reads |
| Compile-time check | **Exists:** declare `outputs` per outcome and `compileGraph` proves every edge lands on a node that accepts the contract; a completion carrying anything else is refused | none needed: one contract everywhere is trivially consistent |

In both styles:

- Carry provenance inside the artifact: the exact input ref (`previous`), the
  seed ref, and the refs of every step that contributed. The example's
  proposal lists its whole chain back to the seed digest.
- Never re-read "the latest artifact for this message". The only inputs a step
  may use are the ones the engine hands it.
- Generated prose (a summary) is a display artifact. Later steps consume the
  typed facts it was generated from, never the prose. If a summary fails, a
  deterministic fallback line stands in and routing does not change.

### Joins synchronize and select; they do not combine

**Exists**, verified against `src/store/memory-unit-store.ts:2715-2770` and
the conformance suite (`src/store/unit-store-conformance.ts:1009-1078`):

- A join node declares its inbound edge ids and `all` or `{ nOf }`. Progress is
  per (unit, join, inbound edge): pending, offered, or impossible.
- Every offered artifact must satisfy the join node's one input contract, even
  when `nOf` needs fewer offers.
- When the threshold is met the join queues exactly once. The queued input
  artifact is the artifact of the **earliest accepted edge in sealed
  `join.inbound` order**, not the first to arrive and not a merge. The queue
  and journey record the complete accepted-offer provenance (edge id, source
  node and occurrence, evidence digest, artifact ref, offered time).
- Later offers are journey-recorded no-ops. A leg whose source can no longer
  be reached makes the join unsatisfiable; the engine synthesizes
  `join_unsatisfiable` with a reserved artifact contract, and that outcome must
  route or be terminal like any other.
- The join body sees only the selected artifact's payload. Nothing in the port
  context exposes the other offers.

Valid uses today:

- A race: `{ nOf: 1 }` between a human decision and a timer callback, where
  either artifact satisfies the same contract (the `escalation-ladder`
  fixture in `test/fixtures/mission-pipeline/node-graph-v2-fixtures.mjs`).
- A barrier: `all` over branches that each carry the same accumulating
  context, where the join body only needs to know that both finished and the
  selected artifact is as good as any.

Not valid today: a join that computes over the payloads of two branches. Use a
sequential trunk where each step appends its fact, or wait for the **Proposed**
join-input envelope (review proposal P7).

## 7. Independent versioning

What changes which identity, verified from `src/graph/definition.ts`,
`src/model/binding.ts`, and `src/execute/turn.ts`:

| You change | Identity that moves | Notes |
| --- | --- | --- |
| A step's input contract or outcome vocabulary | node ref version, therefore graph digest | The ref/version signature is {kind, input, outcome set}; the store refuses a reused ref with a different signature |
| A prompt (stack, persona, component) | binding digest, node fingerprint, graph digest | Prompt identity is inside the sealed binding when `promptStackRef` is set |
| A model revision or an inference parameter | binding digest, node fingerprint, graph digest | Parameters are embedded and strict; unknown keys fail closed |
| A retry budget or lease | graph digest only | `turn` is graph-instance configuration, not part of the node ref |
| Topology (edges, terminals, joins) | graph digest | The compiler re-runs completeness |
| A policy constant in a code body (a threshold, a priority table) | the node's `configuration` ref, therefore the fingerprint, every attempt key, and the graph digest | Only when the node pins a configuration ref; see below |

Policy constants move only when the node pins them. **Exists:** a node may
declare `configuration: { id, version, digest }` naming the host-side policy
it runs under (`src/graph/definition.ts`). The digest fills the fingerprint
slot the engine had sealed as `"default"` (`src/execute/turn.ts`), so it
enters every attempt key and the graph digest, and the worker context hands
the ref to the body as `context.configuration`. **Pattern:** seal the policy
object, derive the ref from its digest, have the body refuse to run under any
other ref (the example's assembler does), and bump the version when a rule
changes. A node that pins nothing keeps today's fixed fingerprint, and a
threshold edit behind it is invisible to the evidence.

The attempt identity ties all of this together: the idempotency key is the
digest of unit, node id, attempt number, node ref, node fingerprint, input
digest, and an optional host execution identity digest
(`src/execute/turn.ts:105-146`). Change any of them and the attempt is a new
physical attempt; keep them and a crashed attempt's cached completion is
reused.

## 8. Assessing the complete workflow

Measure the unit's whole journey, never one call.

**Quality**

- Per objective: precision and recall against human labels with separate
  positive and negative denominators, plus the abstention rate. An uncertain
  answer is neither correct nor wrong; it is workload.
- Complete-path recall: a positive that a gate dropped early counts against
  the objective that never got to answer.
- Escalation rate and human review workload, per objective and per reason
  code, from the journey's escalation artifacts.

**Cost and latency**

- Calls per unit, tokens per unit, and cost per unit come from the usage
  receipts the journey retains on every settled or failed attempt and from the
  receipt events the runner appends to the outbox
  (`src/execute/unit-runner.ts:1150-1177`). **Exists:** `projectUnitPath`
  (`src/store/unit-path.ts`) sums them per node and per unit from the journey
  alone, beside per-node state, open queues, edges taken, and join progress.
- End-to-end p50 and p95 from admission to the last terminal, and the same per
  objective, from journey timestamps. Queue wait is the gap between a queue's
  `queuedAt` and its settlement's `startedAt`.
- Retries and dead letters per node, from `turn_failed` records.

**Why focused calls are not free**

- *Repeated prompt processing.* Every focused call re-sends the context it
  needs. Four calls over a 400-token context cost about 1,600 prefill tokens
  where one call cost 400, before any output. Prefix caching may recover some
  of it; that is a host and provider property, not a graph property.
- *Model loading and swapping.* Several bindings on one resident model revision
  add no load time; a bigger arbiter on the same GPU forces a swap. The
  binding's model revision is in the graph, so the swap points are visible in
  the picture.
- *Graph parallelism versus inference concurrency.* **Exists:** the engine
  queues fan-out branches independently, a worker may claim a homogeneous
  batch and run bodies concurrently (`src/execute/unit-runner.ts:2060`), and
  claims are FIFO per node with round-robin across graph lanes. None of that
  makes two model calls run at once: the host's model port and its capacity
  fence decide, and Inbox's substrate serializes physical model operations.
  Two arrows leaving one node are not a concurrency claim.
- *Serial trunks.* Each turn settles atomically before the next is claimable,
  so a chain of four short calls is four claim-execute-settle cycles.

Whether a decomposition is faster or cheaper on a given model and host is
therefore an experiment: hold everything except the shape fixed, measure the
complete path, and keep the smaller-model result only if it clears the quality
guardrails set beforehand. Do not promise a speedup from the picture.

## 9. Design review checklist

Before sealing a graph that adds or changes a model node:

1. One question per model node, written as a question in the presentation.
2. A declared uncertain or unusable outcome, routed to a person or carried as
   an explicit unresolved fact.
3. An input contract that is the exact previous step's output, with
   provenance refs inside the artifact, and `outputs` declared per outcome so
   the compiler proves the chain.
4. A deterministic validator before any resolution, with its refusal declared
   and routed.
5. A bounded attempt budget, and a decision for each failure class: declared
   outcome with receipt, or dead letter.
6. A sealed binding per model invocation; policy constants sealed and pinned
   as the node's `configuration` ref; the port builds its provider request
   with `modelTurnInvocationRequest`, so the provider sees the attempt
   identity the journey records.
7. Fixtures for the positive, negative, uncertain, and failure paths, run on
   the memory store, asserting the journey path and the queued human node;
   `projectUnitPath` gives the assertion its vocabulary, `graphTurnBudget`
   pins the worst case, and `projectGoalClosures` proves each fixture closed
   its goal exactly once or died inside it.
8. The goal manifest re-sealed and the presentation updated in the same
   change, with coverage checked (see
   [`WORKFLOW-GRAPH-CHANGES.md`](WORKFLOW-GRAPH-CHANGES.md)).
9. The measurement plan: which complete-path numbers must move, and by how
   much, before the change is kept.

# Review: interface and code-design friction for focused-objective graphs

**Status: findings and proposals (2026-09-10); P1, P2, P3, P4, P5, P6, and
P9 implemented in 1.1.0 the same day.** Everything under "What works today" was verified
against the source and tests named. Each proposal names its compatibility
consequences and the tests that prove it; the implemented ones say where they
landed.

Method: build the support-triage example
([`EXAMPLE-SUPPORT-TRIAGE.md`](EXAMPLE-SUPPORT-TRIAGE.md)) on the public API,
read Inbox's node-graph-v2 integration and its in-flight simplification
candidate (`src/simplification/`, source revision `19214e5`), and record every
place the API made the pattern in
[`GUIDE-FOCUSED-OBJECTIVES.md`](GUIDE-FOCUSED-OBJECTIVES.md) awkward.

## What works today

| Capability | Where | Verified by |
| --- | --- | --- |
| Strict per-node outcome vocabularies, versioned with the node ref | `src/graph/outcome.ts`, `src/graph/definition.ts:329-334` | `test/mission-pipeline-graph.test.mjs` |
| Compile-time completeness: every outcome routes unconditionally or is terminal; conditional arms are additive | `src/graph/compile.ts:251-269` | graph tests; the example's "removing an escalation route" test |
| Node definition signature {kind, input, outcome set} bound to (ref id, version) within a graph and across published graphs | `src/graph/compile.ts:166-197`, `src/store/graph-store.ts:51-64` | graph and graph-store tests |
| Closed edge predicate language: outcome, anyOf, outcome + field equality over the output artifact | `src/graph/edge.ts`, `src/store/routing.ts` | routing tests |
| Bounded attempts per queue occurrence; cached completion reuse; retryable versus terminal taxonomy | `src/execute/unit-runner.ts`, `src/execute/failure.ts` | node-turn tests; conformance suite |
| One usage receipt per model completion; receipt-first snapshotting so usage survives a rejected completion; one outbox receipt event per attempt | `src/execute/ports.ts:364-369`, `src/execute/unit-runner.ts:1150-1177` | node-ports tests; the example's receipt test |
| Digest-sealed model bindings embedding the inference profile, with optional prompt-stack identity verified by the invoker | `src/model/binding.ts`, `src/model/invoker.ts` | model tests |
| Atomic settlement: journey, artifacts, edges, joins, successors, outbox, lease in one transaction with named crash checkpoints | `src/store/memory-unit-store.ts:3375-3618` | conformance suite, eight checkpoints |
| Human and callback completions under the node's principal with actor attribution as evidence only | `src/execute/unit-runner.ts` `recordHumanNodeDecision` | conformance and the example |
| Journey records sealed per record; artifacts content-addressed; join provenance retained | `src/store/unit-store.ts` | conformance; the example's replay test |
| Memory store as executable specification with deterministic clock and ids | `src/store/memory-unit-store.ts` | every test above |

### Join semantics, stated exactly

Verified against `src/store/memory-unit-store.ts:2715-2770` (selection),
`:2816-2887` (offers), and `src/store/unit-store-conformance.ts:1009-1078`:

1. A join fires at most once per unit when its `all` or `nOf` threshold over
   distinct declared inbound edges is met.
2. The queued input artifact is the artifact carried by the **earliest accepted
   edge in the sealed `join.inbound` order**. Arrival order is retained as
   evidence and does not change the selection. The reverse-arrival conformance
   case proves it: branch B settles first, the join still receives branch A's
   artifact.
3. Every accepted artifact must match the join node's single input contract;
   a mismatch fails the settling transaction.
4. The queue occurrence and the journey carry `join.selectedEdgeId` and the
   full `accepted` list with source node, source occurrence, evidence digest,
   artifact ref, and offered time.
5. The join body receives only the selected payload. The context handed to a
   port has no join field (`src/execute/ports.ts:50-65`).
6. Late offers are journey-recorded no-ops; an unreachable leg resolves the
   join to the engine-authored `join_unsatisfiable` outcome and artifact.

So a join **synchronizes predecessors and selects one accepted artifact**. It
does not combine payloads. A valid example is the `join` fixture in
`test/fixtures/mission-pipeline/node-graph-v2-fixtures.mjs`: `start` fans out
to `branch-a` and `branch-b`, both emit `unit-artifact.v1`, and `join`
(`require: "all"`) queues once with branch A's artifact and both offers in its
provenance. Inbox's plan records the same conclusion and chose a sequential
accumulating trunk for its first composition.

## Friction found

Each item: problem, current workaround, proposed interface, compatibility,
tests. Priority is in the summary table at the end.

### P1. No engine-owned execution-state projection of a journey

**Problem.** Every consumer that draws a run or asserts a path re-derives
"which nodes settled, with which outcome, which queues are still open, which
joins are pending" from journey records. Inbox wrote `visitsFor` in
`pipeline-http.ts` from its own console projection and `email-journey.ts` for
replay; the example wrote `journeyPath`. Pending state is derivable from the
journey alone (an enqueued queue id with no settlement or terminal failure) but
nobody has one shared derivation, so the frontend SDK has no stable contract
to consume.

**Workaround.** Each consumer projects its own; the example's `journeyPath`
and `openQueues` helpers.

**Implemented (1.1.0).** `projectUnitPath` in `src/store/unit-path.ts`:

```ts
export function projectUnitPath(journey: unknown): UnitPathProjection;
interface UnitPathProjection {
  readonly schemaVersion: "mission-pipeline-unit-path.v1";
  readonly unitId: string; readonly graph: GraphDefinitionRef; readonly seedArtifact: ArtifactRef;
  readonly entryNodeId: string; readonly records: number; readonly lastSequence: number; readonly lastRecordedAt: string;
  readonly nodes: Readonly<Record<string, UnitPathNode>>;   // absent node = never queued
  readonly edges: Readonly<Record<string, number>>;         // edge id -> times it carried the unit
  readonly joins: Readonly<Record<string, UnitPathJoin>>;   // pending | queued | unsatisfiable, per resolved edge
  readonly openQueueIds: readonly string[];
  readonly concluded: boolean;                              // no open queue
  readonly usage: { receipts: number; chargedTokens: number; chargedCostMicroUsd: number };
}
```

A node's `state` (`pending`, `failed`, `dead`, `settled`) is its latest
occurrence's state; every occurrence is listed with its attempts, failures,
outcome, principal, and actor. Derived only from journey records: the
projection re-verifies every record seal, the contiguous sequence, the unit
and graph identity, and every queue reference, and refuses anything else.
"Delivered" is deliberately absent: delivery is an outbox and relay fact the
consumer supplies.

**Compatibility.** Additive export; the 1.1.0 release manifest pins it. No
store or port change.

**Tests.** `test/mission-pipeline-unit-path.test.mjs`: the support-triage
positive, provider-outage, and ambiguous fixtures; a retry recorded through
the store API (open occurrence in `failed` state, then settled on attempt 2);
`all` join offers, queueing with provenance, and a late offer; an
unsatisfiable join with its routed recovery; twelve refusals (tampered seal,
reordered, partial, foreign unit, foreign graph, ghost queue, wrong node,
double settlement, second admission, smuggled key, oversized, Proxy); and
determinism, freezing, and prototype-free records.

### P2. Output contracts per outcome are not declared, so contract chains are checked only at settlement

**Problem.** A node declares one input contract and no output contracts. The
store checks each carried artifact against the target's input at settlement,
so a wrong contract is caught, but only at runtime and only for the path
taken. The example's escalation sources must all emit
`triage-escalation.v1`; nothing at compile time proves they do. Inbox keeps a
consumer-side table (`output-contract-bindings.ts`) and its candidate graph
builds one for every node/outcome pair, then checks it with a preflight.

**Workaround.** Consumer-owned output binding tables plus tests.

**Implemented (1.1.0).** An optional per-node `outputs` map:

```ts
readonly outputs?: Readonly<Record<string, ContractId>>;   // outcome -> the contract this outcome carries onward
```

Rules: every key is a declared outcome of the node; the engine-reserved
`join_unsatisfiable` cannot be declared; an outcome that returns no artifact
carries its input forward, so its entry equals `node.input`; an omitted
outcome is undeclared and unchecked, as before. `compileGraph` proves that
every edge carrying a declared outcome lands on a target whose `input` equals
the declaration, joins included, naming the edge, outcome, contract, and
target on failure. `validateNodeTurnCompletion` refuses a completion whose
returned artifact (or carried-forward input) differs from the declaration, so
the mismatch is a terminal contract rejection before caching, not a stuck
settlement. `outputs` is definition data: it moves the graph digest and is
part of the node definition signature, compared as a map in any key order.

**Compatibility.** Additive optional key; definitions without it keep their
digests, fingerprints, and behaviour. Adding `outputs` to a ref/version that
is already published is a signature conflict (`output contracts`), so it
requires a new node version, exactly as an outcome change does. Consumer
`GraphStore` adapters must compare the new signature field: Inbox's Postgres
store projects only kind, input, and outcomes, so the added conformance cases
bite there until it does.

**Tests.** `test/mission-pipeline-node-contracts.test.mjs` (validation,
digest, compile-time edge and join checks, reuse rule, signature conflict,
completion-time check), two new `graph-store-conformance` cases (map
comparison and the cross-graph conflict), and the example, which declares
outputs on every code and model node and proves a wrong declaration fails
compilation and a wrong artifact fails completion.

### P3. Goals are not representable, so "closes exactly once" cannot be checked

**Problem.** The Inbox invariant "an authoritative logical decision closes
exactly once as a validator-backed resolution or a human escalation" has no
engine hook. The graph knows nodes and terminals, not which nodes form one
goal or which (node, outcome) pairs resolve it. Inbox's plan asks for an
explicit goal/step manifest; its candidate graph uses a naming prefix.

**Workaround.** Naming conventions, presentation groupings (the example's
`goals` table), and per-goal path tests.

**Implemented (1.1.0).** A non-executable companion document in
`src/graph/goals.ts`, sealed against the exact graph and with no effect on
the graph digest:

```ts
interface GoalManifest {
  readonly schemaVersion: "mission-pipeline-goal-manifest.v1";
  readonly graph: GraphDefinitionRef;                    // taken from the definition, never from the draft
  readonly goals: readonly {
    readonly goalId: string;
    readonly entry: string;                              // the only member a unit may enter at
    readonly members: readonly string[];                 // disjoint across goals
    readonly resolutions: readonly { nodeId: string; outcome: string; kind: "resolved" | "escalated" }[];
  }[];
  readonly manifestDigest: string;                       // digest({ schemaVersion, graph, goals })
}
function createGoalManifest(definition: unknown, draft: unknown): GoalManifest;      // validate and seal
function validateGoalManifest(definition: unknown, manifest: unknown): GoalManifest; // document, identity, rules
function validateGoalManifestDocument(manifest: unknown): GoalManifest;              // shape and digest only
```

The proposal named the kinds `valid` and `escalated`; the implementation
says `resolved`, because a resolution need not be validator-backed (the
example's `outage-signal:no` closes the goal on a judgment alone) and the
manifest cannot tell. Sealing proves, from the compiled graph alone, that a
unit entering a goal closes it exactly once: members exist and are disjoint
across goals; the entry is a member, and admission and every edge from
outside land on it; every member outcome either continues inside the goal to
exactly one member or closes it through a declared resolution, to outside
nodes or a graph terminal, so a terminal without a resolution and an exit
without one are both refused; the member subgraph is acyclic; nothing
reachable from a resolution exit re-enters the goal; and at least one
`resolved` and one `escalated` resolution exist. Fan-out inside a goal is
refused because one unit at two members could close twice; fan-out out of a
goal through a resolution is fine.

`src/store/goal-closures.ts` adds the runtime count. `projectGoalClosures`
takes a sealed manifest and a `projectUnitPath` projection of the same exact
graph and reports, per goal, `unentered`, `open`, `dead`, or `closed` with
the closing resolution, the open and dead members, the attempts spent
inside, and the receipts charged inside. A path that closed a goal twice is
refused rather than counted.

**Compatibility.** Additive modules; the engine never reads either at
runtime. The manifest pins the graph digest, so any definition change
re-seals it from the unchanged draft. The graph-core import allowlist gains
`src/graph/goals.ts`.

**Tests.** `test/mission-pipeline-goal-manifest.test.mjs`: sealing and
re-validation; exact identity (another graph, a moved digest, an edited
document, a tampered definition); every membership and outcome rule by its
message; a cycle, fan-out inside versus out, re-entry after closing, and a
join as a goal entry with its synthesized outcome; closures over synthetic
paths, including a refused double close. The example seals a manifest for
each of its graphs and proves every fixture closes the goal exactly once or
dies inside it, with the turns and receipts charged to the goal.

### P4. Code-node policy is invisible to attempt identity

**Problem.** `nodeExecutionFingerprint` seals
`configurationFingerprint: "default"` for every node
(`src/execute/turn.ts:91-99`). A code node's threshold or policy table can
change without moving any digest, so a journey cannot say which policy
produced an outcome, and a changed policy silently reuses cached attempts.

**Workaround.** Seal policy as an artifact referenced by the input contract,
or bump the node ref version (which forces re-declaring the outcome
vocabulary at the new version), or supply `executionIdentityDigest` on every
claim from the host.

**Implemented (1.1.0).** The reserved slot is filled:

```ts
readonly configuration?: { readonly id: string; readonly version: number; readonly digest: string };
```

`nodeExecutionFingerprint` is
`digest({ bindingFingerprint, configurationFingerprint: configuration?.digest ?? "default" })`,
so every attempt key moves with the policy. The ref is allowed on every node
kind, model nodes included (a model port can apply code-side policy too), and
is graph-instance configuration like `binding`: it changes the graph digest
but not the node definition signature. The worker context carries it as
`context.configuration`, `executeNodeTurnAttempt` refuses a context whose ref
disagrees with the sealed node, and a body should refuse to run under any ref
but the one it was written for, as the example's assembler does.

**Compatibility.** Additive optional key; nodes without it produce
byte-identical fingerprints, keys, and digests (the golden vectors are
unchanged). `WorkerNodeTurnContext` gains an optional key; hosts that forward
a snapshot context to `executeNodeTurnAttempt` must forward it too.

**Tests.** `test/mission-pipeline-node-contracts.test.mjs` (ref validation on
every kind, graph digest and signature behaviour, fingerprint arithmetic with
and without the ref and with a binding, context snapshot, direct attempt
refusal on a missing or different ref, and a memory-store run whose journey
key includes the ref) and the example's repinned-policy run, which
dead-letters the assembler on its first attempt.

### P5. No termination or budget certificate for a goal

**Problem.** Cycles compile. Inbox's decision compiler proved worst-case path,
attempt, call, and token bounds; the v2 graph has `maxAttempts` per node and
nothing across nodes. The candidate replay harness guards with a hard-coded
turn cap of 64.

**Workaround.** Consumer tests and turn caps.

**Implemented (1.1.0).** `graphTurnBudget` in `src/graph/budget.ts`, taking
the sealed definition so validation is the compiler's:

```ts
export function graphTurnBudget(definition: unknown): GraphTurnBudget;
interface GraphTurnBudget {
  readonly graph: GraphDefinitionRef;
  readonly acyclic: boolean;
  readonly cycleEdges: readonly { edgeId: string; from: string; to: string }[];   // back edges of a DFS from the entry
  readonly nodes: Readonly<Record<string, { kind; join: boolean; maxAttempts; depth; maxOccurrences; maxTurns }>>;
  readonly maxDepth: number | null; readonly maxTurns: number | null;              // null when cyclic
  readonly maxTurnsByKind: Readonly<Record<MissionPipelineNodeKind, number | null>>;
}
```

The occurrence arithmetic mirrors settlement: the entry queues once, an
ordinary target queues once per distinct source settlement that reaches it
(however many edges match), and a join queues once. It assumes every edge
may fire, so it is an upper bound: the support-triage graph's worst case is
16 turns (8 model), with the shared human fallback reachable four times.

**Compatibility.** Additive; listed in the graph-core import allowlist.

**Tests.** `test/mission-pipeline-graph-budget.test.mjs`: the linear,
router, join, and escalation-ladder fixtures; convergence without a join
versus duplicate edges from one source; the example's exact worst case; a
two-node cycle and a self-loop; validation delegation and frozen,
prototype-free output.

### P6. The model invocation request still speaks the retired vocabulary

**Problem.** `ModelInvocationRequest` in `src/model/invoker.ts:23-32` carries
`runId`, `itemId`, `stage`, and `attempt`. A v2 model port receives a
`WorkerNodeTurnContext` with `unitId`, `queueId`, `nodeRef`, `attemptNumber`,
and `attemptIndex`, and must invent a mapping to call a resolved binding.

**Workaround.** Each host maps by hand.

**Implemented (1.1.0).** A v2 request shape and a builder in
`src/model/invoker.ts`; the old shape stays accepted until the next major:

```ts
interface ModelTurnInvocationRequest {
  readonly unitId: string; readonly queueId: string; readonly nodeId: string;
  readonly nodeRef: MissionPipelineNodeRef; readonly attemptNumber: number; readonly attemptIndex: number;
  readonly idempotencyKey: string;                        // the journey's own attempt identity
  readonly inputArtifact: ArtifactRef;                    // content identity of `input`
  readonly input: unknown; readonly binding: ModelStageBinding;
}
function modelTurnInvocationRequest(fields: {
  context: WorkerNodeTurnContext; input: unknown; bindingRef: MissionPipelineNodeBindingRef; binding: ModelStageBinding;
}): ModelTurnInvocationRequest;
type AnyModelInvocationRequest = ModelInvocationRequest | ModelTurnInvocationRequest;   // what ResolvedModelBinding.invoke accepts
```

The builder takes exactly what a `ModelNodePort` receives plus the sealed
binding the host published for the node's ref. It re-snapshots the context,
so a forged or partial context fails; it resolves the ref against the
binding with `resolveModelBindingRef`, so the request can never carry a
binding the graph did not pin; and it passes `input` through untouched. A
port is then four steps: look up the sealed binding by the ref's digest,
build the request, `verifyResolvedModelBinding` the resolver's answer, and
`invoke`. The example's model port is written that way with a fixture
resolver behind it, and its test proves the resolver received the journey's
own queue id, node ref, attempt numbers, idempotency key, and input digest,
including a new key for the retry at the same occurrence.

**Compatibility.** Additive. `ResolvedModelBinding.invoke` accepts either
shape and passes it through unchanged, so resolvers written for the old
shape keep receiving it from the hosts that send it. Removing the old shape
is a major.

**Tests.** `test/mission-pipeline-model-turn-invocation.test.mjs`: the
request built from a snapshot context and the exact sealed binding; refusal
of a forged context, a stray field on either level, a ref whose digest or
identity names another binding, and an accessor-bearing context read zero
times; pass-through of both shapes and the abort signal by a verified
resolved binding. The invoker's identity checks are unchanged and their
tests still pass.

### P7. Real aggregation across branches needs an engine increment

**Problem.** As stated above, a join selects one artifact. Combining branch
payloads today means a sequential trunk, which costs latency when the branches
are independent model calls. Inbox lists this as an optional later foundation
and requires it to bind exact unit, graph, source, edge, node, queue, and
configuration identities.

**Workaround.** Sequential accumulation.

**Proposed.** An opt-in join composition mode:

```ts
// proposed extension of MissionPipelineJoin
readonly compose?: "select" | "envelope";  // default "select" (today's behaviour)
```

With `"envelope"`, the queued input artifact is a reserved
`mission-pipeline.join-input.v1` envelope that carries, in sealed
`join.inbound` order, every accepted offer's artifact ref and its provenance,
plus the unit, graph, join node, and requirement. The join node's declared
input must be that reserved contract (mirroring the `join_unsatisfiable`
rule). Whether the envelope embeds payloads or refs that the host resolves is
the design decision to settle first; embedding keeps bodies store-free and is
the recommendation.

**Compatibility.** Additive optional key; existing joins unchanged.

**Tests.** Conformance additions: arrival-order independence of the envelope
digest; duplicate and late offers excluded; `nOf` envelopes carry only accepted
offers; crash checkpoints unchanged; compile rejects an envelope join whose
input is not the reserved contract.

### P8. Mapping failures to declared outcomes is re-implemented per consumer

**Problem.** A thrown error in a port becomes a retryable or terminal failure
with no receipt and no successor. Consumers that want a person to see a
provider refusal must return a declared outcome instead, and must supply a
receipt policy for attempts whose result is unknown. Inbox implemented this
twice (the action ports and the candidate replay ports).

**Workaround.** Per-consumer port wrappers.

**Proposed.** A port helper:

```ts
// proposed: src/execute/declared-failures.ts
export function withDeclaredFailureOutcomes<K extends "code" | "model" | "agent">(port, options: {
  readonly outcomes: Readonly<Record<string /* failure code */, string /* declared outcome */>>;
  readonly artifact: (failure: ExecutionFailure, context: WorkerNodeTurnContext) => ArtifactEnvelope;
  readonly receipt?: (failure: ExecutionFailure) => UsageReceipt;   // required for model ports
}): typeof port;
```

Unmapped failures propagate unchanged, so infrastructure failures still
dead-letter. This is a library helper, not an engine semantic: the design
decision that host-policy violations may terminal-fail a node stands, and a
consumer chooses which classes to declare.

**Compatibility.** Additive.

**Tests.** A mapped failure becomes the declared outcome with the artifact and
receipt; an unmapped failure still throws; a model port without a receipt
policy is rejected at construction.

### P9. One code port per kind, not per node

**Problem.** `WorkerNodePorts` is keyed by kind. Every consumer writes a
`switch` on `context.nodeId` (Inbox's code port, the candidate replay port,
the example's `codePortByNode`).

**Workaround.** The `switch`.

**Implemented (1.1.0).** `codeNodePortByNode` in `src/execute/code-port.ts`:

```ts
export function codeNodePortByNode(bodies: unknown): CodeNodePort;   // { [nodeId]: async (input, context) => completion }
```

Bodies are captured once at construction as data-property, non-Proxy
functions under identifier keys; later mutation of the source object changes
nothing. An unregistered node fails terminally with
`immutable_configuration_rejected` (the runner's own code for a missing kind
port) before any body runs. The support-triage example now uses it.

**Compatibility.** Additive.

**Tests.** `test/mission-pipeline-code-port.test.mjs`: dispatch and
pass-through; unregistered, `constructor`, and null contexts rejected with no
body invoked; construction guards for Proxies, accessors, non-functions,
symbol keys, and invalid identifiers; capture-once semantics; and a real
engine run that dead-letters an orphan node on its first attempt.

### Observations recorded without a proposal

- **Human nodes have one input contract**, so every escalation source must
  emit the same escalation contract on its escalating outcome. P2 makes that
  visible at compile time; no other change is needed.
- **Presentation is correctly separate.** The definition carries only a graph
  description; names, questions, and sinks live with the consumer. The example
  and the SDK ADR keep it that way; the SDK adds a coverage check.
- **`listQueuedUnits` requires a principal and a node**, so "every open queue
  for this unit" is a loop over nodes (the example's `openQueues`).
  `projectUnitPath` answers it from the journey instead.
- **`maxAttempts` applies to human nodes too** and is meaningless there
  beyond 1; not worth a change.
- **Runner batching is real concurrency at the engine level** but not at the
  model; documented in the guide, not a change.

## Priority

| # | Proposal | Value | Size | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | `projectUnitPath` execution-state projection | high: unblocks the SDK and testing | small | none | implemented in 1.1.0 |
| P5 | Turn budget helper | medium | small | none | implemented in 1.1.0 |
| P9 | Code port by node | low but universal | tiny | none | implemented in 1.1.0 |
| P2 | Declared output contracts, compile-time edge check | high: makes contract chains provable | medium | additive key; adapters compare a new signature field | implemented in 1.1.0 |
| P4 | Configuration ref in the fingerprint | medium: fixes silent policy drift | small | additive key | implemented in 1.1.0 |
| P3 | Goal manifest and closure projection | medium: expresses the consumer invariant | medium | additive modules | implemented in 1.1.0 |
| P6 | v2 model request shape | low | small | none | implemented in 1.1.0 |
| P8 | Declared failure helper | medium | small | design tension to record | after two consumers agree on receipt policy |
| P7 | Join input envelope | high only when measured serial latency demands it | large | new store semantics, conformance additions, Postgres parity | deferred, as Inbox's plan says |

Four slices (P1, P5, P9; P2 with P4; P3; P6) landed as package version
1.1.0: additive keys and exports, no store migration, two new graph-store
conformance cases, a regenerated release manifest, and the frontend SDK's
execution-state and goal contracts ahead of any rendering code. P7 and P8
remain proposals; P7 is the only one that needs an engine increment.

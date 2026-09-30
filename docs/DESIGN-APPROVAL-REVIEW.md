# DESIGN — Approval before, review after (2.2.0)

**Status: proposed with the 2.2.0 implementation.** Owner decisions D-R1
(compile-time expansion into ordinary nodes, no store change) and D-R2
(rejection sends the node back with the reviewer's notes, at most `maxRounds`,
then `onReject`) are taken as given. This note records the exact expansion and
the choices D-R1/D-R2 left open.

## 1. Settings

A node may carry two optional settings. Both are sealed graph data.

```ts
type SwitchyardActor =
  | { kind: "human"; principal: PrincipalRef }
  | { kind: "model"; binding: SwitchyardNodeBindingRef; principal: PrincipalRef };

type SwitchyardRoute = "terminal" | { retry: true } | { to: string };

approval?: { by: SwitchyardActor; onDeny: SwitchyardRoute };
review?:   { by: SwitchyardActor; onReject: SwitchyardRoute; maxRounds?: number };
```

- `maxRounds` is 1..10, default 2, and counts reviewed attempts: round 1 is the
  node's first output; each rejection before round `maxRounds` sends the node
  back once. The default is written into the sealed graph, so omitting it and
  writing `2` seal the same digest.
- `{ retry: true }` on `onReject` means "keep sending it back" (no bound), so
  it cannot be combined with `maxRounds`. On `onDeny` it re-asks the approver
  and is accepted only for a human approver: a model approver would loop.
- `{ to: T }` names a node of the draft. If `T` itself has an approval, the
  route enters `T`'s approval, like every other edge into `T`.

## 2. Where the expansion lives

`createGraphDefinition` expands a draft and seals the **expanded** graph;
`compileGraph` re-derives the expansion from the settings and rejects a sealed
graph that is not exactly that expansion. The settings stay on the subject node
(authored fields unchanged), and the synthesized nodes, edges, entry and
terminals are ordinary sealed data.

Why not expand only inside `compileGraph`: stores read the sealed topology
directly, not only the compiled one. `MemoryUnitStore` snapshot restore checks
`entryNodeId === graph.entry`, a queue's inbound edges against `graph.edges`,
and fairness keys against `graph.nodes`; a Postgres adapter can do the same in
SQL. If the sealed graph and the executed graph differed, every store would
need to change. Sealing the expansion keeps stores untouched (D-R1) and makes
"the expansion is part of the digest" literal.

Graphs without settings seal byte-for-byte as before (same digests).

## 3. The exact expansion

For subject `X` (ids use `::`: `~` is not in the identifier grammar that turn
keys, evidence and store records share, and widening it would be a wire
change). Every synthesized node uses `X.turn` and `X.ref.version`. Its ref id
encodes everything its definition signature depends on, because graph stores
register one signature per ref across all published graphs:
`<X.ref.id>::approval.<human|model>`,
`<X.ref.id>::review.<human|model>.<single|rounds|retry>` and
`<X.ref.id>::rework`. The same node definition can therefore be approved by a
person in one graph and by a model in another without a publication conflict.

| Node | kind / principal | input | outcomes → outputs |
|---|---|---|---|
| `X::approval` | actor | `X.input` | `approved` → `X.input`, `denied` → `X.input` (both carry the input) |
| `X` (compiled view) | unchanged | `X.input` | every outcome except `join_unsatisfiable` → `switchyard.review-request.v1` |
| `X::review` | actor | `switchyard.review-request.v1` | `accepted:<o>` for each outcome `o` of `X` → `X`'s declared output for `o`; `rework` → `switchyard.rework.v1`; `rejected` → `switchyard.review-rejected.v1` (`switchyard.rework.v1` under retry) |
| `X::rework` | `X`'s kind, principal, binding, configuration | `switchyard.rework.v1` | `X`'s outcomes → `switchyard.review-request.v1` |

Edges (ids are deterministic so a join can name them):

- `X::approval.approved`: `X::approval` —approved→ `X`
- `X::approval.denied`: —denied→ `T` (`{to}`) or `X::approval` (retry); a
  terminal `(X::approval, denied)` otherwise
- `X::review.in`: `X` —anyOf(outcomes)→ `X::review`
- `X::review.rework`: `X::review` —rework→ `X::rework`
- `X::rework.out`: `X::rework` —anyOf(outcomes)→ `X::review`
- `X::review.rejected`: —rejected→ `T`, or `X::rework` under retry; a terminal
  `(X::review, rejected)` otherwise

Rewrites of authored data: edges into `X` and the entry point at `X::approval`;
each authored edge from `X` keeps its **edge id** and moves to `X::review` with
`o` renamed `accepted:<o>` (a `where` arm still tests the same artifact,
because acceptance carries `X`'s output onward unchanged); a terminal `(X, o)`
becomes `(X::review, accepted:<o>)`. `X::rework` exists only when a rework can
happen (`maxRounds ≥ 2` or retry); the `rework` outcome likewise.

Example — `draft` (model, outcome `done` → `publish`) with a human approval
and a model review, `maxRounds: 2`, `onReject: "terminal"`:

```
entry → draft::approval ─approved→ draft ─done→ draft::review ─accepted:done→ publish
              │denied: terminal                     │rework ⇅ done   │rejected: terminal
                                                  draft::rework
```

The compiled `X` differs from the sealed `X` in one place only: its outputs
say `switchyard.review-request.v1`. That is what makes the runtime fail
closed (section 5).

## 4. Rework: how the node gets the notes

Every node has one input contract, so rounds ≥ 2 run at the twin node
`X::rework` — the same body (same kind, principal, binding, configuration)
under the fixed input contract `switchyard.rework.v1`:

```
{ schemaVersion, subject: { nodeId, nodeRef }, round, maxRounds | null,
  input: <X's original input envelope>,
  history: [ { round, outcome, output: <envelope>, feedback: <envelope> | null } ] }
```

A body tells a first attempt from a rework by `context.nodeId` (`X` vs
`X::rework`) or the input contract; the latest notes are `history.at(-1)`.
A host registers the same body under both node ids (`codeNodePortByNode`).
The twin does not pass through `X::approval` again: it reworks an input that
was already approved, plus the reviewer's notes.

Rejected alternatives: notes in the turn context (the context is built by the
runner from the claim, which cannot see the journal — a runner and store
change); sending `X` its original input again (the notes have no carrier);
unrolling rounds into `X::review.2` … (several accepted edges would feed one
downstream join, and an `all` join goes unsatisfiable when the unused round's
edge becomes impossible); composing through envelope joins (a join fires once
per unit).

The reviewer's input `switchyard.review-request.v1` is the same record plus
the round under review: `{ subject, round, maxRounds, input, outcome, output,
history }`. On acceptance `X::review` emits `output` exactly, so downstream
nodes receive what `X` produced. A final rejection emits
`switchyard.review-rejected.v1` (`{ subject, maxRounds, input, history }`),
which is what a `{ to }` target receives.

## 5. Where the records are composed (no engine change)

`X`'s body produces `X`'s output; something must combine it with `X`'s input.
The composition is a pure function, `applyApprovalReviewCompletion(graph,
{ nodeId, inputArtifact, completion })`, applied by:

- `withApprovalReviewPorts(ports, { graphs })` — a port decorator in the style
  of `withDeclaredFailureOutcomes`, for code and model bodies;
- `approvalReviewHumanDecision(graph, …)` — for human subjects and human
  reviewers before `recordHumanNodeDecision`.

Reviewer bodies return `accepted` or `rejected` (optionally with any feedback
artifact; `reviewNotes(text)` makes a `switchyard.review-notes.v1`), approver
bodies return `approved` or `denied` with no artifact. The helper maps the
reviewer's answer to `accepted:<o>`, `rework` or `rejected` from the round and
the sealed `maxRounds`. If a host forgets the decorator, the runner rejects
`X`'s raw output against the compiled declaration (`review-request`) and the
reviewer's raw `accepted` as undeclared: it fails closed. An invalid model
result is handed to the runner as an undeclared `invalid.<reason>` outcome, so
its usage receipt is kept by the runner's ordinary result-error path.

A runner-level hook would remove the decorator but is an engine change; it is
left as an open question. Review on `agent` subjects is rejected in 2.2.0: an
agent's result is awaited without its input, possibly in another process, so
the decorator cannot compose the record durably.

## 6. Counting rounds

The round lives in the engine-composed, digest-sealed artifacts the store
already retains: `review-request.round` is 1 at `X` and `rework.round` at
`X::rework`; the helper checks `history.length === round − 1` and that
`subject` and `maxRounds` match the sealed graph. The journal shows the same
count independently (one settled `X`/`X::rework` turn and one settled
`X::review` turn per round, each referencing those artifacts by digest). No
store query, table or column is added.

## 7. Interactions

- **Every outcome routes.** Synthesized outcomes are routed or terminal by
  construction; the author must still cover every outcome of `X`, and that
  coverage moves to `accepted:<o>`.
- **Joins.** Moved edges keep their ids, so a downstream join's `inbound` is
  unchanged. While the review loop is open `X::review` stays reachable, so the
  join waits; a final rejection to a terminal makes the edge impossible (and an
  `all` join unsatisfiable), which is the right answer. Review on a join node
  works (its `join_unsatisfiable` is engine-authored and is not reviewed).
  Approval on a join node is rejected: the join would have to move to the
  approval node, changing the subject's outcome vocabulary.
- **Retries.** `turn.maxAttempts` bounds attempts within one queue occurrence
  of each node, as before; rounds are separate occurrences. A reviewer that
  keeps failing dead-letters its occurrence like any node.
- **Cycles.** A review with rework is a structural cycle. `graphTurnBudget`
  bounds the loop by `maxRounds` instead of reporting the graph unbounded;
  under retry the loop is a real, unbounded cycle and is reported as one. A
  goal manifest cannot contain the loop (goals are acyclic).
- **Principals.** Approval and review nodes run as the actor's principal (least
  authority: a reviewer's queue is listed by its own principal); the rework
  twin runs as the subject's principal. The engine principal stays reserved.

## 8. What the approver of a model node sees

Exactly the artifact the model would receive (same contract and digest) and
the ordinary turn context. The subject's sealed identity — its binding,
principal and configuration — is available host-side from
`approvalReviewRole(graph, nodeId).subject`, so a local model or a person can
judge "may this input go to that model". The rendered prompt is the host's and
is not part of the engine record.

## 9. Binary-first

`binaryQuestion(...)` builds a draft fragment: a small-model node with outcomes
`yes | no | unsure` whose `unsure` carries the input unchanged to one or more
escalation nodes (`SwitchyardActor`, e.g. a bigger model and then a person);
every tier except the last may also answer `unsure`. `yes` and `no` from every
tier route to the same place. It is ordinary authoring (no reserved ids) and
composes with approval/review settings.

## 10. Digest implications

The digest covers the settings (with defaults written in) and the synthesized
topology. Because `compileGraph` requires the sealed graph to equal the
re-derived expansion, the expansion rules are part of the sealed language: a
later change to them must be versioned in the setting, or graphs sealed under
2.2.0 stop compiling.

## 11. Deferred: re-screening rework inputs

Rework rounds do not pass back through the node's approval. A rework input carries the original
(approved) input plus earlier outputs and the reviewer's feedback, and that feedback is never seen
by the approver. When the approver exists to keep data away from the node (e.g. a local PII screen
in front of a cloud model) and the reviewer saw data the node was not meant to see, the feedback
can reintroduce it. Proposed fix: route `rejected` through the node's approver before
`<node>::rework` whenever the node has `approval`, with a denial following `onDeny`. The owner
deferred this on 2026-09-30 as a longer-term concern; until then, pair approval with reviewers
that may see only what the node may see.

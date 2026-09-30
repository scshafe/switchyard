# Workflow: a graph change includes its picture

**Status: standard expectation for consumers of this package (2026-09-10).**

A sealed graph is executable data. Its picture, its words, and its verification
are how people read that data. A change to the definition that lands without
its matching presentation, example, and checks is incomplete, in the same way
a change to an outcome vocabulary without a new node version is incomplete.

## The expectation

One change contains all of:

1. The definition change (nodes, edges, terminals, joins, bindings, turn
   policy), with the new graph version and digest.
2. The presentation change: names, questions, summaries, arrow groups,
   endpoints, quiet ends, goal names for every added or renamed element; and
   the goal manifest re-sealed against the new digest, with every new member
   outcome classified as inside, `resolved`, or `escalated`.
3. The example or fixture change: at least one fixture per new path, run on
   the memory store, asserting the journey and the queued human node.
4. The verification: the coverage checks below pass in the same test run, and
   any historical snapshot the consumer keeps is preserved, not rewritten.
5. For a candidate that is not published yet: the proposal diff and its
   picture, with candidate-only nodes presented from the candidate.

This repository holds the pattern in miniature: the support-triage example's
presentation table lives beside its graph, `presentationCoverage` proves they
match, and a test compares the diagram in
[`EXAMPLE-SUPPORT-TRIAGE.md`](EXAMPLE-SUPPORT-TRIAGE.md) with the renderer's
output for the current definition. Add an outcome, and the change fails until
the words and the picture follow; the goal manifest, sealed against the graph
digest, fails until it is re-sealed and the new outcome is classified.

## Checks

Every consumer should run these for every sealed graph it draws. The frontend
SDK in [`ADR-GRAPHPAPER-FRONTEND-SDK.md`](ADR-GRAPHPAPER-FRONTEND-SDK.md)
ships static coverage as `validatePresentation` and static contract tests in
the separately packaged, unreleased 0.1.0 core. Runtime-state, proposal, and
browser rules below remain consumer expectations and proposed SDK work.

**Complete node, edge, outcome, and terminal coverage**

- Every node in the definition is named in the presentation; every named node
  exists in the definition.
- Every model, human, agent, and callback node states its question.
- Every sealed `(edgeId, target)` contributes to its pair's drawn arrows;
  fan-out may put one edge on several target pairs. Every outcome an
  arrow group names is one the sealed arrow carries; the groups of one pair
  partition it exactly.
- Every declared terminal is claimed by exactly one endpoint exit or quiet
  end; no sink claims a (node, outcome) the graph does not declare terminal.
- An unclaimed terminal is drawn on its own and reported; it is never
  omitted.

**Correct candidate-only node roles**

- In a proposal picture, a node that exists only in the candidate takes its
  kind and words from the candidate; a node that exists only in the current
  graph takes them from the current presentation. A proposed model node never
  appears as code.
- The proposal diff compares by identity (node id, edge id, terminal pair);
  reordering is not a change.

**Historical graph identity**

- A unit's picture and details resolve the exact graph id, version, and
  digest the unit pinned at admission. A URL parameter cannot override it.
- A version the build has no presentation for is reported as unavailable, with
  the journey still shown; the current presentation is never substituted.
- Frozen snapshots of released graphs are preserved byte for byte; a test
  recomputes the snapshot's digest from its body.

**Safe state projections**

- The picture, the panel, and the details endpoint are built from bounded,
  typed projections: sealed node facts, contract ids, outcome names, counts,
  timestamps, principal and actor ids, reason codes, and content-stripped
  summaries. Never raw artifacts, provider receipts, prompts unless proven to
  be the sealed prompt, message bodies, links, or credentials.
- Model and prompt details are shown only when the resolved binding equals the
  sealed binding digest; otherwise the reason is shown and the prompt is
  withheld.

**Truthful pending, failed, escalated, and delivered states**

- Node state comes from journey evidence: settled with its outcome, pending
  (enqueued with no settlement), failed (a retryable attempt), dead (terminal
  failure), idle (never visited).
- Escalated means a declared escalation outcome settled and the human node is
  pending or decided; it is never inferred from a human node existing.
- Delivered means the consumer supplied a delivery state from its outbox or
  relay evidence; planned is not delivered; an outbox row nobody reads is
  "planned", and a picture must say so.
- Metrics are scoped to the displayed graph version; unavailable data is
  labelled unavailable, never rendered as zero; zero is "never observed
  since <first admission>".
- Join state (pending, queued, unsatisfiable) is read from join progress
  evidence, never from two arrows converging.

## How the SDK makes this cheaper

- The engine's display projection is the only source of nodes, arrows,
  terminals, joins, and marks, so coverage is a pure function over data every
  consumer already has.
- `validatePresentation` returns the exact list of problems, so a failing
  change names what to add.
- Proposed runtime-mode work will turn the engine's execution-state
  projection into a fixed, tested mapping; static SDK 0.1.0 does not render it.
- Golden `DiagramModel` fixtures make a rendering change a reviewable diff.
- Browser checks (hydrate, keyboard pick, deep link, narrow viewport, reduced
  motion, mismatched identity refusal) run only when rendering or interaction
  changes; contract tests run on every change.

## Definition of done for a graph change

- [ ] Definition sealed with a new version; compile passes; golden digest
      vectors updated where the repository keeps them.
- [ ] Presentation updated; coverage check passes; the diagram in the
      documentation equals the renderer's output.
- [ ] Goal manifest re-sealed from its draft; `validateGoalManifest` passes
      against the new definition.
- [ ] Fixtures for every new path; journeys asserted on the memory store.
- [ ] Proposal diff and picture for an unpublished candidate; candidate roles
      from the candidate.
- [ ] Historical snapshots untouched; exact identity lookups still resolve the
      previous version.
- [ ] Panel and details projections understand any new artifact contract with
      bounded fields only.
- [ ] Endpoint and delivery states for any new outbox effect are supplied by
      the consumer's projection, and the picture distinguishes planned from
      delivered.
- [ ] Browser check performed when rendering or interaction changed; its
      screenshots and the exact graph digest recorded with the change.

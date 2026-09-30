# Proposal: replay a retried admission regardless of `admittedAt`

Status: proposed, not implemented (2026-09-30). Came out of the fresh-eyes
run of [Your first switchyard](FIRST-GRAPH.md).

## Today

`admitUnit({ unitId, graph, seedArtifact, admittedAt, principalId })` seals
all five fields into the admission digest. A second call with the same
`unitId`:

- returns `created: false` and the stored unit when the digest is equal
  (every field identical), and
- throws `TurnEvidenceConflictError` otherwise. Since 2.3.0 the message
  names the fields that differ.

## The friction

A caller that stamps `admittedAt = new Date()` per call, as most first
programs do, never gets the replay: a retry after a lost connection or a
crash is always a conflict, even though it admits the same message into the
same graph. To get the replay, the caller has to persist the timestamp of
the first attempt, which is exactly the bookkeeping the replay exists to
save. The guide's `admit.mjs` handles this by catching the conflict; it does
not fake a fixed `admittedAt`, because that would store a false admission
time.

## Proposal

Make the admission's **identity** `unitId + graph + seedArtifact +
principalId`, and treat `admittedAt` as a first-write-wins attribute:

- same identity, any `admittedAt`: `created: false`, returning the stored
  unit (with its stored `admittedAt`, so the caller sees which time counts);
- different graph, seed or principal: `TurnEvidenceConflictError`, as now.

The stored record, its `admissionDigest` and the journey are unchanged: the
digest still covers the stored `admittedAt`. Only the replay comparison
changes.

## Costs and questions

- It changes observable behaviour (a call that throws today would succeed),
  so every store must change together: `MemoryUnitStore`, the conformance
  suite (`unit-store-conformance.ts` asserts the conflict), and
  switchyard-postgres's SQL routine. That is a coordinated minor release of
  both packages, not a switchyard-only change.
- A caller that re-admits with a *later* time on purpose (to say "this unit
  arrived again") would silently keep the first time. Nothing in switchyard
  reads that intent today; the returned stored `admittedAt` makes it visible.
- Alternative: an explicit, caller-chosen `admissionKey` compared instead of
  the digest. More general, but a new field in the admission record and the
  wire, for a problem the identity change already solves.

Recommendation: adopt the identity change together with the next
switchyard-postgres minor after 0.2.0, with a conformance case for "same
identity, new `admittedAt` replays".

# P7 join inputs and P8 declared failures

Implemented on 2026-09-11 at the user's request in unreleased engine 2.1.0.
The SDK remains a separate, unreleased 0.1.0 package. These changes add an
optional join key and helper modules; they add no store migration and change
no existing fixture graph seals. The verification below records the reviewed
pre-commit candidate. The user subsequently authorized committing/pushing this
branch and pinning Inbox to the resulting immutable commit. This record does
not establish a published release, merge readiness, or independent consumer
agreement on provider accounting; downstream evidence has its own record.

## P7: embedded accepted-branch inputs

`SwitchyardJoin.compose?: "select" | "envelope"` is implemented.
Omitting the key retains the old sealed bytes and selection behavior. Explicit
`"select"` has the same runtime behavior but, as additional definition data,
changes the graph digest. Unknown values and present `undefined` are rejected.

An envelope join must declare this input:

```ts
import { JOIN_INPUT_ARTIFACT_CONTRACT } from "@scshafe/switchyard";

// Fields of an otherwise complete node definition:
const aggregation = {
  input: JOIN_INPUT_ARTIFACT_CONTRACT, // switchyard.join-input.v1
  join: {
    inbound: ["facts-to-aggregate", "policy-to-aggregate"],
    require: "all" as const,
    compose: "envelope" as const
  }
};
```

The compiler permits different source contracts only for an envelope-join
target. Ordinary and select targets still require the carried contract, even
when another target on the same fan-out uses an envelope. Source declared
outputs are still enforced at completion. The join body receives the aggregate
payload as its normal input; it receives no store capability.

`JoinInputPayload` contains:

- `schemaVersion: "switchyard.join-input.v1"`, `unitId`, exact `graph`
  ref, `nodeId`, `nodeRef`, optional join `configuration`, and sealed `require`.
- `accepted`, in sealed `join.inbound` order. Each entry contains `edgeId`,
  `sourceNodeId`, `sourceNodeRef`, optional `sourceConfiguration`,
  `sourceQueueId`, `sourceEvidenceDigest`, canonical ISO `offeredAt`, and the
  full source `artifact` envelope with embedded payload. Optional artifact
  `bytes` presence is preserved per offer even when retention deduplicates
  equal contract/digest pairs.

`sourceQueueId` is absent only for an engine-synthesized
`join_unsatisfiable` source. Such an entry must name a join source, its reserved
output contract, and a matching edge; the store additionally proves the
retained synthetic journey evidence.

The envelope includes every offer accepted when the join resolves. A duplicate
or later offer is a recorded no-op and cannot change its queued input. For
`nOf`, the accepted subset may depend on arrival order. More than n offers can
be accepted when several matching inbound edges arrive in one settlement.
Canonical order gives identical envelope bytes for identical accepted evidence
in any supplied order; it does not erase differing source occurrences, times,
or evidence digests. The target queue ID is deliberately absent. Existing
`QueueJoinProvenance.selectedEdgeId` stays the first accepted sealed-order
anchor; envelope execution consumes all embedded accepted payloads.

The following exports are available from the root and `store/join-input`:

```ts
createJoinInputArtifact(definition, { unitId, nodeId, accepted });
validateJoinInputArtifact(definition, artifact);
```

Creation input entries omit `sourceNodeRef` and `sourceConfiguration`; the
helper derives them from the sealed definition. Validation checks strict shape,
artifact seals, exact graph/source/join identities, configuration refs, the
threshold, and canonical order. Both helpers return detached, recursively
frozen data with prototype-free records. They validate a document's identity;
they cannot authenticate caller-supplied queue IDs or evidence digests without
a store. `MemoryUnitStore` proves those against retained source queues,
settlements, accepted routing effects, and synthetic journey records.

The aggregate shares the ordinary artifact budget: maximum depth 64,
250,000 values, and 16,777,216 string code units across the whole envelope,
including embedded payloads. These are not separate allowances per branch.
An oversized aggregate fails the settlement transaction, leaving its lease
and prior state intact; a host must bound its branch payloads accordingly.

Envelope retention, provenance, queueing, and outbox/journey effects use the
existing atomic settlement transaction and all eight crash checkpoints.
Memory snapshot restore reconstructs the input from accepted source evidence;
a newly sealed but forged aggregate, late-offer injection, inconsistent source
occurrence, or mismatched threshold/progress is rejected. Pending, queued,
settled, and synthetic-source cases are covered without changing the snapshot
version or default select representation.

The graph display projection preserves optional composition. The static SDK
validates it and labels envelope inputs “accepted branch payload envelope”.
Old omitted-composition golden models remain unchanged. This adds no runtime
readiness, metrics, or aggregation controls to the viewer.

## P8: explicit failure-to-outcome policy

`withDeclaredFailureOutcomes` is exported from the root and
`execute/declared-failures`. It wraps code, model, or agent ports. Options are
`{ kind, outcomes, artifact, receipt? }`, where `outcomes` maps failure codes
to node-declared outcomes. The node's outcome and output-contract validation
still applies; this helper cannot grant a new outcome or route directly.

The wrapped host port receives a trailing invocation-local evidence capability:

| Kind | Port methods | Fallback receipt policy |
| --- | --- | --- |
| `code` | `run(input, context, evidence)` | Forbidden; code never records usage |
| `model` | `invoke(input, binding, context, evidence)` | Required; returns exactly one receipt as a one-element tuple |
| `agent` | `submitTurnIntent(input, context, evidence)` and `awaitSettledResult(context, evidence)` | Optional; returns an array of at most 256 receipts; omission explicitly permits an empty collection |

`artifact` and `receipt` callbacks may be asynchronous. Each receives a
`DeclaredFailureInvocation`: `kind`, `operation` (`code_run`, `model_invoke`,
`agent_submit`, or `agent_await`), original input, context, optional model
binding, classified failure, and captured evidence. Records and arrays are
detached and frozen, with prototype-free records; the context's validated
AbortSignal remains a trusted live capability. Callbacks see the original
captured evidence, not receipts subsequently generated by the fallback policy.
Methods, callbacks, and the mapping are captured at construction, so later
mutation cannot replace them. Accessor/Proxy options and malformed evidence
are rejected without executing hostile getters/traps.

The capability has three methods:

- `setAdmission("unknown" | "not_admitted" | "admitted")`: defaults to
  `unknown`; the host supplies its knowledge. An admitted invocation cannot
  downgrade. `not_admitted` rejects positive charged or observed usage.
- `recordUsage(receipt)`: validate and detach a physical receipt. At most one
  for a model, at most 256 for an agent, and none for code. A nonempty captured
  collection takes precedence and skips the fallback receipt callback entirely.
- `markUnresolved()`: prevent mapping a rejection while work is unresolved.
  A subsequent returned settled completion remains authoritative.

A fixture-only pre-dispatch example makes no provider call:

```ts
import {
  createArtifactEnvelope,
  ExecutionFailureError,
  withDeclaredFailureOutcomes
} from "@scshafe/switchyard";

const port = withDeclaredFailureOutcomes({
  async invoke(_input, _binding, _context, evidence) {
    evidence.setAdmission("not_admitted");
    throw new ExecutionFailureError("provider_refused", false);
  }
}, {
  kind: "model",
  outcomes: { provider_refused: "review" },
  receipt: () => [{
    schemaVersion: "usage-receipt.v1",
    trust: "provider_reported",
    observedInputTokens: 0,
    observedOutputTokens: 0,
    observedCostMicroUsd: 0,
    chargedTokens: 0,
    chargedCostMicroUsd: 0,
    durationMs: 0
  }],
  artifact: ({ input, failure, evidence }) => createArtifactEnvelope(
    "review-input.v1", { input, reason: failure.code, admission: evidence.admission }
  )
});
```

The node must declare `review` and its appropriate output contract/route.
The zero receipt is scripted fixture evidence in the `provider_reported`
shape, justified only by this fixture's definite lack of dispatch. It asserts
no real provider telemetry. The existing `unavailable` receipt contract has a
positive charge floor and cannot represent this zero-usage fixture.
The helper never infers free or paid work from a failure code and never invents
telemetry or a sealed-tier ceiling. Real host policies must choose accounting
from actual admission, retained receipts, binding identity, and replay evidence.
Tests using fixtures do not constitute independent consumer policy agreement.

Unmapped failures pass through. Untyped agent submit/await failures remain
unresolved for same-key reclaim; only a definite typed `ExecutionFailureError`
is eligible for agent mapping. Abort signals, recognized cancellation errors,
and a marked-unresolved rejection bypass mapping. A mapped submit failure is
held until its matching await; the engine supplies the same context object to
both. Agent capture stays open across successful submit until await ends.
Wrapper state is process-local; a reclaimed worker submits the underlying host
intent with the same attempt key and relies on the host's durable deduplication.
No new durable agent state is created.

Validated captured or policy receipts survive fallback artifact construction
and validation failures in private evidence bound to the exact node/attempt.
Valid receipt prefixes survive a later malformed policy receipt. The runner
uses that evidence for its failure journal and usage outbox; arbitrary `usage`
fields on thrown errors grant no authority. Unmapped object errors preserve
identity and can carry this private evidence; an unmapped primitive throw
preserves its primitive identity but cannot retain object-keyed usage. Hosts
with captured physical usage should throw an Error object. Mapped primitive
failures that fail recovery retain usage on the generated recovery error.
Returned completions retain the existing validation/receipt rules and are not
reclassified or remapped after engine rejection.

## Verification and status

`npm run build && npm run release:manifest && npm run check` exited **0**
on 2026-09-11 after implementation, shipped README changes, and the downstream
restore fast path:

- Engine: **341/341 passed**, no failures, cancellations, skips, or todo.
  This adds 3 compiler/display cases, 13 join-helper/memory-restore cases,
  13 backend-neutral UnitStore conformance cases, and 17 declared-failure
  cases to the static phase's 295. UnitStore conformance now has **46 cases**;
  the memory wrapper runs those plus 8 existing snapshot cases.
- SDK: **95/95 passed**, no failures, cancellations, skips, or todo: 42 core,
  21 browser-wiring, 15 server/assets, and 17 viewer-data cases. The added
  composition case covers projection/model validation and real ELK server
  rendering. Existing golden models remain byte-identical.
- Exact manifested payloads: **138 engine files / 34 SDK files**. The two new
  engine modules account for six source/JavaScript/declaration files. SDK
  dependencies and private witness remain outside the engine payload.
- Reproducible archives, raw-NUL/import boundaries, offline packed runtime and
  strict TypeScript consumption, real ELK server rendering, and complete local
  viewer asset closure passed. The packed API smoke checks P7/P8 exports and
  rejects missing model receipt policy and invalid composition in TypeScript.
- Engine archive SHA-256:
  `0840d6de71d6d799917d27e70364ead710c331304475a96c1323a79d5816fff1`.
- SDK archive SHA-256:
  `aae71ee1f76fb61745ad9d90f7e54cfcaa07b51f7dee1eb89515cdb02c87cbfd`.
- The exact P8 documentation example was extracted and executed through
  `executeNodeTurnAttempt`; its declared review outcome, artifact contract,
  and scripted zero receipt passed validation (exit 0).
- At the recorded pre-commit verification, `git diff --check` passed. Branch was
  `codex/2.1.0-engine-projections`, HEAD
  `f8c8a8de6a7980d005dfb84811d4f923d2478fc2`. Existing static viewer fixes are
  preserved; fixture definitions/seals, package versions, and frozen schemas
  were unchanged. No commit, push, merge, publication, or user-server restart
  had been performed at that point. Those checks did not establish a
  fresh-clone result for the then-uncommitted tree.

Downstream inspection found redundant compilation during restore for graphs
without envelope joins. Restore now skips only that extra envelope pass after
ordinary graph/queue/journey validation. An alternating five-sample local
Node 22 benchmark (ten units, sixteen-node graph, five restores per sample)
measured median 712.0 ms before and 550.2 ms after, with identical snapshots.
This is a narrow local measurement, not a production latency qualification.
The complete ordered gate above was rerun after this change.

The first ordered gate passed 340 engine tests and failed only the explicit
execution import allowlist, which had not yet listed the new helper. Adding
that exact module retained the dependency restrictions; its targeted boundary
suite and the subsequent full ordered gate passed. An independent doc review
also caught an invalid zero-charge `unavailable` example before finalizing the
record; the corrected fixture above was executed as described. The final
verification-record update is outside both package payloads.

The [static Browser record](VERIFY-GRAPHPAPER-STATIC-ADAPTERS.md) predates this
engine slice. Its supported browser witness remains evidence for those static
fixes; no new P7/P8 Browser witness is claimed. Reduced-motion activation,
touch/pen, screen readers, cross-browser and deployed-consumer checks remain
outside that evidence.

## Remaining integration and recommended next slice

Durable stores must implement envelope construction and retention inside their
existing settlement transaction, preserve exact accepted provenance, validate
restored state appropriately, and run the expanded UnitStore conformance suite.
The engine slice itself made no consumer changes. Subsequent Inbox adoption
in `/Users/example/.openclaw/workspace/projects/inbox-pipeline` has its own
`docs/ENGINE_1_1_ADOPTION.md` record, including exact candidate-package gates
and remaining dependency/publication limitations. No store migration is part
of P7; adapters must not claim envelope support until they establish these
semantics and pass the expanded conformance suite.

The user has approved the engine commit/push and dependency integration. Next,
pin the Inbox source candidate to the actual immutable commit and run clean-install
verification. Its no-migration P7/P8 adoption does not provide the separate P2
SQL publication capability; full GraphStore parity needs that independently
authorized revision. Real-provider qualification, durable agent consumer replay
and an independent second consumer remain unverified. Merge and release still
require their own decisions. Runtime overlays, metrics/proposal viewer modes,
`update`, and goal scopes remain proposals.

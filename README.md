# mission-pipeline

The standalone Mission Pipeline engine, promoted from the `inbox-pipeline`
repo into an independently versioned package. The shipped v1 surface is a
closed catalog of digest-sealed definitions compiled to a static DAG. The
additive v2 surface now begins with the N1 node-graph contracts/compiler: typed
outcomes, deterministic outcome predicates, per-target joins, terminal
outcomes, sealed graph definitions, and frozen inbound/outbound indexes. There
is deliberately NO routing DSL, dynamic stage loading, or runtime mutation of
a published definition. Every contract artifact is addressed by the canonical-
JSON SHA-256 rule shared with the frozen `execution-contracts` package.

**STANDALONE constraint** (enforced by `test/import-boundary.test.mjs`): this
package imports `node:` builtins and its own relative files ONLY — never
`mc-*` packages, never `zod`, and never any production npm dependency.
Consumers install a versioned release of this repository. The frozen JSON
Schemas it speaks are MIRRORED under `schemas/` (pin-tested byte-for-byte
against `test/fixtures/mission-pipeline/`), never imported.

## Module map

B1 ships the contracts core:

- `src/contracts/digest.ts` — canonical-JSON serialization + SHA-256 digests
  (`canonicalJson` / `digest` / `rawBodyDigest`), ported byte-identically in
  behavior from `inbox-pipeline/src/hash.ts` (golden-vector proven).
- `src/contracts/artifact.ts` — the ContractId grammar (`<name>.v<number>`),
  `ArtifactRef` (content-addressed reference), and the digest-sealed
  `ArtifactEnvelope` with LOUD hand-written validators (de-Zod-ed from
  `inbox-pipeline/src/runtime/contracts.ts`).
- `schemas/` — checked-in mirrors of the frozen `execution-contracts` schemas:
  `artifact-ref.v1`, `environment-descriptor.v1`, `usage-receipt.v1`.

B2 ships the static model: `src/node.ts` (StageDescriptor + CodeStage),
`src/definition.ts` (digest-sealed PipelineDefinition), `src/catalog.ts`
(StageCatalog with ATOMIC register + the ContractValidator port), and
`src/compile.ts` (compilePipeline with the compile-time parity check and gate
terminality).

Node-graph v2 N1 ships additively beside those v1 execution surfaces:

- `src/graph/outcome.ts` — the non-empty, unique `OutcomeVocabulary`, tied to
  the owning versioned node ref.
- `src/graph/edge.ts` — stable edge identities and the closed predicate
  language `{outcome} | {anyOf} | {outcome, where:[{pointer,equals}]}`. Pointers
  are RFC 6901 over the sealed output `ArtifactEnvelope`; conditional arms are
  additive and do not silently become defaults.
- `src/graph/definition.ts` — `MissionPipelineNode` for
  `code|model|agent|human|callback`, explicit per-node principals and joins,
  terminal outcomes, and canonical-JSON SHA-256 sealed `GraphDefinition`.
- `src/graph/compile.ts` — `compileGraph`: exact outcome completeness,
  references, reachability, joins, and binding rules, producing deeply frozen
  authored-order node/edge indexes. Aggregate validation budgets reject hostile
  inputs before recursive snapshotting/canonicalization. This compiler
  intentionally does not inherit v1 DAG/cycle or gate-terminality rules.

N1 is contracts only: unit journeys, queues, turn execution, join progress,
stores, and provider/host bindings land in later v2 phases. The v1 execution
surfaces remain untouched until the explicit N10 deletion phase.

B3 ships durable execution:

- `src/store.ts` — the host-neutral `PipelineStore` port (definition
  publish/load; createRun; leaseToken-fenced shard claim/heartbeat/complete/
  fail/defer/cancel; idempotency-key stage reservation; atomic transactional-outbox
  persistence; shard-fenced standalone dead-letter recording; content-addressed
  artifacts; auxiliary work leases), plus the ownership-free
  `BoundPipelineEvidenceStore<TFence>` port for a host that already owns the
  execution fence. The append-only invariant lives in its doc comments: only
  leases mutate.
- `src/memory-store.ts` — a full in-memory PipelineStore for hermetic tests
  (enforces fencing, append-only, and outbox atomicity).
- `src/execute/durable-stage.ts` — the durable executor (idempotency key =
  digest of `{runId,itemId,nodeId,stageId,version,fingerprint,inputDigest}` plus
  `executionIdentityDigest` on externally bound execution; cached reuse;
  bounded retries; dead-letter exactly once; retryable-vs-terminal taxonomy)
  promoted from inbox durable-executor.ts + worker/service.ts. `nodeId` keeps
  two uses of the same stage in one DAG distinct.
- `src/execute/control.ts` — typed non-failure shard control outcomes:
  transient host-authority contention defers/requeues without an attempt, while
  obsolete work is conclusively cancelled without fabricated failure evidence.
- `src/execute/shard-runner.ts` — claim ONE shard, run the compiled nodes in
  order per item with per-item failure isolation, heartbeat, finalize,
  release; `NodeInvoker` port (+ fake) for model/agent/gate kinds (B4/B5/B6).
  It also exports `runBoundShard` (`executeClaimedShard` alias): the same
  node-walk and durable-stage implementation under an externally owned fence,
  with no claim/heartbeat/settlement authority.
- `sql/reference/pipeline-store.sql` — documented DDL templates mirroring the
  port. NEVER auto-applied; hosts own migrations.

### Externally fenced execution

Use `runBoundShard` when a host scheduler—not Mission Pipeline—owns the work
lease. The API makes the authority split structural:

```text
host claim/fence
      │
      ▼
runBoundShard
  ├─ validates sealed compiled DAG + item digests
  ├─ invokes nodes and applies Pipeline retry/idempotency policy
  ├─ appends through BoundPipelineEvidenceStore<TFence>
  └─ returns completed | partial | failed | opaque control
      │
      ▼
host validates outcome and atomically settles/releases its lease
```

`BoundPipelineEvidenceStore<TFence>` contains only
`prepareStageExecution`, `persistStageSuccess`, `persistStageFailure`, and
`recordDeadLetter`. Every operation receives the exact opaque `fence` value.
The host adapter must verify that fence in the same transaction as the
evidence append and throw `ExternalFenceRejectedError` when stale. Pipeline
passes that rejection through unchanged.

The bound runner never claims, heartbeats, completes, fails, defers, cancels,
or releases work. A node can throw `PipelineControlOutcomeError(payload)` to
return `status: "control"` with `payload` uninspected and unchanged; the host
validates its own dependency/continuation/delivery contract and parks or
settles work itself. Existing `runOneShard` remains the compatibility path for
hosts that deliberately use Pipeline-owned shard leases.

The Job Application Platform production entry path is deliberately
`runOneShard`: compiled definitions, `StageCatalog`, and `PipelineStore` own
its shard lifecycle. `runBoundShard` is a generic package API and is not that
platform's production entry path. Selecting it there would require an
explicit architecture/gate amendment; it must not happen as a silent pin
update.

### Delivery semantics in v0.2

Version 0.2 executes only `at_least_once_idempotent` nodes. If any compiled
node declares `at_most_once`, both runners reject the entire DAG before any
stage invocation or stage-evidence reservation. A process can crash after a
physical effect but before evidence commits, so honest at-most-once support
requires a separate durable intent plus `unapplied | applied | indeterminate`
reconciliation protocol. This release does not pretend otherwise.

B4 ships the model node kind + prompt module:

- `src/contracts/usage-receipt.ts` — the `usage-receipt.v1` runtime type +
  LOUD validator hand-written against the frozen schema mirror, INCLUDING the
  code-side CONVENTIONS §5 rules the schema cannot express: the non-silent-zero
  floor (trust ∈ {estimated_tier_ceiling, unavailable} ⇒ charged ≥ 1) and
  charged-covers-observed.
- `src/prompt/contracts.ts` — digest-sealed PromptComponent / PersonaDefinition
  / PromptStackDefinition (de-Zod-ed from inbox src/prompts/contracts.ts) plus
  the CODE-OWNED `CodeOwnedPromptContract` (safety / task / output text always
  comes from host code, never operator data).
- `src/prompt/compiler.ts` — `compilePromptStack`: deterministic, digest-pinned
  compilation with the FIXED ownership order — code-owned safety FIRST,
  operator components between task and output, code-owned output-contract line
  LAST (components can add emphasis, never remove policy / enable tools /
  change the result schema); `validateCompiledPrompt` recomputes both the
  rendered systemPrompt and the promptDigest.
- `src/model/binding.ts` — the digest-sealed `ModelStageBinding`
  (modelRevisionRef + EMBEDDED fail-closed inference parameters + optional
  persona/promptStack refs); any recorded-parameter change changes the
  bindingDigest → the compiled bindingFingerprint → the B3 idempotency key.
- `src/model/invoker.ts` — the `ModelBindingResolver` port +
  `createModelNodeInvoker` (the kind:"model" NodeInvoker arm): binding
  resolution by fingerprint (digest must match — LOUD), the promoted
  prompt-identity check, optional inference-concurrency leases, and THE
  RECEIPT FLOOR — every completed call must return a valid receipt or the item
  fails TERMINAL (closing the inbox classification silent-zero gap at
  framework level); `createModelReceiptLedger` rides every admitted receipt
  through the transactional outbox with its exact successful or failed
  attempt.

B5 ships the decision/gate executor:

- `src/gate/contracts.ts` — digest-sealed goal, objective, validity, budget,
  flow, transition, and step-outcome contracts.
- `src/gate/compiler.ts` — static decision-flow compilation with cycle,
  terminal-exhaustiveness, escalation-monotonicity, and budget proofs.
- `src/gate/certificate.ts` — recomputed termination certificates.
- `src/gate/executor.ts` — closed-registry gate execution, model receipt
  enforcement, and deduplicated human-escalation evidence.

B6 ships the frozen agent-step contract and executor port:

- `src/agent/step.ts` — strict request/result validation against the frozen
  agent-step schema mirrors.
- `src/agent/executor-port.ts` — the agent node invoker, output-contract
  coupling, deadline/status routing, and transactional usage-receipt ledger.
- `src/agent/fake-executor.ts` — a deterministic hermetic test executor.

## Development

Use the Node version pinned in `.node-version`.

```sh
npm ci
npm run verify
npm run test:postgres:reference
npm run test:fresh-clone
```

`npm run verify` removes and rebuilds the committed `lib/` artifacts, runs the
independent contract, model, durable-execution, gate, agent, and import-boundary
suites, proves that the tracked build is reproducible, checks the exact package
payload, and installs the resulting tarball into a fresh consumer for runtime
and TypeScript export smoke tests.

The PostgreSQL reference gate is separate because it requires an exact local
PostgreSQL 18.4 toolchain. It initializes a disposable, Unix-socket-only
cluster, applies the reference DDL with `ON_ERROR_STOP`, verifies all 14
tables, stops the cluster, and removes the temporary state. It never connects
to or mutates a host database.

`test:fresh-clone` is the final committed-candidate gate. It refuses a dirty
source checkout, creates an independent `git clone --no-local` at the exact
HEAD, installs solely from the local npm cache in offline mode, runs the full
verification suite, and requires the verified clone to remain clean. It is
kept outside `verify` to avoid recursive clone verification.

## History

This repository was extracted with package-level history from
`packages/mission-pipeline` in Mission Control through source commit
`74081469646d8d50f1e5922e28f818a4330306fb`.

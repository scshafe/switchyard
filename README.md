# mission-pipeline

The static compiled-DAG pipeline engine, promoted from the `inbox-pipeline` repo
into an independently versioned package: pipelines are a CLOSED
catalog of digest-sealed, content-addressed definitions compiled to a static DAG
and executed node-by-node — there is deliberately NO DSL, no dynamic stage
loading, and no runtime mutation of a published definition. Every contract
artifact (definitions, bindings, node inputs/outputs) is addressed by the
canonical-JSON SHA-256 rule shared with the frozen `execution-contracts`
package, so digests are byte-identical across repos.

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

B3 ships durable execution:

- `src/store.ts` — the host-neutral `PipelineStore` port (definition
  publish/load; createRun; leaseToken-fenced shard claim/heartbeat/complete/
  fail/defer/cancel; idempotency-key stage reservation; atomic transactional-outbox
  persistence; shard-fenced standalone dead-letter recording; content-addressed
  artifacts; auxiliary work leases). The append-only invariant lives in its
  doc comments: only leases mutate.
- `src/memory-store.ts` — a full in-memory PipelineStore for hermetic tests
  (enforces fencing, append-only, and outbox atomicity).
- `src/execute/durable-stage.ts` — the durable executor (idempotency key =
  digest of {runId,itemId,stageId,version,fingerprint,inputDigest}; cached
  reuse; bounded retries; dead-letter exactly once; retryable-vs-terminal
  taxonomy) promoted from inbox durable-executor.ts + worker/service.ts.
- `src/execute/control.ts` — typed non-failure shard control outcomes:
  transient host-authority contention defers/requeues without an attempt, while
  obsolete work is conclusively cancelled without fabricated failure evidence.
- `src/execute/shard-runner.ts` — claim ONE shard, run the compiled nodes in
  order per item with per-item failure isolation, heartbeat, finalize,
  release; `NodeInvoker` port (+ fake) for model/agent/gate kinds (B4/B5/B6).
- `sql/reference/pipeline-store.sql` — documented DDL templates mirroring the
  port. NEVER auto-applied; hosts own migrations.

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
```

`npm run verify` removes and rebuilds the committed `lib/` artifacts, runs the
independent contract, model, durable-execution, gate, agent, and import-boundary
suites, proves that the tracked build is reproducible, checks the exact package
payload, and installs the resulting tarball into a fresh consumer for a runtime
export smoke test.

## History

This repository was extracted with package-level history from
`packages/mission-pipeline` in Mission Control through source commit
`74081469646d8d50f1e5922e28f818a4330306fb`.

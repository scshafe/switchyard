# mission-pipeline

The static compiled-DAG pipeline engine, promoted from the `inbox-pipeline` repo
into a standalone Mission Control workspace package: pipelines are a CLOSED
catalog of digest-sealed, content-addressed definitions compiled to a static DAG
and executed node-by-node — there is deliberately NO DSL, no dynamic stage
loading, and no runtime mutation of a published definition. Every contract
artifact (definitions, bindings, node inputs/outputs) is addressed by the
canonical-JSON SHA-256 rule shared with the frozen `execution-contracts`
package, so digests are byte-identical across repos.

**STANDALONE constraint** (enforced by `test/import-boundary.test.mjs`, tests
D+E): this package imports `node:` builtins and its own relative files ONLY —
never `mc-*` workspace packages, never `zod`, never any npm dependency. Other
codebases consume it ALONE via `file:`/`link:` deps (`mc-error-client` is the
precedent). The frozen JSON Schemas it speaks are MIRRORED under `schemas/`
(pin-tested byte-for-byte against `test/fixtures/mission-pipeline/`), never
imported.

## Module map

B1 (this increment) ships the contracts core:

- `src/contracts/digest.ts` — canonical-JSON serialization + SHA-256 digests
  (`canonicalJson` / `digest` / `rawBodyDigest`), ported byte-identically in
  behavior from `inbox-pipeline/src/hash.ts` (golden-vector proven).
- `src/contracts/artifact.ts` — the ContractId grammar (`<name>.v<number>`),
  `ArtifactRef` (content-addressed reference), and the digest-sealed
  `ArtifactEnvelope` with LOUD hand-written validators (de-Zod-ed from
  `inbox-pipeline/src/runtime/contracts.ts`).
- `schemas/` — checked-in mirrors of the frozen `execution-contracts` schemas:
  `artifact-ref.v1`, `environment-descriptor.v1`, `usage-receipt.v1`.

Planned for B2+ (one module each, same STANDALONE rule): `node` · `definition`
· `catalog` · `compile` · `execute` · `store` · `memory-store` · `prompt` ·
`gate` · `agent`.

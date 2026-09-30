# @scshafe/switchyard Agent Contract

A managed library under the SCSHAFE library standard (`scshafe-library` v1).
It is published to GitHub Packages and deploys nothing. Read `README.md` and
`docs/DESIGN-NODE-GRAPH-V2.md` before meaningful changes.

## Invariants

- The package is dependency-free: `src/` imports `node:` built-ins and its own
  relative modules only (`test/import-boundary.test.mjs` enforces this). Never
  add a runtime dependency, database client, provider SDK or credential loader.
- There is no v1 traversal engine; `scripts/check-v1-deletion.mjs` keeps the
  retired paths and symbols out.
- `lib/` is build output and is never committed. Build it with
  `pnpm run build`.
- Toolchain is pnpm, pinned by `packageManager` (`pnpm@10.34.5`), with
  `pnpm-lock.yaml` committed and `strictDepBuilds: true`. Do not add
  `package-lock.json`.
- `.npmrc` holds only `@scshafe:registry=https://npm.pkg.github.com`. Never
  commit a credential, `_authToken` line or token to any file.
- The payload is the `files` whitelist in `package.json`; the release manifest
  `release/scshafe-switchyard-<version>.payload.sha256` pins every
  packed file's sha256. A payload change (including `package.json`, `README.md`
  or `CHANGELOG.md`) needs `pnpm run build && pnpm run release:manifest` in the
  same commit.
- Test and consumer imports use the scoped specifiers
  `@scshafe/switchyard` and `@scshafe/switchyard/<subpath>`.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm run verify             # v1 guard, build, tests, payload, release bytes, packed install
pnpm run test:fresh-clone   # clean committed HEAD only: clone, install, build, verify
```

CI (`.github/workflows/ci.yml`) runs the same `verify` on the Node matrix in
`engines` on GitHub-hosted runners. Libraries never use a self-hosted runner.

## Releasing

- SemVer; `package.json` `version` is the authority. A release commit bumps
  the version, adds `## <x.y.z> — <date>` to `CHANGELOG.md` and regenerates
  the release manifest.
- After `ci.yml` is green on `main`, the owning agent pushes the annotated tag
  `v<x.y.z>` on that `main` commit. `.github/workflows/publish.yml` is the only
  publisher: it refuses tags not on `main` or not equal to the version,
  verifies, publishes, installs the published version back, compares
  integrity, and creates the GitHub Release with the digests.
- Never run `pnpm publish` by hand, never reuse, move or delete a tag or a
  published version. A bad release is superseded by a higher patch version
  with a changelog note.
- No prereleases in v1; co-development with consumers uses `pnpm link`, which
  must never be committed in a consumer.

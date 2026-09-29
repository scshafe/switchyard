# Changelog

All notable changes to `@scshafe/mission-pipeline` are recorded here. Versions
follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused.

## 1.0.1 — 2026-09-29

First version published to GitHub Packages. No API or runtime behaviour change
from 1.0.0: `src/`, `lib/` and `schemas/` are byte-identical to 1.0.0; only
`package.json`, `README.md` and `CHANGELOG.md` differ in the payload.

- Renamed to `@scshafe/mission-pipeline` and published to
  `https://npm.pkg.github.com`. Consumers change `mission-pipeline/<subpath>`
  import specifiers to `@scshafe/mission-pipeline/<subpath>` and map the
  `@scshafe` scope to GitHub Packages in their `.npmrc`.
- `repository.url` is the HTTPS GitHub URL (GitHub Packages requires it to
  match the repository).
- Toolchain: pnpm 10 (`packageManager: pnpm@10.34.5`, `pnpm-lock.yaml`)
  replaces npm.
- `lib/` is no longer committed; it is built from `src/` by `prepack`, CI and
  the publish workflow. Reproducibility is proven by packing twice.
- The payload now includes `CHANGELOG.md`; the release manifest is
  `release/scshafe-mission-pipeline-1.0.1.payload.sha256`, and the payload
  scan also rejects token-shaped strings.

## 1.0.0

Node-graph-only major release (never published to a registry; consumed by
git commit and vendored bytes). The 1.0.0 payload manifest remains in git
history at `release/mission-pipeline-1.0.0.payload.sha256`.

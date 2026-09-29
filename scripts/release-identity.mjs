// The release identity (package name, version, payload-manifest path) is
// derived from package.json so a rename or version bump never leaves a stale
// hardcoded path behind in the release checks.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));

// `@scope/name` -> `scope-name`, the same base npm/pnpm use for the tarball.
export function releaseBaseName(name) {
  if (typeof name !== "string" || !/^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name)) {
    throw new Error(`unexpected release package name: ${String(name)}`);
  }
  return name.replace(/^@/, "").replace("/", "-");
}

export async function readReleaseIdentity(root = projectRoot) {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const { name, version } = packageJson;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be a release version (got ${String(version)})`);
  }
  const manifest = `release/${releaseBaseName(name)}-${version}.payload.sha256`;
  return { name, version, manifest, packageJson };
}

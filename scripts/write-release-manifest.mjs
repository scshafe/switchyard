// Write release/<package-name>-<version>.payload.sha256 for the engine and SDK from fresh
// `npm pack`: one line per packed entry, `<sha256>  <path>`, in code-unit
// path order. The digests are taken from the packed bytes exactly as
// check-release-artifact.mjs reads them back, so the manifest and the check
// cannot disagree about what a release contains. Run after `npm run build`
// and before committing a payload change; the check then pins it.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-manifest-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`);
  }
  return stdout;
}

async function writeManifest(packageRoot) {
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const name = packageJson.name;
  if (name !== "mission-pipeline" && name !== "mission-pipeline-graphpaper") {
    throw new Error(`unexpected release package name: ${String(name)}`);
  }
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`package.json version must be a release version (got ${String(version)})`);
  }
  const report = JSON.parse(
    await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: packageRoot })
  );
  if (report.length !== 1 || typeof report[0].filename !== "string") {
    throw new Error("npm pack did not produce exactly one artifact");
  }
  const tarball = join(scratch, report[0].filename);
  const entries = (await run("tar", ["-tzf", tarball]))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/")) throw new Error(`package entry lacks package/ root: ${entry}`);
      const path = entry.slice("package/".length);
      if (path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`unsafe package entry path: ${entry}`);
      }
      return path;
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (new Set(entries).size !== entries.length) throw new Error("package archive contains duplicate paths");

  const lines = [];
  for (const path of entries) {
    // Payload entries are text (the payload check rejects NUL bytes); hash the
    // same UTF-8 bytes check-release-artifact.mjs hashes when it reads them back.
    const content = await run("tar", ["-xOzf", tarball, `package/${path}`]);
    lines.push(`${createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex")}  ${path}`);
  }
  const manifestPath = resolve(root, "release", `${name}-${version}.payload.sha256`);
  await writeFile(manifestPath, `${lines.join("\n")}\n`, "utf8");
  console.log(JSON.stringify({ result: "written", manifest: `release/${name}-${version}.payload.sha256`, fileCount: entries.length }));
}

try {
  await writeManifest(root);
  await writeManifest(resolve(root, "packages/mission-pipeline-graphpaper"));
} finally {
  await rm(scratch, { force: true, recursive: true });
}

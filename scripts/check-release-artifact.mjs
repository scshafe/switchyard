import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifestPath = resolve(
  root,
  "release/mission-pipeline-1.0.0.payload.sha256"
);
const scratch = await mkdtemp(join(tmpdir(), "mission-pipeline-release-"));

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding(options.encoding ?? "utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`
    );
  }
  return stdout;
}

function hash(algorithm, bytes, encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function parseManifest(text) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([a-f0-9]{64})  ([^\0\r\n]+)$/.exec(line);
    if (!match) {
      throw new Error(`invalid release manifest line ${index + 1}`);
    }
    const [, digest, path] = match;
    if (
      path.startsWith("/")
      || path.split("/").includes("..")
      || entries.has(path)
    ) {
      throw new Error(`unsafe or duplicate release manifest path: ${path}`);
    }
    entries.set(path, digest);
  }
  if (entries.size === 0) throw new Error("release manifest is empty");
  return entries;
}

async function pack(destination) {
  await mkdir(destination);
  const report = JSON.parse(
    await run("npm", [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination
    ])
  );
  if (report.length !== 1 || typeof report[0].filename !== "string") {
    throw new Error("npm pack did not produce exactly one artifact");
  }
  return {
    report: report[0],
    path: join(destination, report[0].filename)
  };
}

try {
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  const first = await pack(join(scratch, "first"));
  const second = await pack(join(scratch, "second"));
  const firstBytes = await readFile(first.path);
  const secondBytes = await readFile(second.path);
  const firstSha256 = hash("sha256", firstBytes);
  const secondSha256 = hash("sha256", secondBytes);
  if (firstSha256 !== secondSha256) {
    throw new Error(
      `two clean npm packs were not byte-reproducible: ${firstSha256} != ${secondSha256}`
    );
  }
  const shasum = hash("sha1", firstBytes);
  const integrity = `sha512-${hash("sha512", firstBytes, "base64")}`;
  for (const packed of [first, second]) {
    if (packed.report.shasum !== shasum || packed.report.integrity !== integrity) {
      throw new Error("npm pack shasum/integrity report does not match artifact bytes");
    }
  }

  const verbose = await run("tar", ["-tvzf", first.path]);
  for (const line of verbose.trim().split(/\r?\n/)) {
    if (line.length > 0 && line[0] !== "-" && line[0] !== "d") {
      throw new Error(`non-regular package entry rejected: ${line}`);
    }
  }
  const archiveEntries = (await run("tar", ["-tzf", first.path]))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/")) {
        throw new Error(`package entry lacks package/ root: ${entry}`);
      }
      const path = entry.slice("package/".length);
      if (
        path.length === 0
        || path.startsWith("/")
        || path.split("/").includes("..")
      ) {
        throw new Error(`unsafe package entry path: ${entry}`);
      }
      return path;
    });
  const archiveSet = new Set(archiveEntries);
  if (archiveSet.size !== archiveEntries.length) {
    throw new Error("package archive contains duplicate paths");
  }
  const missing = [...manifest.keys()].filter((path) => !archiveSet.has(path));
  const unexpected = [...archiveSet].filter((path) => !manifest.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `release manifest path mismatch: ${JSON.stringify({ missing, unexpected })}`
    );
  }

  const forbiddenBytes = [
    /\/Users\//,
    /\/home\//,
    /~\//,
    /\.openclaw/,
    /\.mission-control/,
    /\b(?:file|link|workspace):/
  ];
  for (const [path, expectedDigest] of manifest) {
    const content = await run("tar", ["-xOzf", first.path, `package/${path}`]);
    if (content.includes("\0")) {
      throw new Error(`raw NUL byte found in packed release entry ${path}`);
    }
    const actualDigest = hash("sha256", Buffer.from(content));
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `release manifest digest mismatch for ${path}: ${actualDigest} != ${expectedDigest}`
      );
    }
    for (const pattern of forbiddenBytes) {
      if (pattern.test(content)) {
        throw new Error(
          `mutable local/package-manager reference ${pattern} found in ${path}`
        );
      }
    }
  }
  console.log(JSON.stringify({
    result: "pass",
    filename: first.report.filename,
    fileCount: manifest.size,
    sha256: firstSha256,
    shasum,
    integrity
  }));
} finally {
  await rm(scratch, { force: true, recursive: true });
}

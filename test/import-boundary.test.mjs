import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import {
  dirname,
  join,
  relative,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "src");
const outputRoot = join(root, "lib");

function walk(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...walk(absolute, predicate));
    } else if (predicate(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

const importPatterns = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
];

test("production source imports only node: builtins and in-package relative modules", () => {
  const violations = [];
  for (const file of walk(sourceRoot, (path) => path.endsWith(".ts"))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          violations.push(`${relative(root, file)} -> ${specifier} (bare import)`);
          continue;
        }
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        if (!target.startsWith(`${sourceRoot}/`) || !existsSync(target)) {
          violations.push(`${relative(root, file)} -> ${specifier} (missing or escapes src)`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("v2 graph core transitively depends only on contracts and validation primitives", () => {
  const allowedFiles = new Set([
    "src/graph/limits.ts",
    "src/graph/outcome.ts",
    "src/graph/edge.ts",
    "src/graph/definition.ts",
    "src/graph/compile.ts",
    "src/graph/budget.ts",
    "src/graph/goals.ts",
    "src/graph/display.ts",
    "src/graph/diff.ts",
    "src/graph/approval-review.ts",
    "src/contracts/artifact.ts",
    "src/contracts/digest.ts",
    "src/internal/guards.ts",
    "src/internal/evidence.ts",
    "src/internal/capability.ts"
  ]);
  const allowedBuiltins = new Set(["node:crypto", "node:util"]);
  const pending = [...allowedFiles]
    .filter((path) => path.startsWith("src/graph/"))
    .map((path) => resolve(root, path));
  const visited = new Set();
  const violations = [];

  while (pending.length > 0) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) {
          if (!allowedBuiltins.has(specifier)) {
            violations.push(`${relative(root, file)} -> ${specifier} (builtin outside graph allowlist)`);
          }
          continue;
        }
        if (!specifier.startsWith(".")) {
          violations.push(`${relative(root, file)} -> ${specifier} (bare import)`);
          continue;
        }
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        const targetRelative = relative(root, target).split("\\").join("/");
        if (!allowedFiles.has(targetRelative)) {
          violations.push(`${relative(root, file)} -> ${targetRelative} (module outside graph allowlist)`);
          continue;
        }
        pending.push(target);
      }
    }
  }

  assert.deepEqual(violations, []);
  assert.deepEqual(
    [...visited].map((file) => relative(root, file).split("\\").join("/")).sort(),
    [...allowedFiles].sort()
  );
});

test("v2 turn core cannot reach v1 traversal/store/gate or host provider modules", () => {
  const allowedFiles = new Set([
    "src/execute/declared-failures.ts",
    "src/execute/failure.ts",
    "src/execute/ports.ts",
    "src/execute/turn.ts",
    "src/execute/turn-evidence.ts",
    "src/execute/unit-runner.ts",
    "src/contracts/artifact.ts",
    "src/contracts/digest.ts",
    "src/contracts/usage-receipt.ts",
    "src/graph/limits.ts",
    "src/graph/outcome.ts",
    "src/graph/edge.ts",
    "src/graph/definition.ts",
    "src/graph/compile.ts",
    "src/graph/approval-review.ts",
    "src/internal/guards.ts",
    "src/internal/evidence.ts",
    "src/internal/capability.ts"
  ]);
  const allowedBuiltins = new Set(["node:crypto", "node:util"]);
  const pending = [
    resolve(root, "src/execute/ports.ts"),
    resolve(root, "src/execute/turn.ts"),
    resolve(root, "src/execute/unit-runner.ts")
  ];
  const visited = new Set();
  const violations = [];

  while (pending.length > 0) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const pattern of importPatterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) {
          if (!allowedBuiltins.has(specifier)) {
            violations.push(`${relative(root, file)} -> ${specifier} (builtin outside v2 turn allowlist)`);
          }
          continue;
        }
        if (!specifier.startsWith(".")) {
          violations.push(`${relative(root, file)} -> ${specifier} (bare import)`);
          continue;
        }
        const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
        const targetRelative = relative(root, target).split("\\").join("/");
        if (!allowedFiles.has(targetRelative)) {
          violations.push(`${relative(root, file)} -> ${targetRelative} (module outside v2 turn allowlist)`);
          continue;
        }
        pending.push(target);
      }
    }
  }

  assert.deepEqual(violations, []);
  assert.deepEqual(
    [...visited].map((file) => relative(root, file).split("\\").join("/")).sort(),
    [...allowedFiles].sort()
  );
});

test("package declares no runtime or local-path dependencies", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(packageJson[field] ?? {}, {}, `${field} must remain empty`);
  }
  const serialized = JSON.stringify(packageJson);
  assert.doesNotMatch(serialized, /(?:file:|link:|workspace:|\/Users\/|[A-Za-z]:\\\\)/);
});

test("every source module has current JavaScript and declaration artifacts, with no orphans", () => {
  const sources = walk(sourceRoot, (path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  const expected = new Set();
  const missing = [];

  for (const source of sources) {
    const stem = relative(sourceRoot, source).replace(/\.ts$/, "");
    for (const extension of [".js", ".d.ts"]) {
      const artifact = join(outputRoot, `${stem}${extension}`);
      expected.add(artifact);
      if (!existsSync(artifact)) missing.push(relative(root, artifact));
    }
  }

  const orphans = walk(
    outputRoot,
    (path) => path.endsWith(".js") || path.endsWith(".d.ts")
  ).filter((path) => !expected.has(path)).map((path) => relative(root, path));

  assert.deepEqual({ missing, orphans }, { missing: [], orphans: [] });
});

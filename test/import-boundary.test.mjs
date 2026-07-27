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

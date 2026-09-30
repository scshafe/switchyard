// docs/FIRST-GRAPH.md and docs/first-graph-example/ must agree byte for byte:
// every file the guide shows (marked `<!-- file: NAME -->` before its fenced
// block) is the file in the example directory, and the directory holds
// nothing else except the pnpm-lock.yaml of the guide's install from the
// registry.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const guideUrl = new URL("../docs/FIRST-GRAPH.md", import.meta.url);
const exampleUrl = new URL("../docs/first-graph-example/", import.meta.url);

function filesInGuide(guide) {
  const files = new Map();
  const pattern = /<!-- file: ([^ ]+) -->\n```[a-z]*\n([\s\S]*?)```/g;
  for (const [, name, text] of guide.matchAll(pattern)) {
    assert.equal(files.has(name), false, `the guide shows ${name} twice`);
    files.set(name, text);
  }
  return files;
}

test("every file the guide shows is byte-identical in docs/first-graph-example", async () => {
  const guide = await readFile(guideUrl, "utf8");
  const shown = filesInGuide(guide);
  assert.ok(shown.size >= 10, `expected the guide to show the whole project, found ${shown.size} files`);
  for (const [name, text] of shown) {
    const actual = await readFile(new URL(name, exampleUrl), "utf8");
    assert.equal(actual, text, `docs/first-graph-example/${name} differs from the guide`);
  }
  const present = (await readdir(exampleUrl)).filter((name) => name !== "pnpm-lock.yaml").sort();
  assert.deepEqual(present, [...shown.keys()].sort());
});

test("the example pins the published packages the guide installs", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", exampleUrl), "utf8"));
  const guide = await readFile(guideUrl, "utf8");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
    assert.ok(guide.includes(`${name}@${version}`), `the guide installs ${name}@${version}`);
  }
  const lock = await readFile(new URL("pnpm-lock.yaml", exampleUrl), "utf8");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.ok(lock.includes(`'${name}':\n        specifier: ${version}`) || lock.includes(`${name}:\n        specifier: ${version}`),
      `pnpm-lock.yaml pins ${name} ${version}`);
  }
  // Not a local tarball or directory (pnpm writes those as file:...; the
  // setting excludeLinksFromLockfile is not one).
  assert.ok(!/(?<![A-Za-z])file:/.test(lock), "pnpm-lock.yaml resolves from the registry, not a local tarball");
  assert.ok(!/_authToken|ghp_|github_pat_/.test(lock), "pnpm-lock.yaml holds no credential");
  const npmrc = await readFile(new URL(".npmrc", exampleUrl), "utf8");
  assert.equal(npmrc, "@scshafe:registry=https://npm.pkg.github.com\n");
});

test("the guide links to the repository absolutely and has no open 0.2.0 markers", async () => {
  const guide = await readFile(guideUrl, "utf8");
  // A reader may have only this file: no relative links into the repository.
  const relative = [...guide.matchAll(/\]\((?!https:\/\/|#)([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(relative, []);
  assert.ok(!guide.includes("<!-- postgres-0.2.0"), "the switchyard-postgres 0.2.0 simplifications are done");
  assert.ok(guide.includes("docker rm -f -v first-switchyard-db"), "clean-up removes the data volume");
  assert.ok(!/docker rm -f first-switchyard-db/.test(guide), "every docker rm removes the volume");
});

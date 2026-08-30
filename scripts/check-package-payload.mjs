import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"]
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  }
  return stdout;
}

const rootRules = new Map([
  ["src", (path) => path.endsWith(".ts")],
  ["lib", (path) => path.endsWith(".js") || path.endsWith(".d.ts")],
  ["schemas", (path) => path.endsWith(".json")]
]);

async function expectedFilesIn(directory, accepts) {
  const absolute = resolve(root, directory);
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `symbolic link is not allowed in package payload: ${relative(root, path)}`
        );
      }
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          `non-regular package payload entry: ${relative(root, path)}`
        );
      }
      const packagedPath = relative(root, path).split(sep).join("/");
      if (!accepts(packagedPath)) {
        throw new Error(`unexpected file type in ${directory}: ${packagedPath}`);
      }
      if ((await readFile(path)).includes(0)) {
        throw new Error(`raw NUL byte is not allowed in package source: ${packagedPath}`);
      }
      files.push(packagedPath);
    }
  }

  await walk(absolute);
  return files;
}

const expected = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "tsconfig.json"
]);
for (const [directory, accepts] of rootRules) {
  for (const path of await expectedFilesIn(directory, accepts)) {
    expected.add(path);
  }
}

const report = JSON.parse(
  await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"])
);
if (report.length !== 1) {
  throw new Error(`npm pack returned ${report.length} package reports`);
}
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8")
);
if (
  report[0].name !== packageJson.name
  || report[0].version !== packageJson.version
) {
  throw new Error("npm pack identity does not match package.json");
}

const actual = new Set(report[0].files?.map((entry) => entry.path) ?? []);
const missing = [...expected].filter((path) => !actual.has(path)).sort();
const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    `package payload mismatch: ${JSON.stringify({ missing, unexpected })}`
  );
}

console.log(
  `Mission Pipeline package payload passed (${actual.size} exact files).`
);

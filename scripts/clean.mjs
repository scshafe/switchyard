import { rm } from "node:fs/promises";

await Promise.all([
  new URL("../lib/", import.meta.url),
  new URL("../packages/mission-pipeline-graphpaper/lib/", import.meta.url)
].map((directory) => rm(directory, { force: true, recursive: true })));

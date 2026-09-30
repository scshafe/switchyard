// worker.mjs: the worker loop. It claims queued turns for every worker
// principal in the graph, runs them through the ports, and repeats.
//   node --env-file=.env worker.mjs               keep polling (Ctrl-C stops)
//   node --env-file=.env worker.mjs --until-idle  stop when nothing is queued
import { setTimeout as sleep } from "node:timers/promises";

import {
  codeNodePortByNode,
  createArtifactEnvelope,
  runNextUnitTurns,
  withApprovalReviewPorts
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { REPLY, graph } from "./graph.mjs";
import { fakeModel } from "./models.mjs";

// Code bodies, one per code node. A review rejection runs the same body
// again at "compose-reply::rework", with the reviewer's notes in its input.
async function composeReply(input, context) {
  const rework = context.nodeId === "compose-reply::rework";
  const draft = rework ? input.input.payload : input;
  const notes = rework ? input.history.at(-1).feedback?.payload.notes : undefined;
  const lines = ["Hello,", "", draft.answer];
  if (notes) lines.push("", `(Revised after review: ${notes})`);
  lines.push("", "-- The team");
  return {
    outcome: "composed",
    outputArtifact: createArtifactEnvelope(REPLY, { body: lines.join("\n") })
  };
}

let model = fakeModel;
if (process.env.MODEL_BASE_URL) {
  model = (await import("./real-model.mjs")).realModel;
}

// withApprovalReviewPorts builds the records that reviewers and rework
// rounds see. Without it, reviewed nodes fail closed.
const ports = withApprovalReviewPorts(
  {
    code: codeNodePortByNode({
      "compose-reply": composeReply,
      "compose-reply::rework": composeReply
    }),
    model
  },
  { graphs: [graph] }
);

// Every principal that runs code, model or agent nodes. Human nodes wait for
// decide.mjs instead.
const principals = [
  ...new Set(
    graph.nodes
      .filter((node) => node.kind === "code" || node.kind === "model" || node.kind === "agent")
      .map((node) => node.principal.id)
  )
];

const untilIdle = process.argv.includes("--until-idle");
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const { pool, unitStore } = openStores();
console.log(`worker: principals ${principals.join(", ")}`);
try {
  while (!stop.signal.aborted) {
    let ran = 0;
    for (const principalId of principals) {
      const settled = await runNextUnitTurns({
        store: unitStore,
        principalId,
        leaseOwner: `worker-${process.pid}`,
        ports,
        batch: 8
      });
      for (const { claim, result } of settled) {
        ran += 1;
        const where = `${claim.unitId.padEnd(8)} ${claim.nodeId.padEnd(24)}`;
        if (result.status === "rejected") {
          console.error(`${where} error:`, result.reason);
        } else if (result.value.status === "succeeded") {
          console.log(`${where} -> ${result.value.completion.outcome}`);
        } else {
          console.log(`${where} failed: ${result.value.errorCode}`);
        }
      }
    }
    if (ran > 0) continue;
    if (untilIdle) break;
    await sleep(1_000, undefined, { signal: stop.signal }).catch(() => {});
  }
} finally {
  await pool.end();
}

// worker.mjs: the worker. It claims queued turns for every principal that
// runs code or model nodes, runs them through the ports, and repeats. It
// runs units of every graph version in versions.mjs.
//   node --env-file=.env worker.mjs               keep polling (Ctrl-C stops)
//   node --env-file=.env worker.mjs --until-idle  stop when nothing is queued
import {
  SWITCHYARD_REWORK_CONTRACT,
  codeNodePortByNode,
  createArtifactEnvelope,
  latestReviewNotes,
  runWorker,
  withApprovalReviewPorts,
  workerPrincipals
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { REPLY } from "./graph.mjs";
import { fakeModel } from "./models.mjs";
import { graphs } from "./versions.mjs";

// The body of compose-reply. It receives a draft.v1, { question, answer },
// and returns its outcome with the reply.v1 it produced. After a rejected
// review it runs again at compose-reply::rework, whose input is a
// switchyard.rework.v1 record: the original draft.v1 in input.payload, plus
// every rejected round with the reviewer's notes.
async function composeReply(input, context) {
  const rework = context.inputArtifact.contractId === SWITCHYARD_REWORK_CONTRACT;
  const draft = rework ? input.input.payload : input;
  const notes = rework ? latestReviewNotes(input) : undefined;
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
// rounds receive. Without it, reviewed nodes fail closed; so do the reviewed
// nodes of a graph version it was not given.
const ports = withApprovalReviewPorts(
  {
    code: codeNodePortByNode({
      "compose-reply": composeReply,
      "compose-reply::rework": composeReply
    }),
    model
  },
  { graphs }
);

function report({ claim, result }) {
  const where = `${claim.unitId.padEnd(8)} ${claim.nodeId.padEnd(24)}`;
  if (result.status === "rejected") {
    console.error(`${where} error:`, result.reason);
  } else if (result.value.status === "succeeded") {
    console.log(`${where} -> ${result.value.completion.outcome}`);
  } else {
    console.log(`${where} failed: ${result.value.errorCode}`);
  }
}

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());

const { unitStore, close } = openStores();
const versions = graphs.map((graph) => `${graph.graphId} v${graph.version}`).join(", ");
console.log(`worker: ${versions}; principals ${workerPrincipals(graphs).join(", ")}`);
try {
  await runWorker({
    store: unitStore,
    ports,
    // Every version with units in flight. On switchyard 2.3.0 the worker
    // also claims units of versions missing here, and their reviewed nodes
    // (compose-reply, compose-reply::rework) then fail for good.
    graphs,
    leaseOwner: `worker-${process.pid}`,
    untilIdle: process.argv.includes("--until-idle"),
    signal: stop.signal,
    onSettled: report
  });
} finally {
  await close();
}

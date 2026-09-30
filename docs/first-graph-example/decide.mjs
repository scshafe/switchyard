// decide.mjs: list the turns waiting for a person, or answer one.
//   node --env-file=.env decide.mjs
//   node --env-file=.env decide.mjs <unit-id> <answer> ["notes"]
import {
  approvalReviewHumanDecision,
  approvalReviewRole,
  reviewNotes
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { graph } from "./graph.mjs";

const actorId = process.env.ACTOR ?? "alice";

// What a person answers at a node. Approval and review nodes store other
// outcomes (e.g. "accepted:composed"); approvalReviewHumanDecision maps them.
function answersFor(turn) {
  const role = approvalReviewRole(graph, turn.nodeId);
  if (role?.role === "approval") return ["approved", "denied"];
  if (role?.role === "review") return ["accepted", "rejected"];
  return turn.outcomes;
}

// What the person is looking at: the text, or the reply under review.
function subjectOf(turn) {
  const payload = turn.inputArtifact.payload;
  if (turn.inputArtifact.contractId === "switchyard.review-request.v1") {
    return `round ${payload.round} of ${payload.maxRounds}:\n${payload.output.payload.body}`;
  }
  return payload.text;
}

const [unitId, answer, notes] = process.argv.slice(2);
const { pool, humanDecisions } = openStores();
try {
  const pending = await humanDecisions.listPending({ limit: 1_000 });
  if (unitId === undefined) {
    if (pending.length === 0) console.log("nothing is waiting for a person");
    for (const turn of pending) {
      console.log(`${turn.unitId} at ${turn.nodeId}, answers: ${answersFor(turn).join(" | ")}`);
      console.log(`  ${subjectOf(turn).replaceAll("\n", "\n  ")}`);
    }
  } else {
    const turn = pending.find((candidate) => candidate.unitId === unitId);
    if (turn === undefined) throw new Error(`unit ${unitId} is not waiting for a person`);
    if (turn.graph.digest !== graph.graphDigest) {
      throw new Error(`unit ${unitId} runs another version of the graph`);
    }
    // Shape the answer for this node, then record it. The engine checks it
    // against the node's outcomes and routes the unit on.
    const decision = approvalReviewHumanDecision(graph, {
      queued: turn,
      outcome: answer,
      ...(notes === undefined ? {} : { outputArtifact: reviewNotes(notes) }),
      actor: { actorId }
    });
    await humanDecisions.record({
      queueId: turn.queueId,
      outcome: decision.outcome,
      ...(decision.outputArtifact === undefined ? {} : { outputArtifact: decision.outputArtifact }),
      actorId
    });
    console.log(`${unitId} at ${turn.nodeId}: recorded ${decision.outcome}`);
  }
} finally {
  await pool.end();
}

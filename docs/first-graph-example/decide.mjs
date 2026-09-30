// decide.mjs: list the turns waiting for a person, or answer one.
//   node --env-file=.env decide.mjs
//   node --env-file=.env decide.mjs <unit-id> <answer> ["notes"]
import {
  SWITCHYARD_REVIEW_REQUEST_CONTRACT,
  approvalReviewHumanDecision,
  humanNodeAnswers,
  reviewNotes
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { graph } from "./graph.mjs";

const actorId = process.env.ACTOR ?? "alice";

// What the person is looking at. A review node receives a
// switchyard.review-request.v1 record: the round, the node's input, and the
// output under review (here a reply.v1, { body }). The other human node here,
// is-question.escalate-1, receives the message itself, a ticket.v1.
function subjectOf(turn) {
  const payload = turn.inputArtifact.payload;
  if (turn.inputArtifact.contractId === SWITCHYARD_REVIEW_REQUEST_CONTRACT) {
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
      const answers = humanNodeAnswers(graph, turn.nodeId);
      console.log(`${turn.unitId} at ${turn.nodeId}, answers: ${answers.join(" | ")}`);
      console.log(`  ${subjectOf(turn).replaceAll("\n", "\n  ")}`);
    }
  } else {
    const turn = pending.find((candidate) => candidate.unitId === unitId);
    if (turn === undefined) throw new Error(`unit ${unitId} is not waiting for a person`);
    if (turn.graph.digest !== graph.graphDigest) {
      throw new Error(`unit ${unitId} runs another version of the graph`);
    }
    // Check the answer and shape it for this node: at a review, "rejected"
    // is stored as "rework" (or "rejected" in the last round) and carries
    // the notes; "accepted" as "accepted:composed".
    const decision = approvalReviewHumanDecision(graph, {
      queued: turn,
      outcome: answer,
      ...(notes === undefined ? {} : { outputArtifact: reviewNotes(notes) }),
      actor: { actorId }
    });
    // Record it. The engine settles the turn and routes the unit on.
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

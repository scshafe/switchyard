// decide.mjs: list the turns waiting for a person, or answer one.
//   node --env-file=.env decide.mjs
//   node --env-file=.env decide.mjs <unit-id> <answer> ["notes"]
import { SWITCHYARD_REVIEW_REQUEST_CONTRACT } from "@scshafe/switchyard";
import { InvalidHumanAnswerError } from "@scshafe/switchyard-postgres";

import { openStores } from "./db.mjs";

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
const { humanDecisions, close } = openStores();
try {
  if (unitId === undefined) {
    const pending = await humanDecisions.listPending({ limit: 1_000 });
    if (pending.length === 0) console.log("nothing is waiting for a person");
    for (const turn of pending) {
      // turn.answers: what a person may answer here, in the node's order.
      console.log(`${turn.unitId} at ${turn.nodeId}, answers: ${turn.answers.join(" | ")}`);
      console.log(`  ${subjectOf(turn).replaceAll("\n", "\n  ")}`);
    }
  } else {
    // In this graph a unit waits for a person at one node at a time.
    const [turn] = await humanDecisions.listPending({ unitId });
    if (turn === undefined) {
      console.error(`${unitId} is not waiting for a person; run decide.mjs alone to see who is`);
      process.exitCode = 1;
    } else if (answer === undefined) {
      console.error(`${unitId} at ${turn.nodeId}: give an answer, one of ${turn.answers.join(" | ")}`);
      process.exitCode = 1;
    } else {
      // Record the answer. The store checks it against turn.answers and
      // stores what the node records: at a review, "accepted" as
      // "accepted:composed", "rejected" as "rework" with the notes (or
      // "rejected" in the last round). The engine then settles the turn and
      // routes the unit on.
      const recorded = await humanDecisions.recordAnswer({
        queueId: turn.queueId,
        answer,
        ...(notes === undefined ? {} : { notes }),
        actorId
      });
      console.log(`${unitId} at ${turn.nodeId}: recorded ${recorded.outcome}`);
    }
  }
} catch (error) {
  // A typo, or notes with an answer that takes none. Nothing was recorded.
  if (!(error instanceof InvalidHumanAnswerError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}

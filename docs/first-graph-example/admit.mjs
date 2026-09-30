// admit.mjs: publish the graph and admit one unit (a message) into it.
//   node --env-file=.env admit.mjs <unit-id> "<text>"
import {
  TurnEvidenceConflictError,
  createArtifactEnvelope,
  graphDefinitionRef
} from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { TICKET, graph } from "./graph.mjs";

const [unitId, text] = process.argv.slice(2);
if (unitId === undefined || text === undefined) {
  console.error('usage: node --env-file=.env admit.mjs <unit-id> "<text>"');
  process.exit(2);
}

const { pool, graphStore, unitStore } = openStores();
try {
  // Publishing the same sealed graph again changes nothing.
  await graphStore.publishGraph(graph);
  const { entryQueue } = await unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope(TICKET, { text }),
    // When the unit entered. Part of its admission, which never changes.
    admittedAt: new Date().toISOString(),
    principalId: "admitter"
  });
  console.log(`admitted ${unitId}: queued at ${entryQueue.nodeId}`);
} catch (error) {
  // A unit id is admitted once. Running this again with the same id makes a
  // new admittedAt (and maybe other text), which conflicts with the stored
  // admission.
  if (!(error instanceof TurnEvidenceConflictError)) throw error;
  console.error(`${unitId} is already admitted; admit the message under a new unit id`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

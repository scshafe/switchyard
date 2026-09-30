// admit.mjs: publish the graph and admit one unit (a message) into it.
//   node --env-file=.env admit.mjs <unit-id> "<text>"
import { createArtifactEnvelope, graphDefinitionRef } from "@scshafe/switchyard";

import { openStores } from "./db.mjs";
import { TICKET, graph } from "./graph.mjs";

const [unitId, text] = process.argv.slice(2);
if (unitId === undefined || text === undefined) {
  console.error('usage: node --env-file=.env admit.mjs <unit-id> "<text>"');
  process.exit(2);
}

const { pool, graphStore, unitStore } = openStores();
try {
  // Publishing the same sealed graph again is a no-op.
  await graphStore.publishGraph(graph);
  const { created, entryQueue } = await unitStore.admitUnit({
    unitId,
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope(TICKET, { text }),
    admittedAt: new Date().toISOString(),
    principalId: "admitter"
  });
  console.log(`${created ? "admitted" : "already admitted"} ${unitId}: queued at ${entryQueue.nodeId}`);
} finally {
  await pool.end();
}

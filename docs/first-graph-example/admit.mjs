// admit.mjs: publish the graph and admit one unit (a message) into it.
//   node --env-file=.env admit.mjs <unit-id> "<text>"
import {
  GraphPublicationConflictError,
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

const { graphStore, unitStore, close } = openStores();
try {
  // Publishing the same sealed graph again changes nothing. A changed graph
  // under a version number already published is refused.
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
  if (error instanceof GraphPublicationConflictError) {
    // graph.mjs changed, but its version did not (step 11).
    console.error(`graph ${graph.graphId} v${graph.version} is already published with other content; bump version in graph.mjs`);
  } else if (error instanceof TurnEvidenceConflictError) {
    // A unit id is admitted once. Running this again with the same id makes
    // a new admittedAt (and maybe other text), which conflicts with the
    // stored admission.
    console.error(`${unitId} is already admitted; admit the message under a new unit id`);
  } else {
    throw error;
  }
  process.exitCode = 1;
} finally {
  await close();
}

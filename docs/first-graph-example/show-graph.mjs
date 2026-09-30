// show-graph.mjs: print the sealed graph. Approval and review are nodes now.
import { graph } from "./graph.mjs";

console.log(`graph ${graph.graphId} v${graph.version}, digest ${graph.graphDigest.slice(0, 16)}...`);
console.log("nodes:");
for (const node of graph.nodes) {
  const outcomes = node.outcomes.outcomes.join(" | ");
  console.log(`  ${node.nodeId.padEnd(24)} ${node.kind.padEnd(6)} ${node.principal.id.padEnd(12)} ${outcomes}`);
}
console.log("edges:");
for (const edge of graph.edges) {
  const when = edge.when.outcome ?? edge.when.anyOf.join("|");
  console.log(`  ${edge.from} --${when}--> ${edge.to.join(", ")}`);
}
console.log("ends:");
for (const end of graph.terminals) console.log(`  ${end.nodeId} --${end.outcome}--> (done)`);

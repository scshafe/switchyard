// versions.mjs: every version of the graph that still has units in flight.
// A unit runs to its end on the version it was admitted to, so the worker
// needs all of these, not only the current one. Step 11 adds a version.
import { graph } from "./graph.mjs";

// The current version (the one admit.mjs admits to) first.
export const graphs = [graph];

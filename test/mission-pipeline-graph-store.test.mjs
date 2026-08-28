import {
  registerGraphStoreConformanceTests
} from "mission-pipeline/store/graph-store-conformance";
import { MemoryGraphStore } from "mission-pipeline/store/memory-graph-store";

registerGraphStoreConformanceTests({
  backendName: "MemoryGraphStore",
  createDriver: () => ({
    graphStore: new MemoryGraphStore(),
    async close() {}
  })
});

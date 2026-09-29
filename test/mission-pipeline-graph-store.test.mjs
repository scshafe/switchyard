import {
  registerGraphStoreConformanceTests
} from "@scshafe/mission-pipeline/store/graph-store-conformance";
import { MemoryGraphStore } from "@scshafe/mission-pipeline/store/memory-graph-store";

registerGraphStoreConformanceTests({
  backendName: "MemoryGraphStore",
  createDriver: () => ({
    graphStore: new MemoryGraphStore(),
    async close() {}
  })
});

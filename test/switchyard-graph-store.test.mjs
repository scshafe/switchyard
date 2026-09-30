import {
  registerGraphStoreConformanceTests
} from "@scshafe/switchyard/store/graph-store-conformance";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";

registerGraphStoreConformanceTests({
  backendName: "MemoryGraphStore",
  createDriver: () => ({
    graphStore: new MemoryGraphStore(),
    async close() {}
  })
});

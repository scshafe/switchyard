import test from "node:test";
import assert from "node:assert/strict";

import { createArtifactEnvelope } from "mission-pipeline/contracts/artifact";
import {
  createGraphDefinition,
  graphDefinitionRef
} from "mission-pipeline/graph/definition";
import {
  registerUnitStoreConformanceTests
} from "mission-pipeline/store/unit-store-conformance";
import { MemoryGraphStore } from "mission-pipeline/store/memory-graph-store";
import { MemoryUnitStore } from "mission-pipeline/store/memory-unit-store";

function memoryDriver() {
  let epoch = Date.parse("2026-08-27T12:00:00.000Z");
  let nextId = 1;
  let armed;
  let hits = [];
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({
    graphStore,
    now: () => new Date(epoch),
    idFactory: (kind) => `${kind}-${nextId++}`,
    settleCheckpoint: (checkpoint) => {
      hits.push(checkpoint);
      if (checkpoint === armed) {
        throw new Error(`simulated process death at settle checkpoint ${checkpoint}`);
      }
    }
  });

  return {
    graphStore,
    unitStore,
    now: () => new Date(epoch),
    advanceClock(milliseconds) {
      epoch += milliseconds;
    },
    armSettleCrash(checkpoint) {
      armed = checkpoint;
      hits = [];
    },
    async recover() {
      armed = undefined;
    },
    checkpointHits() {
      return Object.freeze([...hits]);
    },
    async evidence() {
      return unitStore.evidenceSnapshot();
    },
    async close() {}
  };
}

registerUnitStoreConformanceTests({
  backendName: "MemoryUnitStore",
  createDriver: () => memoryDriver()
});

test("MemoryUnitStore captures Date intrinsics before hostile runtime mutation", async () => {
  const driver = memoryDriver();
  const graph = createGraphDefinition({
    graphId: "memory-store.date-intrinsics",
    version: 1,
    description: "Date authority is captured before store operations.",
    entry: "only",
    nodes: [{
      nodeId: "only",
      ref: { id: "memory-store.date-intrinsics.only", version: 1 },
      kind: "code",
      input: "unit-artifact.v1",
      outcomes: { version: 1, outcomes: ["done"] },
      principal: { id: "v2_worker" },
      turn: {
        idempotency: "per (unitId, nodeId, attemptNumber)",
        leaseMs: 1_000,
        maxAttempts: 1,
        retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
      }
    }],
    edges: [],
    terminals: [{ nodeId: "only", outcome: "done" }]
  });
  await driver.graphStore.publishGraph(graph);
  await driver.unitStore.admitUnit({
    unitId: "unit-date-intrinsics",
    graph: graphDefinitionRef(graph),
    seedArtifact: createArtifactEnvelope("unit-artifact.v1", { seed: true }),
    admittedAt: driver.now().toISOString(),
    principalId: "v2_admitter"
  });

  const originalParse = Date.parse;
  const originalToISOString = Date.prototype.toISOString;
  Date.parse = () => {
    throw new Error("hostile Date.parse");
  };
  Date.prototype.toISOString = () => {
    throw new Error("hostile Date.prototype.toISOString");
  };
  try {
    const claims = await driver.unitStore.claimUnitTurns({
      principalId: "v2_worker",
      leaseOwner: "date-intrinsics-worker",
      batch: 1,
      nodeId: "only"
    });
    assert.equal(claims.length, 1);
  } finally {
    Date.parse = originalParse;
    Date.prototype.toISOString = originalToISOString;
  }
});

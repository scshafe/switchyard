// store/graph-store-conformance.ts — reusable GraphStore executable contract.
//
// N3 runs this registrar against MemoryGraphStore. N4 imports the same cases
// and binds a fresh Postgres-backed driver per scenario. The suite deliberately
// keeps publication guards and their prove-it-bites assertions beside the
// happy path so no adapter can claim conformance from prose alone.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createGraphDefinition,
  graphDefinitionRef,
  type GraphDefinition,
  type SwitchyardNodeKind
} from "../graph/definition.js";
import {
  GraphLoadDigestConflictError,
  GraphPublicationConflictError,
  GraphPublicationValidationError,
  NodeDefinitionPublicationConflictError,
  validateGraphDefinitionRef,
  type GraphStore
} from "./graph-store.js";

const TURN = Object.freeze({
  idempotency: "per (unitId, nodeId, attemptNumber)" as const,
  leaseMs: 30_000,
  maxAttempts: 2,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage" as const
});

interface NodeDraftOptions {
  readonly refId?: string;
  readonly kind?: SwitchyardNodeKind;
  readonly input?: string;
  readonly principal?: string;
  readonly outputs?: Readonly<Record<string, string>>;
}

interface ConformanceNodeDraft {
  readonly nodeId: string;
  readonly ref: { readonly id: string; readonly version: number };
  readonly kind: SwitchyardNodeKind;
  readonly input: string;
  readonly outcomes: { readonly version: number; readonly outcomes: readonly string[] };
  readonly outputs?: Readonly<Record<string, string>>;
  readonly principal: { readonly id: string };
  readonly turn: typeof TURN;
}

function node(
  nodeId: string,
  outcomes: readonly string[],
  options: NodeDraftOptions = {}
): ConformanceNodeDraft {
  const kind = options.kind ?? "code";
  return {
    nodeId,
    ref: { id: options.refId ?? `fixture.${nodeId}`, version: 1 },
    kind,
    input: options.input ?? "unit-artifact.v1",
    outcomes: { version: 1, outcomes },
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
    principal: {
      id: options.principal
        ?? (kind === "human" ? "v2_console" : "v2_worker")
    },
    turn: TURN
  };
}

function filterChainDraft(): object {
  return {
    graphId: "fixture.filter-chain",
    version: 1,
    description: "A linear filter chain with an early terminal rejection.",
    entry: "filter",
    nodes: [
      node("filter", ["pass", "drop"]),
      node("normalize", ["ok"]),
      node("sink", ["done"])
    ],
    edges: [
      { edgeId: "filter-pass", from: "filter", when: { outcome: "pass" }, to: ["normalize"] },
      { edgeId: "normalize-ok", from: "normalize", when: { outcome: "ok" }, to: ["sink"] }
    ],
    terminals: [
      { nodeId: "filter", outcome: "drop" },
      { nodeId: "sink", outcome: "done" }
    ]
  };
}

function oneNodeGraph(graphId: string, graphNode: ConformanceNodeDraft): GraphDefinition {
  return createGraphDefinition({
    graphId,
    version: 1,
    description: `Graph ${graphId} for immutable publication evidence.`,
    entry: graphNode.nodeId,
    nodes: [graphNode],
    edges: [],
    terminals: graphNode.outcomes.outcomes.map((outcome) => ({
      nodeId: graphNode.nodeId,
      outcome
    }))
  });
}

interface SharedNodeGraphOptions extends NodeDraftOptions {
  readonly nodeId?: string;
  readonly outcomes?: readonly string[];
}

function sharedNodeGraph(
  graphId: string,
  options: SharedNodeGraphOptions = {}
): GraphDefinition {
  return oneNodeGraph(
    graphId,
    node(options.nodeId ?? "only", options.outcomes ?? ["done", "skipped"], {
      refId: options.refId ?? "shared.definition",
      kind: options.kind,
      input: options.input,
      principal: options.principal,
      outputs: options.outputs
    })
  );
}

export interface GraphStoreConformanceDriver {
  readonly graphStore: GraphStore;
  close(): Promise<void>;
}

export interface GraphStoreConformanceFactoryContext {
  readonly backendName: string;
  readonly scenario: string;
}

export type GraphStoreConformanceDriverFactory = (
  context: GraphStoreConformanceFactoryContext
) => GraphStoreConformanceDriver | Promise<GraphStoreConformanceDriver>;

export interface RegisterGraphStoreConformanceOptions {
  readonly backendName: string;
  readonly createDriver: GraphStoreConformanceDriverFactory;
}

/** Register the complete immutable-publication contract for one backend. */
export function registerGraphStoreConformanceTests(
  options: RegisterGraphStoreConformanceOptions
): void {
  const register = (
    scenario: string,
    body: (store: GraphStore) => Promise<void> | void
  ): void => {
    test(`${options.backendName}: ${scenario}`, async () => {
      const driver = await options.createDriver({
        backendName: options.backendName,
        scenario
      });
      try {
        await body(driver.graphStore);
      } finally {
        await driver.close();
      }
    });
  };

  register(
    "GraphStore publishes a compiled sealed graph, replays identically, and returns frozen detached loads",
    async (store) => {
      const graph = createGraphDefinition(filterChainDraft());
      const ref = graphDefinitionRef(graph);

      await store.publishGraph(graph);
      await store.publishGraph(graph);
      const first = await store.loadGraph(ref);
      const second = await store.loadGraph(ref);

      assert.deepEqual(first, graph);
      assert.deepEqual(second, graph);
      assert.notEqual(first, graph);
      assert.notEqual(first, second);
      assert.equal(Object.isFrozen(first), true);
      assert.ok(first !== undefined);
      assert.equal(Object.isFrozen(first.nodes), true);
      assert.equal(
        await store.loadGraph({ id: "fixture.missing", version: 1, digest: "f".repeat(64) }),
        undefined
      );
    }
  );

  register(
    "GraphStore guard bites: semantic compilation failure names the exact graph and appends nothing",
    async (store) => {
      const draft = structuredClone(filterChainDraft()) as Record<string, unknown>;
      draft.graphId = "fixture.invalid-entry";
      draft.entry = "ghost";
      const graph = createGraphDefinition(draft);

      await assert.rejects(
        store.publishGraph(graph),
        (error) => {
          assert.ok(error instanceof GraphPublicationValidationError);
          assert.match(error.message, /graph fixture\.invalid-entry@1 rejected/);
          assert.match(error.message, /entry references unknown node ghost/);
          return true;
        }
      );
      assert.equal(await store.loadGraph(graphDefinitionRef(graph)), undefined);
    }
  );

  register(
    "GraphStore guard bites: graphId/version replay with another digest names both immutable identities",
    async (store) => {
      const published = createGraphDefinition(filterChainDraft());
      const changedDraft = structuredClone(filterChainDraft()) as Record<string, unknown>;
      changedDraft.description = "A different sealed graph under the same graph identity.";
      const changed = createGraphDefinition(changedDraft);
      await store.publishGraph(published);

      await assert.rejects(
        store.publishGraph(changed),
        (error) => {
          assert.ok(error instanceof GraphPublicationConflictError);
          assert.equal(error.graphId, "fixture.filter-chain");
          assert.equal(error.graphVersion, 1);
          assert.equal(error.publishedDigest, published.graphDigest);
          assert.equal(error.requestedDigest, changed.graphDigest);
          assert.match(error.message, /graph fixture\.filter-chain@1 is already published/);
          assert.match(error.message, new RegExp(`${published.graphDigest}.*${changed.graphDigest}`));
          return true;
        }
      );
      assert.deepEqual(await store.loadGraph(graphDefinitionRef(published)), published);
    }
  );

  register(
    "GraphStore guard bites: load requires the exact digest for an existing graph identity",
    async (store) => {
      const graph = createGraphDefinition(filterChainDraft());
      await store.publishGraph(graph);
      const wrongDigest = "0".repeat(64);

      await assert.rejects(
        store.loadGraph({ id: graph.graphId, version: graph.version, digest: wrongDigest }),
        (error) => {
          assert.ok(error instanceof GraphLoadDigestConflictError);
          assert.equal(error.graphId, "fixture.filter-chain");
          assert.equal(error.publishedDigest, graph.graphDigest);
          assert.equal(error.requestedDigest, wrongDigest);
          assert.match(error.message, /loadGraph: graph fixture\.filter-chain@1/);
          return true;
        }
      );
    }
  );

  register("GraphStore node signatures use outcome-set semantics across graphs", async (store) => {
    const first = sharedNodeGraph("fixture.signature-first", {
      nodeId: "first",
      outcomes: ["done", "skipped"]
    });
    const reordered = sharedNodeGraph("fixture.signature-reordered", {
      nodeId: "second",
      outcomes: ["skipped", "done"]
    });

    await store.publishGraph(first);
    await store.publishGraph(reordered);
    assert.deepEqual(await store.loadGraph(graphDefinitionRef(reordered)), reordered);
  });

  register("GraphStore node signatures compare declared output contracts as maps", async (store) => {
    const first = sharedNodeGraph("fixture.outputs-first", {
      nodeId: "first",
      outputs: { done: "unit-artifact.v1", skipped: "unit-artifact.v1" }
    });
    const reordered = sharedNodeGraph("fixture.outputs-reordered", {
      nodeId: "second",
      outputs: { skipped: "unit-artifact.v1", done: "unit-artifact.v1" }
    });

    await store.publishGraph(first);
    await store.publishGraph(reordered);
    assert.deepEqual(await store.loadGraph(graphDefinitionRef(reordered)), reordered);
  });

  const conflicts: readonly {
    readonly field: "kind" | "input contract" | "outcome vocabulary" | "output contracts";
    readonly graphId: string;
    readonly options: SharedNodeGraphOptions;
  }[] = [
    {
      field: "kind",
      graphId: "fixture.signature-kind-conflict",
      options: { nodeId: "kind-changed", kind: "human", principal: "v2_console" }
    },
    {
      field: "input contract",
      graphId: "fixture.signature-input-conflict",
      options: { nodeId: "input-changed", input: "other-input.v1" }
    },
    {
      field: "outcome vocabulary",
      graphId: "fixture.signature-outcome-conflict",
      options: { nodeId: "outcomes-changed", outcomes: ["done", "extra"] }
    },
    {
      // The owner declares no outputs; declaring them is a new definition.
      field: "output contracts",
      graphId: "fixture.signature-output-conflict",
      options: { nodeId: "outputs-declared", outputs: { done: "unit-artifact.v1" } }
    }
  ];
  for (const conflict of conflicts) {
    register(
      `GraphStore guard bites: cross-graph node ref ${conflict.field} conflict names the exact ref and graphs`,
      async (store) => {
        const published = sharedNodeGraph("fixture.signature-owner", { nodeId: "owner" });
        const requested = sharedNodeGraph(conflict.graphId, conflict.options);
        await store.publishGraph(published);

        await assert.rejects(
          store.publishGraph(requested),
          (error) => {
            assert.ok(error instanceof NodeDefinitionPublicationConflictError);
            assert.equal(error.nodeRefId, "shared.definition");
            assert.equal(error.nodeRefVersion, 1);
            assert.equal(error.field, conflict.field);
            assert.match(error.message, /node definition shared\.definition@1 conflicts/);
            assert.match(error.message, /graph fixture\.signature-owner@1/);
            assert.match(
              error.message,
              new RegExp(`graph ${conflict.graphId.replaceAll(".", "\\.")}@1`)
            );
            return true;
          }
        );
        assert.equal(await store.loadGraph(graphDefinitionRef(requested)), undefined);
      }
    );
  }

  register("GraphStore publication is atomic across graph and node-signature evidence", async (store) => {
    const owner = sharedNodeGraph("fixture.atomic-owner", { nodeId: "owner" });
    await store.publishGraph(owner);

    const rejected = createGraphDefinition({
      graphId: "fixture.atomic-rejected",
      version: 1,
      description: "Introduces a new ref before conflicting with an existing ref.",
      entry: "fresh",
      nodes: [
        node("fresh", ["done"], { refId: "fresh.definition" }),
        node("conflict", ["different"], { refId: "shared.definition" })
      ],
      edges: [
        { edgeId: "fresh-to-conflict", from: "fresh", when: { outcome: "done" }, to: ["conflict"] }
      ],
      terminals: [{ nodeId: "conflict", outcome: "different" }]
    });
    await assert.rejects(
      store.publishGraph(rejected),
      /node definition shared\.definition@1 conflicts in outcome vocabulary.*fixture\.atomic-owner@1.*fixture\.atomic-rejected@1/
    );

    // If the failed append leaked fresh.definition@1, this valid publication
    // would conflict. Its success is the prove-it-bites atomicity evidence.
    const after = oneNodeGraph(
      "fixture.atomic-after",
      node("after", ["other"], { refId: "fresh.definition" })
    );
    await store.publishGraph(after);
    assert.deepEqual(await store.loadGraph(graphDefinitionRef(after)), after);
    assert.equal(await store.loadGraph(graphDefinitionRef(rejected)), undefined);
  });

  register("GraphStore graph refs are strict, digest-bearing, detached values", () => {
    const input = { id: "fixture.strict-ref", version: 1, digest: "a".repeat(64) };
    const ref = validateGraphDefinitionRef(input);
    input.id = "caller-mutated";
    assert.deepEqual(ref, {
      id: "fixture.strict-ref",
      version: 1,
      digest: "a".repeat(64)
    });
    assert.equal(Object.isFrozen(ref), true);
    assert.throws(
      () => validateGraphDefinitionRef({ ...ref, extra: true }),
      /unknown key\(s\) "extra"/
    );
    assert.throws(
      () => validateGraphDefinitionRef({ ...ref, version: Number.MAX_SAFE_INTEGER + 1 }),
      /version: must be a safe positive integer/
    );
  });
}

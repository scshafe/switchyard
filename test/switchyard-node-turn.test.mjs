import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { createGraphDefinition } from "@scshafe/switchyard/graph/definition";
import {
  ExecutionFailureError
} from "@scshafe/switchyard/execute/failure";
import {
  executeNodeTurnAttempt,
  isNodeTurnInvocationUncertainError,
  nodeExecutionFingerprint,
  nodeTurnCompletionDigest,
  nodeTurnIdempotencyKey,
  WorkerNodeKindError
} from "@scshafe/switchyard/execute/turn";
import {
  admitCallbackNodeEvent,
  MAX_TURN_OUTBOX_EVENTS,
  NODE_TURN_USAGE_EVENT_TYPE,
  recordHumanNodeDecision,
  runClaimedUnitTurn,
  runNextUnitTurn,
  runNextUnitTurns,
  TurnAttemptPersistenceUncertainError,
  TurnAuthorityError,
  TurnEvidenceConflictError,
  TurnLeaseHeartbeatError,
  TurnLeaseLostError,
  TurnSettlementUncertainError,
  turnOutboxEventDigest
} from "@scshafe/switchyard/execute/unit-runner";

const TURN = Object.freeze({
  idempotency: "per (unitId, nodeId, attemptNumber)",
  leaseMs: 30_000,
  maxAttempts: 3,
  retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
});

const BINDING = Object.freeze({
  kind: "model",
  bindingId: "test.binding",
  version: 1,
  bindingDigest: "b".repeat(64)
});

const receipt = (overrides = {}) => Object.freeze({
  schemaVersion: "usage-receipt.v1",
  trust: "provider_reported",
  observedInputTokens: 2,
  observedOutputTokens: 3,
  chargedTokens: 5,
  observedCostMicroUsd: 7,
  chargedCostMicroUsd: 7,
  durationMs: 11,
  routeAlias: "test-route",
  ...overrides
});

function graphFor(kind = "code", options = {}) {
  const nodeId = options.nodeId ?? `${kind}-node`;
  const outcomes = options.outcomes ?? ["done"];
  return createGraphDefinition({
    graphId: options.graphId ?? `test.${kind}-graph`,
    version: 1,
    description: `One ${kind} node for N2 protocol evidence.`,
    entry: nodeId,
    nodes: [{
      nodeId,
      ref: { id: options.refId ?? `test.${kind}-node`, version: 1 },
      kind,
      input: options.input ?? "turn-input.v1",
      outcomes: { version: 1, outcomes },
      principal: { id: options.principal ?? `v2_${kind === "code" ? "worker" : kind}` },
      ...(kind === "model" ? { binding: BINDING } : {}),
      turn: {
        ...TURN,
        leaseMs: options.leaseMs ?? TURN.leaseMs,
        maxAttempts: options.maxAttempts ?? TURN.maxAttempts
      }
    }],
    edges: [],
    terminals: outcomes.map((outcome) => ({ nodeId, outcome }))
  });
}

function claimFor(graph, options = {}) {
  return Object.freeze({
    queueId: options.queueId ?? `queue-${options.unitId ?? "unit-1"}`,
    unitId: options.unitId ?? "unit-1",
    nodeId: options.nodeId ?? graph.entry,
    graph,
    inputArtifact: options.inputArtifact
      ?? createArtifactEnvelope("turn-input.v1", { value: options.unitId ?? "unit-1" }),
    leaseToken: options.leaseToken ?? `lease-${options.unitId ?? "unit-1"}`,
    ...(Object.hasOwn(options, "executionIdentityDigest")
      && options.executionIdentityDigest !== undefined
      ? { executionIdentityDigest: options.executionIdentityDigest }
      : {})
  });
}

function directContextFor(graph, claim, attemptNumber = 1) {
  const node = graph.nodes.find((candidate) => candidate.nodeId === claim.nodeId);
  const idempotencyKey = nodeTurnIdempotencyKey({
    unitId: claim.unitId,
    nodeId: node.nodeId,
    attemptNumber,
    nodeRef: node.ref,
    fingerprint: nodeExecutionFingerprint(node),
    inputDigest: claim.inputArtifact.digest
  });
  return {
    graph: { id: graph.graphId, version: graph.version, digest: graph.graphDigest },
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: node.nodeId,
    nodeRef: node.ref,
    attemptNumber,
    attemptIndex: 1,
    idempotencyKey,
    inputArtifact: {
      contractId: claim.inputArtifact.contractId,
      digest: claim.inputArtifact.digest,
      ...(Object.hasOwn(claim.inputArtifact, "bytes")
        ? { bytes: claim.inputArtifact.bytes }
        : {})
    }
  };
}

class FakeTurnStore {
  constructor(claims = [], options = {}) {
    this.claims = claims;
    this.options = options;
    this.states = new Map();
    this.prepareCalls = [];
    this.heartbeatCalls = [];
    this.cacheCalls = [];
    this.failureCalls = [];
    this.settleCalls = [];
    this.claimCalls = [];
    this.externalInspectionCalls = [];
    this.externalClaimCalls = [];
    for (const claim of claims) {
      this.states.set(claim.queueId, {
        attemptNumber: options.startAttemptByQueue?.[claim.queueId]
          ?? options.startAttemptNumber
          ?? 1,
        attemptIndex: 1,
        terminal: undefined,
        cached: options.cachedByQueue?.[claim.queueId]
      });
    }
  }

  state(queueId) {
    const state = this.states.get(queueId);
    if (!state) throw new Error(`missing fake state ${queueId}`);
    return state;
  }

  async claimUnitTurns(input) {
    this.claimCalls.push(structuredClone(input));
    return this.claims.slice(0, input.batch);
  }

  async inspectExternalUnitTurn(input) {
    this.externalInspectionCalls.push(structuredClone(input));
    const claim = this.claims.find((candidate) =>
      candidate.queueId === input.queueId
      && candidate.unitId === input.unitId
      && candidate.nodeId === input.nodeId
    );
    if (!claim) return undefined;
    const snapshot = structuredClone(claim);
    delete snapshot.leaseToken;
    return snapshot;
  }

  async claimExternalUnitTurn(input) {
    this.externalClaimCalls.push(structuredClone(input));
    const claim = this.claims.find((candidate) =>
      candidate.queueId === input.queueId
      && candidate.unitId === input.unitId
      && candidate.nodeId === input.nodeId
    );
    if (!claim) return undefined;
    const state = this.state(input.queueId);
    if (state.settled) {
      const exact = state.settled.principalId === input.principalId
        && state.settled.actorId === input.actorId
        && state.settled.completionDigest === input.completionDigest
        && state.settled.committedOutboxEventDigests.length === input.outboxEventDigests.length
        && state.settled.committedOutboxEventDigests.every(
          (value, index) => value === input.outboxEventDigests[index]
        );
      if (!exact) {
        throw new TurnEvidenceConflictError("external completion conflicts with settled fake evidence");
      }
      return { disposition: "settled", ...structuredClone(state.settled) };
    }
    return {
      disposition: "claimed",
      claim
    };
  }

  async heartbeatTurn(input) {
    this.heartbeatCalls.push(structuredClone(input));
    if (this.options.heartbeatError) throw this.options.heartbeatError;
  }

  async prepareTurnAttempt(input) {
    this.prepareCalls.push(structuredClone(input));
    if (this.options.prepareError) throw this.options.prepareError;
    const state = this.state(input.queueId);
    if (state.terminal) {
      return { disposition: "terminal", errorCode: state.terminal, attempts: state.attemptIndex };
    }
    const identity = {
      attemptNumber: state.attemptNumber,
      attemptIndex: state.attemptIndex,
      idempotencyKey: nodeTurnIdempotencyKey({
        unitId: input.unitId,
        nodeId: input.nodeId,
        attemptNumber: state.attemptNumber,
        nodeRef: input.nodeRef,
        fingerprint: input.fingerprint,
        inputDigest: input.inputDigest,
        ...(input.executionIdentityDigest === undefined
          ? {}
          : { executionIdentityDigest: input.executionIdentityDigest })
      })
    };
    if (state.cached) return { disposition: "cached", ...identity, ...state.cached };
    return { disposition: "reserved", ...identity };
  }

  async cacheTurnCompletion(input) {
    this.cacheCalls.push(structuredClone(input));
    if (this.options.cacheError) throw this.options.cacheError;
    const state = this.state(input.queueId);
    if (state.cached) {
      return {
        created: false,
        ...structuredClone(state.cached)
      };
    }
    state.cached = {
      completion: structuredClone(input.completion),
      completionDigest: input.completionDigest,
      startedAt: input.startedAt,
      settledAt: input.settledAt
    };
    if (this.options.cacheCommitThenError) throw this.options.cacheCommitThenError;
    return this.options.malformedCacheResult
      ?? { created: true, ...structuredClone(state.cached) };
  }

  async recordTurnFailure(input, outboxEvents = []) {
    this.failureCalls.push({ input: structuredClone(input), outboxEvents: structuredClone(outboxEvents) });
    if (this.options.failureError) throw this.options.failureError;
    const state = this.state(input.queueId);
    if (input.terminal) state.terminal = input.errorCode;
    else {
      state.attemptNumber += 1;
      state.attemptIndex += 1;
    }
    return {
      created: true,
      failureDigest: input.failureDigest
    };
  }

  async settleTurn(input, outboxEvents = []) {
    this.settleCalls.push({ input: structuredClone(input), outboxEvents: structuredClone(outboxEvents) });
    const state = this.state(input.queueId);
    if (state.settled) {
      if (
        state.settled.completionDigest !== input.completionDigest
        || state.settled.settlementDigest !== input.settlementDigest
      ) {
        throw new TurnEvidenceConflictError("settlement conflicts with fake evidence");
      }
      return {
        created: false,
        completionDigest: state.settled.completionDigest,
        settlementDigest: state.settled.settlementDigest,
        committedOutboxEventDigests: state.settled.committedOutboxEventDigests
      };
    }
    if (this.options.settleError) throw this.options.settleError;
    if (this.options.settleReply) return this.options.settleReply(input, outboxEvents);
    const committedOutboxEventDigests = outboxEvents.map(turnOutboxEventDigest);
    state.settled = {
      queueId: input.queueId,
      unitId: input.unitId,
      nodeId: input.nodeId,
      attemptNumber: input.attemptNumber,
      attemptIndex: input.attemptIndex,
      idempotencyKey: input.idempotencyKey,
      principalId: input.principalId,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      completionDigest: input.completionDigest,
      startedAt: input.startedAt,
      settledAt: input.settledAt,
      settlementDigest: input.settlementDigest,
      committedOutboxEventDigests
    };
    if (this.options.settleCommitThenError) throw this.options.settleCommitThenError;
    return {
      created: this.options.settleCreated ?? true,
      completionDigest: input.completionDigest,
      settlementDigest: input.settlementDigest,
      ...(this.options.settleCreated === false
        ? { committedOutboxEventDigests }
        : {})
    };
  }
}

function clock(start = "2026-08-27T12:00:00.000Z") {
  let current = Date.parse(start);
  return () => new Date(current++);
}

async function withObjectPrototypeProperties(descriptors, operation) {
  const originals = new Map(
    Reflect.ownKeys(descriptors).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key)
    ])
  );
  try {
    Object.defineProperties(Object.prototype, descriptors);
    return await operation();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
}

const goldenPath = new URL(
  "./fixtures/switchyard/node-turn-v2-digest-golden-vectors.json",
  import.meta.url
);
let storeSequence = 1;

test("node-turn golden vectors pin the fingerprint, attempt key, and completion seal", () => {
  const vectors = JSON.parse(readFileSync(goldenPath, "utf8"));
  for (const vector of vectors.fingerprints) {
    assert.equal(nodeExecutionFingerprint(vector.node), vector.expected);
  }
  for (const vector of vectors.idempotencyKeys) {
    assert.equal(nodeTurnIdempotencyKey(vector.input), vector.expected);
  }
  for (const vector of vectors.completions) {
    assert.equal(nodeTurnCompletionDigest(vector.completion), vector.expected);
  }
});

test("idempotency identity changes on every binding coordinate and rejects hostile shapes", () => {
  const graph = graphFor("code");
  const node = graph.nodes[0];
  const input = createArtifactEnvelope("turn-input.v1", { a: 1 });
  const base = {
    unitId: "unit-1",
    nodeId: node.nodeId,
    attemptNumber: 11,
    nodeRef: node.ref,
    fingerprint: nodeExecutionFingerprint(node),
    inputDigest: input.digest
  };
  const key = nodeTurnIdempotencyKey(base);
  for (const changed of [
    { ...base, unitId: "unit-2" },
    { ...base, nodeId: "other-node" },
    { ...base, attemptNumber: 12 },
    { ...base, nodeRef: { ...base.nodeRef, version: 2 } },
    { ...base, fingerprint: "f".repeat(64) },
    { ...base, inputDigest: "e".repeat(64) },
    { ...base, executionIdentityDigest: "d".repeat(64) }
  ]) {
    assert.notEqual(nodeTurnIdempotencyKey(changed), key);
  }
  let getterCalls = 0;
  const hostile = { ...base };
  Object.defineProperty(hostile, "unitId", { enumerable: true, get() { getterCalls += 1; return "unit-1"; } });
  assert.throws(() => nodeTurnIdempotencyKey(hostile), /unitId must be an enumerable data property/);
  assert.equal(getterCalls, 0);
  assert.throws(() => nodeTurnIdempotencyKey(new Proxy(base, {})), /plain non-Proxy/);
  assert.throws(() => nodeTurnIdempotencyKey({ ...base, next: "node" }), /unknown key/);
});

test("ambient Object.prototype values cannot supply a binding, identity, or node port", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const node = graph.nodes[0];
  const expectedFingerprint = nodeExecutionFingerprint(node);
  const baseKey = nodeTurnIdempotencyKey({
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    attemptNumber: 1,
    nodeRef: node.ref,
    fingerprint: expectedFingerprint,
    inputDigest: claim.inputArtifact.digest
  });
  let getterCalls = 0;
  let ambientBodyCalls = 0;
  let ambientStoreCalls = 0;
  let explicitBodyCalls = 0;
  await withObjectPrototypeProperties({
    binding: {
      configurable: true,
      value: BINDING
    },
    executionIdentityDigest: {
      configurable: true,
      get() {
        getterCalls += 1;
        return "e".repeat(64);
      }
    },
    code: {
      configurable: true,
      value: {
        async run() {
          ambientBodyCalls += 1;
          return { outcome: "done" };
        }
      }
    },
    run: {
      configurable: true,
      value: async () => {
        ambientBodyCalls += 1;
        return { outcome: "done" };
      }
    },
    settleTurn: {
      configurable: true,
      value: async () => {
        ambientStoreCalls += 1;
        throw new Error("ambient store method must not run");
      }
    },
    store: {
      configurable: true,
      value: { forged: true }
    },
    leaseToken: {
      configurable: true,
      value: "ambient-lease"
    },
    credentials: {
      configurable: true,
      value: { forged: true }
    }
  }, async () => {
    assert.equal(nodeExecutionFingerprint(node), expectedFingerprint);
    assert.equal(nodeTurnIdempotencyKey({
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      attemptNumber: 1,
      nodeRef: node.ref,
      fingerprint: expectedFingerprint,
      inputDigest: claim.inputArtifact.digest
    }), baseKey);
    for (const ports of [{}, { code: {} }]) {
      const store = new FakeTurnStore([claim]);
      const result = await runClaimedUnitTurn({
        store,
        claim,
        principalId: "v2_worker",
        ports,
        now: clock()
      });
      assert.equal(result.status, "terminal");
      assert.equal(store.failureCalls[0].input.errorCode, "immutable_configuration_rejected");
    }
    const backing = new FakeTurnStore([claim]);
    const missingSettle = {
      heartbeatTurn: backing.heartbeatTurn.bind(backing),
      prepareTurnAttempt: backing.prepareTurnAttempt.bind(backing),
      cacheTurnCompletion: backing.cacheTurnCompletion.bind(backing),
      recordTurnFailure: backing.recordTurnFailure.bind(backing)
    };
    await assert.rejects(
      runClaimedUnitTurn({
        store: missingSettle,
        claim,
        principalId: "v2_worker",
        ports: { code: { async run() { return { outcome: "done" }; } } }
      }),
      /settleTurn must be a data-property function/
    );

    const explicitStore = new FakeTurnStore([claim]);
    const explicit = await runClaimedUnitTurn({
      store: explicitStore,
      claim,
      principalId: "v2_worker",
      ports: {
        code: {
          async run(_input, context) {
            explicitBodyCalls += 1;
            for (const key of ["store", "leaseToken", "credentials"]) {
              assert.equal(key in context, false);
            }
            assert.equal(Object.getPrototypeOf(context), null);
            assert.equal(Object.getPrototypeOf(context.graph), null);
            assert.equal(Object.getPrototypeOf(context.nodeRef), null);
            assert.equal(Object.getPrototypeOf(context.inputArtifact), null);
            return { outcome: "done" };
          }
        }
      },
      now: clock()
    });
    assert.equal(explicit.status, "succeeded");

    const modelGraph = graphFor("model", { graphId: "test.null-binding" });
    const modelClaim = claimFor(modelGraph, { queueId: "queue-null-binding" });
    const modelStore = new FakeTurnStore([modelClaim]);
    const modelResult = await runClaimedUnitTurn({
      store: modelStore,
      claim: modelClaim,
      principalId: "v2_model",
      ports: {
        model: {
          async invoke(_input, binding) {
            explicitBodyCalls += 1;
            assert.equal("credentials" in binding, false);
            assert.equal(Object.getPrototypeOf(binding), null);
            return { outcome: "done", usage: [receipt()] };
          }
        }
      },
      now: clock()
    });
    assert.equal(modelResult.status, "succeeded");
  });
  assert.equal(getterCalls, 0);
  assert.equal(ambientBodyCalls, 0);
  assert.equal(ambientStoreCalls, 0);
  assert.equal(explicitBodyCalls, 2);
});

test("public completion digest is bounded and caller-thrown lookalikes cannot mint usage evidence", async () => {
  await withObjectPrototypeProperties({
    outcome: {
      configurable: true,
      value: "done"
    }
  }, async () => {
    assert.throws(
      () => nodeTurnCompletionDigest({}),
      /outcome.*must be a string/
    );
  });

  let deep = { value: true };
  for (let index = 0; index < 20_000; index += 1) deep = { child: deep };
  assert.throws(
    () => nodeTurnCompletionDigest({ outcome: "done", usage: [{ ...receipt(), extra: deep }] }),
    (error) => {
      assert.equal(error instanceof RangeError, false);
      assert.match(error.message, /maximum depth|unknown key/);
      return true;
    }
  );
  const graph = graphFor("code", { maxAttempts: 1, graphId: "test.result-lookalike" });
  const claim = claimFor(graph, { queueId: "queue-result-lookalike" });
  const store = new FakeTurnStore([claim]);
  const lookalike = new ExecutionFailureError("immutable_stage_contract_rejected", false);
  lookalike.usage = [receipt()];
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { throw lookalike; } } },
    now: clock()
  });
  assert.equal(result.status, "terminal");
  assert.deepEqual(store.failureCalls[0].input.usage, []);
  assert.deepEqual(store.failureCalls[0].outboxEvents, []);
});

test("real internal error brands are bound to the exact node-turn identity", async () => {
  const modelGraph = graphFor("model", { graphId: "test.brand-source-model" });
  const modelClaim = claimFor(modelGraph, { queueId: "brand-source-model" });
  let brandedResultError;
  try {
    await executeNodeTurnAttempt({
      node: modelGraph.nodes[0],
      context: directContextFor(modelGraph, modelClaim),
      inputArtifact: modelClaim.inputArtifact,
      ports: {
        model: {
          async invoke() {
            return { outcome: "not-declared", usage: [receipt()] };
          }
        }
      }
    });
  } catch (error) {
    brandedResultError = error;
  }
  assert.ok(brandedResultError);

  const agentGraph = graphFor("agent", {
    graphId: "test.brand-source-agent",
    maxAttempts: 1
  });
  const agentClaim = claimFor(agentGraph, { queueId: "brand-source-agent" });
  let brandedUncertainError;
  try {
    await executeNodeTurnAttempt({
      node: agentGraph.nodes[0],
      context: directContextFor(agentGraph, agentClaim),
      inputArtifact: agentClaim.inputArtifact,
      ports: {
        agent: {
          async submitTurnIntent() {},
          async awaitSettledResult() { throw new Error("agent await indeterminate"); }
        }
      }
    });
  } catch (error) {
    brandedUncertainError = error;
  }
  assert.equal(isNodeTurnInvocationUncertainError(brandedUncertainError), true);

  for (const [suffix, replayed] of [
    ["result", brandedResultError],
    ["uncertain", brandedUncertainError]
  ]) {
    const codeGraph = graphFor("code", {
      maxAttempts: 1,
      graphId: `test.cross-kind-${suffix}`
    });
    const codeClaim = claimFor(codeGraph, { queueId: `cross-kind-${suffix}` });
    const store = new FakeTurnStore([codeClaim]);
    const result = await runClaimedUnitTurn({
      store,
      claim: codeClaim,
      principalId: "v2_worker",
      ports: { code: { async run() { throw replayed; } } },
      now: clock()
    });
    assert.equal(result.status, "terminal");
    assert.equal(store.failureCalls.length, 1);
    assert.deepEqual(store.failureCalls[0].input.usage, []);
    assert.deepEqual(store.failureCalls[0].outboxEvents, []);
  }

  const replayedModelStore = new FakeTurnStore([modelClaim], {
    startAttemptNumber: 2
  });
  const replayedModel = await runClaimedUnitTurn({
    store: replayedModelStore,
    claim: modelClaim,
    principalId: "v2_model",
    ports: {
      model: {
        async invoke() { throw brandedResultError; }
      }
    },
    now: clock()
  });
  assert.equal(replayedModel.status, "terminal");
  assert.equal(replayedModelStore.failureCalls.length, 1);
  assert.deepEqual(replayedModelStore.failureCalls[0].input.usage, []);
  assert.deepEqual(replayedModelStore.failureCalls[0].outboxEvents, []);

  const replayedAgentStore = new FakeTurnStore([agentClaim], {
    startAttemptNumber: 2
  });
  const replayedAgent = await runClaimedUnitTurn({
    store: replayedAgentStore,
    claim: agentClaim,
    principalId: "v2_agent",
    ports: {
      agent: {
        async submitTurnIntent() {},
        async awaitSettledResult() { throw brandedUncertainError; }
      }
    },
    now: clock()
  });
  assert.equal(replayedAgent.status, "terminal");
  assert.equal(replayedAgentStore.failureCalls.length, 1);
  assert.equal(replayedAgentStore.cacheCalls.length, 0);
  assert.equal(replayedAgentStore.settleCalls.length, 0);
});

test("one code turn receives frozen least-authority context and uses one atomic settle", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim], { startAttemptNumber: 17 });
  let calls = 0;
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run(input, context) {
          calls += 1;
          assert.deepEqual(input, { value: "unit-1" });
          assert.equal(context.attemptNumber, 17);
          assert.equal(context.attemptIndex, 1);
          assert.equal(Object.isFrozen(context), true);
          assert.equal("store" in context, false);
          assert.equal("leaseToken" in context, false);
          assert.equal("successors" in context, false);
          return { outcome: "done", outputArtifact: createArtifactEnvelope("turn-input.v1", { ok: true }) };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attemptNumber, 17);
  assert.equal(calls, 1);
  assert.equal(store.cacheCalls.length, 1);
  assert.equal(store.settleCalls.length, 1);
  assert.equal(store.failureCalls.length, 0);
  assert.equal("successors" in store.settleCalls[0].input, false);
  assert.equal("routing" in store.settleCalls[0].input, false);
});

test("prepare response loss reclaims the unchanged reservation and attempt key", async () => {
  const graph = graphFor("code");
  const firstClaim = claimFor(graph, { leaseToken: "lease-prepare-lost" });
  const store = new FakeTurnStore([firstClaim], { startAttemptNumber: 29 });
  const basePrepare = store.prepareTurnAttempt.bind(store);
  let reserved;
  let loseFirstResponse = true;
  store.prepareTurnAttempt = async (input) => {
    const result = await basePrepare(input);
    reserved ??= structuredClone(result);
    if (loseFirstResponse) {
      loseFirstResponse = false;
      throw new Error("prepare reservation committed; response lost");
    }
    return result;
  };
  let bodyCalls = 0;
  const ports = {
    code: {
      async run() {
        bodyCalls += 1;
        return { outcome: "done" };
      }
    }
  };
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim: firstClaim,
      principalId: "v2_worker",
      ports,
      now: clock()
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "prepare");
      return true;
    }
  );
  assert.equal(bodyCalls, 0);
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);

  const recovered = await runClaimedUnitTurn({
    store,
    claim: claimFor(graph, { leaseToken: "lease-prepare-reclaimed" }),
    principalId: "v2_worker",
    ports,
    now: clock()
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attemptNumber, reserved.attemptNumber);
  assert.equal(recovered.attemptIndex, reserved.attemptIndex);
  assert.equal(recovered.idempotencyKey, reserved.idempotencyKey);
  assert.equal(bodyCalls, 1);
});

test("cached completion is fully revalidated, invokes no body, and settles once", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const completion = { outcome: "done" };
  const cached = {
    completion,
    completionDigest: nodeTurnCompletionDigest(completion),
    startedAt: "2026-08-27T12:00:00.000Z",
    settledAt: "2026-08-27T12:00:00.001Z"
  };
  const store = new FakeTurnStore([claim], { cachedByQueue: { [claim.queueId]: cached } });
  let calls = 0;
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { calls += 1; throw new Error("must not run"); } } }
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.reused, true);
  assert.equal(calls, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.settleCalls.length, 1);
});

test("cache response loss reclaims the same attempt under a new lease without rerunning the body", async () => {
  const graph = graphFor("code");
  const firstClaim = claimFor(graph, { leaseToken: "lease-before-crash" });
  const store = new FakeTurnStore([firstClaim], {
    startAttemptNumber: 73,
    cacheCommitThenError: new Error("cache committed; response lost")
  });
  let bodyCalls = 0;
  const run = (claim) => runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { bodyCalls += 1; return { outcome: "done" }; } } },
    now: clock()
  });
  await assert.rejects(run(firstClaim), (error) => {
    assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
    assert.equal(error.operation, "cache_completion");
    return true;
  });
  assert.equal(bodyCalls, 1);
  assert.equal(store.settleCalls.length, 0);

  store.options.cacheCommitThenError = undefined;
  const reclaimed = claimFor(graph, { leaseToken: "lease-after-reclaim" });
  const recovered = await run(reclaimed);
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.reused, true);
  assert.equal(recovered.attemptNumber, 73);
  assert.equal(bodyCalls, 1);
  assert.equal(store.prepareCalls[0].leaseToken, "lease-before-crash");
  assert.equal(store.prepareCalls[1].leaseToken, "lease-after-reclaim");
  assert.equal(store.settleCalls[0].input.leaseToken, "lease-after-reclaim");
  assert.equal(store.prepareCalls[0].nodeRef.id, store.prepareCalls[1].nodeRef.id);
});

test("created:false cache replies replace losing local timestamps with the authoritative row", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const authoritative = {
    completion: { outcome: "done" },
    completionDigest: nodeTurnCompletionDigest({ outcome: "done" }),
    startedAt: "2026-08-27T11:00:00.000Z",
    settledAt: "2026-08-27T11:00:00.001Z"
  };
  store.cacheTurnCompletion = async function (input) {
    this.cacheCalls.push(structuredClone(input));
    this.state(input.queueId).cached = structuredClone(authoritative);
    return { created: false, ...structuredClone(authoritative) };
  };
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { return { outcome: "done" }; } } },
    now: clock("2026-08-27T12:00:00.000Z")
  });
  assert.equal(result.reused, true);
  assert.equal(store.settleCalls[0].input.startedAt, authoritative.startedAt);
  assert.equal(store.settleCalls[0].input.settledAt, authoritative.settledAt);
});

test("active worker turns heartbeat their lease without inventing a time outcome", async () => {
  const graph = graphFor("code", { leaseMs: 15 });
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 35));
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.ok(store.heartbeatCalls.length >= 1);
  assert.equal(store.heartbeatCalls.every((call) => call.extendByMs === 15), true);
  assert.equal(store.settleCalls[0].input.completion.outcome, "done");
});

test("a near-expiry lease is renewed before the worker body starts", async () => {
  const graph = graphFor("code", { leaseMs: 30_000 });
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  let renewed = false;
  const baseHeartbeat = store.heartbeatTurn.bind(store);
  store.heartbeatTurn = async (input) => {
    await baseHeartbeat(input);
    renewed = true;
  };
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run() {
          assert.equal(renewed, true, "body started before the current fence was renewed");
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.equal(store.heartbeatCalls.length, 1);
});

test("heartbeat authority failure fences before body execution without failure evidence", async () => {
  const graph = graphFor("code", { leaseMs: 15 });
  const claim = claimFor(graph);
  const stale = new TurnLeaseLostError(claim.queueId);
  const store = new FakeTurnStore([claim], { heartbeatError: stale });
  let bodyCalls = 0;
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: {
        code: {
          async run() {
            bodyCalls += 1;
            return { outcome: "done" };
          }
        }
      },
      now: clock()
    }),
    (error) => error === stale
  );
  assert.ok(store.heartbeatCalls.length >= 1);
  assert.equal(bodyCalls, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);
});

test("generic heartbeat loss preserves the reservation for exact-key reclaim", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim], {
    heartbeatError: new Error("heartbeat response lost")
  });
  let bodyCalls = 0;
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { bodyCalls += 1; return { outcome: "done" }; } } },
      now: clock()
    }),
    TurnLeaseHeartbeatError
  );
  assert.equal(bodyCalls, 0);
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);

  store.options.heartbeatError = undefined;
  let reclaimedKey;
  const recovered = await runClaimedUnitTurn({
    store,
    claim: claimFor(graph, { leaseToken: "lease-heartbeat-reclaimed" }),
    principalId: "v2_worker",
    ports: {
      code: {
        async run(_input, context) {
          bodyCalls += 1;
          reclaimedKey = context.idempotencyKey;
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attemptNumber, 1);
  assert.equal(recovered.attemptIndex, 1);
  assert.equal(recovered.idempotencyKey, reclaimedKey);
  assert.equal(bodyCalls, 1);
});

test("periodic heartbeat loss fences a completed body and reclaims the same attempt key", async () => {
  const graph = graphFor("code", { leaseMs: 15 });
  const firstClaim = claimFor(graph, { leaseToken: "lease-periodic-heartbeat" });
  const store = new FakeTurnStore([firstClaim]);
  const baseHeartbeat = store.heartbeatTurn.bind(store);
  let heartbeatCalls = 0;
  store.heartbeatTurn = async (input) => {
    heartbeatCalls += 1;
    await baseHeartbeat(input);
    if (heartbeatCalls === 2) throw new Error("periodic heartbeat response lost");
  };
  const bodyKeys = [];
  const ports = {
    code: {
      async run(_input, context) {
        bodyKeys.push(context.idempotencyKey);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { outcome: "done" };
      }
    }
  };
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim: firstClaim,
      principalId: "v2_worker",
      ports,
      now: clock()
    }),
    TurnLeaseHeartbeatError
  );
  assert.ok(heartbeatCalls >= 2);
  assert.equal(bodyKeys.length, 1);
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);

  store.heartbeatTurn = baseHeartbeat;
  const recovered = await runClaimedUnitTurn({
    store,
    claim: claimFor(graph, { leaseToken: "lease-periodic-reclaimed" }),
    principalId: "v2_worker",
    ports,
    now: clock()
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attemptNumber, 1);
  assert.equal(recovered.attemptIndex, 1);
  assert.deepEqual(bodyKeys, [recovered.idempotencyKey, recovered.idempotencyKey]);
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.cacheCalls.length, 1);
  assert.equal(store.settleCalls.length, 1);
});

test("retryable failures use consecutive global attempt numbers and per-queue budget", async () => {
  const graph = graphFor("code", { maxAttempts: 3 });
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim], { startAttemptNumber: 41 });
  const contexts = [];
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run(_input, context) {
          contexts.push([context.attemptNumber, context.attemptIndex, context.idempotencyKey]);
          if (contexts.length < 3) throw new Error("fetch 503");
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(contexts.map(([attemptNumber, attemptIndex]) => [attemptNumber, attemptIndex]), [
    [41, 1], [42, 2], [43, 3]
  ]);
  assert.equal(new Set(contexts.map((entry) => entry[2])).size, 3);
  assert.deepEqual(store.failureCalls.map((entry) => entry.input.terminal), [false, false]);
  assert.equal(store.settleCalls.length, 1);
});

test("retry progression rejects repeated or skipped queue-local reservations before another body", async () => {
  for (const scenario of [
    { attemptNumber: 41, attemptIndex: 1 },
    { attemptNumber: 41, attemptIndex: 2 },
    { attemptNumber: 43, attemptIndex: 3 }
  ]) {
    const graph = graphFor("code", {
      maxAttempts: 3,
      graphId: `test.retry-progression-${scenario.attemptIndex}`
    });
    const claim = claimFor(graph, {
      queueId: `queue-retry-progression-${scenario.attemptIndex}`
    });
    const store = new FakeTurnStore([claim], { startAttemptNumber: 41 });
    const basePrepare = store.prepareTurnAttempt.bind(store);
    let prepareCalls = 0;
    store.prepareTurnAttempt = async (input) => {
      prepareCalls += 1;
      if (prepareCalls === 1) return basePrepare(input);
      const node = graph.nodes[0];
      return {
        disposition: "reserved",
        attemptNumber: scenario.attemptNumber,
        attemptIndex: scenario.attemptIndex,
        idempotencyKey: nodeTurnIdempotencyKey({
          unitId: claim.unitId,
          nodeId: node.nodeId,
          attemptNumber: scenario.attemptNumber,
          nodeRef: node.ref,
          fingerprint: nodeExecutionFingerprint(node),
          inputDigest: claim.inputArtifact.digest
        })
      };
    };
    let bodyCalls = 0;
    await assert.rejects(
      runClaimedUnitTurn({
        store,
        claim,
        principalId: "v2_worker",
        ports: {
          code: {
            async run() {
              bodyCalls += 1;
              throw new Error("fetch 503");
            }
          }
        },
        now: clock()
      }),
      (error) => {
        assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
        assert.equal(error.operation, "prepare");
        assert.match(error.cause.message, /did not advance/);
        return true;
      }
    );
    assert.equal(bodyCalls, 1);
    assert.equal(store.failureCalls.length, 1);
    assert.equal(store.cacheCalls.length, 0);
    assert.equal(store.settleCalls.length, 0);
  }
});

test("retry progression permits gaps in the global unit/node attempt counter", async () => {
  const graph = graphFor("code", {
    maxAttempts: 3,
    graphId: "test.retry-global-gap"
  });
  const claim = claimFor(graph, { queueId: "queue-retry-global-gap" });
  const store = new FakeTurnStore([claim], { startAttemptNumber: 41 });
  const basePrepare = store.prepareTurnAttempt.bind(store);
  let prepareCalls = 0;
  store.prepareTurnAttempt = async (input) => {
    prepareCalls += 1;
    if (prepareCalls === 1) return basePrepare(input);
    const node = graph.nodes[0];
    return {
      disposition: "reserved",
      attemptNumber: 43,
      attemptIndex: 2,
      idempotencyKey: nodeTurnIdempotencyKey({
        unitId: claim.unitId,
        nodeId: node.nodeId,
        attemptNumber: 43,
        nodeRef: node.ref,
        fingerprint: nodeExecutionFingerprint(node),
        inputDigest: claim.inputArtifact.digest
      })
    };
  };
  let bodyCalls = 0;
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run() {
          bodyCalls += 1;
          if (bodyCalls === 1) throw new Error("fetch 503");
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.attemptNumber, 43);
  assert.equal(result.attemptIndex, 2);
  assert.equal(bodyCalls, 2);
});

test("agent await uncertainty preserves one reservation and resubmits only the same idempotency key", async () => {
  const graph = graphFor("agent");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim], { startAttemptNumber: 31 });
  const submittedKeys = [];
  let awaitCalls = 0;
  const ports = {
    agent: {
      async submitTurnIntent(_input, context) {
        submittedKeys.push(context.idempotencyKey);
      },
      async awaitSettledResult() {
        awaitCalls += 1;
        if (awaitCalls === 1) throw new Error("agent result transport dropped");
        return { outcome: "done" };
      }
    }
  };
  await assert.rejects(
    runClaimedUnitTurn({ store, claim, principalId: "v2_agent", ports, now: clock() }),
    (error) => {
      assert.equal(isNodeTurnInvocationUncertainError(error), true);
      assert.equal(error.operation, "agent_await");
      return true;
    }
  );
  assert.equal(store.failureCalls.length, 0);
  assert.equal(store.cacheCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);

  const recovered = await runClaimedUnitTurn({
    store,
    claim: claimFor(graph, { leaseToken: "agent-reclaimed" }),
    principalId: "v2_agent",
    ports,
    now: clock()
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.attemptNumber, 31);
  assert.deepEqual(submittedKeys, [submittedKeys[0], submittedKeys[0]]);
  assert.deepEqual(store.prepareCalls.map((call) => call.maxAttempts), [3, 3]);
});

test("malformed host wiring is one terminal configuration failure, not a retry loop", async () => {
  for (const kind of ["code", "model", "agent"]) {
    const graph = graphFor(kind, { graphId: `test.missing-port-${kind}` });
    const claim = claimFor(graph, { queueId: `queue-missing-${kind}` });
    const store = new FakeTurnStore([claim]);
    const result = await runClaimedUnitTurn({
      store,
      claim,
      principalId: `v2_${kind === "code" ? "worker" : kind}`,
      ports: { [kind]: {} },
      now: clock()
    });
    assert.equal(result.status, "terminal");
    assert.equal(store.prepareCalls.length, 1);
    assert.equal(store.failureCalls.length, 1);
    assert.equal(store.failureCalls[0].input.errorCode, "immutable_configuration_rejected");
  }
});

test("hostile thrown Proxies and forged coordination errors cannot bypass failed-attempt evidence", async () => {
  const proxyGraph = graphFor("code", { maxAttempts: 3, graphId: "test.proxy-throw" });
  const proxyClaim = claimFor(proxyGraph, { queueId: "queue-proxy-throw" });
  const proxyStore = new FakeTurnStore([proxyClaim]);
  let traps = 0;
  const hostile = new Proxy(new Error("hostile"), {
    get() { traps += 1; throw new Error("get trap"); },
    getPrototypeOf() { traps += 1; throw new Error("prototype trap"); },
    ownKeys() { traps += 1; throw new Error("ownKeys trap"); }
  });
  const proxyResult = await runClaimedUnitTurn({
    store: proxyStore,
    claim: proxyClaim,
    principalId: "v2_worker",
    ports: { code: { async run() { throw hostile; } } },
    now: clock()
  });
  assert.equal(proxyResult.status, "terminal");
  assert.equal(proxyStore.failureCalls[0].input.errorCode, "untrusted_proxy_error");
  assert.equal(traps, 0);

  const forgedGraph = graphFor("code", { maxAttempts: 1, graphId: "test.forged-fence" });
  const forgedClaim = claimFor(forgedGraph, { queueId: "queue-forged-fence" });
  const forgedStore = new FakeTurnStore([forgedClaim]);
  const forged = await runClaimedUnitTurn({
    store: forgedStore,
    claim: forgedClaim,
    principalId: "v2_worker",
    ports: { code: { async run() { throw new TurnLeaseLostError(forgedClaim.queueId); } } },
    now: clock()
  });
  assert.equal(forged.status, "terminal");
  assert.equal(forgedStore.failureCalls.length, 1);
});

test("nonretryable and exhausted failures dead-letter atomically and never settle success", async () => {
  for (const scenario of [
    { maxAttempts: 3, error: () => new ExecutionFailureError("operator_declined", false), expectedCalls: 1 },
    { maxAttempts: 2, error: () => new Error("connect 503"), expectedCalls: 2 }
  ]) {
    const graph = graphFor("code", { maxAttempts: scenario.maxAttempts, graphId: `test.failure-${scenario.maxAttempts}` });
    const claim = claimFor(graph, { queueId: `queue-failure-${scenario.maxAttempts}` });
    const store = new FakeTurnStore([claim], { startAttemptNumber: 99 });
    let calls = 0;
    const result = await runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { calls += 1; throw scenario.error(); } } },
      now: clock()
    });
    assert.equal(result.status, "terminal");
    assert.equal(calls, scenario.expectedCalls);
    assert.equal(store.failureCalls.at(-1).input.terminal, true);
    assert.ok(store.failureCalls.at(-1).input.failureDigest);
    assert.equal(store.settleCalls.length, 0);
  }
});

test("failure response loss recovers from the committed nonterminal or terminal state", async () => {
  for (const scenario of [
    { suffix: "nonterminal", error: () => new Error("fetch 503"), terminal: false },
    {
      suffix: "terminal",
      error: () => new ExecutionFailureError("operator_declined", false),
      terminal: true
    }
  ]) {
    const graph = graphFor("code", {
      maxAttempts: 3,
      graphId: `test.failure-response-loss-${scenario.suffix}`
    });
    const firstClaim = claimFor(graph, {
      queueId: `queue-failure-response-loss-${scenario.suffix}`,
      leaseToken: `lease-failure-response-loss-${scenario.suffix}`
    });
    const store = new FakeTurnStore([firstClaim], { startAttemptNumber: 61 });
    const baseRecordFailure = store.recordTurnFailure.bind(store);
    let loseFirstResponse = true;
    store.recordTurnFailure = async (input, outboxEvents) => {
      const result = await baseRecordFailure(input, outboxEvents);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("failed-attempt transaction committed; response lost");
      }
      return result;
    };
    let bodyCalls = 0;
    const ports = {
      code: {
        async run() {
          bodyCalls += 1;
          if (bodyCalls === 1 || scenario.terminal) throw scenario.error();
          return { outcome: "done" };
        }
      }
    };
    await assert.rejects(
      runClaimedUnitTurn({
        store,
        claim: firstClaim,
        principalId: "v2_worker",
        ports,
        now: clock()
      }),
      (error) => {
        assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
        assert.equal(error.operation, "record_failure");
        return true;
      }
    );
    assert.equal(store.failureCalls.length, 1);
    assert.equal(store.settleCalls.length, 0);

    const recovered = await runClaimedUnitTurn({
      store,
      claim: claimFor(graph, {
        queueId: firstClaim.queueId,
        leaseToken: `lease-failure-reclaimed-${scenario.suffix}`
      }),
      principalId: "v2_worker",
      ports,
      now: clock()
    });
    if (scenario.terminal) {
      assert.equal(recovered.status, "terminal");
      assert.equal(recovered.errorCode, "operator_declined");
      assert.equal(recovered.attempts, 1);
      assert.equal(bodyCalls, 1);
      assert.equal(store.settleCalls.length, 0);
    } else {
      assert.equal(recovered.status, "succeeded");
      assert.equal(recovered.attemptNumber, 62);
      assert.equal(recovered.attemptIndex, 2);
      assert.equal(bodyCalls, 2);
      assert.equal(store.settleCalls.length, 1);
    }
  }
});

test("the maximum failure-code identifier remains readable on terminal reclaim", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const boundaryCode = `a${"b".repeat(159)}`;
  let bodyCalls = 0;
  const first = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: {
      code: {
        async run() {
          bodyCalls += 1;
          throw new ExecutionFailureError(boundaryCode, false);
        }
      }
    },
    now: clock()
  });
  assert.equal(first.status, "terminal");
  assert.equal(first.errorCode, boundaryCode);

  const recovered = await runClaimedUnitTurn({
    store,
    claim: claimFor(graph, { leaseToken: "lease-terminal-code-reclaimed" }),
    principalId: "v2_worker",
    ports: {
      code: {
        async run() {
          bodyCalls += 1;
          throw new Error("terminal body must not run again");
        }
      }
    },
    now: clock()
  });
  assert.equal(recovered.status, "terminal");
  assert.equal(recovered.errorCode, boundaryCode);
  assert.equal(bodyCalls, 1);
  assert.equal(store.failureCalls.length, 1);
});

test("failure evidence is snapshotted once before hooks can mutate the thrown error", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const thrown = new ExecutionFailureError("original_terminal", false);
  thrown.message = "original message";
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { throw thrown; } } },
    failureOutboxEvents(context) {
      assert.equal(context.errorCode, "original_terminal");
      thrown.code = "mutated_retry";
      thrown.retryable = true;
      thrown.message = "mutated message";
      return [];
    },
    now: clock()
  });
  assert.equal(result.status, "terminal");
  assert.equal(store.failureCalls[0].input.errorCode, "original_terminal");
  assert.equal(store.failureCalls[0].input.retryable, false);
  assert.equal(store.failureCalls[0].input.errorMessage, "original message");
});

test("post-body evidence assembly errors remain uncertainty and never invent failure or settlement", async () => {
  const successGraph = graphFor("code", { graphId: "test.success-assembly" });
  const successClaim = claimFor(successGraph, { queueId: "queue-success-assembly" });
  const successStore = new FakeTurnStore([successClaim]);
  await assert.rejects(
    runClaimedUnitTurn({
      store: successStore,
      claim: successClaim,
      principalId: "v2_worker",
      ports: { code: { async run() { return { outcome: "done" }; } } },
      successOutboxEvents() { throw new Error("cannot assemble success evidence"); },
      now: clock()
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "assemble_settlement");
      return true;
    }
  );
  assert.equal(successStore.cacheCalls.length, 1);
  assert.equal(successStore.failureCalls.length, 0);
  assert.equal(successStore.settleCalls.length, 0);

  const failureGraph = graphFor("code", { graphId: "test.failure-assembly" });
  const failureClaim = claimFor(failureGraph, { queueId: "queue-failure-assembly" });
  const failureStore = new FakeTurnStore([failureClaim]);
  await assert.rejects(
    runClaimedUnitTurn({
      store: failureStore,
      claim: failureClaim,
      principalId: "v2_worker",
      ports: { code: { async run() { throw new Error("body failed"); } } },
      failureOutboxEvents() { throw new Error("cannot assemble failure evidence"); },
      now: clock()
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "assemble_failure");
      return true;
    }
  );
  assert.equal(failureStore.failureCalls.length, 0);
  assert.equal(failureStore.settleCalls.length, 0);
});

test("timestamp and terminal-attempt ordering guards reject before contradictory writes", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);

  const impossibleTimestampStore = new FakeTurnStore([claim], {
    cachedByQueue: {
      [claim.queueId]: {
        completion: { outcome: "done" },
        completionDigest: nodeTurnCompletionDigest({ outcome: "done" }),
        startedAt: "2026-02-31T12:00:00.000Z",
        settledAt: "2026-03-03T12:00:00.001Z"
      }
    }
  });
  let impossibleTimestampBodyCalls = 0;
  await assert.rejects(
    runClaimedUnitTurn({
      store: impossibleTimestampStore,
      claim,
      principalId: "v2_worker",
      ports: {
        code: {
          async run() {
            impossibleTimestampBodyCalls += 1;
            return { outcome: "done" };
          }
        }
      }
    }),
    TurnAttemptPersistenceUncertainError
  );
  assert.equal(impossibleTimestampBodyCalls, 0);
  assert.equal(impossibleTimestampStore.cacheCalls.length, 0);
  assert.equal(impossibleTimestampStore.failureCalls.length, 0);
  assert.equal(impossibleTimestampStore.settleCalls.length, 0);

  const regressingStore = new FakeTurnStore([claim]);
  const instants = [
    new Date("2026-08-27T12:00:00.010Z"),
    new Date("2026-08-27T12:00:00.000Z")
  ];
  await assert.rejects(
    runClaimedUnitTurn({
      store: regressingStore,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { return { outcome: "done" }; } } },
      now: () => instants.shift()
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "assemble_completion");
      return true;
    }
  );
  assert.equal(regressingStore.cacheCalls.length, 0);
  assert.equal(regressingStore.settleCalls.length, 0);

  const invalidClockStore = new FakeTurnStore([claim]);
  await assert.rejects(
    runClaimedUnitTurn({
      store: invalidClockStore,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { throw new Error("must not run"); } } },
      now: () => ({})
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "assemble_completion");
      return true;
    }
  );
  assert.equal(invalidClockStore.prepareCalls.length, 1);
  assert.equal(invalidClockStore.failureCalls.length, 0);
  assert.equal(invalidClockStore.cacheCalls.length, 0);
  assert.equal(invalidClockStore.settleCalls.length, 0);

  for (const attempts of [0, graph.nodes[0].turn.maxAttempts + 1]) {
    const store = new FakeTurnStore([claim]);
    store.prepareTurnAttempt = async () => ({
      disposition: "terminal",
      errorCode: "terminal",
      attempts
    });
    await assert.rejects(
      runClaimedUnitTurn({
        store,
        claim,
        principalId: "v2_worker",
        ports: { code: { async run() { throw new Error("must not run"); } } }
      }),
      TurnAttemptPersistenceUncertainError
    );
    assert.equal(store.failureCalls.length, 0);
  }
});

test("the clock uses Date intrinsics and never executes shadowed instance methods", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  let getterCalls = 0;
  const now = () => {
    const value = new Date("2026-08-27T12:00:00.000Z");
    for (const key of ["getTime", "toISOString"]) {
      Object.defineProperty(value, key, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error(`${key} getter must not run`);
        }
      });
    }
    return value;
  };
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { return { outcome: "done" }; } } },
    now
  });
  assert.equal(result.status, "succeeded");
  assert.equal(getterCalls, 0);
});

test("undeclared outcomes name the exact node/outcome and persist a terminal failed attempt", async () => {
  const graph = graphFor("code", { nodeId: "exact-node" });
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_worker",
    ports: { code: { async run() { return { outcome: "mystery" }; } } },
    now: clock()
  });
  assert.equal(result.status, "terminal");
  assert.equal(store.failureCalls.length, 1);
  assert.match(store.failureCalls[0].input.errorMessage, /node exact-node returned undeclared outcome "mystery"/);
  assert.equal(store.failureCalls[0].input.errorCode, "immutable_stage_contract_rejected");
  assert.equal(store.settleCalls.length, 0);
});

test("model receipt is mandatory and valid receipts ride settlement outbox", async () => {
  for (const valid of [false, true]) {
    const graph = graphFor("model", { graphId: `test.model-${valid}` });
    const claim = claimFor(graph, { queueId: `queue-model-${valid}` });
    const store = new FakeTurnStore([claim]);
    const result = await runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_model",
      ports: {
        model: {
          async invoke() {
            return valid
              ? { outcome: "done", usage: [receipt()] }
              : { outcome: "done" };
          }
        }
      },
      now: clock()
    });
    if (valid) {
      assert.equal(result.status, "succeeded");
      assert.equal(store.settleCalls[0].outboxEvents.length, 1);
      assert.equal(store.settleCalls[0].outboxEvents[0].eventType, NODE_TURN_USAGE_EVENT_TYPE);
    } else {
      assert.equal(result.status, "terminal");
      assert.match(store.failureCalls[0].input.errorMessage, /exactly one usage receipt/);
    }
  }
});

test("valid model usage survives invalid output and is appended with failed-attempt evidence", async () => {
  const graph = graphFor("model");
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  const result = await runClaimedUnitTurn({
    store,
    claim,
    principalId: "v2_model",
    ports: {
      model: {
        async invoke() {
          return {
            outcome: "not-declared",
            outputArtifact: { contractId: "turn-input.v1", digest: "0".repeat(64), payload: {} },
            usage: [receipt()]
          };
        }
      }
    },
    now: clock()
  });
  assert.equal(result.status, "terminal");
  assert.equal(store.failureCalls[0].input.usage.length, 1);
  assert.equal(store.failureCalls[0].outboxEvents.length, 1);
  assert.equal(store.failureCalls[0].outboxEvents[0].eventType, NODE_TURN_USAGE_EVENT_TYPE);
});

test("principal, input contract, human, and callback guards bite before worker invocation", async () => {
  const codeGraph = graphFor("code");
  let bodyCalls = 0;
  for (const entry of [
    {
      claim: claimFor(codeGraph),
      principalId: "wrong_principal",
      expected: TurnAuthorityError
    },
    {
      claim: claimFor(codeGraph, { inputArtifact: createArtifactEnvelope("wrong-input.v1", {}) }),
      principalId: "v2_worker",
      expected: /input contract mismatch/
    }
  ]) {
    const store = new FakeTurnStore([entry.claim]);
    await assert.rejects(
      runClaimedUnitTurn({
        store,
        claim: entry.claim,
        principalId: entry.principalId,
        ports: { code: { async run() { bodyCalls += 1; return { outcome: "done" }; } } }
      }),
      entry.expected
    );
    assert.equal(store.prepareCalls.length, 0);
  }
  for (const kind of ["human", "callback"]) {
    const graph = graphFor(kind);
    const claim = claimFor(graph);
    const store = new FakeTurnStore([claim]);
    await assert.rejects(
      runClaimedUnitTurn({ store, claim, principalId: `v2_${kind}`, ports: {} }),
      WorkerNodeKindError
    );
    assert.equal(store.prepareCalls.length, 0);
  }
  assert.equal(bodyCalls, 0);
});

test("malformed cached replies never invoke or settle and surface durable uncertainty", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const completion = { outcome: "wrong" };
  const store = new FakeTurnStore([claim], {
    cachedByQueue: {
      [claim.queueId]: {
        completion,
        completionDigest: nodeTurnCompletionDigest(completion),
        startedAt: "2026-08-27T12:00:00.000Z",
        settledAt: "2026-08-27T12:00:00.001Z"
      }
    }
  });
  let calls = 0;
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { calls += 1; return { outcome: "done" }; } } }
    }),
    TurnAttemptPersistenceUncertainError
  );
  assert.equal(calls, 0);
  assert.equal(store.settleCalls.length, 0);
});

test("lost/malformed settle is uncertainty, never failed-attempt or dead-letter evidence", async () => {
  for (const options of [
    { settleError: new Error("connection dropped after commit") },
    { settleReply: () => ({ created: true, completionDigest: "0".repeat(64), settlementDigest: "0".repeat(64) }) },
    { settleReply: (input) => ({
        created: false,
        completionDigest: input.completionDigest,
        settlementDigest: input.settlementDigest,
        committedOutboxEventDigests: ["0".repeat(64)]
      }) }
  ]) {
    const sequence = storeSequence++;
    const graph = graphFor("code", { graphId: `test.uncertain-${sequence}` });
    const claim = claimFor(graph, { queueId: `queue-${sequence}` });
    const store = new FakeTurnStore([claim], options);
    await assert.rejects(
      runClaimedUnitTurn({
        store,
        claim,
        principalId: "v2_worker",
        ports: { code: { async run() { return { outcome: "done" }; } } },
        now: clock()
      }),
      TurnSettlementUncertainError
    );
    assert.equal(store.settleCalls.length, 1);
    assert.equal(store.failureCalls.length, 0);
  }
});

test("stale settlement fence passes through unchanged and appends no failure", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const stale = new TurnLeaseLostError(claim.queueId);
  const store = new FakeTurnStore([claim], { settleError: stale });
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { return { outcome: "done" }; } } },
      now: clock()
    }),
    (error) => error === stale
  );
  assert.equal(store.failureCalls.length, 0);
});

test("homogeneous batch isolates units and invokes one settlement per successful unit", async () => {
  const graph = graphFor("code", { maxAttempts: 1 });
  const claims = [
    claimFor(graph, { unitId: "batch-ok", queueId: "queue-batch-ok" }),
    claimFor(graph, { unitId: "batch-fail", queueId: "queue-batch-fail" })
  ];
  const store = new FakeTurnStore(claims, { startAttemptNumber: 12 });
  const settlements = await runNextUnitTurns({
    store,
    principalId: "v2_worker",
    leaseOwner: "test-worker",
    batch: 2,
    ports: {
      code: {
        async run(_input, context) {
          if (context.unitId === "batch-fail") throw new ExecutionFailureError("rejected", false);
          return { outcome: "done" };
        }
      }
    },
    now: clock()
  });
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements.map((entry) => entry.result.status), ["fulfilled", "fulfilled"]);
  assert.deepEqual(settlements.map((entry) => entry.result.value.status), ["succeeded", "terminal"]);
  assert.equal(store.settleCalls.length, 1);
  assert.equal(store.failureCalls.length, 1);
});

test("batch claim validation rejects duplicate, requested, graph, and node mismatches before any body", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  const otherGraph = graphFor("code", { graphId: "test.other-code-graph" });
  const twoNodeGraph = createGraphDefinition({
    graphId: "test.two-node-batch",
    version: 1,
    description: "Two valid nodes used to prove node-homogeneous claims.",
    entry: "code-a",
    nodes: [
      {
        nodeId: "code-a",
        ref: { id: "test.code-a", version: 1 },
        kind: "code",
        input: "turn-input.v1",
        outcomes: { version: 1, outcomes: ["next"] },
        principal: { id: "v2_worker" },
        turn: TURN
      },
      {
        nodeId: "code-b",
        ref: { id: "test.code-b", version: 1 },
        kind: "code",
        input: "turn-input.v1",
        outcomes: { version: 1, outcomes: ["done"] },
        principal: { id: "v2_worker" },
        turn: TURN
      }
    ],
    edges: [
      { edgeId: "code-a-to-b", from: "code-a", when: { outcome: "next" }, to: ["code-b"] }
    ],
    terminals: [{ nodeId: "code-b", outcome: "done" }]
  });
  for (const scenario of [
    { claims: [claim, claim], nodeId: undefined, message: /duplicate queueId/ },
    { claims: [claim], nodeId: "requested-node", message: /for requested node/ },
    {
      claims: [
        claimFor(graph, { queueId: "batch-graph-a", unitId: "batch-graph-a" }),
        claimFor(otherGraph, { queueId: "batch-graph-b", unitId: "batch-graph-b" })
      ],
      nodeId: undefined,
      message: /non-homogeneous graph\/node/
    },
    {
      claims: [
        claimFor(twoNodeGraph, {
          queueId: "batch-node-a",
          unitId: "batch-node-a",
          nodeId: "code-a"
        }),
        claimFor(twoNodeGraph, {
          queueId: "batch-node-b",
          unitId: "batch-node-b",
          nodeId: "code-b"
        })
      ],
      nodeId: undefined,
      message: /non-homogeneous graph\/node/
    }
  ]) {
    const store = new FakeTurnStore(scenario.claims);
    let bodyCalls = 0;
    await assert.rejects(
      runNextUnitTurns({
        store,
        principalId: "v2_worker",
        leaseOwner: "batch-guard",
        batch: scenario.claims.length,
        ...(scenario.nodeId === undefined ? {} : { nodeId: scenario.nodeId }),
        ports: { code: { async run() { bodyCalls += 1; return { outcome: "done" }; } } }
      }),
      (error) => {
        assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
        assert.equal(error.operation, "claim_worker");
        assert.match(error.cause.message, scenario.message);
        return true;
      }
    );
    assert.equal(bodyCalls, 0);
    assert.equal(store.prepareCalls.length, 0);
  }
});

test("worker claim transport and reply validation have a distinct uncertainty boundary", async () => {
  for (const scenario of [
    { reply: undefined, error: new Error("claim response lost") },
    { reply: Object.freeze({}), error: undefined }
  ]) {
    const graph = graphFor("code");
    const claim = claimFor(graph);
    const store = new FakeTurnStore([claim]);
    store.claimUnitTurns = async (input) => {
      store.claimCalls.push(structuredClone(input));
      if (scenario.error !== undefined) throw scenario.error;
      return scenario.reply;
    };
    let bodyCalls = 0;
    await assert.rejects(
      runNextUnitTurns({
        store,
        principalId: "v2_worker",
        leaseOwner: "claim-boundary",
        ports: {
          code: {
            async run() {
              bodyCalls += 1;
              return { outcome: "done" };
            }
          }
        }
      }),
      (error) => {
        assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
        assert.equal(error.operation, "claim_worker");
        return true;
      }
    );
    assert.equal(bodyCalls, 0);
    assert.equal(store.prepareCalls.length, 0);
    assert.equal(store.settleCalls.length, 0);
  }
});

test("singular claim API rejects a runtime batch field and always asks for exactly one turn", async () => {
  const graph = graphFor("code");
  const claims = [
    claimFor(graph, { queueId: "single-1", unitId: "single-1" }),
    claimFor(graph, { queueId: "single-2", unitId: "single-2" })
  ];
  const store = new FakeTurnStore(claims);
  let bodyCalls = 0;
  const input = {
    store,
    principalId: "v2_worker",
    leaseOwner: "single-worker",
    ports: { code: { async run() { bodyCalls += 1; return { outcome: "done" }; } } }
  };
  await assert.rejects(
    runNextUnitTurn({ ...input, batch: 2 }),
    /unknown key\(s\) "batch"/
  );
  assert.equal(store.claimCalls.length, 0);
  const result = await runNextUnitTurn(input);
  assert.equal(result.status, "succeeded");
  assert.equal(store.claimCalls[0].batch, 1);
  assert.equal(bodyCalls, 1);
  assert.equal(store.settleCalls.length, 1);
});

test("human and callback inbound ports settle under exact principal with actor as attribution only", async () => {
  const humanGraph = graphFor("human", { outcomes: ["approved", "rejected"] });
  const humanClaim = claimFor(humanGraph, { queueId: "queue-human", unitId: "human-unit" });
  const humanStore = new FakeTurnStore([humanClaim], { startAttemptNumber: 8 });
  const human = await recordHumanNodeDecision({
    store: humanStore,
    principalId: "v2_human",
    decision: {
      queueId: humanClaim.queueId,
      unitId: humanClaim.unitId,
      nodeId: humanClaim.nodeId,
      outcome: "approved",
      actor: { actorId: "person-123" }
    },
    now: clock()
  });
  assert.equal(human.status, "succeeded");
  assert.equal(humanStore.settleCalls[0].input.actorId, "person-123");
  assert.equal(humanStore.settleCalls[0].input.principalId, "v2_human");

  const callbackGraph = graphFor("callback", { outcomes: ["received"] });
  const callbackClaim = claimFor(callbackGraph, { queueId: "queue-callback", unitId: "callback-unit" });
  const callbackStore = new FakeTurnStore([callbackClaim]);
  const eventArtifact = createArtifactEnvelope("turn-input.v1", { event: true });
  const callback = await admitCallbackNodeEvent({
    store: callbackStore,
    principalId: "v2_callback",
    event: {
      queueId: callbackClaim.queueId,
      unitId: callbackClaim.unitId,
      nodeId: callbackClaim.nodeId,
      outcome: "received",
      outputArtifact: eventArtifact,
      actor: { actorId: "webhook-source" }
    },
    now: clock()
  });
  assert.equal(callback.status, "succeeded");
  assert.equal(callbackStore.settleCalls[0].input.completion.outputArtifact.digest, eventArtifact.digest);
});

test("external input is validated from a read-only inspection before any lease or attempt mutation", async () => {
  const graph = graphFor("human", { outcomes: ["approved"] });
  const claim = claimFor(graph);
  for (const decision of [
    {
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      outcome: "not-declared",
      actor: { actorId: "person-1" }
    },
    {
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      outcome: "approved",
      outputArtifact: { contractId: "turn-input.v1", digest: "0".repeat(64), payload: {} },
      actor: { actorId: "person-1" }
    }
  ]) {
    const store = new FakeTurnStore([claim]);
    await assert.rejects(
      recordHumanNodeDecision({ store, principalId: "v2_human", decision }),
      /undeclared outcome|digest mismatch/
    );
    assert.equal(store.externalInspectionCalls.length, 1);
    assert.equal(store.externalClaimCalls.length, 0);
    assert.equal(store.prepareCalls.length, 0);
    assert.equal(store.settleCalls.length, 0);
  }

  const oversizedStore = new FakeTurnStore([claim]);
  await assert.rejects(
    recordHumanNodeDecision({
      store: oversizedStore,
      principalId: "v2_human",
      decision: {
        queueId: claim.queueId,
        unitId: claim.unitId,
        nodeId: claim.nodeId,
        outcome: "approved",
        actor: { actorId: "person-1" }
      },
      outboxEvents: Array.from(
        { length: MAX_TURN_OUTBOX_EVENTS + 1 },
        () => ({ eventType: "too_many", payload: null })
      )
    }),
    /at most 1024 events/
  );
  assert.equal(oversizedStore.externalClaimCalls.length, 0);
});

test("external settle response loss recovers only an exact actor, completion, and outbox batch", async () => {
  const graph = graphFor("human", { outcomes: ["approved", "rejected"] });
  const claim = claimFor(graph, { queueId: "queue-human-recovery", unitId: "human-recovery" });
  const store = new FakeTurnStore([claim], {
    settleCommitThenError: new Error("settlement committed; response lost")
  });
  const outboxEvents = [{ eventType: "human_audit", payload: { ticket: "T-1" } }];
  const baseDecision = {
    queueId: claim.queueId,
    unitId: claim.unitId,
    nodeId: claim.nodeId,
    outcome: "approved",
    actor: { actorId: "alice" }
  };
  await assert.rejects(
    recordHumanNodeDecision({
      store,
      principalId: "v2_human",
      decision: baseDecision,
      outboxEvents,
      now: clock()
    }),
    TurnSettlementUncertainError
  );
  assert.equal(store.settleCalls.length, 1);
  assert.equal(store.cacheCalls.length, 0);

  store.options.settleCommitThenError = undefined;
  const recovered = await recordHumanNodeDecision({
    store,
    principalId: "v2_human",
    decision: structuredClone(baseDecision),
    outboxEvents: structuredClone(outboxEvents),
    now: clock("2026-08-27T13:00:00.000Z")
  });
  assert.equal(recovered.status, "succeeded");
  assert.equal(recovered.reused, true);
  assert.equal(store.settleCalls.length, 1);
  assert.equal(store.externalInspectionCalls.length, 2);

  const conflicts = [
    { decision: { ...baseDecision, actor: { actorId: "bob" } }, outboxEvents },
    { decision: { ...baseDecision, outcome: "rejected" }, outboxEvents },
    {
      decision: {
        ...baseDecision,
        outputArtifact: createArtifactEnvelope("turn-input.v1", { changed: true })
      },
      outboxEvents
    },
    {
      decision: baseDecision,
      outboxEvents: [{ eventType: "human_audit", payload: { ticket: "T-2" } }]
    }
  ];
  for (const conflict of conflicts) {
    await assert.rejects(
      recordHumanNodeDecision({
        store,
        principalId: "v2_human",
        decision: conflict.decision,
        outboxEvents: conflict.outboxEvents
      }),
      TurnEvidenceConflictError
    );
  }
  assert.equal(store.settleCalls.length, 1);
});

test("external completion needs only its narrow inspection, exact-claim, prepare, and settle capabilities", async () => {
  const graph = graphFor("human", { outcomes: ["approved"] });
  const claim = claimFor(graph, { queueId: "queue-narrow-human" });
  const backing = new FakeTurnStore([claim]);
  const narrow = {
    inspectExternalUnitTurn: backing.inspectExternalUnitTurn.bind(backing),
    claimExternalUnitTurn: backing.claimExternalUnitTurn.bind(backing),
    prepareTurnAttempt: backing.prepareTurnAttempt.bind(backing),
    settleTurn: backing.settleTurn.bind(backing)
  };
  const result = await recordHumanNodeDecision({
    store: narrow,
    principalId: "v2_human",
    decision: {
      queueId: claim.queueId,
      unitId: claim.unitId,
      nodeId: claim.nodeId,
      outcome: "approved",
      actor: { actorId: "least-authority-user" }
    },
    now: clock()
  });
  assert.equal(result.status, "succeeded");
  assert.equal("claimUnitTurns" in narrow, false);
  assert.equal("heartbeatTurn" in narrow, false);
  assert.equal("recordTurnFailure" in narrow, false);
});

test("external completion ignores an inherited clock without executing its getter", async () => {
  const graph = graphFor("human", { outcomes: ["approved"] });
  const claim = claimFor(graph, { queueId: "queue-human-ambient-clock" });
  const store = new FakeTurnStore([claim]);
  let getterCalls = 0;
  await withObjectPrototypeProperties({
    now: {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("ambient clock must not run");
      }
    }
  }, async () => {
    const result = await recordHumanNodeDecision({
      store,
      principalId: "v2_human",
      decision: {
        queueId: claim.queueId,
        unitId: claim.unitId,
        nodeId: claim.nodeId,
        outcome: "approved",
        actor: { actorId: "person-ambient-clock" }
      }
    });
    assert.equal(result.status, "succeeded");
  });
  assert.equal(getterCalls, 0);
});

test("actor cannot substitute for authenticated external authority", async () => {
  const graph = graphFor("human", { outcomes: ["approved"] });
  const claim = claimFor(graph);
  const store = new FakeTurnStore([claim]);
  await assert.rejects(
    recordHumanNodeDecision({
      store,
      principalId: "actor_person",
      decision: {
        queueId: claim.queueId,
        unitId: claim.unitId,
        nodeId: claim.nodeId,
        outcome: "approved",
        actor: { actorId: "v2_human" }
      }
    }),
    TurnAuthorityError
  );
  assert.equal(store.externalInspectionCalls.length, 1);
  assert.equal(store.externalClaimCalls.length, 0);
  assert.equal(store.prepareCalls.length, 0);
  assert.equal(store.settleCalls.length, 0);
});

test("outbox acknowledgements occur only after exact committed proof", async () => {
  const graph = graphFor("code");
  const claim = claimFor(graph);
  for (const committed of [true, false]) {
    let acknowledgements = 0;
    const store = new FakeTurnStore([claim], committed
      ? { settleCreated: false }
      : { settleCreated: false, settleReply: (input) => ({
          created: false,
          completionDigest: input.completionDigest,
          settlementDigest: input.settlementDigest
        }) });
    const batch = [{ eventType: "test_event", payload: { ok: true } }];
    Object.defineProperty(batch, "acknowledge", {
      configurable: false,
      enumerable: false,
      writable: false,
      value() { acknowledgements += 1; }
    });
    const operation = runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: { code: { async run() { return { outcome: "done" }; } } },
      successOutboxEvents: () => batch,
      now: clock()
    });
    if (committed) {
      assert.equal((await operation).status, "succeeded");
      assert.equal(acknowledgements, 1);
    } else {
      await assert.rejects(operation, TurnSettlementUncertainError);
      assert.equal(acknowledgements, 0);
    }
  }
});

test("failed-attempt outbox replay requires exact committed proof before acknowledgement", async () => {
  for (const exactProof of [true, false]) {
    const graph = graphFor("code", {
      maxAttempts: 1,
      graphId: `test.failure-outbox-proof-${exactProof}`
    });
    const claim = claimFor(graph, {
      queueId: `queue-failure-outbox-proof-${exactProof}`
    });
    const store = new FakeTurnStore([claim]);
    const baseRecordFailure = store.recordTurnFailure.bind(store);
    store.recordTurnFailure = async (input, outboxEvents = []) => {
      await baseRecordFailure(input, outboxEvents);
      return {
        created: false,
        failureDigest: input.failureDigest,
        ...(exactProof
          ? { committedOutboxEventDigests: outboxEvents.map(turnOutboxEventDigest) }
          : {})
      };
    };
    let acknowledgements = 0;
    const batch = [{ eventType: "failure_event", payload: { exactProof } }];
    Object.defineProperty(batch, "acknowledge", {
      configurable: false,
      enumerable: false,
      writable: false,
      value() { acknowledgements += 1; }
    });
    const operation = runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: {
        code: {
          async run() { throw new ExecutionFailureError("rejected", false); }
        }
      },
      failureOutboxEvents: () => batch,
      now: clock()
    });
    if (exactProof) {
      assert.equal((await operation).status, "terminal");
      assert.equal(acknowledgements, 1);
    } else {
      await assert.rejects(operation, (error) => {
        assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
        assert.equal(error.operation, "record_failure");
        return true;
      });
      assert.equal(acknowledgements, 0);
    }
    assert.equal(store.failureCalls.length, 1);
    assert.equal(store.settleCalls.length, 0);
  }
});

test("an empty failed-attempt replay rejects a previously committed nonempty outbox batch", async () => {
  const graph = graphFor("code", {
    maxAttempts: 1,
    graphId: "test.failure-empty-outbox-conflict"
  });
  const claim = claimFor(graph, { queueId: "queue-failure-empty-outbox-conflict" });
  const store = new FakeTurnStore([claim]);
  const baseRecordFailure = store.recordTurnFailure.bind(store);
  store.recordTurnFailure = async (input, outboxEvents = []) => {
    await baseRecordFailure(input, outboxEvents);
    return {
      created: false,
      failureDigest: input.failureDigest,
      committedOutboxEventDigests: ["0".repeat(64)]
    };
  };
  await assert.rejects(
    runClaimedUnitTurn({
      store,
      claim,
      principalId: "v2_worker",
      ports: {
        code: {
          async run() { throw new ExecutionFailureError("rejected", false); }
        }
      },
      now: clock()
    }),
    (error) => {
      assert.equal(error instanceof TurnAttemptPersistenceUncertainError, true);
      assert.equal(error.operation, "record_failure");
      return true;
    }
  );
  assert.equal(store.failureCalls.length, 1);
  assert.equal(store.settleCalls.length, 0);
});

test("direct attempt dispatch is exact and never exposes external node kinds", async () => {
  for (const kind of ["human", "callback"]) {
    const graph = graphFor(kind);
    const claim = claimFor(graph);
    const node = graph.nodes[0];
    const key = nodeTurnIdempotencyKey({
      unitId: claim.unitId,
      nodeId: node.nodeId,
      attemptNumber: 1,
      nodeRef: node.ref,
      fingerprint: nodeExecutionFingerprint(node),
      inputDigest: claim.inputArtifact.digest
    });
    await assert.rejects(
      executeNodeTurnAttempt({
        node,
        context: {
          graph: { id: graph.graphId, version: graph.version, digest: graph.graphDigest },
          queueId: claim.queueId,
          unitId: claim.unitId,
          nodeId: node.nodeId,
          nodeRef: node.ref,
          attemptNumber: 1,
          attemptIndex: 1,
          idempotencyKey: key,
          inputArtifact: {
            contractId: claim.inputArtifact.contractId,
            digest: claim.inputArtifact.digest,
            bytes: claim.inputArtifact.bytes
          }
        },
        inputArtifact: claim.inputArtifact,
        ports: {}
      }),
      WorkerNodeKindError
    );
  }
});

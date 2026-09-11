// store/unit-store-conformance.ts — reusable N2/N3 UnitStore conformance.
//
// The memory implementation runs these cases in N3. Consumer-owned durable
// adapters import and run the same cases in N4 through a small driver that
// supplies a controllable clock, crash checkpoints, and a normalized
// privileged evidence view. Every execution mutation still goes through the
// public GraphStore / UnitStore ports.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createArtifactEnvelope } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import { createGraphDefinition, graphDefinitionRef, JOIN_INPUT_ARTIFACT_CONTRACT, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID } from "../graph/definition.js";
import { ExecutionFailureError } from "../execute/failure.js";
import { admitCallbackNodeEvent, recordHumanNodeDecision, runClaimedUnitTurn, runNextUnitTurn, runNextUnitTurns, TurnLeaseLostError, TurnSettlementUncertainError } from "../execute/unit-runner.js";
import { nodeExecutionFingerprint, nodeTurnCompletionDigest } from "../execute/turn.js";
import { nodeTurnFailureDigest, nodeTurnSettlementDigest } from "../execute/turn-evidence.js";
import { SETTLE_TRANSACTION_CHECKPOINTS } from "./unit-store.js";
const ARTIFACT_CONTRACT = "unit-artifact.v1";
const WORKER_PRINCIPAL = "v2_worker";
const CONSOLE_PRINCIPAL = "v2_console";
const CALLBACK_PRINCIPAL = "v2_callback";
const ADMITTER_PRINCIPAL = "v2_admitter";
const TURN = Object.freeze({
    idempotency: "per (unitId, nodeId, attemptNumber)",
    leaseMs: 1_000,
    maxAttempts: 3,
    retryTaxonomy: "retryable vs terminal, as v1 durable-stage"
});
function node(nodeId, outcomes, options = {}) {
    const kind = options.kind ?? "code";
    return {
        nodeId,
        ref: { id: options.refId ?? `conformance.${nodeId}`, version: 1 },
        kind,
        input: options.input ?? ARTIFACT_CONTRACT,
        outcomes: { version: 1, outcomes },
        principal: {
            id: options.principal
                ?? (kind === "human"
                    ? CONSOLE_PRINCIPAL
                    : kind === "callback"
                        ? CALLBACK_PRINCIPAL
                        : WORKER_PRINCIPAL)
        },
        turn: { ...TURN, ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) },
        ...(options.join === undefined ? {} : { join: options.join })
    };
}
function oneNodeGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `UnitStore conformance graph ${graphId}.`,
        entry: "only",
        nodes: [node("only", ["done"])],
        edges: [],
        terminals: [{ nodeId: "only", outcome: "done" }]
    });
}
function linearGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `UnitStore routed conformance graph ${graphId}.`,
        entry: "source",
        nodes: [node("source", ["done"]), node("target", ["done"])],
        edges: [{ edgeId: "source-target", from: "source", when: { outcome: "done" }, to: ["target"] }],
        terminals: [{ nodeId: "target", outcome: "done" }]
    });
}
function joinGraph(graphId, requirement, branchAOutcomes = ["done"]) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `UnitStore join conformance graph ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("branch-a", branchAOutcomes),
            node("branch-b", ["done"]),
            node("join", ["joined", "join_unsatisfiable"], {
                join: { inbound: ["a-join", "b-join"], require: requirement }
            })
        ],
        edges: [
            { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
            { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
            { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
            { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] }
        ],
        terminals: [
            ...(branchAOutcomes.includes("drop") ? [{ nodeId: "branch-a", outcome: "drop" }] : []),
            { nodeId: "join", outcome: "joined" },
            { nodeId: "join", outcome: "join_unsatisfiable" }
        ]
    });
}
function humanCallbackGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Human and callback UnitStore conformance graph ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("review", ["approved", "rejected"], { kind: "human" }),
            node("callback", ["received"], { kind: "callback" }),
            node("sink", ["done"])
        ],
        edges: [
            { edgeId: "start-review", from: "start", when: { outcome: "ready" }, to: ["review"] },
            { edgeId: "review-callback", from: "review", when: { outcome: "approved" }, to: ["callback"] },
            { edgeId: "callback-sink", from: "callback", when: { outcome: "received" }, to: ["sink"] }
        ],
        terminals: [
            { nodeId: "review", outcome: "rejected" },
            { nodeId: "sink", outcome: "done" }
        ]
    });
}
function crashGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Every settle write participates in one crash-tested transaction ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("branch-a", ["done"]),
            node("branch-b", ["done"]),
            node("direct", ["done"]),
            node("join", ["joined", "join_unsatisfiable"], {
                join: { inbound: ["a-join", "b-join"], require: "all" }
            })
        ],
        edges: [
            { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
            { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
            { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
            { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] },
            { edgeId: "b-direct", from: "branch-b", when: { outcome: "done" }, to: ["direct"] }
        ],
        terminals: [
            { nodeId: "direct", outcome: "done" },
            { nodeId: "join", outcome: "joined" },
            { nodeId: "join", outcome: "join_unsatisfiable" }
        ]
    });
}
function boundedAttemptGraph(graphId, maxAttempts) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Bounded retry conformance graph ${graphId}.`,
        entry: "only",
        nodes: [node("only", ["done"], { maxAttempts })],
        edges: [],
        terminals: [{ nodeId: "only", outcome: "done" }]
    });
}
function routedUnsatisfiableGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Partial join failure routes engine evidence in ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("branch-a", ["done"]),
            node("branch-b", ["done", "drop"]),
            node("join", ["joined", "join_unsatisfiable"], {
                join: { inbound: ["a-join", "b-join"], require: "all" }
            }),
            node("recover", ["done"], { input: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT })
        ],
        edges: [
            { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
            { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
            { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
            { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] },
            {
                edgeId: "join-recover",
                from: "join",
                when: { outcome: "join_unsatisfiable" },
                to: ["recover"]
            }
        ],
        terminals: [
            { nodeId: "branch-b", outcome: "drop" },
            { nodeId: "join", outcome: "joined" },
            { nodeId: "recover", outcome: "done" }
        ]
    });
}
function duplicateOrdinaryTargetGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Multiple matched edges dedupe one ordinary target in ${graphId}.`,
        entry: "source",
        nodes: [node("source", ["done"]), node("target", ["done"])],
        edges: [
            { edgeId: "source-target-first", from: "source", when: { outcome: "done" }, to: ["target"] },
            { edgeId: "source-target-second", from: "source", when: { anyOf: ["done"] }, to: ["target"] }
        ],
        terminals: [{ nodeId: "target", outcome: "done" }]
    });
}
function cyclicJoinGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Cycle-safe duplicate join-offer conformance graph ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("branch-a", ["done", "skip"]),
            node("helper", ["go"]),
            node("branch-b", ["done"]),
            node("join", ["joined", "join_unsatisfiable"], {
                join: { inbound: ["a-join", "b-join"], require: "all" }
            })
        ],
        edges: [
            { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
            { edgeId: "start-helper", from: "start", when: { outcome: "ready" }, to: ["helper"] },
            { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
            { edgeId: "helper-a", from: "helper", when: { outcome: "go" }, to: ["branch-a"] },
            { edgeId: "a-join", from: "branch-a", when: { outcome: "done" }, to: ["join"] },
            { edgeId: "a-cycle", from: "branch-a", when: { outcome: "done" }, to: ["branch-a"] },
            { edgeId: "b-join", from: "branch-b", when: { outcome: "done" }, to: ["join"] }
        ],
        terminals: [
            { nodeId: "branch-a", outcome: "skip" },
            { nodeId: "join", outcome: "joined" },
            { nodeId: "join", outcome: "join_unsatisfiable" }
        ]
    });
}
function humanJoinGraph(graphId) {
    return createGraphDefinition({
        graphId,
        version: 1,
        description: `Human join queue hides its engine-only outcome in ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            node("branch-a", ["done"]),
            node("branch-b", ["done"]),
            node("review", ["approved", "rejected", "join_unsatisfiable"], {
                kind: "human",
                join: { inbound: ["a-review", "b-review"], require: "all" }
            })
        ],
        edges: [
            { edgeId: "start-a", from: "start", when: { outcome: "ready" }, to: ["branch-a"] },
            { edgeId: "start-b", from: "start", when: { outcome: "ready" }, to: ["branch-b"] },
            { edgeId: "a-review", from: "branch-a", when: { outcome: "done" }, to: ["review"] },
            { edgeId: "b-review", from: "branch-b", when: { outcome: "done" }, to: ["review"] }
        ],
        terminals: [
            { nodeId: "review", outcome: "approved" },
            { nodeId: "review", outcome: "rejected" },
            { nodeId: "review", outcome: "join_unsatisfiable" }
        ]
    });
}
function envelopeJoinGraph(graph) {
    const { graphDigest: _graphDigest, ...draft } = graph;
    return createGraphDefinition({
        ...draft,
        nodes: graph.nodes.map((candidate) => ({
            ...candidate,
            ...(candidate.join === undefined ? {} : {
                input: JOIN_INPUT_ARTIFACT_CONTRACT,
                join: { ...candidate.join, compose: "envelope" }
            }),
            ...(candidate.join === undefined && !candidate.nodeId.startsWith("branch-") ? {} : {
                configuration: {
                    id: `conformance.${candidate.nodeId}.configuration`,
                    version: 1,
                    digest: digest({ nodeId: candidate.nodeId, policy: "conformance" })
                }
            })
        }))
    });
}
function threeBranchEnvelopeJoinGraph(graphId) {
    return envelopeJoinGraph(createGraphDefinition({
        graphId,
        version: 1,
        description: `Envelope subset conformance graph ${graphId}.`,
        entry: "start",
        nodes: [
            node("start", ["ready"]),
            ...["a", "b", "c"].map((branch) => node(`branch-${branch}`, ["done"])),
            node("join", ["joined", "join_unsatisfiable"], {
                join: { inbound: ["a-join", "b-join", "c-join"], require: { nOf: 2 } }
            })
        ],
        edges: [
            ...["a", "b", "c"].map((branch) => ({
                edgeId: `start-${branch}`, from: "start", when: { outcome: "ready" }, to: [`branch-${branch}`]
            })),
            ...["a", "b", "c"].map((branch) => ({
                edgeId: `${branch}-join`, from: `branch-${branch}`, when: { outcome: "done" }, to: ["join"]
            }))
        ],
        terminals: [
            { nodeId: "join", outcome: "joined" },
            { nodeId: "join", outcome: "join_unsatisfiable" }
        ]
    }));
}
function assertFrozenPayload(value) {
    if (value === null || typeof value !== "object")
        return;
    assert.equal(Object.isFrozen(value), true);
    for (const item of Object.values(value))
        assertFrozenPayload(item);
}
/** Build expected bytes independently of the join composition implementation. */
function assertJoinInputArtifact(graph, queue, artifacts) {
    const joinNode = graph.nodes.find((candidate) => candidate.nodeId === queue.nodeId);
    assert.ok(joinNode.join !== undefined);
    assert.ok(queue.join !== undefined);
    const expected = createArtifactEnvelope(JOIN_INPUT_ARTIFACT_CONTRACT, {
        schemaVersion: JOIN_INPUT_ARTIFACT_CONTRACT,
        unitId: queue.unitId,
        graph: graphDefinitionRef(graph),
        nodeId: joinNode.nodeId,
        nodeRef: joinNode.ref,
        ...(joinNode.configuration === undefined ? {} : { configuration: joinNode.configuration }),
        require: joinNode.join.require,
        accepted: joinNode.join.inbound.flatMap((edgeId) => {
            const offer = queue.join.accepted.find((candidate) => candidate.edgeId === edgeId);
            if (offer === undefined)
                return [];
            const source = graph.nodes.find((candidate) => candidate.nodeId === offer.sourceNodeId);
            const artifact = artifacts.get(edgeId);
            assert.ok(artifact !== undefined, `expected accepted artifact at ${edgeId}`);
            assert.equal(offer.artifact.contractId, artifact.contractId);
            assert.equal(offer.artifact.digest, artifact.digest);
            assert.equal(offer.artifact.bytes, artifact.bytes);
            assert.equal(Object.hasOwn(offer.artifact, "bytes"), Object.hasOwn(artifact, "bytes"));
            return [{
                    ...offer,
                    sourceNodeRef: source.ref,
                    ...(source.configuration === undefined ? {} : { sourceConfiguration: source.configuration }),
                    artifact
                }];
        })
    });
    assert.deepEqual(queue.inputArtifact, expected);
    assertFrozenPayload(queue.inputArtifact.payload);
}
async function publishAndAdmit(driver, graph, unitId, payload = { unitId }) {
    await driver.graphStore.publishGraph(graph);
    return driver.unitStore.admitUnit({
        unitId,
        graph: graphDefinitionRef(graph),
        seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, payload),
        admittedAt: driver.now().toISOString(),
        principalId: ADMITTER_PRINCIPAL
    });
}
async function runCode(driver, nodeId, completion, options = {}) {
    return runNextUnitTurn({
        store: driver.unitStore,
        principalId: WORKER_PRINCIPAL,
        leaseOwner: `conformance-${nodeId}`,
        nodeId,
        ports: {
            code: {
                run: async () => {
                    options.bodyCalled?.();
                    return completion;
                }
            }
        },
        ...(options.outboxEvents === undefined
            ? {}
            : { successOutboxEvents: () => options.outboxEvents }),
        now: () => driver.now()
    });
}
async function claimOne(driver, nodeId) {
    const claimed = await driver.unitStore.claimUnitTurns({
        principalId: WORKER_PRINCIPAL,
        leaseOwner: `conformance-claim-${nodeId}`,
        batch: 1,
        nodeId
    });
    assert.equal(claimed.length, 1, `expected exactly one claim at ${nodeId}`);
    return claimed[0];
}
function executionStoreWithCapturedSettle(store, capture) {
    return {
        heartbeatTurn: (input) => store.heartbeatTurn(input),
        prepareTurnAttempt: (input) => store.prepareTurnAttempt(input),
        cacheTurnCompletion: (input) => store.cacheTurnCompletion(input),
        recordTurnFailure: (input, outbox) => store.recordTurnFailure(input, outbox),
        settleTurn: (input, outbox) => {
            capture(input, outbox);
            return store.settleTurn(input, outbox);
        }
    };
}
function queueCount(evidence, nodeId) {
    return evidence.queues.filter((queue) => queue.nodeId === nodeId).length;
}
function settledAtNode(evidence, nodeId) {
    return evidence.journey.filter((record) => record.kind === "turn_settled" && record.nodeId === nodeId);
}
function assertAdmissionDigest(unit) {
    const { admissionDigest, ...base } = unit;
    assert.equal(admissionDigest, digest(base), `admission digest for ${unit.unitId}`);
}
function assertJourneyRecordDigest(record) {
    const { recordDigest, ...base } = record;
    assert.equal(recordDigest, digest(base), `journey record digest for ${record.unitId} sequence ${record.sequence}`);
}
function assertJourneyRecordDigests(records) {
    for (const record of records)
        assertJourneyRecordDigest(record);
}
function assertFailureSeal(record) {
    assert.equal(record.kind, "turn_failed");
    if (record.kind !== "turn_failed")
        return;
    assert.equal(record.failureDigest, nodeTurnFailureDigest({
        queueId: record.queueId,
        unitId: record.unitId,
        nodeId: record.nodeId,
        attemptNumber: record.attemptNumber,
        attemptIndex: record.attemptIndex,
        idempotencyKey: record.idempotencyKey,
        principalId: record.principalId,
        startedAt: record.startedAt,
        failedAt: record.failedAt,
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        retryable: record.retryable,
        terminal: record.terminal,
        usage: record.usage
    }));
}
function assertSettlementSeal(record) {
    assert.equal(record.kind, "turn_settled");
    if (record.kind !== "turn_settled")
        return;
    assert.equal(record.settlementDigest, nodeTurnSettlementDigest({
        queueId: record.queueId,
        unitId: record.unitId,
        nodeId: record.nodeId,
        attemptNumber: record.attemptNumber,
        attemptIndex: record.attemptIndex,
        idempotencyKey: record.idempotencyKey,
        principalId: record.principalId,
        ...(record.actorId === undefined ? {} : { actorId: record.actorId }),
        startedAt: record.startedAt,
        settledAt: record.settledAt,
        completionDigest: record.completionDigest
    }));
}
/** Register the same executable store contract under one backend label. */
export function registerUnitStoreConformanceTests(options) {
    const register = (scenario, body) => {
        test(`${options.backendName}: ${scenario}`, async () => {
            const driver = await options.createDriver({
                backendName: options.backendName,
                scenario
            });
            try {
                await body(driver);
            }
            finally {
                await driver.close();
            }
        });
    };
    register("admission is append-once and conflicting replay bites without residue", async (driver) => {
        const graph = oneNodeGraph("conformance.admission");
        const first = await publishAndAdmit(driver, graph, "unit-admission", { value: 1 });
        const replay = await driver.unitStore.admitUnit({
            unitId: "unit-admission",
            graph: graphDefinitionRef(graph),
            seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { value: 1 }),
            admittedAt: first.unit.admittedAt,
            principalId: ADMITTER_PRINCIPAL
        });
        assert.equal(first.created, true);
        assert.equal(replay.created, false);
        assertAdmissionDigest(first.unit);
        assertAdmissionDigest(replay.unit);
        assert.equal(replay.entryQueue.queueId, first.entryQueue.queueId);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-admission" });
        assert.equal(journey.length, 1);
        assertJourneyRecordDigests(journey);
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "only"
        })).length, 1);
        await assert.rejects(driver.unitStore.admitUnit({
            unitId: "unit-admission",
            graph: graphDefinitionRef(graph),
            seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { value: 2 }),
            admittedAt: first.unit.admittedAt,
            principalId: ADMITTER_PRINCIPAL
        }), /conflicts with immutable admission/);
        const evidence = await driver.evidence();
        assert.equal(evidence.queues.length, 1);
        assert.equal(evidence.artifacts.length, 1);
        assert.equal(evidence.journey.length, 1);
    });
    register("hostile deeply nested admission fails bounded and leaves no residue", async (driver) => {
        const graph = oneNodeGraph("conformance.hostile-deep-admission");
        await driver.graphStore.publishGraph(graph);
        let payload = null;
        for (let depth = 0; depth < 20_000; depth += 1)
            payload = { next: payload };
        const hostileArtifact = {
            contractId: ARTIFACT_CONTRACT,
            digest: "0".repeat(64),
            payload
        };
        await assert.rejects(driver.unitStore.admitUnit({
            unitId: "unit-hostile-deep-admission",
            graph: graphDefinitionRef(graph),
            seedArtifact: hostileArtifact,
            admittedAt: driver.now().toISOString(),
            principalId: ADMITTER_PRINCIPAL
        }), (error) => error instanceof Error
            && !(error instanceof RangeError)
            && /artifact validation data exceeds the maximum depth/.test(error.message));
        assert.equal(await driver.unitStore.readUnit({ unitId: "unit-hostile-deep-admission" }), undefined);
        assert.deepEqual(await driver.unitStore.readJourney({
            unitId: "unit-hostile-deep-admission"
        }), []);
        const evidence = await driver.evidence();
        assert.equal(evidence.artifacts.length, 0);
        assert.equal(evidence.queues.length, 0);
        assert.equal(evidence.journey.length, 0);
        assert.equal(evidence.joins.length, 0);
        assert.equal(evidence.settlements.length, 0);
        assert.equal(evidence.outbox.length, 0);
        assert.equal(evidence.deadLetters.length, 0);
    });
    register("retryable failure advances the attempt before succeeding", async (driver) => {
        const graph = boundedAttemptGraph("conformance.retry-then-success", 3);
        await publishAndAdmit(driver, graph, "unit-retry-then-success");
        let calls = 0;
        const result = await runNextUnitTurn({
            store: driver.unitStore,
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "conformance-retry-then-success",
            nodeId: "only",
            ports: {
                code: {
                    run: async () => {
                        calls += 1;
                        if (calls === 1) {
                            throw new ExecutionFailureError("conformance_retryable", true);
                        }
                        return { outcome: "done" };
                    }
                }
            },
            now: () => driver.now()
        });
        assert.equal(result?.status, "succeeded");
        if (result?.status !== "succeeded")
            throw new Error("expected retry success");
        assert.equal(result.attemptIndex, 2);
        assert.equal(result.attemptNumber, 2);
        assert.equal(calls, 2);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-retry-then-success" });
        assert.deepEqual(journey.map((record) => record.kind), [
            "unit_admitted",
            "turn_failed",
            "turn_settled"
        ]);
        const failure = journey[1];
        assertFailureSeal(failure);
        if (failure.kind === "turn_failed") {
            assert.equal(failure.attemptIndex, 1);
            assert.equal(failure.attemptNumber, 1);
            assert.equal(failure.retryable, true);
            assert.equal(failure.terminal, false);
            assert.equal(failure.principalId, WORKER_PRINCIPAL);
        }
        const settlement = journey[2];
        assertSettlementSeal(settlement);
        if (settlement.kind === "turn_settled") {
            assert.equal(settlement.attemptIndex, 2);
            assert.equal(settlement.attemptNumber, 2);
            assert.equal(settlement.principalId, WORKER_PRINCIPAL);
        }
        assertJourneyRecordDigests(journey);
        assert.equal((await driver.unitStore.listDeadLetters({
            unitId: "unit-retry-then-success"
        })).length, 0);
    });
    register("retry exhaustion atomically dead-letters the final attempt", async (driver) => {
        const graph = boundedAttemptGraph("conformance.retry-exhaustion", 2);
        await publishAndAdmit(driver, graph, "unit-retry-exhaustion");
        let calls = 0;
        const result = await runNextUnitTurn({
            store: driver.unitStore,
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "conformance-retry-exhaustion",
            nodeId: "only",
            ports: {
                code: {
                    run: async () => {
                        calls += 1;
                        throw new ExecutionFailureError("conformance_retry_exhausted", true);
                    }
                }
            },
            now: () => driver.now()
        });
        assert.equal(result?.status, "terminal");
        if (result?.status !== "terminal")
            throw new Error("expected terminal retry exhaustion");
        assert.equal(result.attempts, 2);
        assert.equal(calls, 2);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-retry-exhaustion" });
        assert.deepEqual(journey.map((record) => record.kind), [
            "unit_admitted",
            "turn_failed",
            "turn_failed"
        ]);
        const firstFailure = journey[1];
        const terminalFailure = journey[2];
        assertFailureSeal(firstFailure);
        assertFailureSeal(terminalFailure);
        if (firstFailure.kind === "turn_failed") {
            assert.equal(firstFailure.attemptIndex, 1);
            assert.equal(firstFailure.retryable, true);
            assert.equal(firstFailure.terminal, false);
        }
        if (terminalFailure.kind === "turn_failed") {
            assert.equal(terminalFailure.attemptIndex, 2);
            assert.equal(terminalFailure.retryable, true);
            assert.equal(terminalFailure.terminal, true);
        }
        assertJourneyRecordDigests(journey);
        const deadLetters = await driver.unitStore.listDeadLetters({
            unitId: "unit-retry-exhaustion"
        });
        assert.equal(deadLetters.length, 1);
        if (terminalFailure.kind === "turn_failed") {
            assert.equal(deadLetters[0].failureDigest, terminalFailure.failureDigest);
            assert.equal(deadLetters[0].principalId, WORKER_PRINCIPAL);
        }
        const evidence = await driver.evidence();
        assert.equal(evidence.settlements.length, 0);
        assert.equal(evidence.deadLetters.length, 1);
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "only"
        })).length, 0);
    });
    register("failure messages retain 2000 characters and truncate longer input", async (driver) => {
        const graph = boundedAttemptGraph("conformance.failure-message-bound", 1);
        await driver.graphStore.publishGraph(graph);
        for (const unitId of ["unit-failure-2000", "unit-failure-2001"]) {
            await driver.unitStore.admitUnit({
                unitId,
                graph: graphDefinitionRef(graph),
                seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { unitId }),
                admittedAt: driver.now().toISOString(),
                principalId: ADMITTER_PRINCIPAL
            });
        }
        const exact = "x".repeat(2_000);
        const over = "y".repeat(2_001);
        const messages = [exact, over];
        for (const message of messages) {
            const result = await runNextUnitTurn({
                store: driver.unitStore,
                principalId: WORKER_PRINCIPAL,
                leaseOwner: "conformance-failure-message",
                nodeId: "only",
                ports: { code: { run: async () => { throw new Error(message); } } },
                now: () => driver.now()
            });
            assert.equal(result?.status, "terminal");
        }
        const firstJourney = await driver.unitStore.readJourney({ unitId: "unit-failure-2000" });
        const secondJourney = await driver.unitStore.readJourney({ unitId: "unit-failure-2001" });
        const firstFailure = firstJourney.at(-1);
        const secondFailure = secondJourney.at(-1);
        assertFailureSeal(firstFailure);
        assertFailureSeal(secondFailure);
        assert.equal(firstFailure.kind === "turn_failed" ? firstFailure.errorMessage : undefined, exact);
        assert.equal(secondFailure.kind === "turn_failed" ? secondFailure.errorMessage : undefined, "y".repeat(2_000));
        assert.equal(secondFailure.kind === "turn_failed" ? secondFailure.errorMessage.length : undefined, 2_000);
        assertJourneyRecordDigests(firstJourney);
        assertJourneyRecordDigests(secondJourney);
    });
    register("homogeneous batch settles every claimed unit independently", async (driver) => {
        const graph = oneNodeGraph("conformance.batch-settlement");
        await driver.graphStore.publishGraph(graph);
        const unitIds = ["unit-batch-1", "unit-batch-2", "unit-batch-3"];
        for (const unitId of unitIds) {
            await driver.unitStore.admitUnit({
                unitId,
                graph: graphDefinitionRef(graph),
                seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { unitId }),
                admittedAt: driver.now().toISOString(),
                principalId: ADMITTER_PRINCIPAL
            });
        }
        let calls = 0;
        const results = await runNextUnitTurns({
            store: driver.unitStore,
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "conformance-batch-settlement",
            batch: 3,
            nodeId: "only",
            ports: {
                code: {
                    run: async () => {
                        calls += 1;
                        return { outcome: "done" };
                    }
                }
            },
            now: () => driver.now()
        });
        assert.equal(results.length, 3);
        assert.deepEqual(results.map((entry) => entry.claim.unitId), unitIds);
        assert.equal(results.every((entry) => entry.result.status === "fulfilled" && entry.result.value.status === "succeeded"), true);
        assert.equal(calls, 3);
        const evidence = await driver.evidence();
        assert.equal(evidence.settlements.length, 3);
        for (const unitId of unitIds) {
            const journey = await driver.unitStore.readJourney({ unitId });
            assert.deepEqual(journey.map((record) => record.kind), ["unit_admitted", "turn_settled"]);
            assertSettlementSeal(journey[1]);
            assertJourneyRecordDigests(journey);
        }
    });
    register("expired lease token stays fenced after reclaim", async (driver) => {
        const graph = oneNodeGraph("conformance.stale-lease-token");
        await publishAndAdmit(driver, graph, "unit-stale-lease-token");
        const stale = await claimOne(driver, "only");
        driver.advanceClock(TURN.leaseMs + 1);
        const reclaimed = await claimOne(driver, "only");
        assert.notEqual(reclaimed.leaseToken, stale.leaseToken);
        const onlyNode = graph.nodes.find((candidate) => candidate.nodeId === "only");
        await assert.rejects(driver.unitStore.prepareTurnAttempt({
            queueId: stale.queueId,
            unitId: stale.unitId,
            nodeId: stale.nodeId,
            leaseToken: stale.leaseToken,
            nodeRef: onlyNode.ref,
            fingerprint: nodeExecutionFingerprint(onlyNode),
            inputDigest: stale.inputArtifact.digest,
            maxAttempts: onlyNode.turn.maxAttempts
        }), (error) => error instanceof TurnLeaseLostError);
        assert.deepEqual((await driver.unitStore.readJourney({ unitId: stale.unitId })).map((record) => record.kind), ["unit_admitted"]);
        const result = await runClaimedUnitTurn({
            store: driver.unitStore,
            claim: reclaimed,
            principalId: WORKER_PRINCIPAL,
            ports: { code: { run: async () => ({ outcome: "done" }) } },
            now: () => driver.now()
        });
        assert.equal(result.status, "succeeded");
        if (result.status === "succeeded")
            assert.equal(result.attemptIndex, 1);
    });
    register("worker terminal outcome and terminal failure retain exact evidence", async (driver) => {
        const graph = oneNodeGraph("conformance.worker-terminal");
        await publishAndAdmit(driver, graph, "unit-worker-terminal");
        let bodyCalls = 0;
        const completed = await runCode(driver, "only", { outcome: "done" }, {
            bodyCalled: () => { bodyCalls += 1; }
        });
        assert.equal(completed?.status, "succeeded");
        assert.equal(bodyCalls, 1);
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "only"
        })).length, 0);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-worker-terminal" });
        assert.deepEqual(journey.map((record) => record.kind), ["unit_admitted", "turn_settled"]);
        const failedGraph = oneNodeGraph("conformance.worker-dead-letter");
        await publishAndAdmit(driver, failedGraph, "unit-worker-dead-letter");
        const failed = await runNextUnitTurn({
            store: driver.unitStore,
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "conformance-fatal-worker",
            nodeId: "only",
            ports: {
                code: {
                    run: async () => {
                        throw new ExecutionFailureError("conformance_fatal", false);
                    }
                }
            },
            now: () => driver.now()
        });
        assert.equal(failed?.status, "terminal");
        const failedJourney = await driver.unitStore.readJourney({ unitId: "unit-worker-dead-letter" });
        assert.equal(failedJourney.at(-1)?.kind, "turn_failed");
        assert.equal((await driver.unitStore.listDeadLetters({ unitId: "unit-worker-dead-letter" })).length, 1);
    });
    register("successful routing carries one sealed output with its journey append", async (driver) => {
        const graph = linearGraph("conformance.routing");
        await publishAndAdmit(driver, graph, "unit-routing", { stage: "seed" });
        const output = createArtifactEnvelope(ARTIFACT_CONTRACT, { stage: "output" });
        const result = await runCode(driver, "source", {
            outcome: "done",
            outputArtifact: output
        });
        assert.equal(result?.status, "succeeded");
        const target = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "target"
        });
        assert.equal(target.length, 1);
        assert.equal(target[0].inputArtifact.digest, output.digest);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-routing" });
        assert.equal(journey.length, 2);
        assert.equal(journey[1]?.kind, "turn_settled");
        const retained = await driver.unitStore.getArtifact({
            artifact: {
                contractId: output.contractId,
                digest: output.digest,
                ...(output.bytes === undefined ? {} : { bytes: output.bytes })
            }
        });
        assert.deepEqual(retained, output);
    });
    register("expired lease reclaims the exact cached attempt without reinvoking the body", async (driver) => {
        const graph = oneNodeGraph("conformance.cached-reclaim");
        await publishAndAdmit(driver, graph, "unit-cached-reclaim");
        const firstClaim = await claimOne(driver, "only");
        let calls = 0;
        driver.armSettleCrash("journey_append");
        await assert.rejects(runClaimedUnitTurn({
            store: driver.unitStore,
            claim: firstClaim,
            principalId: WORKER_PRINCIPAL,
            ports: {
                code: {
                    run: async () => {
                        calls += 1;
                        return { outcome: "done" };
                    }
                }
            },
            now: () => driver.now()
        }), (error) => error instanceof TurnSettlementUncertainError);
        assert.equal(calls, 1);
        const crashed = await driver.evidence();
        assert.equal(crashed.cachedCompletions.length, 1);
        assert.equal(crashed.settlements.length, 0);
        assert.deepEqual(crashed.journey.map((record) => record.kind), ["unit_admitted"]);
        await driver.recover();
        driver.advanceClock(TURN.leaseMs + 1);
        const reclaimed = await claimOne(driver, "only");
        assert.notEqual(reclaimed.leaseToken, firstClaim.leaseToken);
        const result = await runClaimedUnitTurn({
            store: driver.unitStore,
            claim: reclaimed,
            principalId: WORKER_PRINCIPAL,
            ports: {
                code: {
                    run: async () => {
                        calls += 1;
                        throw new Error("cached body must not run");
                    }
                }
            },
            now: () => driver.now()
        });
        assert.equal(result.status, "succeeded");
        assert.equal(result.reused, true);
        assert.equal(calls, 1);
        assert.equal((await driver.evidence()).settlements.length, 1);
    });
    register("all join fires exactly once after both distinct offers", async (driver) => {
        const graph = joinGraph("conformance.join-all", "all");
        await publishAndAdmit(driver, graph, "unit-join-all");
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "done" });
        assert.equal((await driver.unitStore.listQueuedUnits({ principalId: WORKER_PRINCIPAL, nodeId: "join" })).length, 0);
        const pending = await driver.unitStore.readJoinProgress({
            unitId: "unit-join-all",
            nodeId: "join"
        });
        assert.equal(pending?.status, "pending");
        assert.deepEqual(pending?.inbound.map((edge) => edge.state), ["offered", "pending"]);
        await runCode(driver, "branch-b", { outcome: "done" });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "join"
        });
        assert.equal(queued.length, 1);
        assert.equal(queued[0].join?.selectedEdgeId, "a-join");
        assert.deepEqual(queued[0].join?.accepted.map((offer) => offer.edgeId), ["a-join", "b-join"]);
        assert.equal((await driver.unitStore.readJoinProgress({ unitId: "unit-join-all", nodeId: "join" }))?.status, "queued");
    });
    register("reverse join arrival selects authored earliest edge with complete provenance", async (driver) => {
        const graph = joinGraph("conformance.join-reverse-arrival", "all");
        await publishAndAdmit(driver, graph, "unit-join-reverse-arrival");
        await runCode(driver, "start", { outcome: "ready" });
        const branchBArtifact = createArtifactEnvelope(ARTIFACT_CONTRACT, { branch: "b" });
        const branchAArtifact = createArtifactEnvelope(ARTIFACT_CONTRACT, { branch: "a" });
        await runCode(driver, "branch-b", {
            outcome: "done",
            outputArtifact: branchBArtifact
        });
        driver.advanceClock(1);
        await runCode(driver, "branch-a", {
            outcome: "done",
            outputArtifact: branchAArtifact
        });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "join"
        });
        assert.equal(queued.length, 1);
        assert.equal(queued[0].inputArtifact.digest, branchAArtifact.digest);
        assert.equal(queued[0].join?.selectedEdgeId, "a-join");
        const accepted = queued[0].join?.accepted ?? [];
        assert.deepEqual(accepted.map((offer) => offer.edgeId), ["a-join", "b-join"]);
        assert.deepEqual(accepted.map((offer) => offer.sourceNodeId), ["branch-a", "branch-b"]);
        assert.deepEqual(accepted.map((offer) => offer.artifact.digest), [
            branchAArtifact.digest,
            branchBArtifact.digest
        ]);
        assert.equal(accepted.every((offer) => typeof offer.sourceQueueId === "string" && offer.sourceQueueId.length > 0), true);
        assert.equal(accepted.every((offer) => /^[a-f0-9]{64}$/.test(offer.sourceEvidenceDigest)), true);
        assert.equal(Date.parse(accepted[1].offeredAt) < Date.parse(accepted[0].offeredAt), true);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-join-reverse-arrival" });
        assertJourneyRecordDigests(journey);
        for (const record of journey) {
            if (record.kind === "turn_settled")
                assertSettlementSeal(record);
        }
    });
    register("envelope join delivers heterogeneous payloads and exact source identities in sealed inbound order", async (driver) => {
        const graph = envelopeJoinGraph(joinGraph("conformance.join-envelope-reverse-arrival", "all"));
        const unitId = "unit-join-envelope-reverse-arrival";
        await publishAndAdmit(driver, graph, unitId);
        await runCode(driver, "start", { outcome: "ready" });
        const artifactA = createArtifactEnvelope("conformance.classification.v1", {
            category: "support", labels: ["account"]
        });
        const artifactB = createArtifactEnvelope("conformance.lookup.v1", {
            candidates: [{ id: "case-17", score: 0.75 }], found: true
        });
        await runCode(driver, "branch-b", { outcome: "done", outputArtifact: artifactB });
        driver.advanceClock(1);
        await runCode(driver, "branch-a", { outcome: "done", outputArtifact: artifactA });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(queued.length, 1);
        const queue = queued[0];
        assert.deepEqual(queue.join?.accepted.map((offer) => offer.edgeId), ["a-join", "b-join"]);
        assert.equal(queue.join?.selectedEdgeId, "a-join");
        assert.equal(queue.join.accepted[1].offeredAt < queue.join.accepted[0].offeredAt, true);
        assertJoinInputArtifact(graph, queue, new Map([["a-join", artifactA], ["b-join", artifactB]]));
        const journey = await driver.unitStore.readJourney({ unitId });
        for (const offer of queue.join.accepted) {
            const source = journey.find((record) => record.kind === "turn_settled"
                && record.nodeId === offer.sourceNodeId);
            assert.ok(source?.kind === "turn_settled");
            assert.equal(offer.sourceQueueId, source.queueId);
            assert.equal(offer.sourceEvidenceDigest, source.settlementDigest);
            assert.equal(offer.offeredAt, source.settledAt);
            assertSettlementSeal(source);
        }
        assertJourneyRecordDigests(journey);
        assert.deepEqual(await driver.unitStore.getArtifact({ artifact: {
                contractId: queue.inputArtifact.contractId,
                digest: queue.inputArtifact.digest
            } }), queue.inputArtifact);
        let observedInput;
        const result = await runNextUnitTurn({
            store: driver.unitStore,
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "conformance-envelope-body",
            nodeId: "join",
            ports: { code: { run: async (input) => {
                        observedInput = input;
                        return { outcome: "joined" };
                    } } },
            now: () => driver.now()
        });
        assert.equal(result?.status, "succeeded");
        assert.deepEqual(observedInput, queue.inputArtifact.payload);
        assertFrozenPayload(observedInput);
    });
    register("envelope join preserves each accepted artifact ref when identical payloads differ in optional bytes", async (driver) => {
        const graph = envelopeJoinGraph(joinGraph("conformance.join-envelope-ref-bytes", "all"));
        await publishAndAdmit(driver, graph, "unit-join-envelope-ref-bytes");
        await runCode(driver, "start", { outcome: "ready" });
        const withBytes = createArtifactEnvelope(ARTIFACT_CONTRACT, { shared: "payload" });
        const withoutBytes = {
            contractId: withBytes.contractId,
            digest: withBytes.digest,
            payload: withBytes.payload
        };
        await runCode(driver, "branch-a", { outcome: "done", outputArtifact: withBytes });
        await runCode(driver, "branch-b", { outcome: "done", outputArtifact: withoutBytes });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(queued.length, 1);
        assertJoinInputArtifact(graph, queued[0], new Map([
            ["a-join", withBytes], ["b-join", withoutBytes]
        ]));
    });
    register("envelope nOf retains only its accepted subset in sealed order and excludes late arrivals", async (driver) => {
        const graph = threeBranchEnvelopeJoinGraph("conformance.join-envelope-n-of");
        const unitId = "unit-join-envelope-n-of";
        await publishAndAdmit(driver, graph, unitId);
        await runCode(driver, "start", { outcome: "ready" });
        const artifactB = createArtifactEnvelope("conformance.second.v1", { accepted: "b" });
        const artifactC = createArtifactEnvelope("conformance.third.v1", ["accepted-c"]);
        await runCode(driver, "branch-c", { outcome: "done", outputArtifact: artifactC });
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        })).length, 0);
        await runCode(driver, "branch-b", { outcome: "done", outputArtifact: artifactB });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(queued.length, 1);
        const queue = queued[0];
        assert.deepEqual(queue.join?.accepted.map((offer) => offer.edgeId), ["b-join", "c-join"]);
        assert.equal(queue.join?.selectedEdgeId, "b-join");
        assertJoinInputArtifact(graph, queue, new Map([["b-join", artifactB], ["c-join", artifactC]]));
        const before = queue.inputArtifact;
        await runCode(driver, "branch-a", {
            outcome: "done",
            outputArtifact: createArtifactEnvelope("conformance.late.v1", { excluded: "a" })
        });
        const after = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(after.length, 1);
        assert.equal(after[0].queueId, queue.queueId);
        assert.deepEqual(after[0].inputArtifact, before);
        assert.deepEqual(after[0].join, queue.join);
        const journey = await driver.unitStore.readJourney({ unitId });
        const late = journey.find((record) => record.kind === "turn_settled"
            && record.nodeId === "branch-a");
        assert.ok(late?.kind === "turn_settled");
        assert.equal(late.routing.some((effect) => effect.kind === "join_offer"
            && effect.edgeId === "a-join"
            && effect.disposition === "join_already_resolved_noop"), true);
    });
    register("envelope nOf includes every offer accepted within the settlement that reaches its threshold", async (driver) => {
        const graph = envelopeJoinGraph(createGraphDefinition({
            graphId: "conformance.join-envelope-same-source",
            version: 1,
            description: "A threshold does not discard simultaneous matching edges from one settlement.",
            entry: "source",
            nodes: [
                node("source", ["done"]),
                node("join", ["joined", "join_unsatisfiable"], {
                    join: { inbound: ["third", "first", "second"], require: { nOf: 1 } }
                })
            ],
            edges: ["first", "second", "third"].map((edgeId) => ({
                edgeId, from: "source", when: { outcome: "done" }, to: ["join"]
            })),
            terminals: [
                { nodeId: "join", outcome: "joined" },
                { nodeId: "join", outcome: "join_unsatisfiable" }
            ]
        }));
        await publishAndAdmit(driver, graph, "unit-join-envelope-same-source");
        const output = createArtifactEnvelope("conformance.simultaneous.v1", { shared: true });
        await runCode(driver, "source", { outcome: "done", outputArtifact: output });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(queued.length, 1);
        assert.deepEqual(queued[0].join?.accepted.map((offer) => offer.edgeId), ["third", "first", "second"]);
        assertJoinInputArtifact(graph, queued[0], new Map([
            ["first", output], ["second", output], ["third", output]
        ]));
        assert.equal(new Set(queued[0].join.accepted.map((offer) => offer.sourceQueueId)).size, 1);
        assert.equal(new Set(queued[0].join.accepted.map((offer) => offer.sourceEvidenceDigest)).size, 1);
    });
    register("envelope join excludes duplicate edge payloads before resolution and late cycle payloads after it", async (driver) => {
        const graph = envelopeJoinGraph(cyclicJoinGraph("conformance.join-envelope-duplicates"));
        const unitId = "unit-join-envelope-duplicates";
        await publishAndAdmit(driver, graph, unitId);
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "skip" });
        await runCode(driver, "helper", { outcome: "go" });
        const first = createArtifactEnvelope(ARTIFACT_CONTRACT, { first: "a" });
        const duplicate = createArtifactEnvelope(ARTIFACT_CONTRACT, { excluded: "duplicate-a" });
        const artifactB = createArtifactEnvelope("conformance.final-leg.v1", { accepted: "b" });
        await runCode(driver, "branch-a", { outcome: "done", outputArtifact: first });
        await runCode(driver, "branch-a", { outcome: "done", outputArtifact: duplicate });
        const pending = await driver.unitStore.readJoinProgress({ unitId, nodeId: "join" });
        assert.equal(pending?.status, "pending");
        const offered = pending?.inbound.find((entry) => entry.edgeId === "a-join");
        assert.ok(offered?.state === "offered");
        assert.equal(offered.offer.artifact.digest, first.digest);
        await runCode(driver, "branch-b", { outcome: "done", outputArtifact: artifactB });
        const queued = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(queued.length, 1);
        assertJoinInputArtifact(graph, queued[0], new Map([["a-join", first], ["b-join", artifactB]]));
        await runCode(driver, "branch-a", {
            outcome: "done", outputArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { excluded: "late-a" })
        });
        const after = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL, nodeId: "join"
        });
        assert.equal(after.length, 1);
        assert.deepEqual(after[0].inputArtifact, queued[0].inputArtifact);
        const journey = await driver.unitStore.readJourney({ unitId });
        const offers = journey.flatMap((record) => record.kind === "turn_settled"
            && record.nodeId === "branch-a"
            ? record.routing.filter((effect) => effect.kind === "join_offer" && effect.edgeId === "a-join")
            : []);
        assert.deepEqual(offers.map((effect) => effect.kind === "join_offer" ? effect.disposition : undefined), [
            "accepted", "edge_already_resolved_noop", "join_already_resolved_noop"
        ]);
    });
    register("nOf join fires once and records every late offer as a no-op", async (driver) => {
        const graph = joinGraph("conformance.join-n-of", { nOf: 1 });
        await publishAndAdmit(driver, graph, "unit-join-n-of");
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "done" });
        assert.equal((await driver.unitStore.listQueuedUnits({ principalId: WORKER_PRINCIPAL, nodeId: "join" })).length, 1);
        await runCode(driver, "branch-b", { outcome: "done" });
        assert.equal((await driver.unitStore.listQueuedUnits({ principalId: WORKER_PRINCIPAL, nodeId: "join" })).length, 1);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-join-n-of" });
        const branchB = journey.find((record) => record.kind === "turn_settled" && record.nodeId === "branch-b");
        assert.ok(branchB?.kind === "turn_settled");
        assert.equal(branchB.routing.some((effect) => effect.kind === "join_offer"
            && effect.edgeId === "b-join"
            && effect.disposition === "join_already_resolved_noop"), true);
    });
    register("dead inbound leg emits one engine-authored join_unsatisfiable outcome", async (driver) => {
        const graph = joinGraph("conformance.join-unsatisfiable", "all", ["done", "drop"]);
        await publishAndAdmit(driver, graph, "unit-join-unsatisfiable");
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "drop" });
        const progress = await driver.unitStore.readJoinProgress({
            unitId: "unit-join-unsatisfiable",
            nodeId: "join"
        });
        assert.equal(progress?.status, "unsatisfiable");
        assert.equal((await driver.unitStore.listQueuedUnits({ principalId: WORKER_PRINCIPAL, nodeId: "join" })).length, 0);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-join-unsatisfiable" });
        const synthetic = journey.filter((record) => record.kind === "join_unsatisfiable");
        assert.equal(synthetic.length, 1);
        assert.equal(synthetic[0].principalId, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID);
        assert.equal(synthetic[0].startedAt, synthetic[0].settledAt);
        assert.equal(synthetic[0].artifact.contractId, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT);
        await runCode(driver, "branch-b", { outcome: "done" });
        const after = await driver.unitStore.readJourney({ unitId: "unit-join-unsatisfiable" });
        assert.equal(after.filter((record) => record.kind === "join_unsatisfiable").length, 1);
        const branchB = after.find((record) => record.kind === "turn_settled" && record.nodeId === "branch-b");
        assert.ok(branchB?.kind === "turn_settled");
        assert.equal(branchB.routing.some((effect) => effect.kind === "join_offer"
            && effect.disposition === "join_already_resolved_noop"), true);
    });
    register("partial join unsatisfiable routes its sealed reserved artifact", async (driver) => {
        const graph = routedUnsatisfiableGraph("conformance.join-unsatisfiable-routed");
        await publishAndAdmit(driver, graph, "unit-join-unsatisfiable-routed");
        await runCode(driver, "start", { outcome: "ready" });
        const acceptedArtifact = createArtifactEnvelope(ARTIFACT_CONTRACT, { branch: "accepted-a" });
        await runCode(driver, "branch-a", {
            outcome: "done",
            outputArtifact: acceptedArtifact
        });
        driver.advanceClock(1);
        await runCode(driver, "branch-b", { outcome: "drop" });
        const progress = await driver.unitStore.readJoinProgress({
            unitId: "unit-join-unsatisfiable-routed",
            nodeId: "join"
        });
        assert.equal(progress?.status, "unsatisfiable");
        assert.deepEqual(progress?.inbound.map((entry) => entry.state), ["offered", "impossible"]);
        const recover = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "recover"
        });
        assert.equal(recover.length, 1);
        assert.equal(recover[0].inputArtifact.contractId, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT);
        const journey = await driver.unitStore.readJourney({
            unitId: "unit-join-unsatisfiable-routed"
        });
        const syntheticRecords = journey.filter((record) => record.kind === "join_unsatisfiable");
        assert.equal(syntheticRecords.length, 1);
        const synthetic = syntheticRecords[0];
        const cause = [...journey].reverse().find((record) => record.kind === "turn_settled" && record.nodeId === "branch-b");
        assert.ok(cause?.kind === "turn_settled");
        assert.equal(synthetic.causeEvidenceDigest, cause.settlementDigest);
        assert.equal(synthetic.principalId, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID);
        assert.equal(synthetic.startedAt, synthetic.settledAt);
        assert.equal(recover[0].inputArtifact.digest, synthetic.artifact.digest);
        const artifact = await driver.unitStore.getArtifact({ artifact: synthetic.artifact });
        assert.ok(artifact !== undefined);
        assert.equal(artifact.contractId, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT);
        assert.equal(artifact.digest, digest(artifact.payload));
        const payload = artifact.payload;
        assert.equal(payload.unitId, "unit-join-unsatisfiable-routed");
        assert.equal(payload.nodeId, "join");
        assert.deepEqual(payload.accepted.map((offer) => offer.edgeId), ["a-join"]);
        assert.deepEqual(payload.impossible.map((entry) => entry.edgeId), ["b-join"]);
        assert.equal(payload.causeEvidenceDigest, synthetic.causeEvidenceDigest);
        assert.equal(payload.resolvedAt, synthetic.settledAt);
        assert.equal(synthetic.syntheticOutcomeDigest, digest({
            unitId: synthetic.unitId,
            graphDigest: graph.graphDigest,
            nodeId: synthetic.nodeId,
            outcome: "join_unsatisfiable",
            accepted: ["a-join"],
            impossible: ["b-join"],
            causeEvidenceDigest: synthetic.causeEvidenceDigest,
            resolvedAt: synthetic.settledAt,
            artifactDigest: synthetic.artifact.digest
        }));
        assertJourneyRecordDigests(journey);
        for (const record of journey) {
            if (record.kind === "turn_settled")
                assertSettlementSeal(record);
        }
    });
    register("ordinary matching edges enqueue one target with both edge ids", async (driver) => {
        const graph = duplicateOrdinaryTargetGraph("conformance.ordinary-edge-dedupe");
        await publishAndAdmit(driver, graph, "unit-ordinary-edge-dedupe");
        await runCode(driver, "source", { outcome: "done" });
        const target = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "target"
        });
        assert.equal(target.length, 1);
        const evidence = await driver.evidence();
        const targetOccurrence = evidence.queues.find((queue) => queue.queueId === target[0].queueId);
        assert.ok(targetOccurrence !== undefined);
        assert.deepEqual(targetOccurrence.inboundEdgeIds, [
            "source-target-first",
            "source-target-second"
        ]);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-ordinary-edge-dedupe" });
        const source = journey.find((record) => record.kind === "turn_settled" && record.nodeId === "source");
        assert.ok(source?.kind === "turn_settled");
        const enqueues = source.routing.filter((effect) => effect.kind === "queue_enqueued" && effect.targetNodeId === "target");
        assert.equal(enqueues.length, 1);
        assert.deepEqual(enqueues[0].kind === "queue_enqueued" ? enqueues[0].edgeIds : [], [
            "source-target-first",
            "source-target-second"
        ]);
    });
    register("cyclic duplicate join offer is a no-op while another leg remains possible", async (driver) => {
        const graph = cyclicJoinGraph("conformance.cyclic-duplicate-join-offer");
        await publishAndAdmit(driver, graph, "unit-cyclic-duplicate-join-offer");
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "skip" });
        let progress = await driver.unitStore.readJoinProgress({
            unitId: "unit-cyclic-duplicate-join-offer",
            nodeId: "join"
        });
        assert.equal(progress?.status, "pending");
        assert.deepEqual(progress?.inbound.map((entry) => entry.state), ["pending", "pending"]);
        assert.equal((await driver.unitStore.readJourney({ unitId: "unit-cyclic-duplicate-join-offer" }))
            .some((record) => record.kind === "join_unsatisfiable"), false);
        await runCode(driver, "helper", { outcome: "go" });
        await runCode(driver, "branch-a", { outcome: "done" });
        await runCode(driver, "branch-a", { outcome: "done" });
        progress = await driver.unitStore.readJoinProgress({
            unitId: "unit-cyclic-duplicate-join-offer",
            nodeId: "join"
        });
        assert.equal(progress?.status, "pending");
        assert.deepEqual(progress?.inbound.map((entry) => entry.state), ["offered", "pending"]);
        const beforeB = await driver.unitStore.readJourney({
            unitId: "unit-cyclic-duplicate-join-offer"
        });
        const branchASettlements = beforeB.filter((record) => record.kind === "turn_settled" && record.nodeId === "branch-a");
        const duplicate = branchASettlements.at(-1);
        assert.ok(duplicate?.kind === "turn_settled");
        assert.equal(duplicate.routing.some((effect) => effect.kind === "join_offer"
            && effect.edgeId === "a-join"
            && effect.disposition === "edge_already_resolved_noop"), true);
        assert.equal(beforeB.some((record) => record.kind === "join_unsatisfiable"), false);
        await runCode(driver, "branch-b", { outcome: "done" });
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "join"
        })).length, 1);
        assert.equal((await driver.unitStore.readJoinProgress({
            unitId: "unit-cyclic-duplicate-join-offer",
            nodeId: "join"
        }))?.status, "queued");
    });
    register("claim fairness is FIFO, per-graph round-robin, and batch homogeneous", async (driver) => {
        const graphA = createGraphDefinition({
            graphId: "conformance.fairness-a",
            version: 1,
            description: "First fairness graph lane.",
            entry: "shared",
            nodes: [node("shared", ["done"], { refId: "conformance.shared-node" })],
            edges: [],
            terminals: [{ nodeId: "shared", outcome: "done" }]
        });
        const graphB = createGraphDefinition({
            graphId: "conformance.fairness-b",
            version: 1,
            description: "Second fairness graph lane.",
            entry: "shared",
            nodes: [node("shared", ["done"], { refId: "conformance.shared-node" })],
            edges: [],
            terminals: [{ nodeId: "shared", outcome: "done" }]
        });
        await driver.graphStore.publishGraph(graphA);
        await driver.graphStore.publishGraph(graphB);
        for (const unitId of ["a-1", "a-2", "a-3"]) {
            await driver.unitStore.admitUnit({
                unitId,
                graph: graphDefinitionRef(graphA),
                seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { unitId }),
                admittedAt: driver.now().toISOString(),
                principalId: ADMITTER_PRINCIPAL
            });
        }
        for (const unitId of ["b-1", "b-2"]) {
            await driver.unitStore.admitUnit({
                unitId,
                graph: graphDefinitionRef(graphB),
                seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { unitId }),
                admittedAt: driver.now().toISOString(),
                principalId: ADMITTER_PRINCIPAL
            });
        }
        const first = await driver.unitStore.claimUnitTurns({
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "fairness-first",
            batch: 2,
            nodeId: "shared"
        });
        assert.deepEqual(first.map((claim) => claim.unitId), ["a-1", "a-2"]);
        assert.equal(new Set(first.map((claim) => claim.graph.graphDigest)).size, 1);
        const second = await driver.unitStore.claimUnitTurns({
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "fairness-second",
            batch: 2,
            nodeId: "shared"
        });
        assert.deepEqual(second.map((claim) => claim.unitId), ["b-1", "b-2"]);
        assert.equal(new Set(second.map((claim) => claim.graph.graphDigest)).size, 1);
        const third = await driver.unitStore.claimUnitTurns({
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "fairness-third",
            batch: 2,
            nodeId: "shared"
        });
        assert.deepEqual(third.map((claim) => claim.unitId), ["a-3"]);
    });
    register("fairness graph-lane order uses UTF-16 code units, including punctuation", async (driver) => {
        const graphIds = [
            "conformance.lexical-a",
            "conformance.lexical.a",
            "conformance.lexical:a"
        ];
        const graphs = graphIds.map((graphId) => createGraphDefinition({
            graphId,
            version: 1,
            description: `Lexical fairness lane ${graphId}.`,
            entry: "shared",
            nodes: [node("shared", ["done"], { refId: "conformance.lexical-shared" })],
            edges: [],
            terminals: [{ nodeId: "shared", outcome: "done" }]
        }));
        for (const [index, graph] of graphs.entries()) {
            await driver.graphStore.publishGraph(graph);
            await driver.unitStore.admitUnit({
                unitId: `unit-lexical-${index}`,
                graph: graphDefinitionRef(graph),
                seedArtifact: createArtifactEnvelope(ARTIFACT_CONTRACT, { index }),
                admittedAt: driver.now().toISOString(),
                principalId: ADMITTER_PRINCIPAL
            });
        }
        const first = await driver.unitStore.claimUnitTurns({
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "lexical-first",
            batch: 1,
            nodeId: "shared"
        });
        assert.equal(first.length, 1);
        assert.equal(first[0].graph.graphId, "conformance.lexical-a");
        const second = await driver.unitStore.claimUnitTurns({
            principalId: WORKER_PRINCIPAL,
            leaseOwner: "lexical-second",
            batch: 1,
            nodeId: "shared"
        });
        assert.equal(second.length, 1);
        assert.equal(second[0].graph.graphId, "conformance.lexical.a");
        assert.notEqual(second[0].graph.graphId, "conformance.lexical:a");
    });
    register("mixed-principal shared node queues list only each caller's authority", async (driver) => {
        const workerGraph = createGraphDefinition({
            graphId: "conformance.shared-principal-worker",
            version: 1,
            description: "Worker-principal shared node queue.",
            entry: "shared",
            nodes: [node("shared", ["done"], {
                    refId: "conformance.mixed-principal-shared",
                    principal: WORKER_PRINCIPAL
                })],
            edges: [],
            terminals: [{ nodeId: "shared", outcome: "done" }]
        });
        const consoleGraph = createGraphDefinition({
            graphId: "conformance.shared-principal-console",
            version: 1,
            description: "Console-principal shared node queue.",
            entry: "shared",
            nodes: [node("shared", ["done"], {
                    refId: "conformance.mixed-principal-shared",
                    principal: CONSOLE_PRINCIPAL
                })],
            edges: [],
            terminals: [{ nodeId: "shared", outcome: "done" }]
        });
        await publishAndAdmit(driver, workerGraph, "unit-shared-principal-worker");
        await publishAndAdmit(driver, consoleGraph, "unit-shared-principal-console");
        const workerQueues = await driver.unitStore.listQueuedUnits({
            principalId: WORKER_PRINCIPAL,
            nodeId: "shared"
        });
        const consoleQueues = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "shared"
        });
        assert.deepEqual(workerQueues.map((queue) => queue.unitId), ["unit-shared-principal-worker"]);
        assert.deepEqual(consoleQueues.map((queue) => queue.unitId), ["unit-shared-principal-console"]);
        assert.equal(workerQueues[0].principalId, WORKER_PRINCIPAL);
        assert.equal(consoleQueues[0].principalId, CONSOLE_PRINCIPAL);
    });
    register("human wait never expires and human/callback settlements route under exact principals", async (driver) => {
        const graph = humanCallbackGraph("conformance.external");
        await publishAndAdmit(driver, graph, "unit-external");
        await runCode(driver, "start", { outcome: "ready" });
        driver.advanceClock(365 * 24 * 60 * 60 * 1_000);
        const reviews = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "review"
        });
        assert.equal(reviews.length, 1);
        const human = await recordHumanNodeDecision({
            store: driver.unitStore,
            principalId: CONSOLE_PRINCIPAL,
            decision: {
                queueId: reviews[0].queueId,
                unitId: reviews[0].unitId,
                nodeId: reviews[0].nodeId,
                outcome: "approved",
                actor: { actorId: "operator-1" }
            },
            now: () => driver.now()
        });
        assert.equal(human.status, "succeeded");
        const callbacks = await driver.unitStore.listQueuedUnits({
            principalId: CALLBACK_PRINCIPAL,
            nodeId: "callback"
        });
        assert.equal(callbacks.length, 1);
        const callbackArtifact = createArtifactEnvelope(ARTIFACT_CONTRACT, { event: "arrived" });
        const callback = await admitCallbackNodeEvent({
            store: driver.unitStore,
            principalId: CALLBACK_PRINCIPAL,
            event: {
                queueId: callbacks[0].queueId,
                unitId: callbacks[0].unitId,
                nodeId: callbacks[0].nodeId,
                outcome: "received",
                outputArtifact: callbackArtifact,
                actor: { actorId: "callback-adapter-1" }
            },
            now: () => driver.now()
        });
        assert.equal(callback.status, "succeeded");
        assert.equal((await driver.unitStore.listQueuedUnits({ principalId: WORKER_PRINCIPAL, nodeId: "sink" })).length, 1);
        const journey = await driver.unitStore.readJourney({ unitId: "unit-external" });
        const external = journey.filter((record) => record.kind === "turn_settled"
            && (record.nodeId === "review" || record.nodeId === "callback"));
        assert.deepEqual(external.map((record) => record.kind === "turn_settled" ? record.actorId : undefined), ["operator-1", "callback-adapter-1"]);
    });
    register("external lease heartbeat is denied without losing the human decision", async (driver) => {
        const graph = humanCallbackGraph("conformance.external-heartbeat-denial");
        await publishAndAdmit(driver, graph, "unit-external-heartbeat-denial");
        await runCode(driver, "start", { outcome: "ready" });
        const reviews = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "review"
        });
        assert.equal(reviews.length, 1);
        const review = reviews[0];
        const completionDigest = nodeTurnCompletionDigest({ outcome: "approved" });
        const claimed = await driver.unitStore.claimExternalUnitTurn({
            principalId: CONSOLE_PRINCIPAL,
            kind: "human",
            queueId: review.queueId,
            unitId: review.unitId,
            nodeId: review.nodeId,
            actorId: "operator-heartbeat-denial",
            completionDigest,
            outboxEventDigests: []
        });
        assert.equal(claimed?.disposition, "claimed");
        if (claimed?.disposition !== "claimed") {
            throw new Error("expected an external lease claim");
        }
        await assert.rejects(driver.unitStore.heartbeatTurn({
            queueId: review.queueId,
            leaseToken: claimed.claim.leaseToken,
            extendByMs: TURN.leaseMs,
            at: driver.now().toISOString()
        }), (error) => error instanceof TurnLeaseLostError);
        assert.deepEqual((await driver.unitStore.readJourney({ unitId: review.unitId }))
            .map((record) => record.kind), ["unit_admitted", "turn_settled"]);
        const settled = await recordHumanNodeDecision({
            store: driver.unitStore,
            principalId: CONSOLE_PRINCIPAL,
            decision: {
                queueId: review.queueId,
                unitId: review.unitId,
                nodeId: review.nodeId,
                outcome: "approved",
                actor: { actorId: "operator-heartbeat-denial" }
            },
            now: () => driver.now()
        });
        assert.equal(settled.status, "succeeded");
    });
    register("callback completion without an event artifact is rejected without settlement", async (driver) => {
        const graph = humanCallbackGraph("conformance.callback-artifact-required");
        await publishAndAdmit(driver, graph, "unit-callback-artifact-required");
        await runCode(driver, "start", { outcome: "ready" });
        const reviews = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "review"
        });
        assert.equal(reviews.length, 1);
        await recordHumanNodeDecision({
            store: driver.unitStore,
            principalId: CONSOLE_PRINCIPAL,
            decision: {
                queueId: reviews[0].queueId,
                unitId: reviews[0].unitId,
                nodeId: reviews[0].nodeId,
                outcome: "approved",
                actor: { actorId: "operator-callback-artifact" }
            },
            now: () => driver.now()
        });
        const callbacks = await driver.unitStore.listQueuedUnits({
            principalId: CALLBACK_PRINCIPAL,
            nodeId: "callback"
        });
        assert.equal(callbacks.length, 1);
        const callback = callbacks[0];
        await assert.rejects(admitCallbackNodeEvent({
            store: driver.unitStore,
            principalId: CALLBACK_PRINCIPAL,
            event: {
                queueId: callback.queueId,
                unitId: callback.unitId,
                nodeId: callback.nodeId,
                outcome: "received",
                actor: { actorId: "callback-without-artifact" }
            },
            now: () => driver.now()
        }), /callback node event.*outputArtifact/);
        const journey = await driver.unitStore.readJourney({ unitId: callback.unitId });
        assert.equal(journey.some((record) => record.kind === "turn_settled" && record.nodeId === "callback"), false);
        assert.equal((await driver.unitStore.listQueuedUnits({
            principalId: CALLBACK_PRINCIPAL,
            nodeId: "callback"
        })).length, 1);
        assert.equal((await driver.unitStore.listDeadLetters({ unitId: callback.unitId })).length, 0);
    });
    register("human join queue never advertises engine-authored join_unsatisfiable", async (driver) => {
        const graph = humanJoinGraph("conformance.human-join-outcomes");
        await publishAndAdmit(driver, graph, "unit-human-join-outcomes");
        await runCode(driver, "start", { outcome: "ready" });
        await runCode(driver, "branch-a", { outcome: "done" });
        await runCode(driver, "branch-b", { outcome: "done" });
        const reviews = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "review"
        });
        assert.equal(reviews.length, 1);
        assert.deepEqual(reviews[0].outcomes, ["approved", "rejected"]);
        assert.equal(reviews[0].outcomes.includes("join_unsatisfiable"), false);
        assert.equal(reviews[0].join?.selectedEdgeId, "a-review");
    });
    register("external leases cannot invoke the worker failure/dead-letter authority", async (driver) => {
        const graph = humanCallbackGraph("conformance.external-failure-denial");
        await publishAndAdmit(driver, graph, "unit-external-failure-denial");
        await runCode(driver, "start", { outcome: "ready" });
        const reviews = await driver.unitStore.listQueuedUnits({
            principalId: CONSOLE_PRINCIPAL,
            nodeId: "review"
        });
        assert.equal(reviews.length, 1);
        const review = reviews[0];
        const completion = { outcome: "approved" };
        const completionDigest = nodeTurnCompletionDigest(completion);
        const claimed = await driver.unitStore.claimExternalUnitTurn({
            principalId: CONSOLE_PRINCIPAL,
            kind: "human",
            queueId: review.queueId,
            unitId: review.unitId,
            nodeId: review.nodeId,
            actorId: "operator-denial",
            completionDigest,
            outboxEventDigests: []
        });
        assert.equal(claimed?.disposition, "claimed");
        if (claimed?.disposition !== "claimed") {
            throw new Error("expected the human completion lease to be claimed");
        }
        const reviewNode = graph.nodes.find((candidate) => candidate.nodeId === "review");
        const prepared = await driver.unitStore.prepareTurnAttempt({
            queueId: review.queueId,
            unitId: review.unitId,
            nodeId: review.nodeId,
            leaseToken: claimed.claim.leaseToken,
            nodeRef: reviewNode.ref,
            fingerprint: nodeExecutionFingerprint(reviewNode),
            inputDigest: review.inputArtifact.digest,
            maxAttempts: reviewNode.turn.maxAttempts
        });
        assert.equal(prepared.disposition, "reserved");
        if (prepared.disposition !== "reserved") {
            throw new Error("expected the human completion attempt to be reserved");
        }
        const at = driver.now().toISOString();
        const failure = {
            queueId: review.queueId,
            unitId: review.unitId,
            nodeId: review.nodeId,
            attemptNumber: prepared.attemptNumber,
            attemptIndex: prepared.attemptIndex,
            idempotencyKey: prepared.idempotencyKey,
            principalId: CONSOLE_PRINCIPAL,
            startedAt: at,
            failedAt: at,
            errorCode: "forged_worker_failure",
            errorMessage: "external completion cannot terminalize its own queue",
            retryable: false,
            terminal: true,
            usage: []
        };
        await assert.rejects(driver.unitStore.recordTurnFailure({
            ...failure,
            leaseToken: claimed.claim.leaseToken,
            failureDigest: nodeTurnFailureDigest(failure)
        }), /recordTurnFailure: human node review cannot record a worker failure/);
        const denied = await driver.evidence();
        assert.equal(denied.deadLetters.length, 0);
        assert.equal(denied.journey.some((record) => record.kind === "turn_failed" && record.nodeId === "review"), false);
        const settled = await recordHumanNodeDecision({
            store: driver.unitStore,
            principalId: CONSOLE_PRINCIPAL,
            decision: {
                queueId: review.queueId,
                unitId: review.unitId,
                nodeId: review.nodeId,
                outcome: "approved",
                actor: { actorId: "operator-denial" }
            },
            now: () => driver.now()
        });
        assert.equal(settled.status, "succeeded");
    });
    const settlementScenarios = ["select", "envelope"].flatMap((compose) => SETTLE_TRANSACTION_CHECKPOINTS.map((checkpoint) => ({ compose, checkpoint })));
    for (const { compose, checkpoint } of settlementScenarios) {
        register(`${compose === "envelope" ? "envelope join " : ""}settle crash at ${checkpoint} is exactly-once and never between queues`, async (driver) => {
            const baseGraph = crashGraph(`conformance.crash-${checkpoint.replaceAll("_", "-")}`);
            const graph = compose === "envelope" ? envelopeJoinGraph(baseGraph) : baseGraph;
            const admission = await publishAndAdmit(driver, graph, `unit-crash-${checkpoint}`);
            await runCode(driver, "start", { outcome: "ready" });
            await runCode(driver, "branch-a", { outcome: "done" });
            const pendingJoin = await driver.unitStore.readJoinProgress({
                unitId: admission.unit.unitId, nodeId: "join"
            });
            const branchB = await claimOne(driver, "branch-b");
            const output = createArtifactEnvelope(ARTIFACT_CONTRACT, {
                checkpoint,
                result: "branch-b"
            });
            const outbox = [{
                    eventType: "conformance_settlement",
                    payload: { checkpoint },
                    dedupeKey: `conformance:${checkpoint}`
                }];
            let bodyCalls = 0;
            let captured;
            const executionStore = executionStoreWithCapturedSettle(driver.unitStore, (input, events) => {
                captured = { input, outbox: events };
            });
            driver.armSettleCrash(checkpoint);
            await assert.rejects(runClaimedUnitTurn({
                store: executionStore,
                claim: branchB,
                principalId: WORKER_PRINCIPAL,
                ports: {
                    code: {
                        run: async () => {
                            bodyCalls += 1;
                            return { outcome: "done", outputArtifact: output };
                        }
                    }
                },
                successOutboxEvents: () => outbox,
                now: () => driver.now()
            }), (error) => error instanceof TurnSettlementUncertainError);
            assert.equal(driver.checkpointHits().includes(checkpoint), true);
            assert.equal(bodyCalls, 1);
            assert.ok(captured !== undefined);
            const postCommit = checkpoint === "post_commit_reply";
            const crashed = await driver.evidence();
            assert.equal(crashed.settlements.some((settlement) => settlement.queueId === branchB.queueId), postCommit);
            assert.equal(settledAtNode(crashed, "branch-b").length, postCommit ? 1 : 0);
            assert.equal(queueCount(crashed, "direct"), postCommit ? 1 : 0);
            assert.equal(queueCount(crashed, "join"), postCommit ? 1 : 0);
            assert.equal(crashed.outbox.length, postCommit ? 1 : 0);
            assert.equal(crashed.artifacts.some((artifact) => artifact.digest === output.digest), postCommit);
            assert.equal(crashed.cachedCompletions.some((cached) => cached.queueId === branchB.queueId), true);
            if (compose === "envelope") {
                assert.equal(crashed.artifacts.filter((artifact) => artifact.contractId === JOIN_INPUT_ARTIFACT_CONTRACT).length, postCommit ? 1 : 0);
                if (!postCommit) {
                    assert.deepEqual(await driver.unitStore.readJoinProgress({
                        unitId: admission.unit.unitId, nodeId: "join"
                    }), pendingJoin);
                }
            }
            await driver.recover();
            if (postCommit) {
                const prior = captured;
                const replay = await driver.unitStore.settleTurn(prior.input, prior.outbox);
                assert.equal(replay.created, false);
            }
            else {
                driver.advanceClock(TURN.leaseMs + 1);
                const reclaimed = await claimOne(driver, "branch-b");
                const replay = await runClaimedUnitTurn({
                    store: driver.unitStore,
                    claim: reclaimed,
                    principalId: WORKER_PRINCIPAL,
                    ports: {
                        code: {
                            run: async () => {
                                bodyCalls += 1;
                                throw new Error("cached crash replay must not invoke the body");
                            }
                        }
                    },
                    successOutboxEvents: () => outbox,
                    now: () => driver.now()
                });
                assert.equal(replay.status, "succeeded");
                assert.equal(replay.reused, true);
            }
            const final = await driver.evidence();
            assert.equal(bodyCalls, 1);
            assert.equal(settledAtNode(final, "branch-b").length, 1);
            assert.equal(queueCount(final, "direct"), 1);
            assert.equal(queueCount(final, "join"), 1);
            assert.equal(final.outbox.length, 1);
            assert.equal(final.artifacts.filter((artifact) => artifact.digest === output.digest).length, 1);
            assert.equal(final.joins.filter((join) => join.nodeId === "join" && join.status === "queued").length, 1);
            if (compose === "envelope") {
                const joinQueue = final.queues.find((queue) => queue.nodeId === "join");
                assertJoinInputArtifact(graph, joinQueue, new Map([
                    ["a-join", admission.entryQueue.inputArtifact],
                    ["b-join", output]
                ]));
                const retainedEnvelopes = final.artifacts.filter((artifact) => artifact.contractId === JOIN_INPUT_ARTIFACT_CONTRACT);
                assert.equal(retainedEnvelopes.length, 1);
                assert.deepEqual(retainedEnvelopes[0], joinQueue.inputArtifact);
                assertJourneyRecordDigests(final.journey);
            }
        });
    }
}

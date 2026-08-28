// store/memory-unit-store.ts — executable N3 UnitStore specification.
//
// The implementation intentionally favors explicit retained evidence over a
// compact mutable workflow object. Queue occurrences, attempts, cached body
// results, failures, settlements, journey, artifacts, join progress events,
// dead letters, and outbox rows are append-only. Only lease rows and the
// fairness cursor are replaceable coordination state.
import { randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { artifactRef, validateArtifactEnvelope, validateArtifactRef } from "../contracts/artifact.js";
import { digest } from "../contracts/digest.js";
import { validateUsageReceipt } from "../contracts/usage-receipt.js";
import { compileGraph } from "../graph/compile.js";
import { snapshotGraphValidationData } from "../graph/limits.js";
import { graphDefinitionRef, JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT, MISSION_PIPELINE_ENGINE_PRINCIPAL_ID, validateMissionPipelineNode } from "../graph/definition.js";
import { assertIdentifier, assertSafePositiveInt, assertSha256Hex, typeName } from "../internal/guards.js";
import { captureCapabilityRecord, captureDenseArrayItems } from "../internal/capability.js";
import { assertEvidenceString, deepFrozenClone } from "../internal/evidence.js";
import { ENGINE_JOIN_UNSATISFIABLE_OUTCOME, MAX_AGENT_TURN_USAGE_RECEIPTS, validateNodeTurnCompletion } from "../execute/ports.js";
import { MAX_TURN_BATCH_SIZE, MAX_TURN_OUTBOX_EVENTS, TurnAuthorityError, TurnEvidenceConflictError, TurnLeaseLostError, turnOutboxEventDigest } from "../execute/unit-runner.js";
import { nodeExecutionFingerprint, nodeTurnCompletionDigest, nodeTurnIdempotencyKey } from "../execute/turn.js";
import { validateGraphDefinitionRef } from "./graph-store.js";
import { MemoryGraphStore } from "./memory-graph-store.js";
import { evaluateJoinThreshold, matchingOutcomeEdges } from "./routing.js";
import { MAX_UNIT_STORE_LIST_LIMIT, MISSION_PIPELINE_UNIT_SCHEMA_VERSION, nodeTurnFailureDigest, nodeTurnSettlementDigest, validateNodeTurnFailureMessage } from "./unit-store.js";
const WORKER_KINDS = new Set(["code", "model", "agent"]);
const DateConstructor = Date;
const dateParse = Date.parse;
const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
function timestampEpoch(value) {
    return Reflect.apply(dateParse, DateConstructor, [value]);
}
function timestampFromEpoch(epoch) {
    return Reflect.apply(dateToISOString, new DateConstructor(epoch), []);
}
function emptyState() {
    return {
        units: new Map(),
        unitGraphs: new Map(),
        artifacts: new Map(),
        queues: new Map(),
        leases: new Map(),
        reservations: new Map(),
        cachedCompletions: new Map(),
        failures: new Map(),
        settlements: new Map(),
        journey: new Map(),
        joins: new Map(),
        outbox: Object.freeze([]),
        outboxDedupeKeys: new Set(),
        deadLetters: Object.freeze([]),
        fairnessCursor: new Map(),
        nextEnqueueSequence: 1
    };
}
function cloneState(state) {
    return {
        units: new Map(state.units),
        unitGraphs: new Map(state.unitGraphs),
        artifacts: new Map(state.artifacts),
        queues: new Map(state.queues),
        leases: new Map(state.leases),
        reservations: new Map([...state.reservations].map(([key, rows]) => [key, [...rows]])),
        cachedCompletions: new Map(state.cachedCompletions),
        failures: new Map(state.failures),
        settlements: new Map(state.settlements),
        journey: new Map([...state.journey].map(([key, rows]) => [key, [...rows]])),
        joins: new Map(state.joins),
        outbox: [...state.outbox],
        outboxDedupeKeys: new Set(state.outboxDedupeKeys),
        deadLetters: [...state.deadLetters],
        fairnessCursor: new Map(state.fairnessCursor),
        nextEnqueueSequence: state.nextEnqueueSequence
    };
}
function artifactKey(ref) {
    return `${ref.contractId}\0${ref.digest}`;
}
function joinKey(unitId, nodeId) {
    return `${unitId}\0${nodeId}`;
}
function attemptKey(queueId, attemptNumber) {
    return `${queueId}\0${attemptNumber}`;
}
function unitNodeKey(unitId, nodeId) {
    return `${unitId}\0${nodeId}`;
}
function laneKey(graph) {
    return `${graph.graphId}\0${graph.version}\0${graph.graphDigest}`;
}
function sharedNodeKey(node) {
    return `${node.nodeId}\0${node.ref.id}\0${node.ref.version}`;
}
function codeUnitCompare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function assertBoolean(value, label) {
    if (typeof value !== "boolean") {
        throw new Error(`${label} must be a boolean (got ${typeName(value)})`);
    }
    return value;
}
function assertCanonicalTimestamp(value, label) {
    const epoch = typeof value === "string"
        ? Reflect.apply(dateParse, DateConstructor, [value])
        : Number.NaN;
    if (typeof value !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(epoch)
        || Reflect.apply(dateToISOString, new DateConstructor(epoch), []) !== value) {
        throw new Error(`${label} must be a canonical UTC ISO timestamp`);
    }
    return value;
}
function assertTimestampOrder(startedRaw, endedRaw, startedLabel, endedLabel) {
    const startedAt = assertCanonicalTimestamp(startedRaw, startedLabel);
    const endedAt = assertCanonicalTimestamp(endedRaw, endedLabel);
    if (timestampEpoch(endedAt) < timestampEpoch(startedAt)) {
        throw new Error(`${endedLabel} must be at or after ${startedLabel}`);
    }
    return Object.freeze({ startedAt, endedAt });
}
function nowIso(now) {
    const value = now();
    if (value === null
        || typeof value !== "object"
        || nodeTypes.isProxy(value)
        || Object.getPrototypeOf(value) !== Date.prototype) {
        throw new Error("MemoryUnitStore clock must return a non-Proxy Date");
    }
    const epoch = Reflect.apply(dateGetTime, value, []);
    if (!Number.isFinite(epoch)) {
        throw new Error("MemoryUnitStore clock must return a valid Date");
    }
    return Reflect.apply(dateToISOString, value, []);
}
function isLeaseActive(lease, at) {
    return lease !== undefined && timestampEpoch(at) < timestampEpoch(lease.expiresAt);
}
function sealRecord(value, label) {
    const base = deepFrozenClone(value, label);
    return deepFrozenClone({ ...base, recordDigest: digest(base) }, `${label} sealed`);
}
function sameOrdered(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function nodeForQueue(state, queue) {
    const graph = state.unitGraphs.get(queue.unitId);
    const node = graph === undefined ? undefined : compileGraph(graph).nodesById[queue.nodeId];
    if (graph === undefined || node === undefined) {
        throw new Error(`MemoryUnitStore invariant: queue ${queue.queueId} has no sealed graph/node`);
    }
    return node;
}
function graphForQueue(state, queue) {
    const graph = state.unitGraphs.get(queue.unitId);
    if (graph === undefined) {
        throw new Error(`MemoryUnitStore invariant: queue ${queue.queueId} has no sealed graph`);
    }
    return graph;
}
function terminalFailureForQueue(state, queueId) {
    const rows = [...state.failures.values()]
        .filter((failure) => failure.queueId === queueId && failure.terminal)
        .sort((a, b) => a.attemptIndex - b.attemptIndex);
    return rows.at(-1);
}
function isQueueOpen(state, queueId) {
    return !state.settlements.has(queueId) && terminalFailureForQueue(state, queueId) === undefined;
}
function claimSnapshot(state, queue, leaseToken) {
    return deepFrozenClone({
        queueId: queue.queueId,
        unitId: queue.unitId,
        nodeId: queue.nodeId,
        graph: graphForQueue(state, queue),
        inputArtifact: queue.inputArtifact,
        leaseToken
    }, `claimed queue ${queue.queueId}`);
}
function graphRefEqual(left, right) {
    return left.id === right.id && left.version === right.version && left.digest === right.digest;
}
/** Memory UnitStore; also forwards GraphStore for ergonomic hermetic use. */
export class MemoryUnitStore {
    #graphStore;
    #now;
    #idFactory;
    #settleCheckpoint;
    #state = emptyState();
    constructor(options = {}) {
        this.#graphStore = options.graphStore ?? new MemoryGraphStore();
        this.#now = options.now ?? (() => new DateConstructor());
        this.#idFactory = options.idFactory ?? ((kind) => `${kind}:${randomUUID()}`);
        this.#settleCheckpoint = options.settleCheckpoint;
    }
    async publishGraph(graph) {
        await this.#graphStore.publishGraph(graph);
    }
    async loadGraph(ref) {
        return this.#graphStore.loadGraph(ref);
    }
    #newId(kind) {
        return assertEvidenceString(this.#idFactory(kind), `MemoryUnitStore ${kind} id`);
    }
    #checkpoint(checkpoint) {
        if (this.#settleCheckpoint !== undefined)
            this.#settleCheckpoint(checkpoint);
    }
    async admitUnit(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["unitId", "graph", "seedArtifact", "admittedAt", "principalId"], ["unitId", "graph", "seedArtifact", "admittedAt", "principalId"], "admitUnit input");
        const unitId = assertEvidenceString(raw.unitId, "admitUnit input.unitId");
        const graphRef = validateGraphDefinitionRef(raw.graph, "admitUnit input.graph");
        const seedArtifact = validateArtifactEnvelope(raw.seedArtifact);
        const admittedAt = assertCanonicalTimestamp(raw.admittedAt, "admitUnit input.admittedAt");
        const principalId = assertIdentifier(raw.principalId, "admitUnit input.principalId");
        const graph = await this.#graphStore.loadGraph(graphRef);
        if (graph === undefined) {
            throw new Error(`admitUnit: graph ${graphRef.id}@${graphRef.version} (${graphRef.digest}) is not published`);
        }
        const compiled = compileGraph(graph);
        const entry = compiled.nodesById[compiled.entry];
        if (seedArtifact.contractId !== entry.input) {
            throw new Error(`admitUnit: entry node ${entry.nodeId} input contract mismatch: expected ${entry.input}, got ${seedArtifact.contractId}`);
        }
        const seedRef = artifactRef(seedArtifact);
        const admissionBase = {
            schemaVersion: MISSION_PIPELINE_UNIT_SCHEMA_VERSION,
            unitId,
            graph: graphRef,
            seedArtifact: seedRef,
            admittedAt,
            principalId
        };
        const admissionDigest = digest(admissionBase);
        const existing = this.#state.units.get(unitId);
        if (existing !== undefined) {
            if (existing.admissionDigest !== admissionDigest) {
                throw new TurnEvidenceConflictError(`admitUnit: unit ${unitId} conflicts with immutable admission ${existing.admissionDigest}; requested ${admissionDigest}`);
            }
            const entryQueue = [...this.#state.queues.values()].find((queue) => queue.unitId === unitId && queue.sourceEvidenceDigest === admissionDigest);
            if (entryQueue === undefined) {
                throw new Error(`MemoryUnitStore invariant: admitted unit ${unitId} has no entry queue`);
            }
            return deepFrozenClone({ created: false, unit: existing, entryQueue }, "admitUnit replay");
        }
        const queueId = this.#newId("queue");
        if (this.#state.queues.has(queueId)) {
            throw new Error(`MemoryUnitStore idFactory produced duplicate queue id ${queueId}`);
        }
        const unit = deepFrozenClone({ ...admissionBase, admissionDigest }, `unit ${unitId}`);
        const entryQueue = deepFrozenClone({
            queueId,
            unitId,
            graph: graphRef,
            nodeId: entry.nodeId,
            nodeRef: entry.ref,
            inputArtifact: seedArtifact,
            queuedAt: admittedAt,
            enqueueSequence: this.#state.nextEnqueueSequence,
            sourceEvidenceDigest: admissionDigest,
            inboundEdgeIds: Object.freeze([])
        }, `unit ${unitId} entry queue`);
        const admissionRecord = sealRecord({
            kind: "unit_admitted",
            sequence: 1,
            unitId,
            graph: graphRef,
            recordedAt: admittedAt,
            principalId,
            seedArtifact: seedRef,
            entryQueueId: queueId,
            entryNodeId: entry.nodeId,
            entryEnqueueSequence: entryQueue.enqueueSequence
        }, `unit ${unitId} admission journey`);
        const draft = cloneState(this.#state);
        draft.units.set(unitId, unit);
        draft.unitGraphs.set(unitId, graph);
        if (!draft.artifacts.has(artifactKey(seedRef))) {
            draft.artifacts.set(artifactKey(seedRef), seedArtifact);
        }
        draft.queues.set(queueId, entryQueue);
        draft.journey.set(unitId, Object.freeze([admissionRecord]));
        draft.nextEnqueueSequence += 1;
        this.#state = draft;
        return deepFrozenClone({ created: true, unit, entryQueue }, "admitUnit result");
    }
    async readUnit(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["unitId"], ["unitId"], "readUnit input");
        const unit = this.#state.units.get(assertEvidenceString(raw.unitId, "readUnit input.unitId"));
        return unit === undefined ? undefined : deepFrozenClone(unit, "readUnit result");
    }
    async readJourney(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["unitId"], ["unitId"], "readJourney input");
        const unitId = assertEvidenceString(raw.unitId, "readJourney input.unitId");
        return deepFrozenClone(this.#state.journey.get(unitId) ?? [], "readJourney result");
    }
    async readJoinProgress(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["unitId", "nodeId"], ["unitId", "nodeId"], "readJoinProgress input");
        const progress = this.#state.joins.get(joinKey(assertEvidenceString(raw.unitId, "readJoinProgress input.unitId"), assertIdentifier(raw.nodeId, "readJoinProgress input.nodeId")));
        return progress === undefined
            ? undefined
            : deepFrozenClone(progress, "readJoinProgress result");
    }
    async getArtifact(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["artifact"], ["artifact"], "getArtifact input");
        const ref = validateArtifactRef(raw.artifact);
        const artifact = this.#state.artifacts.get(artifactKey(ref));
        return artifact === undefined ? undefined : deepFrozenClone(artifact, "getArtifact result");
    }
    async listQueuedUnits(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["principalId", "nodeId", "graphId", "limit"], ["principalId", "nodeId"], "listQueuedUnits input");
        const principalId = assertIdentifier(raw.principalId, "listQueuedUnits input.principalId");
        const nodeId = assertIdentifier(raw.nodeId, "listQueuedUnits input.nodeId");
        const graphId = raw.graphId === undefined
            ? undefined
            : assertIdentifier(raw.graphId, "listQueuedUnits input.graphId");
        const limit = raw.limit === undefined
            ? 100
            : assertSafePositiveInt(raw.limit, "listQueuedUnits input.limit");
        if (limit > MAX_UNIT_STORE_LIST_LIMIT) {
            throw new Error(`listQueuedUnits input.limit must be 1..${MAX_UNIT_STORE_LIST_LIMIT}`);
        }
        const now = nowIso(this.#now);
        const candidateQueues = [...this.#state.queues.values()]
            .filter((queue) => queue.nodeId === nodeId)
            .filter((queue) => graphId === undefined || queue.graph.id === graphId)
            .filter((queue) => nodeForQueue(this.#state, queue).principal.id === principalId);
        return deepFrozenClone(candidateQueues
            .filter((queue) => isQueueOpen(this.#state, queue.queueId))
            .filter((queue) => !isLeaseActive(this.#state.leases.get(queue.queueId), now))
            .sort((a, b) => a.enqueueSequence - b.enqueueSequence)
            .slice(0, limit)
            .map((queue) => {
            const node = nodeForQueue(this.#state, queue);
            return {
                queueId: queue.queueId,
                unitId: queue.unitId,
                graph: queue.graph,
                nodeId: queue.nodeId,
                nodeRef: queue.nodeRef,
                nodeKind: node.kind,
                principalId: node.principal.id,
                inputArtifact: queue.inputArtifact,
                queuedAt: queue.queuedAt,
                outcomes: node.outcomes.outcomes.filter((outcome) => outcome !== ENGINE_JOIN_UNSATISFIABLE_OUTCOME),
                ...(queue.join === undefined ? {} : { join: queue.join })
            };
        }), "listQueuedUnits result");
    }
    async claimUnitTurns(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["principalId", "leaseOwner", "batch", "nodeId"], ["principalId", "leaseOwner", "batch"], "claimUnitTurns input");
        const principalId = assertIdentifier(raw.principalId, "claimUnitTurns input.principalId");
        const leaseOwner = assertEvidenceString(raw.leaseOwner, "claimUnitTurns input.leaseOwner");
        const batch = assertSafePositiveInt(raw.batch, "claimUnitTurns input.batch");
        if (batch > MAX_TURN_BATCH_SIZE) {
            throw new Error(`claimUnitTurns input.batch must be 1..${MAX_TURN_BATCH_SIZE}`);
        }
        const requestedNodeId = raw.nodeId === undefined
            ? undefined
            : assertIdentifier(raw.nodeId, "claimUnitTurns input.nodeId");
        const at = nowIso(this.#now);
        const eligible = [...this.#state.queues.values()]
            .filter((queue) => isQueueOpen(this.#state, queue.queueId))
            .filter((queue) => !isLeaseActive(this.#state.leases.get(queue.queueId), at))
            .filter((queue) => requestedNodeId === undefined || queue.nodeId === requestedNodeId)
            .filter((queue) => {
            const node = nodeForQueue(this.#state, queue);
            return node.principal.id === principalId && WORKER_KINDS.has(node.kind);
        })
            .sort((a, b) => a.enqueueSequence - b.enqueueSequence);
        if (eligible.length === 0)
            return Object.freeze([]);
        const headByShared = new Map();
        for (const queue of eligible) {
            const key = sharedNodeKey(nodeForQueue(this.#state, queue));
            if (!headByShared.has(key))
                headByShared.set(key, queue);
        }
        const selectedShared = [...headByShared]
            .sort((a, b) => {
            const order = a[1].enqueueSequence - b[1].enqueueSequence;
            return order === 0 ? codeUnitCompare(a[0], b[0]) : order;
        })[0][0];
        const sharedEligible = eligible.filter((queue) => sharedNodeKey(nodeForQueue(this.#state, queue)) === selectedShared);
        const lanes = new Map();
        for (const queue of sharedEligible) {
            const key = laneKey(graphForQueue(this.#state, queue));
            const rows = lanes.get(key) ?? [];
            rows.push(queue);
            lanes.set(key, rows);
        }
        const laneKeys = [...lanes.keys()].sort(codeUnitCompare);
        const prior = this.#state.fairnessCursor.get(selectedShared);
        let selectedLane;
        if (prior === undefined) {
            selectedLane = [...lanes]
                .sort((a, b) => {
                const order = a[1][0].enqueueSequence - b[1][0].enqueueSequence;
                return order === 0 ? codeUnitCompare(a[0], b[0]) : order;
            })[0][0];
        }
        else {
            selectedLane = laneKeys.find((key) => key > prior) ?? laneKeys[0];
        }
        const selected = lanes.get(selectedLane).slice(0, batch);
        const draft = cloneState(this.#state);
        const claims = [];
        for (const queue of selected) {
            const node = nodeForQueue(this.#state, queue);
            const leaseToken = this.#newId("lease");
            if ([...draft.leases.values()].some((lease) => lease.leaseToken === leaseToken)) {
                throw new Error(`MemoryUnitStore idFactory produced duplicate lease token ${leaseToken}`);
            }
            const expiresAt = timestampFromEpoch(timestampEpoch(at) + node.turn.leaseMs);
            draft.leases.set(queue.queueId, deepFrozenClone({
                leaseOwner,
                leaseToken,
                acquiredAt: at,
                heartbeatAt: at,
                expiresAt,
                mode: "worker",
                principalId
            }, `queue ${queue.queueId} worker lease`));
            claims.push(claimSnapshot(this.#state, queue, leaseToken));
        }
        draft.fairnessCursor.set(selectedShared, selectedLane);
        this.#state = draft;
        return deepFrozenClone(claims, "claimUnitTurns result");
    }
    #findExactQueue(queueIdRaw, unitIdRaw, nodeIdRaw, label) {
        const queueId = assertEvidenceString(queueIdRaw, `${label}.queueId`);
        const unitId = assertEvidenceString(unitIdRaw, `${label}.unitId`);
        const nodeId = assertIdentifier(nodeIdRaw, `${label}.nodeId`);
        const queue = this.#state.queues.get(queueId);
        if (queue === undefined || queue.unitId !== unitId || queue.nodeId !== nodeId) {
            return undefined;
        }
        return queue;
    }
    #requireExactQueue(queueIdRaw, unitIdRaw, nodeIdRaw, label) {
        const queue = this.#findExactQueue(queueIdRaw, unitIdRaw, nodeIdRaw, label);
        if (queue === undefined) {
            throw new Error(`${label}: queue/unit/node coordinates do not identify one retained occurrence`);
        }
        return queue;
    }
    #assertActiveLease(state, queueId, leaseTokenRaw, at) {
        const leaseToken = assertEvidenceString(leaseTokenRaw, "turn leaseToken");
        const lease = state.leases.get(queueId);
        if (!isLeaseActive(lease, at) || lease.leaseToken !== leaseToken) {
            throw new TurnLeaseLostError(queueId);
        }
        return lease;
    }
    async inspectExternalUnitTurn(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["principalId", "kind", "queueId", "unitId", "nodeId"], ["principalId", "kind", "queueId", "unitId", "nodeId"], "inspectExternalUnitTurn input");
        const principalId = assertIdentifier(raw.principalId, "inspectExternalUnitTurn input.principalId");
        if (raw.kind !== "human" && raw.kind !== "callback") {
            throw new Error('inspectExternalUnitTurn input.kind must be "human" | "callback"');
        }
        const queue = this.#findExactQueue(raw.queueId, raw.unitId, raw.nodeId, "inspectExternalUnitTurn input");
        if (queue === undefined)
            return undefined;
        const node = nodeForQueue(this.#state, queue);
        if (node.kind !== raw.kind)
            return undefined;
        if (node.principal.id !== principalId) {
            throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
        }
        if (terminalFailureForQueue(this.#state, queue.queueId) !== undefined)
            return undefined;
        return deepFrozenClone({
            queueId: queue.queueId,
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            graph: graphForQueue(this.#state, queue),
            inputArtifact: queue.inputArtifact
        }, "inspectExternalUnitTurn result");
    }
    async claimExternalUnitTurn(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, [
            "principalId", "kind", "queueId", "unitId", "nodeId", "actorId",
            "completionDigest", "outboxEventDigests"
        ], [
            "principalId", "kind", "queueId", "unitId", "nodeId", "actorId",
            "completionDigest", "outboxEventDigests"
        ], "claimExternalUnitTurn input");
        const principalId = assertIdentifier(raw.principalId, "claimExternalUnitTurn input.principalId");
        if (raw.kind !== "human" && raw.kind !== "callback") {
            throw new Error('claimExternalUnitTurn input.kind must be "human" | "callback"');
        }
        const kind = raw.kind;
        const actorId = assertEvidenceString(raw.actorId, "claimExternalUnitTurn input.actorId");
        const completionDigest = assertSha256Hex(raw.completionDigest, "claimExternalUnitTurn input.completionDigest");
        const digestValues = captureDenseArrayItems(raw.outboxEventDigests, "claimExternalUnitTurn input.outboxEventDigests", MAX_TURN_OUTBOX_EVENTS);
        const outboxEventDigests = Object.freeze(digestValues.map((value, index) => assertSha256Hex(value, `claimExternalUnitTurn input.outboxEventDigests[${index}]`)));
        const queue = this.#findExactQueue(raw.queueId, raw.unitId, raw.nodeId, "claimExternalUnitTurn input");
        if (queue === undefined)
            return undefined;
        const node = nodeForQueue(this.#state, queue);
        if (node.kind !== kind)
            return undefined;
        if (node.principal.id !== principalId) {
            throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
        }
        const settled = this.#state.settlements.get(queue.queueId);
        if (settled !== undefined) {
            if (settled.principalId !== principalId
                || settled.actorId !== actorId
                || settled.completionDigest !== completionDigest
                || !sameOrdered(settled.committedOutboxEventDigests, outboxEventDigests)) {
                throw new TurnEvidenceConflictError(`external completion conflicts with settled evidence for queue ${queue.queueId}`);
            }
            return deepFrozenClone({
                disposition: "settled",
                queueId: settled.queueId,
                unitId: settled.unitId,
                nodeId: settled.nodeId,
                attemptNumber: settled.attemptNumber,
                attemptIndex: settled.attemptIndex,
                idempotencyKey: settled.idempotencyKey,
                principalId: settled.principalId,
                actorId,
                completionDigest: settled.completionDigest,
                startedAt: settled.startedAt,
                settledAt: settled.settledAt,
                settlementDigest: settled.settlementDigest,
                committedOutboxEventDigests: settled.committedOutboxEventDigests
            }, "settled external turn recovery");
        }
        if (terminalFailureForQueue(this.#state, queue.queueId) !== undefined)
            return undefined;
        const at = nowIso(this.#now);
        const existingLease = this.#state.leases.get(queue.queueId);
        if (isLeaseActive(existingLease, at)) {
            const exact = existingLease.mode === "external"
                && existingLease.principalId === principalId
                && existingLease.external?.kind === kind
                && existingLease.external.actorId === actorId
                && existingLease.external.completionDigest === completionDigest
                && sameOrdered(existingLease.external.outboxEventDigests, outboxEventDigests);
            if (!exact)
                return undefined;
            return deepFrozenClone({
                disposition: "claimed",
                claim: claimSnapshot(this.#state, queue, existingLease.leaseToken)
            }, "recovered external claim");
        }
        const leaseToken = this.#newId("lease");
        if ([...this.#state.leases.values()].some((lease) => lease.leaseToken === leaseToken)) {
            throw new Error(`MemoryUnitStore idFactory produced duplicate lease token ${leaseToken}`);
        }
        const expiresAt = timestampFromEpoch(timestampEpoch(at) + node.turn.leaseMs);
        const draft = cloneState(this.#state);
        draft.leases.set(queue.queueId, deepFrozenClone({
            leaseOwner: `external:${principalId}:${actorId}`,
            leaseToken,
            acquiredAt: at,
            heartbeatAt: at,
            expiresAt,
            mode: "external",
            principalId,
            external: {
                kind,
                actorId,
                completionDigest,
                outboxEventDigests
            }
        }, `queue ${queue.queueId} external lease`));
        this.#state = draft;
        return deepFrozenClone({
            disposition: "claimed",
            claim: claimSnapshot(this.#state, queue, leaseToken)
        }, "new external claim");
    }
    async heartbeatTurn(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, ["queueId", "leaseToken", "extendByMs", "at"], ["queueId", "leaseToken", "extendByMs", "at"], "heartbeatTurn input");
        const queueId = assertEvidenceString(raw.queueId, "heartbeatTurn input.queueId");
        const queue = this.#state.queues.get(queueId);
        if (queue === undefined)
            throw new TurnLeaseLostError(queueId);
        const at = assertCanonicalTimestamp(raw.at, "heartbeatTurn input.at");
        const lease = this.#assertActiveLease(this.#state, queueId, raw.leaseToken, at);
        const extendByMs = assertSafePositiveInt(raw.extendByMs, "heartbeatTurn input.extendByMs");
        const node = nodeForQueue(this.#state, queue);
        if (lease.mode !== "worker" || lease.principalId !== node.principal.id) {
            throw new TurnLeaseLostError(queueId);
        }
        if (extendByMs > node.turn.leaseMs) {
            throw new Error(`heartbeatTurn input.extendByMs ${extendByMs} exceeds node ${node.nodeId} leaseMs ${node.turn.leaseMs}`);
        }
        if (timestampEpoch(at) < timestampEpoch(lease.heartbeatAt)) {
            throw new Error("heartbeatTurn input.at cannot precede the prior heartbeat");
        }
        const draft = cloneState(this.#state);
        draft.leases.set(queueId, deepFrozenClone({
            ...lease,
            heartbeatAt: at,
            expiresAt: timestampFromEpoch(timestampEpoch(at) + extendByMs)
        }, `queue ${queueId} heartbeated lease`));
        this.#state = draft;
    }
    #validatePreparationIdentity(inputRaw, requireLease = true) {
        const raw = captureCapabilityRecord(inputRaw, [
            "queueId", "unitId", "nodeId", "leaseToken", "nodeRef", "fingerprint",
            "inputDigest", "maxAttempts", "executionIdentityDigest"
        ], [
            "queueId", "unitId", "nodeId", "leaseToken", "nodeRef", "fingerprint",
            "inputDigest", "maxAttempts"
        ], "prepareTurnAttempt input");
        const queue = this.#requireExactQueue(raw.queueId, raw.unitId, raw.nodeId, "prepareTurnAttempt input");
        const node = nodeForQueue(this.#state, queue);
        const refRaw = captureCapabilityRecord(raw.nodeRef, ["id", "version"], ["id", "version"], "prepareTurnAttempt input.nodeRef");
        const refId = assertIdentifier(refRaw.id, "prepareTurnAttempt input.nodeRef.id");
        const refVersion = assertSafePositiveInt(refRaw.version, "prepareTurnAttempt input.nodeRef.version");
        if (refId !== node.ref.id || refVersion !== node.ref.version) {
            throw new TurnEvidenceConflictError(`prepareTurnAttempt node ref conflicts for queue ${queue.queueId}`);
        }
        const fingerprint = assertSha256Hex(raw.fingerprint, "prepareTurnAttempt input.fingerprint");
        if (fingerprint !== nodeExecutionFingerprint(node)) {
            throw new TurnEvidenceConflictError(`prepareTurnAttempt fingerprint conflicts for node ${node.nodeId}`);
        }
        const inputDigest = assertSha256Hex(raw.inputDigest, "prepareTurnAttempt input.inputDigest");
        if (inputDigest !== queue.inputArtifact.digest) {
            throw new TurnEvidenceConflictError(`prepareTurnAttempt input digest conflicts for queue ${queue.queueId}`);
        }
        const maxAttempts = assertSafePositiveInt(raw.maxAttempts, "prepareTurnAttempt input.maxAttempts");
        if (maxAttempts !== node.turn.maxAttempts) {
            throw new TurnEvidenceConflictError(`prepareTurnAttempt maxAttempts conflicts for node ${node.nodeId}`);
        }
        const executionIdentityDigest = raw.executionIdentityDigest === undefined
            ? undefined
            : assertSha256Hex(raw.executionIdentityDigest, "prepareTurnAttempt input.executionIdentityDigest");
        if (requireLease && terminalFailureForQueue(this.#state, queue.queueId) === undefined) {
            this.#assertActiveLease(this.#state, queue.queueId, raw.leaseToken, nowIso(this.#now));
        }
        return {
            raw,
            queue,
            node,
            fingerprint,
            inputDigest,
            ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
        };
    }
    async prepareTurnAttempt(inputRaw) {
        const validated = this.#validatePreparationIdentity(inputRaw);
        const { queue, node, fingerprint, inputDigest, executionIdentityDigest } = validated;
        const terminal = terminalFailureForQueue(this.#state, queue.queueId);
        if (terminal !== undefined) {
            return Object.freeze({
                disposition: "terminal",
                errorCode: terminal.errorCode,
                attempts: terminal.attemptIndex
            });
        }
        if (this.#state.settlements.has(queue.queueId)) {
            throw new TurnEvidenceConflictError(`queue ${queue.queueId} is already settled`);
        }
        const reservations = this.#state.reservations.get(queue.queueId) ?? [];
        const current = reservations.at(-1);
        if (current !== undefined) {
            if (current.executionIdentityDigest !== executionIdentityDigest) {
                throw new TurnEvidenceConflictError(`prepareTurnAttempt execution identity conflicts for queue ${queue.queueId}`);
            }
            const failure = this.#state.failures.get(attemptKey(queue.queueId, current.attemptNumber));
            if (failure === undefined) {
                const cached = this.#state.cachedCompletions.get(attemptKey(queue.queueId, current.attemptNumber));
                if (cached !== undefined) {
                    return deepFrozenClone({
                        disposition: "cached",
                        attemptNumber: current.attemptNumber,
                        attemptIndex: current.attemptIndex,
                        idempotencyKey: current.idempotencyKey,
                        completion: cached.completion,
                        completionDigest: cached.completionDigest,
                        startedAt: cached.startedAt,
                        settledAt: cached.settledAt
                    }, "cached turn preparation");
                }
                return Object.freeze({
                    disposition: "reserved",
                    attemptNumber: current.attemptNumber,
                    attemptIndex: current.attemptIndex,
                    idempotencyKey: current.idempotencyKey
                });
            }
            if (failure.terminal) {
                return Object.freeze({
                    disposition: "terminal",
                    errorCode: failure.errorCode,
                    attempts: failure.attemptIndex
                });
            }
        }
        const attemptIndex = current === undefined ? 1 : current.attemptIndex + 1;
        const globalAttemptNumber = [...this.#state.reservations.values()]
            .flat()
            .filter((reservation) => reservation.unitId === queue.unitId && reservation.nodeId === queue.nodeId)
            .reduce((maximum, reservation) => Math.max(maximum, reservation.attemptNumber), 0) + 1;
        const idempotencyKey = nodeTurnIdempotencyKey({
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            attemptNumber: globalAttemptNumber,
            nodeRef: node.ref,
            fingerprint,
            inputDigest,
            ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest })
        });
        const reservation = deepFrozenClone({
            queueId: queue.queueId,
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            nodeRef: node.ref,
            fingerprint,
            inputDigest,
            ...(executionIdentityDigest === undefined ? {} : { executionIdentityDigest }),
            attemptNumber: globalAttemptNumber,
            attemptIndex,
            idempotencyKey
        }, `queue ${queue.queueId} attempt reservation`);
        const draft = cloneState(this.#state);
        draft.reservations.set(queue.queueId, Object.freeze([...reservations, reservation]));
        this.#state = draft;
        return Object.freeze({
            disposition: "reserved",
            attemptNumber: globalAttemptNumber,
            attemptIndex,
            idempotencyKey
        });
    }
    #captureOutbox(outboxRaw, label) {
        const items = captureDenseArrayItems(outboxRaw ?? [], label, MAX_TURN_OUTBOX_EVENTS);
        const events = Object.freeze(items.map((eventRaw, index) => {
            const eventLabel = `${label}[${index}]`;
            const event = captureCapabilityRecord(eventRaw, ["eventType", "payload", "dedupeKey"], ["eventType", "payload"], eventLabel);
            const dedupeKey = event.dedupeKey === undefined
                ? undefined
                : assertEvidenceString(event.dedupeKey, `${eventLabel}.dedupeKey`);
            return deepFrozenClone({
                eventType: assertEvidenceString(event.eventType, `${eventLabel}.eventType`),
                payload: snapshotGraphValidationData(event.payload, `${eventLabel}.payload`),
                ...(dedupeKey === undefined ? {} : { dedupeKey })
            }, eventLabel);
        }));
        const batchDedupe = events
            .map((event) => event.dedupeKey)
            .filter((value) => value !== undefined);
        const duplicate = batchDedupe.find((value, index) => batchDedupe.indexOf(value) !== index);
        if (duplicate !== undefined) {
            throw new Error(`${label}: duplicate outbox dedupeKey ${duplicate} within one transaction`);
        }
        return Object.freeze({
            events,
            digests: Object.freeze(events.map(turnOutboxEventDigest))
        });
    }
    #assertOutboxDedupeAvailable(events, label) {
        for (const event of events) {
            if (event.dedupeKey !== undefined && this.#state.outboxDedupeKeys.has(event.dedupeKey)) {
                throw new Error(`${label}: outbox dedupeKey ${event.dedupeKey} already exists; rejecting the whole transaction`);
            }
        }
    }
    #requireReservation(state, queue, raw, label) {
        const attemptNumber = assertSafePositiveInt(raw.attemptNumber, `${label}.attemptNumber`);
        const attemptIndex = assertSafePositiveInt(raw.attemptIndex, `${label}.attemptIndex`);
        const idempotencyKey = assertSha256Hex(raw.idempotencyKey, `${label}.idempotencyKey`);
        const reservation = (state.reservations.get(queue.queueId) ?? []).find((candidate) => candidate.attemptNumber === attemptNumber);
        if (reservation === undefined
            || reservation.attemptIndex !== attemptIndex
            || reservation.idempotencyKey !== idempotencyKey) {
            throw new TurnEvidenceConflictError(`${label}: attempt identity conflicts for queue ${queue.queueId}`);
        }
        return reservation;
    }
    async cacheTurnCompletion(inputRaw) {
        const raw = captureCapabilityRecord(inputRaw, [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "completion", "completionDigest", "startedAt", "settledAt"
        ], [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "completion", "completionDigest", "startedAt", "settledAt"
        ], "cacheTurnCompletion input");
        const queue = this.#requireExactQueue(raw.queueId, raw.unitId, raw.nodeId, "cacheTurnCompletion input");
        const node = nodeForQueue(this.#state, queue);
        if (!WORKER_KINDS.has(node.kind)) {
            throw new Error(`cacheTurnCompletion: ${node.kind} node ${node.nodeId} has no worker body cache`);
        }
        const reservation = this.#requireReservation(this.#state, queue, raw, "cacheTurnCompletion input");
        const completion = validateNodeTurnCompletion(node, raw.completion, "cacheTurnCompletion input.completion");
        const completionDigest = assertSha256Hex(raw.completionDigest, "cacheTurnCompletion input.completionDigest");
        const computed = nodeTurnCompletionDigest(completion);
        if (completionDigest !== computed) {
            throw new TurnEvidenceConflictError(`cacheTurnCompletion: completion digest ${completionDigest} != computed ${computed}`);
        }
        const timestamps = assertTimestampOrder(raw.startedAt, raw.settledAt, "cacheTurnCompletion input.startedAt", "cacheTurnCompletion input.settledAt");
        const key = attemptKey(queue.queueId, reservation.attemptNumber);
        const existing = this.#state.cachedCompletions.get(key);
        if (existing !== undefined) {
            if (existing.completionDigest !== completionDigest
                || existing.startedAt !== timestamps.startedAt
                || existing.settledAt !== timestamps.endedAt) {
                throw new TurnEvidenceConflictError(`cacheTurnCompletion conflicts with cached evidence for queue ${queue.queueId} attempt ${reservation.attemptNumber}`);
            }
            return deepFrozenClone({
                created: false,
                completion: existing.completion,
                completionDigest: existing.completionDigest,
                startedAt: existing.startedAt,
                settledAt: existing.settledAt
            }, "cacheTurnCompletion replay");
        }
        if (this.#state.failures.has(key) || this.#state.settlements.has(queue.queueId)) {
            throw new TurnEvidenceConflictError(`cacheTurnCompletion contradicts concluded evidence for queue ${queue.queueId}`);
        }
        this.#assertActiveLease(this.#state, queue.queueId, raw.leaseToken, nowIso(this.#now));
        const cached = deepFrozenClone({
            queueId: queue.queueId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            completion,
            completionDigest,
            startedAt: timestamps.startedAt,
            settledAt: timestamps.endedAt
        }, `queue ${queue.queueId} cached completion`);
        const draft = cloneState(this.#state);
        draft.cachedCompletions.set(key, cached);
        this.#state = draft;
        return deepFrozenClone({
            created: true,
            completion,
            completionDigest,
            startedAt: timestamps.startedAt,
            settledAt: timestamps.endedAt
        }, "cacheTurnCompletion result");
    }
    #planRouting(input) {
        const graph = input.state.unitGraphs.get(input.unitId);
        if (graph === undefined) {
            throw new Error(`MemoryUnitStore invariant: unit ${input.unitId} has no graph`);
        }
        const compiled = compileGraph(graph);
        const graphRef = graphDefinitionRef(graph);
        const plannedJoins = new Map(input.state.joins);
        const plannedQueues = [];
        const plannedArtifacts = new Map();
        const synthetic = [];
        const rootEffects = [];
        let nextEnqueueSequence = input.state.nextEnqueueSequence;
        if (input.outputArtifact !== undefined) {
            plannedArtifacts.set(artifactKey(input.outputArtifact), input.outputArtifact);
        }
        const ensureJoin = (node) => {
            if (node.join === undefined) {
                throw new Error(`MemoryUnitStore invariant: node ${node.nodeId} is not a join`);
            }
            const key = joinKey(input.unitId, node.nodeId);
            const existing = plannedJoins.get(key);
            if (existing !== undefined)
                return existing;
            const created = deepFrozenClone({
                unitId: input.unitId,
                nodeId: node.nodeId,
                require: node.join.require,
                inbound: node.join.inbound.map((edgeId) => ({
                    edgeId,
                    state: "pending"
                })),
                status: "pending"
            }, `join ${input.unitId}/${node.nodeId} initial progress`);
            plannedJoins.set(key, created);
            return created;
        };
        // Initialize every declared join so liveness can resolve an untouched leg.
        for (const node of compiled.nodes) {
            if (node.join !== undefined)
                ensureJoin(node);
        }
        const artifactByRef = (ref) => plannedArtifacts.get(artifactKey(ref)) ?? input.state.artifacts.get(artifactKey(ref));
        const addQueue = (node, artifact, at, sourceEvidenceDigest, inboundEdgeIds, join) => {
            if (artifact.contractId !== node.input) {
                throw new Error(`routing target node ${node.nodeId} input contract mismatch: expected ${node.input}, got ${artifact.contractId}`);
            }
            const queueId = this.#newId("queue");
            if (input.state.queues.has(queueId)
                || plannedQueues.some((queue) => queue.queueId === queueId)) {
                throw new Error(`MemoryUnitStore idFactory produced duplicate queue id ${queueId}`);
            }
            const queue = deepFrozenClone({
                queueId,
                unitId: input.unitId,
                graph: graphRef,
                nodeId: node.nodeId,
                nodeRef: node.ref,
                inputArtifact: artifact,
                queuedAt: at,
                enqueueSequence: nextEnqueueSequence,
                sourceEvidenceDigest,
                inboundEdgeIds,
                ...(join === undefined ? {} : { join })
            }, `routed queue ${queueId}`);
            nextEnqueueSequence += 1;
            plannedQueues.push(queue);
            return queue;
        };
        const setJoinInbound = (progress, edgeId, replacement) => deepFrozenClone({
            ...progress,
            inbound: progress.inbound.map((state) => state.edgeId === edgeId ? replacement : state)
        }, `join ${progress.unitId}/${progress.nodeId} edge ${edgeId} progress`);
        const queueJoinIfSatisfied = (node, progress, effects, at, sourceEvidenceDigest) => {
            if (progress.status !== "pending" || node.join === undefined)
                return progress;
            const threshold = evaluateJoinThreshold(node.join.require, progress.inbound.map((edge) => ({ edgeId: edge.edgeId, state: edge.state })));
            if (!threshold.thresholdSatisfied)
                return progress;
            const accepted = progress.inbound
                .filter((edge) => edge.state === "offered")
                .map((edge) => edge.offer);
            const selected = accepted[0];
            if (selected === undefined) {
                throw new Error(`MemoryUnitStore invariant: satisfied join ${node.nodeId} has no offer`);
            }
            const selectedArtifact = artifactByRef(selected.artifact);
            if (selectedArtifact === undefined) {
                throw new Error(`MemoryUnitStore invariant: join ${node.nodeId} selected missing artifact ${selected.artifact.digest}`);
            }
            const provenance = deepFrozenClone({
                joinNodeId: node.nodeId,
                selectedEdgeId: selected.edgeId,
                accepted
            }, `join ${node.nodeId} queue provenance`);
            const queue = addQueue(node, selectedArtifact, at, sourceEvidenceDigest, accepted.map((offer) => offer.edgeId), provenance);
            effects.push(deepFrozenClone({
                kind: "join_queued",
                targetNodeId: node.nodeId,
                queueId: queue.queueId,
                enqueueSequence: queue.enqueueSequence,
                selectedEdgeId: selected.edgeId,
                acceptedEdgeIds: accepted.map((offer) => offer.edgeId)
            }, `join ${node.nodeId} queued routing effect`));
            return deepFrozenClone({
                ...progress,
                status: "queued",
                selectedEdgeId: selected.edgeId,
                queueId: queue.queueId
            }, `join ${node.nodeId} queued progress`);
        };
        const routeEvent = (event) => {
            const outbound = compiled.outboundByNode[event.sourceNodeId] ?? [];
            const matched = matchingOutcomeEdges(outbound, event.outcome, event.outputArtifact);
            const matchedIds = new Set(matched.map((edge) => edge.edgeId));
            // Ordinary targets dedupe all matching edge arms from this one event.
            const ordinaryTargets = new Map();
            for (const edge of matched) {
                for (const targetNodeId of edge.to) {
                    const target = compiled.nodesById[targetNodeId];
                    if (target.join !== undefined)
                        continue;
                    const edgeIds = ordinaryTargets.get(targetNodeId) ?? [];
                    edgeIds.push(edge.edgeId);
                    ordinaryTargets.set(targetNodeId, edgeIds);
                }
            }
            for (const [targetNodeId, edgeIds] of ordinaryTargets) {
                const target = compiled.nodesById[targetNodeId];
                const queue = addQueue(target, event.effectiveArtifact, event.at, event.evidenceDigest, edgeIds);
                event.effects.push(deepFrozenClone({
                    kind: "queue_enqueued",
                    targetNodeId,
                    queueId: queue.queueId,
                    enqueueSequence: queue.enqueueSequence,
                    edgeIds,
                    inputArtifact: artifactRef(event.effectiveArtifact)
                }, `queue ${queue.queueId} routing effect`));
            }
            // Join matches are applied in the sealed join.inbound order. Every
            // accepted artifact is validated even when nOf needs fewer offers.
            for (const target of compiled.nodes) {
                if (target.join === undefined)
                    continue;
                const relevant = target.join.inbound.filter((edgeId) => {
                    const edge = compiled.edgesById[edgeId];
                    return edge.from === event.sourceNodeId && matchedIds.has(edgeId);
                });
                if (relevant.length === 0)
                    continue;
                const key = joinKey(input.unitId, target.nodeId);
                let progress = ensureJoin(target);
                for (const edgeId of relevant) {
                    const artifact = artifactRef(event.effectiveArtifact);
                    if (progress.status !== "pending") {
                        event.effects.push(deepFrozenClone({
                            kind: "join_offer",
                            targetNodeId: target.nodeId,
                            edgeId,
                            disposition: "join_already_resolved_noop",
                            artifact
                        }, `join ${target.nodeId} late offer effect`));
                        continue;
                    }
                    const inbound = progress.inbound.find((state) => state.edgeId === edgeId);
                    if (inbound.state !== "pending") {
                        event.effects.push(deepFrozenClone({
                            kind: "join_offer",
                            targetNodeId: target.nodeId,
                            edgeId,
                            disposition: "edge_already_resolved_noop",
                            artifact
                        }, `join ${target.nodeId} duplicate offer effect`));
                        continue;
                    }
                    if (event.effectiveArtifact.contractId !== target.input) {
                        throw new Error(`routing join target node ${target.nodeId} input contract mismatch on edge ${edgeId}: expected ${target.input}, got ${event.effectiveArtifact.contractId}`);
                    }
                    const offer = deepFrozenClone({
                        edgeId,
                        sourceNodeId: event.sourceNodeId,
                        ...(event.sourceQueueId === undefined
                            ? {}
                            : { sourceQueueId: event.sourceQueueId }),
                        sourceEvidenceDigest: event.evidenceDigest,
                        artifact,
                        offeredAt: event.at
                    }, `join ${target.nodeId} accepted offer ${edgeId}`);
                    progress = setJoinInbound(progress, edgeId, {
                        edgeId,
                        state: "offered",
                        offer
                    });
                    event.effects.push(deepFrozenClone({
                        kind: "join_offer",
                        targetNodeId: target.nodeId,
                        edgeId,
                        disposition: "accepted",
                        artifact
                    }, `join ${target.nodeId} accepted effect ${edgeId}`));
                }
                progress = queueJoinIfSatisfied(target, progress, event.effects, event.at, event.evidenceDigest);
                plannedJoins.set(key, progress);
            }
        };
        routeEvent({
            sourceNodeId: input.sourceNodeId,
            ...(input.sourceQueueId === undefined ? {} : { sourceQueueId: input.sourceQueueId }),
            outcome: input.outcome,
            ...(input.outputArtifact === undefined ? {} : { outputArtifact: input.outputArtifact }),
            effectiveArtifact: input.effectiveArtifact,
            at: input.at,
            evidenceDigest: input.sourceEvidenceDigest,
            effects: rootEffects
        });
        const openNodeIds = () => [
            ...[...input.state.queues.values()]
                .filter((queue) => !input.closingQueueIds.has(queue.queueId))
                .filter((queue) => isQueueOpen(input.state, queue.queueId))
                .map((queue) => queue.nodeId),
            ...plannedQueues.map((queue) => queue.nodeId)
        ];
        const canReach = (targetNodeId) => {
            const pending = [...openNodeIds()];
            const visited = new Set();
            while (pending.length > 0) {
                const current = pending.shift();
                if (current === targetNodeId)
                    return true;
                if (visited.has(current))
                    continue;
                visited.add(current);
                for (const edge of compiled.outboundByNode[current] ?? []) {
                    for (const target of edge.to) {
                        const targetNode = compiled.nodesById[target];
                        if (targetNode.join !== undefined) {
                            const progress = plannedJoins.get(joinKey(input.unitId, target));
                            const inbound = progress?.inbound.find((state) => state.edgeId === edge.edgeId);
                            // A resolved join never fires again, and an already-resolved
                            // inbound edge cannot carry another occurrence through it.
                            if (progress?.status !== "pending" || inbound?.state !== "pending") {
                                continue;
                            }
                        }
                        if (!visited.has(target))
                            pending.push(target);
                    }
                }
            }
            return false;
        };
        // Resolve unreachable pending legs to a deterministic fixed point. A
        // synthetic outcome can itself offer downstream joins or enqueue work.
        let changed = true;
        while (changed) {
            changed = false;
            outer: for (const node of compiled.nodes) {
                if (node.join === undefined)
                    continue;
                const key = joinKey(input.unitId, node.nodeId);
                let progress = ensureJoin(node);
                if (progress.status !== "pending")
                    continue;
                for (const inbound of progress.inbound) {
                    if (inbound.state !== "pending")
                        continue;
                    const edge = compiled.edgesById[inbound.edgeId];
                    if (canReach(edge.from))
                        continue;
                    const impossible = deepFrozenClone({
                        edgeId: inbound.edgeId,
                        sourceNodeId: edge.from,
                        causeEvidenceDigest: input.sourceEvidenceDigest,
                        resolvedAt: input.at,
                        reason: "source_unreachable"
                    }, `join ${node.nodeId} impossible edge ${inbound.edgeId}`);
                    progress = setJoinInbound(progress, inbound.edgeId, {
                        edgeId: inbound.edgeId,
                        state: "impossible",
                        impossible
                    });
                    rootEffects.push(deepFrozenClone({
                        kind: "join_impossible",
                        targetNodeId: node.nodeId,
                        edgeId: inbound.edgeId,
                        disposition: "resolved"
                    }, `join ${node.nodeId} impossible routing effect`));
                    const threshold = evaluateJoinThreshold(node.join.require, progress.inbound.map((state) => ({ edgeId: state.edgeId, state: state.state })));
                    if (threshold.unsatisfiable) {
                        const accepted = progress.inbound
                            .filter((state) => state.state === "offered")
                            .map((state) => state.offer);
                        const impossibleEdges = progress.inbound
                            .filter((state) => state.state === "impossible")
                            .map((state) => state.impossible);
                        const payload = deepFrozenClone({
                            schemaVersion: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
                            unitId: input.unitId,
                            graph: graphRef,
                            nodeId: node.nodeId,
                            require: node.join.require,
                            accepted,
                            impossible: impossibleEdges,
                            causeEvidenceDigest: input.sourceEvidenceDigest,
                            resolvedAt: input.at
                        }, `join ${node.nodeId} unsatisfiable artifact payload`);
                        const syntheticArtifact = validateArtifactEnvelope({
                            contractId: JOIN_UNSATISFIABLE_ARTIFACT_CONTRACT,
                            digest: digest(payload),
                            payload
                        });
                        plannedArtifacts.set(artifactKey(syntheticArtifact), syntheticArtifact);
                        const syntheticOutcomeDigest = digest({
                            unitId: input.unitId,
                            graphDigest: graph.graphDigest,
                            nodeId: node.nodeId,
                            outcome: "join_unsatisfiable",
                            accepted: accepted.map((offer) => offer.edgeId),
                            impossible: impossibleEdges.map((entry) => entry.edgeId),
                            causeEvidenceDigest: input.sourceEvidenceDigest,
                            resolvedAt: input.at,
                            artifactDigest: syntheticArtifact.digest
                        });
                        progress = deepFrozenClone({
                            ...progress,
                            status: "unsatisfiable",
                            syntheticOutcomeDigest
                        }, `join ${node.nodeId} unsatisfiable progress`);
                        const syntheticDraft = {
                            nodeId: node.nodeId,
                            at: input.at,
                            causeEvidenceDigest: input.sourceEvidenceDigest,
                            artifact: syntheticArtifact,
                            syntheticOutcomeDigest,
                            routing: []
                        };
                        synthetic.push(syntheticDraft);
                        rootEffects.push(deepFrozenClone({
                            kind: "join_unsatisfiable",
                            targetNodeId: node.nodeId,
                            syntheticOutcomeDigest,
                            artifact: artifactRef(syntheticArtifact)
                        }, `join ${node.nodeId} unsatisfiable routing effect`));
                        plannedJoins.set(key, progress);
                        routeEvent({
                            sourceNodeId: node.nodeId,
                            outcome: "join_unsatisfiable",
                            outputArtifact: syntheticArtifact,
                            effectiveArtifact: syntheticArtifact,
                            at: input.at,
                            evidenceDigest: syntheticOutcomeDigest,
                            effects: syntheticDraft.routing
                        });
                    }
                    else {
                        plannedJoins.set(key, progress);
                    }
                    changed = true;
                    break outer;
                }
            }
        }
        return {
            effects: deepFrozenClone(rootEffects, "routing effects"),
            joins: plannedJoins,
            queues: deepFrozenClone(plannedQueues, "planned routed queues"),
            artifacts: deepFrozenClone([...plannedArtifacts.values()], "planned routing artifacts"),
            synthetic: deepFrozenClone(synthetic, "planned synthetic journey"),
            nextEnqueueSequence
        };
    }
    #appendOutboxRows(draft, input) {
        const appended = [];
        for (const [index, event] of input.events.entries()) {
            const outboxEventId = this.#newId("outbox");
            if ([...draft.outbox, ...appended].some((row) => row.outboxEventId === outboxEventId)) {
                throw new Error(`MemoryUnitStore idFactory produced duplicate outbox id ${outboxEventId}`);
            }
            appended.push(deepFrozenClone({
                outboxEventId,
                unitId: input.unitId,
                ...(input.queueId === undefined ? {} : { queueId: input.queueId }),
                nodeId: input.nodeId,
                ...(input.attemptNumber === undefined
                    ? {}
                    : { attemptNumber: input.attemptNumber }),
                ...(input.attemptIndex === undefined ? {} : { attemptIndex: input.attemptIndex }),
                eventType: event.eventType,
                payload: event.payload,
                ...(event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey }),
                eventDigest: input.digests[index],
                recordedAt: input.recordedAt
            }, `outbox event ${outboxEventId}`));
            if (event.dedupeKey !== undefined)
                draft.outboxDedupeKeys.add(event.dedupeKey);
        }
        draft.outbox = Object.freeze([
            ...draft.outbox,
            ...appended
        ]);
    }
    #appendJourney(draft, unitId, rows) {
        draft.journey.set(unitId, Object.freeze([
            ...(draft.journey.get(unitId) ?? []),
            ...rows
        ]));
    }
    #syntheticJourneyRecords(unitId, graph, drafts, firstSequence) {
        return Object.freeze(drafts.map((entry, index) => sealRecord({
            kind: "join_unsatisfiable",
            sequence: firstSequence + index,
            unitId,
            graph: graphDefinitionRef(graph),
            recordedAt: entry.at,
            nodeId: entry.nodeId,
            outcome: "join_unsatisfiable",
            principalId: MISSION_PIPELINE_ENGINE_PRINCIPAL_ID,
            startedAt: entry.at,
            settledAt: entry.at,
            causeEvidenceDigest: entry.causeEvidenceDigest,
            artifact: artifactRef(entry.artifact),
            syntheticOutcomeDigest: entry.syntheticOutcomeDigest,
            routing: entry.routing
        }, `join ${unitId}/${entry.nodeId} unsatisfiable journey`)));
    }
    async recordTurnFailure(inputRaw, outboxRaw) {
        const raw = captureCapabilityRecord(inputRaw, [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "startedAt", "failedAt", "errorCode", "errorMessage",
            "principalId", "retryable", "terminal", "usage", "failureDigest"
        ], [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "startedAt", "failedAt", "errorCode", "errorMessage",
            "principalId", "retryable", "terminal", "usage", "failureDigest"
        ], "recordTurnFailure input");
        const queue = this.#requireExactQueue(raw.queueId, raw.unitId, raw.nodeId, "recordTurnFailure input");
        const node = nodeForQueue(this.#state, queue);
        if (!WORKER_KINDS.has(node.kind)) {
            throw new Error(`recordTurnFailure: ${node.kind} node ${node.nodeId} cannot record a worker failure`);
        }
        const principalId = assertIdentifier(raw.principalId, "recordTurnFailure input.principalId");
        if (principalId !== node.principal.id) {
            throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
        }
        const reservation = this.#requireReservation(this.#state, queue, raw, "recordTurnFailure input");
        const timestamps = assertTimestampOrder(raw.startedAt, raw.failedAt, "recordTurnFailure input.startedAt", "recordTurnFailure input.failedAt");
        const errorCode = assertIdentifier(raw.errorCode, "recordTurnFailure input.errorCode");
        const errorMessage = validateNodeTurnFailureMessage(raw.errorMessage, "recordTurnFailure input.errorMessage");
        const retryable = assertBoolean(raw.retryable, "recordTurnFailure input.retryable");
        const terminal = assertBoolean(raw.terminal, "recordTurnFailure input.terminal");
        const expectedTerminal = !retryable || reservation.attemptIndex >= node.turn.maxAttempts;
        if (terminal !== expectedTerminal) {
            throw new TurnEvidenceConflictError(`recordTurnFailure terminal=${terminal} conflicts with retry/max-attempt disposition ${expectedTerminal}`);
        }
        const usageRaw = captureDenseArrayItems(raw.usage, "recordTurnFailure input.usage", MAX_AGENT_TURN_USAGE_RECEIPTS);
        const usage = Object.freeze(usageRaw.map((receipt) => validateUsageReceipt(receipt)));
        if (node.kind === "code") {
            if (usage.length > 0) {
                throw new Error(`recordTurnFailure: ${node.kind} node ${node.nodeId} cannot record usage`);
            }
        }
        const leaseToken = assertEvidenceString(raw.leaseToken, "recordTurnFailure input.leaseToken");
        const normalizedBase = deepFrozenClone({
            queueId: queue.queueId,
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            principalId,
            startedAt: timestamps.startedAt,
            failedAt: timestamps.endedAt,
            errorCode,
            errorMessage,
            retryable,
            terminal,
            usage
        }, "recordTurnFailure normalized evidence");
        const failureDigest = assertSha256Hex(raw.failureDigest, "recordTurnFailure input.failureDigest");
        const computed = nodeTurnFailureDigest(normalizedBase);
        if (failureDigest !== computed) {
            throw new TurnEvidenceConflictError(`recordTurnFailure digest ${failureDigest} != computed ${computed}`);
        }
        const outbox = this.#captureOutbox(outboxRaw, "recordTurnFailure outboxEvents");
        const key = attemptKey(queue.queueId, reservation.attemptNumber);
        const existing = this.#state.failures.get(key);
        if (existing !== undefined) {
            if (existing.failureDigest !== failureDigest
                || !sameOrdered(existing.committedOutboxEventDigests, outbox.digests)) {
                throw new TurnEvidenceConflictError(`recordTurnFailure conflicts with retained attempt ${reservation.attemptNumber} for queue ${queue.queueId}`);
            }
            return Object.freeze({
                created: false,
                failureDigest,
                committedOutboxEventDigests: existing.committedOutboxEventDigests
            });
        }
        if (this.#state.cachedCompletions.has(key)
            || this.#state.settlements.has(queue.queueId)) {
            throw new TurnEvidenceConflictError(`recordTurnFailure contradicts completion evidence for queue ${queue.queueId}`);
        }
        const lease = this.#assertActiveLease(this.#state, queue.queueId, leaseToken, nowIso(this.#now));
        if (lease.mode !== "worker" || lease.principalId !== principalId) {
            throw new TurnAuthorityError(node.nodeId, node.principal.id, lease.principalId);
        }
        this.#assertOutboxDedupeAvailable(outbox.events, "recordTurnFailure outboxEvents");
        const graph = graphForQueue(this.#state, queue);
        const existingJourney = this.#state.journey.get(queue.unitId) ?? [];
        const routing = terminal
            ? this.#planRouting({
                state: this.#state,
                unitId: queue.unitId,
                sourceNodeId: queue.nodeId,
                sourceQueueId: queue.queueId,
                outcome: "engine_terminal_failure",
                effectiveArtifact: queue.inputArtifact,
                at: timestamps.endedAt,
                sourceEvidenceDigest: failureDigest,
                closingQueueIds: new Set([queue.queueId])
            })
            : {
                effects: Object.freeze([]),
                joins: this.#state.joins,
                queues: Object.freeze([]),
                artifacts: Object.freeze([]),
                synthetic: Object.freeze([]),
                nextEnqueueSequence: this.#state.nextEnqueueSequence
            };
        const failureJourney = sealRecord({
            kind: "turn_failed",
            sequence: existingJourney.length + 1,
            unitId: queue.unitId,
            graph: queue.graph,
            recordedAt: timestamps.endedAt,
            queueId: queue.queueId,
            nodeId: queue.nodeId,
            nodeRef: node.ref,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            inputArtifact: artifactRef(queue.inputArtifact),
            principalId,
            startedAt: timestamps.startedAt,
            failedAt: timestamps.endedAt,
            errorCode,
            errorMessage,
            retryable,
            terminal,
            usage,
            failureDigest,
            routing: routing.effects
        }, `queue ${queue.queueId} failed journey`);
        const syntheticJourney = this.#syntheticJourneyRecords(queue.unitId, graph, routing.synthetic, existingJourney.length + 2);
        const failure = deepFrozenClone({
            ...normalizedBase,
            failureDigest,
            committedOutboxEventDigests: outbox.digests
        }, `queue ${queue.queueId} failed attempt`);
        const draft = cloneState(this.#state);
        draft.failures.set(key, failure);
        this.#appendJourney(draft, queue.unitId, [failureJourney, ...syntheticJourney]);
        for (const artifact of routing.artifacts) {
            if (!draft.artifacts.has(artifactKey(artifact))) {
                draft.artifacts.set(artifactKey(artifact), artifact);
            }
        }
        for (const [progressKey, progress] of routing.joins) {
            draft.joins.set(progressKey, progress);
        }
        for (const plannedQueue of routing.queues) {
            draft.queues.set(plannedQueue.queueId, plannedQueue);
        }
        draft.nextEnqueueSequence =
            routing.nextEnqueueSequence;
        this.#appendOutboxRows(draft, {
            unitId: queue.unitId,
            queueId: queue.queueId,
            nodeId: queue.nodeId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            recordedAt: timestamps.endedAt,
            events: outbox.events,
            digests: outbox.digests
        });
        if (terminal) {
            const deadLetterId = this.#newId("dead-letter");
            if (draft.deadLetters.some((row) => row.deadLetterId === deadLetterId)) {
                throw new Error(`MemoryUnitStore idFactory produced duplicate dead-letter id ${deadLetterId}`);
            }
            const deadLetter = deepFrozenClone({
                deadLetterId,
                unitId: queue.unitId,
                queueId: queue.queueId,
                nodeId: queue.nodeId,
                attemptNumber: reservation.attemptNumber,
                attemptIndex: reservation.attemptIndex,
                errorCode,
                failureDigest,
                principalId,
                recordedAt: timestamps.endedAt
            }, `dead letter ${deadLetterId}`);
            draft.deadLetters =
                Object.freeze([...draft.deadLetters, deadLetter]);
            draft.leases.delete(queue.queueId);
        }
        this.#state = draft;
        return Object.freeze({ created: true, failureDigest });
    }
    async settleTurn(inputRaw, outboxRaw) {
        const raw = captureCapabilityRecord(inputRaw, [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "principalId", "actorId", "startedAt", "settledAt",
            "completion", "completionDigest", "settlementDigest"
        ], [
            "queueId", "unitId", "nodeId", "leaseToken", "attemptNumber", "attemptIndex",
            "idempotencyKey", "principalId", "startedAt", "settledAt", "completion",
            "completionDigest", "settlementDigest"
        ], "settleTurn input");
        const queue = this.#requireExactQueue(raw.queueId, raw.unitId, raw.nodeId, "settleTurn input");
        const node = nodeForQueue(this.#state, queue);
        const reservation = this.#requireReservation(this.#state, queue, raw, "settleTurn input");
        const principalId = assertIdentifier(raw.principalId, "settleTurn input.principalId");
        const actorId = Object.hasOwn(raw, "actorId")
            ? assertEvidenceString(raw.actorId, "settleTurn input.actorId")
            : undefined;
        const timestamps = assertTimestampOrder(raw.startedAt, raw.settledAt, "settleTurn input.startedAt", "settleTurn input.settledAt");
        const completion = validateNodeTurnCompletion(node, raw.completion, "settleTurn input.completion");
        const completionDigest = assertSha256Hex(raw.completionDigest, "settleTurn input.completionDigest");
        const computedCompletion = nodeTurnCompletionDigest(completion);
        if (completionDigest !== computedCompletion) {
            throw new TurnEvidenceConflictError(`settleTurn completion digest ${completionDigest} != computed ${computedCompletion}`);
        }
        const settlementBase = deepFrozenClone({
            queueId: queue.queueId,
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            principalId,
            ...(actorId === undefined ? {} : { actorId }),
            startedAt: timestamps.startedAt,
            settledAt: timestamps.endedAt,
            completionDigest
        }, "settleTurn settlement seal input");
        const settlementDigest = assertSha256Hex(raw.settlementDigest, "settleTurn input.settlementDigest");
        const computedSettlement = nodeTurnSettlementDigest(settlementBase);
        if (settlementDigest !== computedSettlement) {
            throw new TurnEvidenceConflictError(`settleTurn settlement digest ${settlementDigest} != computed ${computedSettlement}`);
        }
        const outbox = this.#captureOutbox(outboxRaw, "settleTurn outboxEvents");
        const existing = this.#state.settlements.get(queue.queueId);
        if (existing !== undefined) {
            if (existing.completionDigest !== completionDigest
                || existing.settlementDigest !== settlementDigest
                || !sameOrdered(existing.committedOutboxEventDigests, outbox.digests)) {
                throw new TurnEvidenceConflictError(`settleTurn conflicts with retained settlement for queue ${queue.queueId}`);
            }
            return Object.freeze({
                created: false,
                completionDigest,
                settlementDigest,
                committedOutboxEventDigests: existing.committedOutboxEventDigests
            });
        }
        const attemptIdentity = attemptKey(queue.queueId, reservation.attemptNumber);
        if (this.#state.failures.has(attemptIdentity)) {
            throw new TurnEvidenceConflictError(`settleTurn contradicts failed attempt ${reservation.attemptNumber} for queue ${queue.queueId}`);
        }
        if (node.principal.id !== principalId) {
            throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
        }
        const leaseToken = assertEvidenceString(raw.leaseToken, "settleTurn input.leaseToken");
        const lease = this.#assertActiveLease(this.#state, queue.queueId, leaseToken, nowIso(this.#now));
        if (WORKER_KINDS.has(node.kind)) {
            if (lease.mode !== "worker" || actorId !== undefined) {
                throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
            }
            const cached = this.#state.cachedCompletions.get(attemptIdentity);
            if (cached === undefined
                || cached.completionDigest !== completionDigest
                || cached.startedAt !== timestamps.startedAt
                || cached.settledAt !== timestamps.endedAt) {
                throw new TurnEvidenceConflictError(`settleTurn requires the exact cached worker completion for queue ${queue.queueId}`);
            }
        }
        else {
            if (actorId === undefined || lease.mode !== "external" || lease.external === undefined) {
                throw new TurnAuthorityError(node.nodeId, node.principal.id, principalId);
            }
            if (lease.external.kind !== node.kind
                || lease.external.actorId !== actorId
                || lease.external.completionDigest !== completionDigest
                || !sameOrdered(lease.external.outboxEventDigests, outbox.digests)) {
                throw new TurnEvidenceConflictError(`settleTurn external request conflicts with claimed evidence for queue ${queue.queueId}`);
            }
        }
        this.#assertOutboxDedupeAvailable(outbox.events, "settleTurn outboxEvents");
        const outputArtifact = completion.outputArtifact;
        const effectiveArtifact = outputArtifact ?? queue.inputArtifact;
        const graph = graphForQueue(this.#state, queue);
        const routing = this.#planRouting({
            state: this.#state,
            unitId: queue.unitId,
            sourceNodeId: queue.nodeId,
            sourceQueueId: queue.queueId,
            outcome: completion.outcome,
            ...(outputArtifact === undefined ? {} : { outputArtifact }),
            effectiveArtifact,
            at: timestamps.endedAt,
            sourceEvidenceDigest: settlementDigest,
            closingQueueIds: new Set([queue.queueId])
        });
        const existingJourney = this.#state.journey.get(queue.unitId) ?? [];
        const turnJourney = sealRecord({
            kind: "turn_settled",
            sequence: existingJourney.length + 1,
            unitId: queue.unitId,
            graph: queue.graph,
            recordedAt: timestamps.endedAt,
            queueId: queue.queueId,
            nodeId: queue.nodeId,
            nodeRef: node.ref,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            inputArtifact: artifactRef(queue.inputArtifact),
            outcome: completion.outcome,
            ...(outputArtifact === undefined ? {} : { outputArtifact: artifactRef(outputArtifact) }),
            usage: completion.usage ?? Object.freeze([]),
            principalId,
            ...(actorId === undefined ? {} : { actorId }),
            startedAt: timestamps.startedAt,
            settledAt: timestamps.endedAt,
            completionDigest,
            settlementDigest,
            routing: routing.effects
        }, `queue ${queue.queueId} settled journey`);
        const syntheticJourney = this.#syntheticJourneyRecords(queue.unitId, graph, routing.synthetic, existingJourney.length + 2);
        const settlement = deepFrozenClone({
            queueId: queue.queueId,
            unitId: queue.unitId,
            nodeId: queue.nodeId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            idempotencyKey: reservation.idempotencyKey,
            principalId,
            ...(actorId === undefined ? {} : { actorId }),
            startedAt: timestamps.startedAt,
            settledAt: timestamps.endedAt,
            completion,
            completionDigest,
            settlementDigest,
            committedOutboxEventDigests: outbox.digests
        }, `queue ${queue.queueId} settlement`);
        // Copy-on-write transaction. The failpoint observes every stable logical
        // boundary while the live state remains unchanged until the final swap.
        const draft = cloneState(this.#state);
        draft.settlements.set(queue.queueId, settlement);
        this.#appendJourney(draft, queue.unitId, [turnJourney, ...syntheticJourney]);
        this.#checkpoint("journey_append");
        for (const artifact of routing.artifacts) {
            if (!draft.artifacts.has(artifactKey(artifact))) {
                draft.artifacts.set(artifactKey(artifact), artifact);
            }
        }
        this.#checkpoint("artifact_retain");
        // Edge evaluation was completed against the sealed graph before any live
        // write; this checkpoint pins that logical transaction boundary.
        this.#checkpoint("edge_evaluation");
        for (const [progressKey, progress] of routing.joins) {
            draft.joins.set(progressKey, progress);
        }
        this.#checkpoint("join_progress");
        for (const plannedQueue of routing.queues) {
            draft.queues.set(plannedQueue.queueId, plannedQueue);
        }
        draft.nextEnqueueSequence =
            routing.nextEnqueueSequence;
        this.#checkpoint("successor_enqueue");
        this.#appendOutboxRows(draft, {
            unitId: queue.unitId,
            queueId: queue.queueId,
            nodeId: queue.nodeId,
            attemptNumber: reservation.attemptNumber,
            attemptIndex: reservation.attemptIndex,
            recordedAt: timestamps.endedAt,
            events: outbox.events,
            digests: outbox.digests
        });
        this.#checkpoint("outbox_append");
        draft.leases.delete(queue.queueId);
        this.#checkpoint("lease_release");
        this.#state = draft;
        this.#checkpoint("post_commit_reply");
        return Object.freeze({ created: true, completionDigest, settlementDigest });
    }
    #captureEvidenceListInput(inputRaw, label) {
        const raw = captureCapabilityRecord(inputRaw ?? {}, ["unitId", "limit"], [], label);
        const unitId = raw.unitId === undefined
            ? undefined
            : assertEvidenceString(raw.unitId, `${label}.unitId`);
        const limit = raw.limit === undefined
            ? MAX_UNIT_STORE_LIST_LIMIT
            : assertSafePositiveInt(raw.limit, `${label}.limit`);
        if (limit > MAX_UNIT_STORE_LIST_LIMIT) {
            throw new Error(`${label}.limit must be 1..${MAX_UNIT_STORE_LIST_LIMIT}`);
        }
        return { ...(unitId === undefined ? {} : { unitId }), limit };
    }
    async listOutboxEvents(inputRaw) {
        const input = this.#captureEvidenceListInput(inputRaw, "listOutboxEvents input");
        return deepFrozenClone(this.#state.outbox
            .filter((row) => input.unitId === undefined || row.unitId === input.unitId)
            .slice(0, input.limit), "listOutboxEvents result");
    }
    async listDeadLetters(inputRaw) {
        const input = this.#captureEvidenceListInput(inputRaw, "listDeadLetters input");
        return deepFrozenClone(this.#state.deadLetters
            .filter((row) => input.unitId === undefined || row.unitId === input.unitId)
            .slice(0, input.limit), "listDeadLetters result");
    }
    /** Privileged normalized observer used only by the shipped conformance driver. */
    evidenceSnapshot() {
        return deepFrozenClone({
            units: [...this.#state.units.values()],
            artifacts: [...this.#state.artifacts.values()],
            queues: [...this.#state.queues.values()],
            journey: [...this.#state.journey.values()].flat(),
            joins: [...this.#state.joins.values()],
            attempts: [...this.#state.reservations.values()].flat(),
            cachedCompletions: [...this.#state.cachedCompletions.values()],
            failures: [...this.#state.failures.values()],
            settlements: [...this.#state.settlements.values()],
            outbox: this.#state.outbox,
            deadLetters: this.#state.deadLetters,
            leases: [...this.#state.leases].map(([queueId, lease]) => ({ queueId, lease }))
        }, "MemoryUnitStore evidence snapshot");
    }
}

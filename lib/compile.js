// compile.ts — compilePipeline(definition, catalog): the static, fail-closed
// pipeline compiler emitting a digest-sealed CompiledPipeline.
//
// PROMOTED from inbox-pipeline/src/runtime/pipeline-compiler.ts (Kahn
// topological order with original-index tie-break; the promoted rejection
// messages: "Unknown registered stage", "references unknown node", "cannot
// depend on itself", "dependency cycle", "input slots do not match",
// "slot … expects …, received …", "Pipeline output references unknown node";
// the compiled-node `bindingFingerprint` attribution; deterministic sealed
// output) with the binding checks promoted from stage-registry.ts
// `validateBinding` ("requires a model binding" / "does not accept …").
// NEW in the promotion:
//   - descriptor-without-executable is a COMPILE-TIME failure (the parity fix
//     — the inbox discovered the split at run time);
//   - gate terminality (promoted from the inbox worker/service.ts run-time
//     admission check into the compiler): a gate node must be a pipeline
//     output and must have NO downstream edges — a human terminal must not
//     flow through an action-authorizing node;
//   - the definition's inputContract must be known to the catalog's
//     ContractValidator port;
//   - compiled nodes carry kind + deliverySemantics + configurationFingerprint
//     from the descriptor (the executor's B3 idempotency/retry inputs).
//
// STANDALONE: relative imports only (no npm deps, no zod).
import { digest } from "./contracts/digest.js";
import { validateContractId } from "./contracts/artifact.js";
import { validatePipelineDefinition, validatePipelineNodeInputSource } from "./definition.js";
import { DELIVERY_SEMANTICS, MAX_STAGE_CAPABILITIES, MAX_STAGE_INPUTS, STAGE_KINDS, stageIdentity } from "./node.js";
import { assertEnum, assertIdentifier, assertPlainObject, assertPositiveInt, assertSha256Hex, assertStrictKeys, typeName, truncate } from "./internal/guards.js";
export const COMPILED_PIPELINE_SCHEMA_VERSION = "compiled-pipeline.v2";
export const PIPELINE_COMPILER_VERSION = "mission-pipeline-compiler.v1";
/** Promoted Kahn topological sort: LOUD on unknown deps, self-deps, and cycles. */
function topologicalOrder(nodes) {
    const nodeIds = new Set(nodes.map(({ node }) => node.nodeId));
    const remaining = new Map(nodes.map((resolved) => [
        resolved.node.nodeId,
        new Set(resolved.node.inputs.flatMap((input) => (input.source.kind === "node_output" ? [input.source.nodeId] : [])))
    ]));
    for (const [nodeId, dependencies] of remaining) {
        for (const dependency of dependencies) {
            if (!nodeIds.has(dependency))
                throw new Error(`Pipeline node ${nodeId} references unknown node ${dependency}`);
            if (dependency === nodeId)
                throw new Error(`Pipeline node ${nodeId} cannot depend on itself`);
        }
    }
    const byId = new Map(nodes.map((resolved) => [resolved.node.nodeId, resolved]));
    const ordered = [];
    while (remaining.size > 0) {
        const ready = [...remaining.entries()]
            .filter(([, dependencies]) => dependencies.size === 0)
            .map(([nodeId]) => byId.get(nodeId))
            .sort((left, right) => left.originalIndex - right.originalIndex);
        if (ready.length === 0)
            throw new Error("Pipeline definition contains a dependency cycle");
        for (const resolved of ready) {
            ordered.push(resolved);
            remaining.delete(resolved.node.nodeId);
            for (const dependencies of remaining.values())
                dependencies.delete(resolved.node.nodeId);
        }
    }
    return ordered;
}
/** The promoted validateBinding rules, applied to the node's binding REF. */
function validateNodeBinding(node, descriptor) {
    const identity = stageIdentity(descriptor.stageId, descriptor.version);
    if (descriptor.bindingKind === "model" && node.binding === undefined) {
        throw new Error(`Stage ${identity} requires a model binding (pipeline node ${node.nodeId} has none)`);
    }
    if (descriptor.bindingKind === "decision" && node.binding === undefined) {
        throw new Error(`Stage ${identity} requires a decision binding (pipeline node ${node.nodeId} has none)`);
    }
    if (descriptor.bindingKind === "none" && node.binding !== undefined) {
        throw new Error(`Stage ${identity} does not accept a binding (pipeline node ${node.nodeId} carries one)`);
    }
    if (node.binding !== undefined && node.binding.kind !== descriptor.bindingKind) {
        throw new Error(`Pipeline node ${node.nodeId} binding kind "${node.binding.kind}" does not match stage ${identity} binding kind "${descriptor.bindingKind}"`);
    }
}
/**
 * Compile a digest-sealed definition against a catalog into a digest-sealed
 * {@link CompiledPipeline}. Fails LOUD (in this order) on: invalid/tampered
 * definition; pipeline inputContract unknown to the ContractValidator; unknown
 * stages; descriptor-without-executable (NEW, compile-time parity); binding
 * kind violations; slot-set mismatches; per-slot contract mismatches; unknown
 * source nodes; unknown output nodes; gate nodes that are not terminal
 * pipeline outputs; and dependency cycles.
 */
export function compilePipeline(definitionRaw, catalog) {
    const definition = validatePipelineDefinition(definitionRaw);
    if (!catalog.contracts.knows(definition.inputContract)) {
        throw new Error(`Pipeline input contract ${definition.inputContract} is not known to the catalog ContractValidator`);
    }
    const resolved = definition.nodes.map((node, originalIndex) => ({
        node,
        descriptor: catalog.resolveDescriptor(node.stage.id, node.stage.version),
        originalIndex
    }));
    const byId = new Map(resolved.map((item) => [item.node.nodeId, item]));
    for (const { node, descriptor } of resolved) {
        // NEW compile-time parity check (the parity fix): every referenced
        // descriptor must have a resolvable executable.
        if (!catalog.hasExecutable(descriptor.stageId, descriptor.version)) {
            throw new Error(`Stage ${stageIdentity(descriptor.stageId, descriptor.version)} has a descriptor but no registered executable (descriptor-executable parity; referenced by pipeline node ${node.nodeId})`);
        }
        validateNodeBinding(node, descriptor);
        const expectedSlots = new Map(descriptor.inputs.map((input) => [input.slot, input.contract]));
        if (node.inputs.length !== expectedSlots.size || node.inputs.some((input) => !expectedSlots.has(input.slot))) {
            throw new Error(`Pipeline node ${node.nodeId} input slots do not match stage ${stageIdentity(descriptor.stageId, descriptor.version)}`);
        }
        for (const input of node.inputs) {
            const expectedContract = expectedSlots.get(input.slot);
            const actualContract = input.source.kind === "pipeline_input"
                ? definition.inputContract
                : byId.get(input.source.nodeId)?.descriptor.outputContract;
            if (actualContract === undefined) {
                throw new Error(`Pipeline node ${node.nodeId} references unknown node ${input.source.nodeId}`);
            }
            if (actualContract !== expectedContract) {
                throw new Error(`Pipeline node ${node.nodeId} slot ${input.slot} expects ${expectedContract}, received ${actualContract}`);
            }
        }
    }
    for (const output of definition.outputs) {
        if (!byId.has(output))
            throw new Error(`Pipeline output references unknown node ${output}`);
    }
    // Gate terminality (promoted from the inbox worker admission check, now
    // compile-time): a human terminal must not flow through downstream nodes.
    for (const { node, descriptor } of resolved) {
        if (descriptor.kind !== "gate")
            continue;
        const hasDownstream = definition.nodes.some((candidate) => candidate.inputs.some((candidateInput) => candidateInput.source.kind === "node_output" && candidateInput.source.nodeId === node.nodeId));
        if (hasDownstream) {
            throw new Error(`Gate node ${node.nodeId} has downstream edges — a gate is a pipeline output (a human terminal must not flow through downstream nodes)`);
        }
        if (!definition.outputs.includes(node.nodeId)) {
            throw new Error(`Gate node ${node.nodeId} must be a pipeline output — gate nodes terminate the pipeline`);
        }
    }
    const ordered = topologicalOrder(resolved);
    const nodes = ordered.map(({ node, descriptor }) => {
        const compiled = {
            nodeId: node.nodeId,
            stage: node.stage,
            inputs: node.inputs.map((input) => ({
                slot: input.slot,
                source: input.source,
                contract: input.source.kind === "pipeline_input"
                    ? definition.inputContract
                    : byId.get(input.source.nodeId).descriptor.outputContract
            })),
            kind: descriptor.kind,
            outputContract: descriptor.outputContract,
            capabilities: descriptor.capabilities,
            deliverySemantics: descriptor.deliverySemantics,
            bindingFingerprint: node.binding?.bindingDigest ?? "none"
        };
        if (descriptor.configurationFingerprint !== undefined) {
            compiled.configurationFingerprint = descriptor.configurationFingerprint;
        }
        return compiled;
    });
    const payload = {
        schemaVersion: COMPILED_PIPELINE_SCHEMA_VERSION,
        compilerVersion: PIPELINE_COMPILER_VERSION,
        pipeline: { id: definition.pipelineId, version: definition.version, digest: definition.definitionDigest },
        inputContract: definition.inputContract,
        nodes,
        outputs: definition.outputs
    };
    return { ...payload, compiledDigest: digest(payload) };
}
const COMPILED_KEYS = new Set([
    "schemaVersion",
    "compilerVersion",
    "pipeline",
    "inputContract",
    "nodes",
    "outputs",
    "compiledDigest"
]);
const COMPILED_NODE_KEYS = new Set([
    "nodeId",
    "stage",
    "inputs",
    "kind",
    "outputContract",
    "capabilities",
    "deliverySemantics",
    "bindingFingerprint",
    "configurationFingerprint"
]);
function validateCompiledNode(value, label) {
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, COMPILED_NODE_KEYS, label);
    const nodeId = assertIdentifier(raw.nodeId, `${label}: nodeId`);
    const nodeLabel = `${label} ${nodeId}`;
    const stageRaw = assertPlainObject(raw.stage, `${nodeLabel}: stage`);
    assertStrictKeys(stageRaw, new Set(["id", "version"]), `${nodeLabel}: stage`);
    const stage = {
        id: assertIdentifier(stageRaw.id, `${nodeLabel}: stage.id`),
        version: assertPositiveInt(stageRaw.version, `${nodeLabel}: stage.version`)
    };
    if (!Array.isArray(raw.inputs) || raw.inputs.length < 1 || raw.inputs.length > MAX_STAGE_INPUTS) {
        throw new Error(`${nodeLabel}: inputs must be an array of 1..${MAX_STAGE_INPUTS} (got ${Array.isArray(raw.inputs) ? raw.inputs.length : typeName(raw.inputs)})`);
    }
    const inputs = raw.inputs.map((inputRaw, index) => {
        const inputLabel = `${nodeLabel}: inputs[${index}]`;
        const inputObject = assertPlainObject(inputRaw, inputLabel);
        assertStrictKeys(inputObject, new Set(["slot", "source", "contract"]), inputLabel);
        return {
            slot: assertIdentifier(inputObject.slot, `${inputLabel}.slot`),
            source: validatePipelineNodeInputSource(inputObject.source, `${inputLabel}.source`),
            contract: validateContractId(inputObject.contract, `${inputLabel}.contract`)
        };
    });
    const kind = assertEnum(raw.kind, STAGE_KINDS, `${nodeLabel}: kind`);
    const outputContract = validateContractId(raw.outputContract, `${nodeLabel}: outputContract`);
    if (!Array.isArray(raw.capabilities) || raw.capabilities.length < 1 || raw.capabilities.length > MAX_STAGE_CAPABILITIES) {
        throw new Error(`${nodeLabel}: capabilities must be an array of 1..${MAX_STAGE_CAPABILITIES} (got ${Array.isArray(raw.capabilities) ? raw.capabilities.length : typeName(raw.capabilities)})`);
    }
    const capabilities = raw.capabilities.map((capability, index) => assertIdentifier(capability, `${nodeLabel}: capabilities[${index}]`));
    const deliverySemantics = assertEnum(raw.deliverySemantics, DELIVERY_SEMANTICS, `${nodeLabel}: deliverySemantics`);
    const bindingFingerprint = raw.bindingFingerprint === "none"
        ? "none"
        : assertSha256Hex(raw.bindingFingerprint, `${nodeLabel}: bindingFingerprint`);
    const node = { nodeId, stage, inputs, kind, outputContract, capabilities, deliverySemantics, bindingFingerprint };
    if ("configurationFingerprint" in raw) {
        if (raw.configurationFingerprint === undefined) {
            throw new Error(`${nodeLabel}: configurationFingerprint is present but undefined (omit the key instead)`);
        }
        node.configurationFingerprint = assertSha256Hex(raw.configurationFingerprint, `${nodeLabel}: configurationFingerprint`);
    }
    return node;
}
/**
 * LOUD validator for a sealed {@link CompiledPipeline} (used by B3 to verify
 * store round-trips): full shape validation plus digest recompute — any
 * tampering throws "digest mismatch".
 */
export function validateCompiledPipeline(value) {
    const label = "compiled pipeline";
    const raw = assertPlainObject(value, label);
    assertStrictKeys(raw, COMPILED_KEYS, label);
    if (raw.schemaVersion !== COMPILED_PIPELINE_SCHEMA_VERSION) {
        throw new Error(`${label}: schemaVersion must be ${JSON.stringify(COMPILED_PIPELINE_SCHEMA_VERSION)} (got ${typeof raw.schemaVersion === "string" ? JSON.stringify(truncate(raw.schemaVersion)) : typeName(raw.schemaVersion)})`);
    }
    if (raw.compilerVersion !== PIPELINE_COMPILER_VERSION) {
        throw new Error(`${label}: compilerVersion must be ${JSON.stringify(PIPELINE_COMPILER_VERSION)} (got ${typeof raw.compilerVersion === "string" ? JSON.stringify(truncate(raw.compilerVersion)) : typeName(raw.compilerVersion)})`);
    }
    const refRaw = assertPlainObject(raw.pipeline, `${label}: pipeline`);
    assertStrictKeys(refRaw, new Set(["id", "version", "digest"]), `${label}: pipeline`);
    const pipeline = {
        id: assertIdentifier(refRaw.id, `${label}: pipeline.id`),
        version: assertPositiveInt(refRaw.version, `${label}: pipeline.version`),
        digest: assertSha256Hex(refRaw.digest, `${label}: pipeline.digest`)
    };
    const inputContract = validateContractId(raw.inputContract, `${label}: inputContract`);
    if (!Array.isArray(raw.nodes) || raw.nodes.length < 1) {
        throw new Error(`${label}: nodes must be a non-empty array (got ${Array.isArray(raw.nodes) ? raw.nodes.length : typeName(raw.nodes)})`);
    }
    const nodes = raw.nodes.map((nodeRaw, index) => validateCompiledNode(nodeRaw, `${label}: nodes[${index}]`));
    if (!Array.isArray(raw.outputs) || raw.outputs.length < 1) {
        throw new Error(`${label}: outputs must be a non-empty array (got ${Array.isArray(raw.outputs) ? raw.outputs.length : typeName(raw.outputs)})`);
    }
    const outputs = raw.outputs.map((output, index) => assertIdentifier(output, `${label}: outputs[${index}]`));
    const sealed = assertSha256Hex(raw.compiledDigest, `${label}: compiledDigest`);
    const payload = {
        schemaVersion: COMPILED_PIPELINE_SCHEMA_VERSION,
        compilerVersion: PIPELINE_COMPILER_VERSION,
        pipeline,
        inputContract,
        nodes,
        outputs
    };
    const computed = digest(payload);
    if (sealed !== computed) {
        throw new Error(`${label} ${pipeline.id}@${pipeline.version}: digest mismatch — sealed ${sealed} != computed ${computed}`);
    }
    return { ...payload, compiledDigest: sealed };
}

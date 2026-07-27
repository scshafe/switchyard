// mission-pipeline-node-model.test.mjs — B2 of the STANDALONE mission-pipeline
// package: node model (StageDescriptor + CodeStage), digest-sealed
// PipelineDefinition, StageCatalog with ATOMIC register (the parity fix) +
// ContractValidator port, and compilePipeline.
//
// All hermetic (no network, no DB). The compiler behavioral cases are PORTED
// from inbox-pipeline/test/pipeline-definition.test.ts ("pipeline definition
// compiler" describe: default-DAG compile with immutable attribution +
// deterministic recompile; unknown-field/digest-tamper; unknown stage; cycle;
// slot mismatch; contract mismatch; requires-a-model-binding; binding change
// changes identity; unknown output node) and extended with the NEW rejection
// rules: descriptor-without-executable at compile time + assertParity, gate
// terminality (output-only, no downstream edges), binding-kind mismatch on the
// content-addressed binding ref, and unknown pipeline inputContract.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { digest } from "mission-pipeline/contracts/digest";
import { CONTRACT_ID_PATTERN, SHA256_HEX_PATTERN } from "mission-pipeline/contracts/artifact";
import {
  STAGE_KINDS,
  STAGE_BINDING_KINDS,
  DELIVERY_SEMANTICS,
  CANONICAL_BINDING_KIND,
  IDENTIFIER_PATTERN,
  MAX_STAGE_INPUTS,
  MAX_STAGE_CAPABILITIES,
  validateStageDescriptor,
  validateStageExecutable
} from "mission-pipeline/node";
import {
  PIPELINE_DEFINITION_SCHEMA_VERSION,
  PIPELINE_NODE_BINDING_KINDS,
  MAX_PIPELINE_NODES,
  MAX_PIPELINE_OUTPUTS,
  MAX_DESCRIPTION_LENGTH,
  createPipelineDefinition,
  validatePipelineDefinition,
  pipelineDefinitionRef
} from "mission-pipeline/definition";
import { StageCatalog } from "mission-pipeline/catalog";
import {
  COMPILED_PIPELINE_SCHEMA_VERSION,
  PIPELINE_COMPILER_VERSION,
  compilePipeline,
  validateCompiledPipeline
} from "mission-pipeline/compile";

const schemaPath = (rel) => new URL(`../schemas/${rel}`, import.meta.url);

// ── Fixtures: a fake ContractValidator + the inbox-default stage family ──

const KNOWN_CONTRACTS = [
  "ingested-email.v1",
  "normalized-email.v1",
  "secured-email.v1",
  "routed-email.v1",
  "classified-email.v1",
  "notification-plan.v1",
  "jobtrack-mail-proposal-batch.v1",
  "hierarchical-decision-node-result.v1",
  "loop.v1"
];

const fakeContracts = (known = KNOWN_CONTRACTS) => ({
  knows: (contractId) => known.includes(contractId),
  validate: (contractId, value) =>
    known.includes(contractId)
      ? { ok: true, value }
      : { ok: false, issues: [{ message: `unknown contract ${contractId}` }] }
});

const codeExecutable = (id, version = 1) => ({ id, version, run: async (input) => input });
const handleExecutable = (id, version = 1) => ({ id, version });

const descriptor = (stageId, kind, inputs, outputContract, capabilities) => ({
  stageId,
  version: 1,
  kind,
  inputs: inputs.map(([slot, contract]) => ({ slot, contract })),
  outputContract,
  ...(capabilities ? { capabilities } : {}),
  deliverySemantics: "at_least_once_idempotent"
});

const DEFAULT_REGISTRATIONS = () => [
  { descriptor: descriptor("normalize.email", "code", [["email", "ingested-email.v1"]], "normalized-email.v1"), executable: codeExecutable("normalize.email") },
  { descriptor: descriptor("security.scan", "code", [["email", "normalized-email.v1"]], "secured-email.v1"), executable: codeExecutable("security.scan") },
  { descriptor: descriptor("route.deterministic", "code", [["email", "secured-email.v1"]], "routed-email.v1"), executable: codeExecutable("route.deterministic") },
  { descriptor: descriptor("classify.model", "model", [["email", "routed-email.v1"]], "classified-email.v1", ["network:model"]), executable: handleExecutable("classify.model") },
  { descriptor: descriptor("notifications.plan", "code", [["email", "classified-email.v1"]], "notification-plan.v1"), executable: codeExecutable("notifications.plan") },
  { descriptor: descriptor("jobtrack.proposal", "code", [["email", "classified-email.v1"]], "jobtrack-mail-proposal-batch.v1"), executable: codeExecutable("jobtrack.proposal") },
  { descriptor: descriptor("decision.requires-human-action", "gate", [["email", "routed-email.v1"]], "hierarchical-decision-node-result.v1", ["network:model", "decision:hierarchical"]), executable: handleExecutable("decision.requires-human-action") },
  { descriptor: descriptor("after.gate", "code", [["decision", "hierarchical-decision-node-result.v1"]], "notification-plan.v1"), executable: codeExecutable("after.gate") },
  { descriptor: descriptor("loop.stage", "code", [["in", "loop.v1"]], "loop.v1"), executable: codeExecutable("loop.stage") }
];

const buildCatalog = () => new StageCatalog({ contracts: fakeContracts(), registrations: DEFAULT_REGISTRATIONS() });

const CLASSIFY_BINDING = {
  kind: "model",
  bindingId: "default.classification.binding",
  version: 1,
  bindingDigest: digest({ schemaVersion: "model-stage-binding.v1", bindingId: "default.classification.binding", model: "qwen2.5-14b" })
};

const nodeRef = (nodeId) => ({ kind: "node_output", nodeId });

const defaultDraft = () => ({
  schemaVersion: "pipeline-definition.v2",
  pipelineId: "inbox.email.default",
  version: 1,
  description: "Default email pipeline mirroring the inbox default-metadata DAG.",
  inputContract: "ingested-email.v1",
  nodes: [
    { nodeId: "normalize", stage: { id: "normalize.email", version: 1 }, inputs: [{ slot: "email", source: { kind: "pipeline_input" } }] },
    { nodeId: "security", stage: { id: "security.scan", version: 1 }, inputs: [{ slot: "email", source: nodeRef("normalize") }] },
    { nodeId: "route", stage: { id: "route.deterministic", version: 1 }, inputs: [{ slot: "email", source: nodeRef("security") }] },
    { nodeId: "classify", stage: { id: "classify.model", version: 1 }, inputs: [{ slot: "email", source: nodeRef("route") }], binding: CLASSIFY_BINDING },
    { nodeId: "notifications", stage: { id: "notifications.plan", version: 1 }, inputs: [{ slot: "email", source: nodeRef("classify") }] },
    { nodeId: "jobtrack-proposal", stage: { id: "jobtrack.proposal", version: 1 }, inputs: [{ slot: "email", source: nodeRef("classify") }] }
  ],
  outputs: ["notifications", "jobtrack-proposal"]
});

const draftWithNodes = (mapNode, outputs) => {
  const base = defaultDraft();
  return { ...base, nodes: base.nodes.map(mapNode), ...(outputs ? { outputs } : {}) };
};

// ── 1. Node model: StageDescriptor validation + normalization ──

test("stage descriptor: normalizes bindingKind from kind and defaults capabilities", () => {
  const gate = validateStageDescriptor(descriptor("g.stage", "gate", [["in", "routed-email.v1"]], "hierarchical-decision-node-result.v1"));
  assert.equal(gate.bindingKind, "decision");
  assert.deepEqual(gate.capabilities, ["none"]);
  const model = validateStageDescriptor({ ...descriptor("m.stage", "model", [["in", "routed-email.v1"]], "classified-email.v1"), bindingKind: "model" });
  assert.equal(model.bindingKind, "model");
  const code = validateStageDescriptor(descriptor("c.stage", "code", [["in", "loop.v1"]], "loop.v1"));
  assert.equal(code.bindingKind, "none");
  assert.equal(code.deliverySemantics, "at_least_once_idempotent");
  assert.deepEqual(CANONICAL_BINDING_KIND, { code: "none", model: "model", agent: "none", gate: "decision" });
  // configurationFingerprint accepted when sha256.
  const withFingerprint = validateStageDescriptor({ ...descriptor("f.stage", "code", [["in", "loop.v1"]], "loop.v1"), configurationFingerprint: "a".repeat(64) });
  assert.equal(withFingerprint.configurationFingerprint, "a".repeat(64));
});

test("stage descriptor: every rejection is LOUD and precise", () => {
  const good = descriptor("x.stage", "code", [["in", "loop.v1"]], "loop.v1");
  assert.throws(() => validateStageDescriptor(null), /must be a plain object \(got null\)/);
  assert.throws(() => validateStageDescriptor({ ...good, sneaky: 1 }), /unknown key\(s\) "sneaky"/);
  assert.throws(() => validateStageDescriptor({ ...good, stageId: "Bad Id" }), /identifier grammar/);
  assert.throws(() => validateStageDescriptor({ ...good, version: 0 }), /version: must be a positive integer/);
  assert.throws(() => validateStageDescriptor({ ...good, kind: "shell" }), /kind: must be one of "code" \| "model" \| "agent" \| "gate"/);
  assert.throws(() => validateStageDescriptor({ ...good, inputs: [] }), /inputs must be an array of 1\.\.16/);
  assert.throws(
    () => validateStageDescriptor({ ...good, inputs: Array.from({ length: MAX_STAGE_INPUTS + 1 }, (_, i) => ({ slot: `s${i}`, contract: "loop.v1" })) }),
    /inputs must be an array of 1\.\.16/
  );
  assert.throws(
    () => validateStageDescriptor({ ...good, inputs: [{ slot: "in", contract: "loop.v1" }, { slot: "in", contract: "loop.v1" }] }),
    /input slots must be unique/
  );
  assert.throws(() => validateStageDescriptor({ ...good, inputs: [{ slot: "in", contract: "NotAContract" }] }), /contract id/);
  assert.throws(() => validateStageDescriptor({ ...good, capabilities: ["none", "network:model"] }), /"none" cannot be combined/);
  assert.throws(() => validateStageDescriptor({ ...good, capabilities: ["a", "a"] }), /capabilities must be unique/);
  assert.throws(
    () => validateStageDescriptor({ ...good, capabilities: Array.from({ length: MAX_STAGE_CAPABILITIES + 1 }, (_, i) => `c${i}`) }),
    /capabilities must be an array of 1\.\.8/
  );
  assert.throws(() => validateStageDescriptor({ ...good, bindingKind: "model" }), /bindingKind "model" conflicts with kind "code"/);
  assert.throws(() => validateStageDescriptor({ ...descriptor("g.stage", "gate", [["in", "loop.v1"]], "loop.v1"), bindingKind: "none" }), /conflicts with kind "gate"/);
  const { deliverySemantics: _dropped, ...withoutDelivery } = good;
  assert.throws(() => validateStageDescriptor(withoutDelivery), /deliverySemantics: must be one of "at_most_once" \| "at_least_once_idempotent"/);
  assert.throws(() => validateStageDescriptor({ ...good, deliverySemantics: "exactly_once" }), /deliverySemantics: must be one of/);
  assert.throws(() => validateStageDescriptor({ ...good, configurationFingerprint: "xyz" }), /bare lowercase sha256 hex/);
  assert.throws(() => validateStageDescriptor({ ...good, configurationFingerprint: undefined }), /present but undefined/);
});

test("stage executable: identity + optional run shape (contract validation is NOT the stage's job)", () => {
  const stage = codeExecutable("x.stage", 1);
  assert.equal(validateStageExecutable(stage), stage);
  assert.equal(validateStageExecutable(handleExecutable("m.stage", 2)).version, 2);
  assert.throws(() => validateStageExecutable(null), /must be an object/);
  assert.throws(() => validateStageExecutable({ id: "x.stage" }), /version: must be a positive integer/);
  assert.throws(() => validateStageExecutable({ id: "x.stage", version: 1, run: 42 }), /run must be a function when present \(got number\)/);
});

// ── 2. Catalog: atomic register (the parity fix) + ContractValidator port ──

test("catalog: atomic register resolves descriptor AND executable; list is deterministic", () => {
  const catalog = buildCatalog();
  const resolved = catalog.resolveDescriptor("classify.model", 1);
  assert.equal(resolved.bindingKind, "model");
  assert.deepEqual(resolved.capabilities, ["network:model"]);
  assert.equal(catalog.resolveExecutable("normalize.email", 1).id, "normalize.email");
  assert.ok(catalog.hasStage("route.deterministic", 1));
  assert.ok(catalog.hasExecutable("route.deterministic", 1));
  assert.ok(!catalog.hasStage("route.deterministic", 2));
  const listed = catalog.list().map((d) => d.stageId);
  assert.deepEqual(listed, [...listed].sort());
  catalog.assertParity(); // atomic path can never violate parity
  assert.throws(() => catalog.resolveDescriptor("ghost.stage", 1), /Unknown registered stage: ghost\.stage@1/);
  // The injected port is reachable for the executor (B3).
  assert.deepEqual(catalog.contracts.validate("loop.v1", { n: 1 }), { ok: true, value: { n: 1 } });
  assert.equal(catalog.contracts.validate("mystery.v1", {}).ok, false);
});

test("catalog: descriptor snapshots are deeply immutable and detached from caller-owned inputs", () => {
  const callerDescriptor = descriptor(
    "snapshot.stage",
    "code",
    [["in", "loop.v1"]],
    "loop.v1",
    ["cache:local"]
  );
  const registration = {
    descriptor: callerDescriptor,
    executable: codeExecutable("snapshot.stage")
  };
  const registrations = [registration];
  const catalog = new StageCatalog({
    contracts: fakeContracts(),
    registrations
  });

  callerDescriptor.stageId = "caller.changed";
  callerDescriptor.inputs[0].slot = "changed";
  callerDescriptor.inputs.push({ slot: "extra", contract: "mystery.v1" });
  callerDescriptor.capabilities[0] = "network:model";
  registration.descriptor = descriptor(
    "replacement.stage",
    "code",
    [["in", "loop.v1"]],
    "loop.v1"
  );
  registrations.pop();

  const stored = catalog.resolveDescriptor("snapshot.stage", 1);
  assert.deepEqual(stored, {
    stageId: "snapshot.stage",
    version: 1,
    kind: "code",
    inputs: [{ slot: "in", contract: "loop.v1" }],
    outputContract: "loop.v1",
    capabilities: ["cache:local"],
    bindingKind: "none",
    deliverySemantics: "at_least_once_idempotent"
  });
  assert.equal(catalog.resolveExecutable("snapshot.stage", 1).id, "snapshot.stage");
  assert.equal(catalog.hasStage("caller.changed", 1), false);

  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.inputs), true);
  assert.equal(Object.isFrozen(stored.inputs[0]), true);
  assert.equal(Object.isFrozen(stored.capabilities), true);
  assert.throws(() => {
    stored.stageId = "mutated.stage";
  }, TypeError);
  assert.throws(() => {
    stored.inputs[0].contract = "mystery.v1";
  }, TypeError);
  assert.throws(() => {
    stored.inputs.push({ slot: "extra", contract: "loop.v1" });
  }, TypeError);
  assert.throws(() => {
    stored.capabilities.push("network:model");
  }, TypeError);

  const listed = catalog.list();
  assert.equal(listed[0], stored);
  listed.pop();
  assert.deepEqual(catalog.list(), [stored]);

  const descriptorOnlyCatalog = new StageCatalog({ contracts: fakeContracts() });
  const descriptorOnly = descriptorOnlyCatalog.registerDescriptorOnly(
    descriptor(
      "descriptor-only.stage",
      "code",
      [["in", "loop.v1"]],
      "loop.v1"
    )
  );
  assert.equal(Object.isFrozen(descriptorOnly), true);
  assert.equal(Object.isFrozen(descriptorOnly.inputs), true);
  assert.equal(Object.isFrozen(descriptorOnly.inputs[0]), true);
  assert.equal(Object.isFrozen(descriptorOnly.capabilities), true);
  assert.equal(
    descriptorOnlyCatalog.resolveDescriptor("descriptor-only.stage", 1),
    descriptorOnly
  );

  const directCatalog = new StageCatalog({ contracts: fakeContracts() });
  const directlyRegistered = directCatalog.register({
    descriptor: descriptor(
      "direct.stage",
      "code",
      [["in", "loop.v1"]],
      "loop.v1"
    ),
    executable: codeExecutable("direct.stage")
  });
  assert.equal(Object.isFrozen(directlyRegistered), true);
  assert.equal(
    directCatalog.resolveDescriptor("direct.stage", 1),
    directlyRegistered
  );
});

test("catalog: list uses explicit code-unit stage ordering, then numeric version", () => {
  const catalog = new StageCatalog({ contracts: fakeContracts() });
  const identities = [
    ["a_0", 1],
    ["a0", 2],
    ["a:0", 1],
    ["a.0", 1],
    ["a0", 1],
    ["a-0", 1]
  ];
  for (const [stageId, version] of identities) {
    catalog.register({
      descriptor: {
        ...descriptor(stageId, "code", [["in", "loop.v1"]], "loop.v1"),
        version
      },
      executable: codeExecutable(stageId, version)
    });
  }
  assert.deepEqual(
    catalog.list().map(({ stageId, version }) => `${stageId}@${version}`),
    ["a-0@1", "a.0@1", "a0@1", "a0@2", "a:0@1", "a_0@1"]
  );
});

test("catalog: register is atomic and LOUD (identity mismatch, duplicates, kind rules, unknown contracts)", () => {
  const catalog = buildCatalog();
  const dNorm = descriptor("fresh.stage", "code", [["in", "loop.v1"]], "loop.v1");
  assert.throws(
    () => catalog.register({ descriptor: dNorm, executable: codeExecutable("other.stage") }),
    /executable other\.stage@1 does not match descriptor fresh\.stage@1/
  );
  assert.throws(
    () => catalog.register({ descriptor: dNorm, executable: codeExecutable("fresh.stage", 2) }),
    /does not match descriptor fresh\.stage@1/
  );
  assert.throws(
    () => catalog.register({ descriptor: dNorm, executable: handleExecutable("fresh.stage") }),
    /kind "code" but its executable has no run\(\) function/
  );
  assert.throws(
    () => catalog.register({ descriptor: dNorm, executable: codeExecutable("fresh.stage"), extra: 1 }),
    /unknown key\(s\) "extra"/
  );
  catalog.register({ descriptor: dNorm, executable: codeExecutable("fresh.stage") });
  assert.throws(
    () => catalog.register({ descriptor: dNorm, executable: codeExecutable("fresh.stage") }),
    /Stage already registered: fresh\.stage@1/
  );
  assert.throws(
    () => catalog.register({ descriptor: descriptor("dark.stage", "code", [["in", "mystery.v1"]], "loop.v1"), executable: codeExecutable("dark.stage") }),
    /references unknown contract\(s\): mystery\.v1/
  );
  assert.throws(() => new StageCatalog({ contracts: {} }), /must implement the ContractValidator port/);
  assert.throws(() => new StageCatalog({ contracts: fakeContracts(), bogus: 1 }), /unknown key\(s\) "bogus"/);
});

test("catalog: descriptor-only escape hatch fails assertParity until the executable attaches", () => {
  const catalog = new StageCatalog({ contracts: fakeContracts() });
  catalog.registerDescriptorOnly(descriptor("loop.stage", "code", [["in", "loop.v1"]], "loop.v1"));
  assert.ok(catalog.hasStage("loop.stage", 1));
  assert.ok(!catalog.hasExecutable("loop.stage", 1));
  assert.throws(() => catalog.assertParity(), /parity violation — descriptor\(s\) registered without an executable: loop\.stage@1/);
  assert.throws(() => catalog.resolveExecutable("loop.stage", 1), /descriptor but no registered executable/);
  assert.throws(() => catalog.attachExecutable(handleExecutable("ghost.stage")), /Unknown registered stage: ghost\.stage@1/);
  assert.throws(() => catalog.attachExecutable(handleExecutable("loop.stage")), /kind "code" but its executable has no run\(\) function/);
  catalog.attachExecutable(codeExecutable("loop.stage"));
  catalog.assertParity();
  assert.equal(catalog.resolveExecutable("loop.stage", 1).id, "loop.stage");
  assert.throws(() => catalog.attachExecutable(codeExecutable("loop.stage")), /Executable already attached: loop\.stage@1/);
});

// ── 3. PipelineDefinition: digest sealing + stability + tamper rejection ──

test("pipeline definition: create seals; digest is stable under key permutation", () => {
  const definition = createPipelineDefinition(defaultDraft());
  assert.match(definition.definitionDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(validatePipelineDefinition(definition), definition);
  assert.deepEqual(pipelineDefinitionRef(definition), {
    id: "inbox.email.default",
    version: 1,
    digest: definition.definitionDigest
  });

  // Same content, permuted key order everywhere (top level, nodes, binding).
  const base = defaultDraft();
  const permuted = {
    outputs: base.outputs,
    nodes: base.nodes.map((node) => ({
      inputs: node.inputs.map((input) => ({ source: input.source, slot: input.slot })),
      stage: { version: node.stage.version, id: node.stage.id },
      ...(node.binding
        ? { binding: { bindingDigest: node.binding.bindingDigest, version: node.binding.version, bindingId: node.binding.bindingId, kind: node.binding.kind } }
        : {}),
      nodeId: node.nodeId
    })),
    inputContract: base.inputContract,
    description: base.description,
    version: base.version,
    pipelineId: base.pipelineId,
    schemaVersion: base.schemaVersion
  };
  assert.equal(createPipelineDefinition(permuted).definitionDigest, definition.definitionDigest);
});

test("pipeline definition: fails closed for unknown fields and digest tampering (ported)", () => {
  const definition = createPipelineDefinition(defaultDraft());
  assert.throws(() => validatePipelineDefinition({ ...definition, unexpected: true }), /unknown key\(s\) "unexpected"/);
  assert.throws(() => validatePipelineDefinition({ ...definition, description: "tampered" }), /digest mismatch/);
  assert.throws(() => createPipelineDefinition({ ...defaultDraft(), definitionDigest: "a".repeat(64) }), /unknown key\(s\) "definitionDigest"/);
  assert.throws(() => createPipelineDefinition({ ...defaultDraft(), schemaVersion: "pipeline-definition.v1" }), /schemaVersion must be "pipeline-definition\.v2"/);
  const twoSameNodes = draftWithNodes((node) => (node.nodeId === "security" ? { ...node, nodeId: "normalize" } : node));
  assert.throws(() => createPipelineDefinition(twoSameNodes), /pipeline node IDs must be unique/);
  assert.throws(() => createPipelineDefinition({ ...defaultDraft(), outputs: ["notifications", "notifications"] }), /output node IDs must be unique/);
  assert.throws(() => createPipelineDefinition({ ...defaultDraft(), description: "   " }), /description must be 1\.\.1000 chars after trimming/);
  const badBinding = draftWithNodes((node) => (node.nodeId === "classify" ? { ...node, binding: { ...CLASSIFY_BINDING, kind: "prompt" } } : node));
  assert.throws(() => createPipelineDefinition(badBinding), /binding kind must be "model" \| "decision"/);
});

// ── 4. Compiler: the ported happy path with immutable attribution ──

test("compiles the default registered-stage DAG with immutable attribution (ported)", () => {
  const catalog = buildCatalog();
  const definition = createPipelineDefinition(defaultDraft());
  const compiled = compilePipeline(definition, catalog);
  assert.equal(compiled.schemaVersion, COMPILED_PIPELINE_SCHEMA_VERSION);
  assert.equal(compiled.compilerVersion, PIPELINE_COMPILER_VERSION);
  assert.deepEqual(compiled.pipeline, { id: "inbox.email.default", version: 1, digest: definition.definitionDigest });
  assert.deepEqual(
    compiled.nodes.map((node) => node.nodeId),
    ["normalize", "security", "route", "classify", "notifications", "jobtrack-proposal"]
  );
  assert.deepEqual(compiled.outputs, ["notifications", "jobtrack-proposal"]);
  const classify = compiled.nodes.find((node) => node.nodeId === "classify");
  assert.equal(classify.bindingFingerprint, CLASSIFY_BINDING.bindingDigest);
  assert.equal(classify.kind, "model");
  assert.deepEqual(classify.capabilities, ["network:model"]);
  assert.equal(classify.deliverySemantics, "at_least_once_idempotent");
  assert.equal(compiled.nodes.find((node) => node.nodeId === "jobtrack-proposal").outputContract, "jobtrack-mail-proposal-batch.v1");
  assert.equal(compiled.nodes.find((node) => node.nodeId === "normalize").bindingFingerprint, "none");
  assert.equal(compiled.nodes.find((node) => node.nodeId === "security").inputs[0].contract, "normalized-email.v1");
  // Deterministic: recompiling yields a byte-identical sealed assembly.
  assert.deepEqual(compilePipeline(definition, catalog), compiled);
  // The sealed compiled shape round-trips and rejects tampering.
  assert.deepEqual(validateCompiledPipeline(compiled), compiled);
  assert.throws(() => validateCompiledPipeline({ ...compiled, outputs: ["notifications"] }), /digest mismatch/);
  assert.throws(() => validateCompiledPipeline({ ...compiled, sneaky: 1 }), /unknown key\(s\) "sneaky"/);
});

// ── 5. Compiler: every rejection rule ──

test("compiler rejects unknown stages (ported)", () => {
  const catalog = buildCatalog();
  const unknown = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "normalize" ? { ...node, stage: { id: "unknown.stage", version: 1 } } : node))
  );
  assert.throws(() => compilePipeline(unknown, catalog), /Unknown registered stage: unknown\.stage@1/);
});

test("compiler rejects cycles, self-dependencies, and unknown source nodes (ported)", () => {
  const catalog = buildCatalog();
  const loopNode = (nodeId, from) => ({
    nodeId,
    stage: { id: "loop.stage", version: 1 },
    inputs: [{ slot: "in", source: nodeRef(from) }]
  });
  const cyclic = createPipelineDefinition({
    ...defaultDraft(),
    inputContract: "loop.v1",
    nodes: [loopNode("a", "b"), loopNode("b", "a")],
    outputs: ["a"]
  });
  assert.throws(() => compilePipeline(cyclic, catalog), /dependency cycle/);

  const selfDep = createPipelineDefinition({
    ...defaultDraft(),
    inputContract: "loop.v1",
    nodes: [loopNode("a", "a")],
    outputs: ["a"]
  });
  assert.throws(() => compilePipeline(selfDep, catalog), /Pipeline node a cannot depend on itself/);

  const ghostSource = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "security" ? { ...node, inputs: [{ slot: "email", source: nodeRef("ghost") }] } : node))
  );
  assert.throws(() => compilePipeline(ghostSource, catalog), /Pipeline node security references unknown node ghost/);
});

test("compiler rejects slot and contract mismatches (ported)", () => {
  const catalog = buildCatalog();
  const wrongSlot = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "security" ? { ...node, inputs: [{ slot: "wrong", source: nodeRef("normalize") }] } : node))
  );
  assert.throws(() => compilePipeline(wrongSlot, catalog), /Pipeline node security input slots do not match stage security\.scan@1/);

  const mismatched = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "security" ? { ...node, inputs: [{ slot: "email", source: { kind: "pipeline_input" } }] } : node))
  );
  assert.throws(
    () => compilePipeline(mismatched, catalog),
    /Pipeline node security slot email expects normalized-email\.v1, received ingested-email\.v1/
  );
});

test("compiler rejects unknown output nodes and unknown pipeline input contracts", () => {
  const catalog = buildCatalog();
  const ghostOutput = createPipelineDefinition({ ...defaultDraft(), outputs: ["notifications", "ghost"] });
  assert.throws(() => compilePipeline(ghostOutput, catalog), /Pipeline output references unknown node ghost/);

  const mysteryInput = createPipelineDefinition({ ...defaultDraft(), inputContract: "mystery.v1" });
  assert.throws(() => compilePipeline(mysteryInput, catalog), /input contract mystery\.v1 is not known to the catalog ContractValidator/);
});

test("compiler enforces binding kinds on the content-addressed binding ref (ported + extended)", () => {
  const catalog = buildCatalog();
  const withoutBinding = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "classify" ? { nodeId: node.nodeId, stage: node.stage, inputs: node.inputs } : node))
  );
  assert.throws(() => compilePipeline(withoutBinding, catalog), /Stage classify\.model@1 requires a model binding/);

  const boundCodeStage = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "normalize" ? { ...node, binding: CLASSIFY_BINDING } : node))
  );
  assert.throws(() => compilePipeline(boundCodeStage, catalog), /Stage normalize\.email@1 does not accept a binding/);

  const wrongKind = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "classify" ? { ...node, binding: { ...CLASSIFY_BINDING, kind: "decision" } } : node))
  );
  assert.throws(
    () => compilePipeline(wrongKind, catalog),
    /Pipeline node classify binding kind "decision" does not match stage classify\.model@1 binding kind "model"/
  );
});

test("a binding change changes the pipeline identity (ported)", () => {
  const catalog = buildCatalog();
  const definition = createPipelineDefinition(defaultDraft());
  const changedBinding = {
    ...CLASSIFY_BINDING,
    bindingId: "alternate.classification.binding",
    bindingDigest: digest({ schemaVersion: "model-stage-binding.v1", bindingId: "alternate.classification.binding", model: "mistral-small-24b" })
  };
  const changed = createPipelineDefinition(
    draftWithNodes((node) => (node.nodeId === "classify" ? { ...node, binding: changedBinding } : node))
  );
  assert.notEqual(changed.definitionDigest, definition.definitionDigest);
  assert.notEqual(compilePipeline(changed, catalog).compiledDigest, compilePipeline(definition, catalog).compiledDigest);
});

test("NEW: a descriptor without an executable fails at COMPILE time (the parity fix)", () => {
  const catalog = new StageCatalog({ contracts: fakeContracts() });
  for (const registration of DEFAULT_REGISTRATIONS()) {
    if (registration.descriptor.stageId === "classify.model") {
      catalog.registerDescriptorOnly(registration.descriptor); // the split the inbox only caught at run time
    } else {
      catalog.register(registration);
    }
  }
  const definition = createPipelineDefinition(defaultDraft());
  assert.throws(
    () => compilePipeline(definition, catalog),
    /Stage classify\.model@1 has a descriptor but no registered executable .*referenced by pipeline node classify/
  );
  assert.throws(() => catalog.assertParity(), /parity violation/);
  catalog.attachExecutable(handleExecutable("classify.model"));
  catalog.assertParity();
  assert.equal(compilePipeline(definition, catalog).nodes.length, 6);
});

test("NEW: gate nodes must be terminal pipeline outputs", () => {
  const catalog = buildCatalog();
  const gateBinding = {
    kind: "decision",
    bindingId: "requires-human-action.flow",
    version: 1,
    bindingDigest: digest({ schemaVersion: "hierarchical-decision-flow-binding.v1", bindingId: "requires-human-action.flow" })
  };
  const base = defaultDraft();
  const gateNodes = [
    ...base.nodes.slice(0, 3), // normalize, security, route
    { nodeId: "gate", stage: { id: "decision.requires-human-action", version: 1 }, inputs: [{ slot: "email", source: nodeRef("route") }], binding: gateBinding }
  ];

  // Happy path: gate as a pipeline output with no downstream edges.
  const terminal = createPipelineDefinition({ ...base, nodes: gateNodes, outputs: ["gate"] });
  const compiled = compilePipeline(terminal, catalog);
  const gateNode = compiled.nodes.find((node) => node.nodeId === "gate");
  assert.equal(gateNode.kind, "gate");
  assert.equal(gateNode.bindingFingerprint, gateBinding.bindingDigest);

  // A gate that is not a pipeline output fails.
  const notOutput = createPipelineDefinition({ ...base, nodes: gateNodes, outputs: ["route"] });
  assert.throws(() => compilePipeline(notOutput, catalog), /Gate node gate must be a pipeline output/);

  // A gate with downstream edges fails, even when listed as an output.
  const downstream = createPipelineDefinition({
    ...base,
    nodes: [
      ...gateNodes,
      { nodeId: "after", stage: { id: "after.gate", version: 1 }, inputs: [{ slot: "decision", source: nodeRef("gate") }] }
    ],
    outputs: ["gate", "after"]
  });
  assert.throws(
    () => compilePipeline(downstream, catalog),
    /Gate node gate has downstream edges — a gate is a pipeline output/
  );
});

test("compiler rejects a gate node without its decision binding", () => {
  const catalog = buildCatalog();
  const base = defaultDraft();
  const unbound = createPipelineDefinition({
    ...base,
    nodes: [
      ...base.nodes.slice(0, 3),
      { nodeId: "gate", stage: { id: "decision.requires-human-action", version: 1 }, inputs: [{ slot: "email", source: nodeRef("route") }] }
    ],
    outputs: ["gate"]
  });
  assert.throws(() => compilePipeline(unbound, catalog), /Stage decision\.requires-human-action@1 requires a decision binding/);
});

// ── 6. Schema-first sources stay pinned to the code constants ──

test("stage-descriptor.v1 schema source matches the hand-written validator's constants", () => {
  const schema = JSON.parse(readFileSync(schemaPath("stage-descriptor.v1.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.kind.enum, [...STAGE_KINDS]);
  assert.deepEqual(schema.properties.bindingKind.enum, [...STAGE_BINDING_KINDS]);
  assert.deepEqual(schema.properties.deliverySemantics.enum, [...DELIVERY_SEMANTICS]);
  assert.equal(schema.properties.inputs.maxItems, MAX_STAGE_INPUTS);
  assert.equal(schema.properties.capabilities.maxItems, MAX_STAGE_CAPABILITIES);
  assert.equal(schema.$defs.identifier.pattern, IDENTIFIER_PATTERN.source);
  assert.equal(schema.$defs.contractId.pattern, CONTRACT_ID_PATTERN.source);
  assert.equal(schema.$defs.sha256.pattern, SHA256_HEX_PATTERN.source);
  assert.equal(schema.additionalProperties, false);
});

test("pipeline-definition.v2 schema source matches the hand-written validator's constants", () => {
  const schema = JSON.parse(readFileSync(schemaPath("pipeline-definition.v2.schema.json"), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, PIPELINE_DEFINITION_SCHEMA_VERSION);
  assert.equal(schema.properties.nodes.maxItems, MAX_PIPELINE_NODES);
  assert.equal(schema.properties.outputs.maxItems, MAX_PIPELINE_OUTPUTS);
  assert.equal(schema.properties.description.maxLength, MAX_DESCRIPTION_LENGTH);
  assert.deepEqual(schema.$defs.bindingRef.properties.kind.enum, [...PIPELINE_NODE_BINDING_KINDS]);
  assert.equal(schema.$defs.node.properties.inputs.maxItems, 16);
  assert.equal(schema.$defs.identifier.pattern, IDENTIFIER_PATTERN.source);
  assert.equal(schema.$defs.contractId.pattern, CONTRACT_ID_PATTERN.source);
  assert.equal(schema.$defs.sha256.pattern, SHA256_HEX_PATTERN.source);
  assert.equal(schema.additionalProperties, false);
});

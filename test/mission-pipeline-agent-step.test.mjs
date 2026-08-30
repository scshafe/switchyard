import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AGENT_STEP_REQUEST_SCHEMA_VERSION,
  AGENT_STEP_RESULT_SCHEMA_VERSION,
  validateAgentStepRequest,
  validateAgentStepResult
} from "mission-pipeline/agent/step";
import {
  createFakeAgentStepExecutor,
  fakeUsageReceipt
} from "mission-pipeline/agent/fake-executor";

const mirror = (name) => new URL(`../schemas/${name}`, import.meta.url);
const fixture = (name) =>
  new URL(`./fixtures/mission-pipeline/${name}`, import.meta.url);

const ENVIRONMENT = Object.freeze({
  schemaVersion: "environment-descriptor.v1",
  network: "model-endpoint",
  capabilities: ["network:model"],
  mounts: [],
  secretRefs: [],
  io: { inputContract: "routed-item.v1", outputContract: "draft.v1" }
});

const goodRequest = () => ({
  schemaVersion: AGENT_STEP_REQUEST_SCHEMA_VERSION,
  stage: { stageId: "draft.reply", version: 1 },
  environment: ENVIRONMENT,
  brief: {
    instructions: "Draft a reply.",
    inputArtifacts: [],
    outputContract: "draft.v1"
  },
  idempotencyKey: "agent-turn-1",
  deadlineMs: 30_000
});

for (const name of [
  "agent-step-request.v1.schema.json",
  "agent-step-result.v1.schema.json"
]) {
  test(`frozen schema remains pinned: ${name}`, () => {
    assert.equal(readFileSync(mirror(name), "utf8"), readFileSync(fixture(name), "utf8"));
  });
}

test("agent request validates the descriptor carrier without granting authority", () => {
  const request = validateAgentStepRequest(goodRequest());
  assert.deepEqual(request.environment, ENVIRONMENT);
  assert.throws(
    () => validateAgentStepRequest({
      ...goodRequest(),
      environment: { network: "none" }
    }),
    /missing required key/
  );
  assert.throws(
    () => validateAgentStepRequest({
      ...goodRequest(),
      environment: { ...ENVIRONMENT, schemaVersion: "environment-descriptor.v2" }
    }),
    /schemaVersion must be "environment-descriptor\.v1"/
  );
});

test("agent result enforces status/output coupling and the receipt floor", () => {
  assert.equal(validateAgentStepResult({
    schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
    status: "completed",
    output: { drafted: true },
    usage: [fakeUsageReceipt()]
  }).status, "completed");
  assert.throws(
    () => validateAgentStepResult({
      schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
      status: "completed",
      usage: [fakeUsageReceipt()]
    }),
    /requires an output/
  );
  assert.throws(
    () => validateAgentStepResult({
      schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
      status: "failed",
      output: {},
      usage: [fakeUsageReceipt()]
    }),
    /must not carry an output/
  );
  assert.throws(
    () => validateAgentStepResult({
      schemaVersion: AGENT_STEP_RESULT_SCHEMA_VERSION,
      status: "failed",
      usage: [],
      failure: { kind: "bad-output", detail: "invalid" }
    }),
    /usage may be empty ONLY/
  );
});

test("the hermetic agent executor is one-turn and preserves the request", async () => {
  const seen = [];
  const executor = createFakeAgentStepExecutor({
    onRequest: (request) => seen.push(request)
  });
  const request = validateAgentStepRequest(goodRequest());
  const result = validateAgentStepResult(await executor.execute(request));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], request);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, {
    echoedFrom: "draft.reply",
    inputArtifacts: []
  });
});

test("the fake executor rejects dynamic option authority without reading it", () => {
  let reads = 0;
  const options = {};
  Object.defineProperty(options, "handlers", {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    }
  });
  assert.throws(
    () => createFakeAgentStepExecutor(options),
    /handlers must be an enumerable data property/
  );
  assert.equal(reads, 0);
  assert.throws(
    () => createFakeAgentStepExecutor({ unexpectedAuthority: true }),
    /unknown key/
  );
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  ExecutionFailureError,
  classifyExecutionFailure
} from "mission-pipeline/execute/failure";

test("shared failure taxonomy preserves the stable retryable/terminal code families", () => {
  assert.deepEqual(classifyExecutionFailure(new Error("compiled digest mismatch")), {
    code: "immutable_configuration_rejected",
    retryable: false
  });
  assert.deepEqual(classifyExecutionFailure(new Error("fetch returned 503")), {
    code: "dependency_unavailable",
    retryable: true
  });
  assert.deepEqual(classifyExecutionFailure(new Error("boom")), {
    code: "stage_execution_failed",
    retryable: true
  });
  assert.deepEqual(classifyExecutionFailure("timeout"), {
    code: "stage_execution_failed",
    retryable: true
  });
});

test("typed execution failures retain deliberate stable codes and dispositions", () => {
  assert.deepEqual(
    classifyExecutionFailure(new ExecutionFailureError("provider_busy", true)),
    { code: "provider_busy", retryable: true }
  );
  assert.deepEqual(
    classifyExecutionFailure(new ExecutionFailureError("payload_rejected", false)),
    { code: "payload_rejected", retryable: false }
  );
  assert.deepEqual(
    classifyExecutionFailure(new ExecutionFailureError("a".repeat(160), false)),
    { code: "a".repeat(160), retryable: false }
  );

  for (const code of ["", "Uppercase", "_prefix", "bad\u0000code", "a".repeat(161)]) {
    assert.deepEqual(
      classifyExecutionFailure(new ExecutionFailureError(code, true)),
      { code: "invalid_execution_failure_error", retryable: false },
      JSON.stringify(code)
    );
  }
});

test("shared classification rejects Proxy authority without executing traps", () => {
  let trapCalls = 0;
  const hostile = new Proxy(
    new ExecutionFailureError("must_not_be_trusted", true),
    {
      get() {
        trapCalls += 1;
        throw new Error("proxy get trap must not run");
      },
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error("proxy prototype trap must not run");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("proxy ownKeys trap must not run");
      }
    }
  );

  assert.deepEqual(classifyExecutionFailure(hostile), {
    code: "untrusted_proxy_error",
    retryable: false
  });
  assert.equal(trapCalls, 0);
});

test("shared classification never invokes Error or typed-error accessors", () => {
  let getterCalls = 0;
  const hostileError = new Error("original");
  for (const key of ["name", "message"]) {
    Object.defineProperty(hostileError, key, {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(`${key} getter must not run`);
      }
    });
  }
  assert.deepEqual(classifyExecutionFailure(hostileError), {
    code: "stage_execution_failed",
    retryable: true
  });

  const hostileTyped = new ExecutionFailureError("original", true);
  Object.defineProperty(hostileTyped, "code", {
    configurable: true,
    get() {
      getterCalls += 1;
      return "forged";
    }
  });
  assert.deepEqual(classifyExecutionFailure(hostileTyped), {
    code: "invalid_execution_failure_error",
    retryable: false
  });
  assert.equal(getterCalls, 0);
});

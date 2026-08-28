import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactRef,
  createArtifactEnvelope,
  validateArtifactEnvelope,
  validateArtifactRef
} from "mission-pipeline/contracts/artifact";
import { validateUsageReceipt } from "mission-pipeline/contracts/usage-receipt";

function unavailableReceipt(overrides = {}) {
  return {
    schemaVersion: "usage-receipt.v1",
    trust: "unavailable",
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: 1,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 1,
    durationMs: 1,
    ...overrides
  };
}

function withObjectPrototypeProperties(descriptors, body) {
  const originals = new Map(
    Reflect.ownKeys(descriptors).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key)
    ])
  );
  try {
    Object.defineProperties(Object.prototype, descriptors);
    return body();
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) delete Object.prototype[key];
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
}

test("artifact validators require own fields and reject inherited complete records", () => {
  const inherited = createArtifactEnvelope("hostile.v1", { inherited: true });
  withObjectPrototypeProperties({
    contractId: {
      configurable: true,
      writable: true,
      value: inherited.contractId
    },
    digest: {
      configurable: true,
      writable: true,
      value: inherited.digest
    },
    bytes: {
      configurable: true,
      writable: true,
      value: inherited.bytes
    },
    payload: {
      configurable: true,
      writable: true,
      value: inherited.payload
    }
  }, () => {
    assert.throws(
      () => validateArtifactRef({}),
      /artifact ref: missing required key\(s\) "contractId", "digest"/
    );
    assert.throws(
      () => validateArtifactEnvelope({}),
      /artifact envelope: missing required key\(s\) "contractId", "digest"/
    );
    const noBytes = {
      contractId: inherited.contractId,
      digest: inherited.digest,
      payload: inherited.payload
    };
    const validated = validateArtifactEnvelope(noBytes);
    const projected = artifactRef(noBytes);
    assert.equal(Object.hasOwn(validated, "bytes"), false);
    assert.equal(Object.hasOwn(projected, "bytes"), false);
  });
});

test("usage optional fields ignore inherited getters without executing them", () => {
  let getterReads = 0;
  let result;
  withObjectPrototypeProperties({
    routeAlias: {
      configurable: true,
      get() {
        getterReads += 1;
        return "ambient-route";
      }
    },
    signature: {
      configurable: true,
      get() {
        getterReads += 1;
        return "ambient-signature";
      }
    }
  }, () => {
    result = validateUsageReceipt(unavailableReceipt());
    assert.equal(Object.hasOwn(result, "routeAlias"), false);
    assert.equal(Object.hasOwn(result, "signature"), false);
    assert.equal(getterReads, 0);
  });
  assert.equal(getterReads, 0);
  assert.ok(Object.isFrozen(result));
});

test("artifact aggregate depth guard rejects loudly before recursive stack exhaustion", () => {
  let payload = null;
  for (let index = 0; index < 20_000; index += 1) {
    payload = { child: payload };
  }
  assert.throws(
    () => validateArtifactEnvelope({
      contractId: "hostile.v1",
      digest: "0".repeat(64),
      payload
    }),
    (error) => {
      assert.equal(error instanceof RangeError, false);
      assert.match(
        error.message,
        /artifact envelope\.payload(?:\.child)+: artifact validation data exceeds the maximum depth of 64/
      );
      return true;
    }
  );
});

test("artifact aggregate value and string budgets reject before cloning", () => {
  assert.throws(
    () => createArtifactEnvelope(
      "hostile.v1",
      new Array(250_000).fill(null)
    ),
    /payload: artifact validation data exceeds the aggregate value budget of 250000/
  );
  assert.throws(
    () => createArtifactEnvelope(
      "hostile.v1",
      "x".repeat(16_777_217)
    ),
    /payload: artifact validation data exceeds the aggregate string budget of 16777216 UTF-16 code units/
  );
});

test("artifact and usage accessors and Proxies are rejected without trap execution", () => {
  const valid = createArtifactEnvelope("hostile.v1", { safe: true });
  let getterReads = 0;
  const accessorEnvelope = {
    contractId: valid.contractId,
    digest: valid.digest
  };
  Object.defineProperty(accessorEnvelope, "payload", {
    enumerable: true,
    get() {
      getterReads += 1;
      return valid.payload;
    }
  });
  assert.throws(
    () => validateArtifactEnvelope(accessorEnvelope),
    /artifact envelope\.payload must be an enumerable data property/
  );
  assert.equal(getterReads, 0);

  let proxyTrapReads = 0;
  const hostileProxy = new Proxy({}, {
    get() {
      proxyTrapReads += 1;
      return undefined;
    },
    getPrototypeOf() {
      proxyTrapReads += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTrapReads += 1;
      return [];
    }
  });
  assert.throws(
    () => createArtifactEnvelope("hostile.v1", hostileProxy),
    /payload: artifact validation data must not contain Proxies/
  );
  assert.throws(
    () => validateUsageReceipt(hostileProxy),
    /usage receipt must contain only bounded acyclic plain JSON data \(Proxies are not accepted\)/
  );
  assert.equal(proxyTrapReads, 0);
});

test("artifact snapshots reject symbols, sparse arrays, and cycles loudly", () => {
  const symbolPayload = { safe: true };
  Object.defineProperty(symbolPayload, Symbol("secret"), {
    enumerable: true,
    value: "hidden"
  });
  assert.throws(
    () => createArtifactEnvelope("hostile.v1", symbolPayload),
    /payload has symbol keys/
  );

  const sparsePayload = [];
  sparsePayload.length = 2;
  sparsePayload[1] = "present";
  assert.throws(
    () => createArtifactEnvelope("hostile.v1", sparsePayload),
    /payload: artifact validation data must be a dense array without extra keys/
  );

  const cyclicPayload = { safe: true };
  cyclicPayload.self = cyclicPayload;
  assert.throws(
    () => createArtifactEnvelope("hostile.v1", cyclicPayload),
    /payload\.self: artifact validation data must not be cyclic/
  );
});

test("successful artifact and usage validation returns detached frozen snapshots", () => {
  const source = { nested: { value: 1 } };
  const created = createArtifactEnvelope("hostile.v1", source);
  source.nested.value = 2;
  assert.deepEqual(created.payload, { nested: { value: 1 } });
  assert.ok(Object.isFrozen(created));
  assert.ok(Object.isFrozen(created.payload));
  assert.ok(Object.isFrozen(created.payload.nested));

  const validated = validateArtifactEnvelope(structuredClone(created));
  const ref = validateArtifactRef({
    contractId: validated.contractId,
    digest: validated.digest,
    bytes: validated.bytes
  });
  const receipt = validateUsageReceipt(unavailableReceipt());
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.payload));
  assert.ok(Object.isFrozen(ref));
  assert.ok(Object.isFrozen(receipt));
});

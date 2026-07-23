// mission-pipeline — the static compiled-DAG pipeline engine (promoted from
// inbox-pipeline): a CLOSED catalog of digest-sealed, content-addressed pipeline
// contracts compiled to a static DAG — no DSL. This barrel re-exports the B1
// contracts core + the B2 node model / definition / catalog / compiler + the
// B3 store port / memory store / durable executor / shard runner + the B4
// usage-receipt validator / prompt-component compiler / model binding +
// resolver port + the B5 gate module (decision-flow compiler, termination
// certificates, gate node executor — the module is named GATE, not decision:
// mission-swarm owns a "decision ledger"); B6 adds the agent-step contract +
// executor port + agent node invoker.
//
// STANDALONE RULE (import-boundary tests D+E): this package imports node:
// builtins + its own relative files ONLY — never mc-* workspace packages, never
// zod, never any npm dep. Other codebases consume it alone via file:/link:.

export * from "./contracts/digest.js";
export * from "./contracts/artifact.js";
export * from "./contracts/usage-receipt.js";
export * from "./node.js";
export * from "./definition.js";
export * from "./catalog.js";
export * from "./compile.js";
export * from "./store.js";
export * from "./memory-store.js";
export * from "./execute/durable-stage.js";
export * from "./execute/shard-runner.js";
export * from "./prompt/contracts.js";
export * from "./prompt/compiler.js";
export * from "./model/binding.js";
export * from "./model/invoker.js";
export * from "./gate/contracts.js";
export * from "./gate/certificate.js";
export * from "./gate/compiler.js";
export * from "./gate/executor.js";
// B6 — the frozen agent-step contract + executor port + agent node invoker.
export * from "./agent/step.js";
export * from "./agent/executor-port.js";
export * from "./agent/fake-executor.js";

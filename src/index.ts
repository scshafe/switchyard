// mission-pipeline — the static compiled-DAG pipeline engine (promoted from
// inbox-pipeline): a CLOSED catalog of digest-sealed, content-addressed pipeline
// contracts compiled to a static DAG — no DSL. This barrel re-exports the B1
// contracts core + the B2 node model / definition / catalog / compiler; B3+
// add execute/store/memory-store/prompt/gate/agent.
//
// STANDALONE RULE (import-boundary tests D+E): this package imports node:
// builtins + its own relative files ONLY — never mc-* workspace packages, never
// zod, never any npm dep. Other codebases consume it alone via file:/link:.

export * from "./contracts/digest.js";
export * from "./contracts/artifact.js";
export * from "./node.js";
export * from "./definition.js";
export * from "./catalog.js";
export * from "./compile.js";

// Support-ticket triage: a worked example of building one business objective
// ("does this ticket need an on-call escalation, and how urgently?") from
// small, focused model judgments and deterministic code, on the real engine.
//
// Everything here is fixture-only. The "model" is a table of canned answers
// keyed by (fixture, node); the store is the in-memory executable
// specification; no provider, credential, database, or network is involved.
// The graph, contracts, bindings, ports, runner, human-decision path, and the
// per-node code port adapter are the package's actual public API. The helpers
// at the bottom (journeyPath, modelCallsFor) are test conveniences; the
// engine's own execution-state projection is `projectUnitPath` in
// `store/unit-path`, exercised by test/switchyard-unit-path.test.mjs.
//
// The narrative for this graph lives in docs/EXAMPLE-SUPPORT-TRIAGE.md.

import { createArtifactEnvelope } from "@scshafe/switchyard/contracts/artifact";
import { digest } from "@scshafe/switchyard/contracts/digest";
import { codeNodePortByNode } from "@scshafe/switchyard/execute/code-port";
import { ExecutionFailureError } from "@scshafe/switchyard/execute/failure";
import {
  NODE_TURN_USAGE_EVENT_TYPE,
  recordHumanNodeDecision,
  runNextUnitTurn
} from "@scshafe/switchyard/execute/unit-runner";
import { compileGraph } from "@scshafe/switchyard/graph/compile";
import { createGoalManifest, GOAL_MANIFEST_SCHEMA_VERSION } from "@scshafe/switchyard/graph/goals";
import {
  createGraphDefinition,
  graphDefinitionRef,
  NODE_TURN_IDEMPOTENCY,
  NODE_TURN_RETRY_TAXONOMY
} from "@scshafe/switchyard/graph/definition";
import {
  createInferenceProfileRef,
  createModelStageBinding,
  modelStageBindingRef
} from "@scshafe/switchyard/model/binding";
import { modelTurnInvocationRequest, verifyResolvedModelBinding } from "@scshafe/switchyard/model/invoker";
import { MemoryGraphStore } from "@scshafe/switchyard/store/memory-graph-store";
import { MemoryUnitStore } from "@scshafe/switchyard/store/memory-unit-store";

/* ------------------------------------------------------------------------ */
/* Contracts, principals, turn policies                                       */
/* ------------------------------------------------------------------------ */

/** Versioned artifact contracts. Each step consumes the exact previous one. */
export const CONTRACTS = Object.freeze({
  ticket: "support-ticket.v1",
  context: "triage-context.v1",
  signal: "outage-signal.v1",
  grounded: "grounded-evidence.v1",
  verification: "outage-verification.v1",
  blastRadius: "blast-radius.v1",
  proposal: "escalation-proposal.v1",
  packet: "dispatch-packet.v1",
  escalation: "triage-escalation.v1",
  // Raw model response contracts: what the provider must return, host-validated.
  signalAnswer: "outage-signal-answer.v1",
  verifyAnswer: "outage-verify-answer.v1",
  blastRadiusAnswer: "blast-radius-answer.v1",
  summaryAnswer: "dispatch-summary-answer.v1",
  monolithAnswer: "triage-monolith-answer.v1"
});

export const PRINCIPALS = Object.freeze({
  admitter: "triage_admitter",
  worker: "triage_worker",
  console: "triage_console"
});

const MAX_TEXT_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 200;

function turn(maxAttempts) {
  return {
    idempotency: NODE_TURN_IDEMPOTENCY,
    leaseMs: 30_000,
    maxAttempts,
    retryTaxonomy: NODE_TURN_RETRY_TAXONOMY
  };
}

/* ------------------------------------------------------------------------ */
/* Model bindings: one resident model, one sealed profile per question        */
/* ------------------------------------------------------------------------ */

/** A content-addressed model revision. The digest is a fixture value. */
export const SMALL_JUDGE_MODEL = Object.freeze({
  id: "triage.small-judge",
  version: 1,
  digest: digest({ fixture: "small-judge-8b-q5" })
});

function profile(id, responseContract, maxOutputTokens) {
  return createInferenceProfileRef({
    id,
    version: 1,
    parameters: {
      temperature: 0,
      seed: 7,
      thinking: "off",
      timeoutMs: 30_000,
      maxOutputTokens,
      maxOutputBytes: 65_536,
      maxConcurrency: 1,
      toolPolicy: "none",
      responseContract
    }
  });
}

function binding(bindingId, inferenceProfileRef) {
  return createModelStageBinding({
    schemaVersion: "model-stage-binding.v2",
    bindingId,
    version: 1,
    kind: "model",
    modelRevisionRef: SMALL_JUDGE_MODEL,
    inferenceProfileRef
  });
}

/**
 * Every model invocation has its own sealed binding: same model revision,
 * different response contract and output budget. Any parameter change changes
 * the binding digest, the node fingerprint, and the graph digest.
 */
export const MODEL_BINDINGS = Object.freeze({
  outageSignal: binding("triage.outage-signal", profile("triage.outage-signal.profile", CONTRACTS.signalAnswer, 96)),
  outageVerify: binding("triage.outage-verify", profile("triage.outage-verify.profile", CONTRACTS.verifyAnswer, 48)),
  blastRadius: binding("triage.blast-radius", profile("triage.blast-radius.profile", CONTRACTS.blastRadiusAnswer, 48)),
  summary: binding("triage.dispatch-summary", profile("triage.dispatch-summary.profile", CONTRACTS.summaryAnswer, 160)),
  monolith: binding("triage.monolith", profile("triage.monolith.profile", CONTRACTS.monolithAnswer, 512))
});

/** The sealed bindings this host has published, by digest: what a node's binding ref resolves against. */
const SEALED_MODEL_BINDINGS = new Map(
  Object.values(MODEL_BINDINGS).map((sealed) => [sealed.bindingDigest, sealed])
);

/* ------------------------------------------------------------------------ */
/* The focused graph                                                          */
/* ------------------------------------------------------------------------ */

function node(nodeId, refId, kind, input, outcomes, options = {}) {
  const version = options.version ?? 1;
  return {
    nodeId,
    ref: { id: refId, version },
    kind,
    input,
    outcomes: { version, outcomes },
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
    principal: { id: kind === "human" ? PRINCIPALS.console : PRINCIPALS.worker },
    ...(options.binding === undefined ? {} : { binding: modelStageBindingRef(options.binding) }),
    ...(options.configuration === undefined ? {} : { configuration: options.configuration }),
    turn: turn(options.maxAttempts ?? 1)
  };
}

/* ------------------------------------------------------------------------ */
/* Policy: sealed, versioned, and pinned by the graph                          */
/* ------------------------------------------------------------------------ */

/**
 * The assembler's priority policy. It is host code, but its identity is
 * sealed into the graph: the `assemble` node pins this ref as its
 * configuration, the ref's digest enters the node fingerprint and every
 * attempt key, and the body refuses to run under any other ref. Changing a
 * rule means a new policy version, a new graph digest, and new attempt keys.
 */
export const PRIORITY_POLICY = Object.freeze({
  id: "triage.priority-policy",
  version: 1,
  rules: Object.freeze({ manyAffected: "p1", otherwise: "p2", unresolvedBlastRadius: "p2" })
});

export const PRIORITY_POLICY_REF = Object.freeze({
  id: PRIORITY_POLICY.id,
  version: PRIORITY_POLICY.version,
  digest: digest(PRIORITY_POLICY)
});

export const SUPPORT_TRIAGE_GRAPH_DRAFT = Object.freeze({
  graphId: "example.support-triage",
  version: 1,
  description: "Escalate a support ticket to on-call only when a focused outage judgment is grounded, verified, and validated; every uncertainty reaches a person.",
  entry: "normalize",
  nodes: [
    node("normalize", "triage.normalize", "code", CONTRACTS.ticket, ["ready", "malformed"], {
      // `malformed` returns no artifact: the ticket is carried forward as evidence.
      outputs: { ready: CONTRACTS.context, malformed: CONTRACTS.ticket }
    }),
    node("outage-signal", "triage.outage-signal", "model", CONTRACTS.context, ["yes", "no", "uncertain"], {
      binding: MODEL_BINDINGS.outageSignal,
      maxAttempts: 2,
      outputs: { yes: CONTRACTS.signal, no: CONTRACTS.signal, uncertain: CONTRACTS.escalation }
    }),
    node("ground-evidence", "triage.ground-evidence", "code", CONTRACTS.signal, ["grounded", "ungrounded"], {
      outputs: { grounded: CONTRACTS.grounded, ungrounded: CONTRACTS.escalation }
    }),
    node("outage-verify", "triage.outage-verify", "model", CONTRACTS.grounded, ["confirmed", "unsupported", "uncertain"], {
      binding: MODEL_BINDINGS.outageVerify,
      maxAttempts: 2,
      outputs: { confirmed: CONTRACTS.verification, unsupported: CONTRACTS.verification, uncertain: CONTRACTS.escalation }
    }),
    node("blast-radius", "triage.blast-radius", "model", CONTRACTS.verification, ["many", "single", "uncertain"], {
      binding: MODEL_BINDINGS.blastRadius,
      maxAttempts: 2,
      outputs: { many: CONTRACTS.blastRadius, single: CONTRACTS.blastRadius, uncertain: CONTRACTS.blastRadius }
    }),
    node("assemble", "triage.assemble", "code", CONTRACTS.blastRadius, ["proposed", "invalid"], {
      outputs: { proposed: CONTRACTS.proposal, invalid: CONTRACTS.escalation },
      configuration: PRIORITY_POLICY_REF
    }),
    node("summarize", "triage.summarize", "model", CONTRACTS.proposal, ["summarized", "unusable"], {
      binding: MODEL_BINDINGS.summary,
      maxAttempts: 2,
      outputs: { summarized: CONTRACTS.packet, unusable: CONTRACTS.packet }
    }),
    node("dispatch-review", "triage.dispatch-review", "human", CONTRACTS.packet, ["approved", "rejected"]),
    node("triage-review", "triage.triage-review", "human", CONTRACTS.escalation, ["escalate", "standard"])
  ],
  edges: [
    { edgeId: "normalize-ready", from: "normalize", when: { outcome: "ready" }, to: ["outage-signal"] },
    { edgeId: "signal-yes", from: "outage-signal", when: { outcome: "yes" }, to: ["ground-evidence"] },
    { edgeId: "signal-uncertain", from: "outage-signal", when: { outcome: "uncertain" }, to: ["triage-review"] },
    { edgeId: "evidence-grounded", from: "ground-evidence", when: { outcome: "grounded" }, to: ["outage-verify"] },
    { edgeId: "evidence-ungrounded", from: "ground-evidence", when: { outcome: "ungrounded" }, to: ["triage-review"] },
    { edgeId: "verify-confirmed", from: "outage-verify", when: { outcome: "confirmed" }, to: ["blast-radius"] },
    { edgeId: "verify-uncertain", from: "outage-verify", when: { outcome: "uncertain" }, to: ["triage-review"] },
    { edgeId: "blast-radius-assemble", from: "blast-radius", when: { anyOf: ["many", "single", "uncertain"] }, to: ["assemble"] },
    { edgeId: "assemble-proposed", from: "assemble", when: { outcome: "proposed" }, to: ["summarize"] },
    { edgeId: "assemble-invalid", from: "assemble", when: { outcome: "invalid" }, to: ["triage-review"] },
    { edgeId: "summarize-dispatch", from: "summarize", when: { anyOf: ["summarized", "unusable"] }, to: ["dispatch-review"] }
  ],
  terminals: [
    { nodeId: "normalize", outcome: "malformed" },
    { nodeId: "outage-signal", outcome: "no" },
    { nodeId: "outage-verify", outcome: "unsupported" },
    { nodeId: "dispatch-review", outcome: "approved" },
    { nodeId: "dispatch-review", outcome: "rejected" },
    { nodeId: "triage-review", outcome: "escalate" },
    { nodeId: "triage-review", outcome: "standard" }
  ]
});

export const SUPPORT_TRIAGE_GRAPH = createGraphDefinition(SUPPORT_TRIAGE_GRAPH_DRAFT);
export const COMPILED_SUPPORT_TRIAGE_GRAPH = compileGraph(SUPPORT_TRIAGE_GRAPH);

/**
 * The goal manifest: the one logical objective in this graph, which members
 * pursue it, and the exact (node, outcome) pairs that close it. `resolved`
 * means the members decided by themselves; `escalated` means they handed the
 * decision to the person at `triage-review`. Sealed against the graph digest,
 * so a graph change re-seals it (the draft rarely changes). Nothing here
 * enters the graph digest; the engine never reads it.
 */
export const SUPPORT_TRIAGE_GOALS_DRAFT = Object.freeze({
  schemaVersion: GOAL_MANIFEST_SCHEMA_VERSION,
  goals: [
    {
      goalId: "outage-escalation",
      entry: "outage-signal",
      members: ["outage-signal", "ground-evidence", "outage-verify", "blast-radius", "assemble"],
      resolutions: [
        { nodeId: "outage-signal", outcome: "no", kind: "resolved" },
        { nodeId: "outage-signal", outcome: "uncertain", kind: "escalated" },
        { nodeId: "ground-evidence", outcome: "ungrounded", kind: "escalated" },
        { nodeId: "outage-verify", outcome: "unsupported", kind: "resolved" },
        { nodeId: "outage-verify", outcome: "uncertain", kind: "escalated" },
        { nodeId: "assemble", outcome: "proposed", kind: "resolved" },
        { nodeId: "assemble", outcome: "invalid", kind: "escalated" }
      ]
    }
  ]
});
export const SUPPORT_TRIAGE_GOAL_MANIFEST = createGoalManifest(SUPPORT_TRIAGE_GRAPH, SUPPORT_TRIAGE_GOALS_DRAFT);

/* ------------------------------------------------------------------------ */
/* The overloaded single-node comparison                                      */
/* ------------------------------------------------------------------------ */

export const SUPPORT_TRIAGE_MONOLITH_DRAFT = Object.freeze({
  graphId: "example.support-triage-monolith",
  version: 1,
  description: "The same objective answered by one broad model call whose port assembles the packet and applies the confidence policy.",
  entry: "normalize",
  nodes: [
    node("normalize", "triage.normalize", "code", CONTRACTS.ticket, ["ready", "malformed"], {
      outputs: { ready: CONTRACTS.context, malformed: CONTRACTS.ticket }
    }),
    node("triage", "triage.monolith", "model", CONTRACTS.context, ["proposed", "standard", "uncertain"], {
      binding: MODEL_BINDINGS.monolith,
      maxAttempts: 2,
      outputs: { proposed: CONTRACTS.packet, standard: CONTRACTS.context, uncertain: CONTRACTS.escalation }
    }),
    node("dispatch-review", "triage.dispatch-review", "human", CONTRACTS.packet, ["approved", "rejected"]),
    node("triage-review", "triage.triage-review", "human", CONTRACTS.escalation, ["escalate", "standard"])
  ],
  edges: [
    { edgeId: "normalize-ready", from: "normalize", when: { outcome: "ready" }, to: ["triage"] },
    { edgeId: "triage-proposed", from: "triage", when: { outcome: "proposed" }, to: ["dispatch-review"] },
    { edgeId: "triage-uncertain", from: "triage", when: { outcome: "uncertain" }, to: ["triage-review"] }
  ],
  terminals: [
    { nodeId: "normalize", outcome: "malformed" },
    { nodeId: "triage", outcome: "standard" },
    { nodeId: "dispatch-review", outcome: "approved" },
    { nodeId: "dispatch-review", outcome: "rejected" },
    { nodeId: "triage-review", outcome: "escalate" },
    { nodeId: "triage-review", outcome: "standard" }
  ]
});

export const SUPPORT_TRIAGE_MONOLITH_GRAPH = createGraphDefinition(SUPPORT_TRIAGE_MONOLITH_DRAFT);

/** The same goal, pursued by one member: the broad call closes it by itself or escalates. */
export const SUPPORT_TRIAGE_MONOLITH_GOALS_DRAFT = Object.freeze({
  schemaVersion: GOAL_MANIFEST_SCHEMA_VERSION,
  goals: [
    {
      goalId: "outage-escalation",
      entry: "triage",
      members: ["triage"],
      resolutions: [
        { nodeId: "triage", outcome: "proposed", kind: "resolved" },
        { nodeId: "triage", outcome: "standard", kind: "resolved" },
        { nodeId: "triage", outcome: "uncertain", kind: "escalated" }
      ]
    }
  ]
});
export const SUPPORT_TRIAGE_MONOLITH_GOAL_MANIFEST = createGoalManifest(
  SUPPORT_TRIAGE_MONOLITH_GRAPH,
  SUPPORT_TRIAGE_MONOLITH_GOALS_DRAFT
);

/** The confidence bar the monolith port applies. It lives in code, not in any sealed identity. */
export const MONOLITH_CONFIDENCE_BAR = 0.7;

/* ------------------------------------------------------------------------ */
/* Fixtures: tickets, canned model answers, human decisions                   */
/* ------------------------------------------------------------------------ */

function usage(input, output) {
  return { input, output };
}

export const FIXTURES = Object.freeze({
  positive: {
    unitId: "ticket-4101",
    ticket: {
      ticketId: "4101",
      product: "console",
      customerTier: "enterprise",
      subject: "Production is down",
      body: "Since 09:10 UTC none of our 40 agents can log in to the console; the API returns 503 on every request. Production is down for us.",
      openedAt: "2026-09-10T09:14:00Z"
    },
    answers: {
      "outage-signal": { response: { answer: "yes", evidence: [{ quote: "none of our 40 agents can log in" }] }, usage: usage(412, 21) },
      "outage-verify": { response: { verdict: "confirmed" }, usage: usage(455, 6) },
      "blast-radius": { response: { answer: "many" }, usage: usage(470, 5) },
      summarize: { response: { summary: "Enterprise console outage: 40 agents cannot log in, API 503 since 09:10 UTC." }, usage: usage(310, 32) },
      triage: {
        response: { outage: true, blastRadius: "many", priority: "p1", summary: "Console outage for an enterprise customer.", confidence: 0.92, category: "incident" },
        usage: usage(690, 88)
      }
    },
    decisions: { "dispatch-review": "approved" }
  },
  negative: {
    unitId: "ticket-4102",
    ticket: {
      ticketId: "4102",
      product: "mobile",
      customerTier: "free",
      subject: "Feature request",
      body: "Could you add dark mode to the mobile app? It would be lovely for late-night reading.",
      openedAt: "2026-09-10T09:20:00Z"
    },
    answers: {
      "outage-signal": { response: { answer: "no", evidence: [] }, usage: usage(380, 9) },
      triage: {
        response: { outage: false, blastRadius: "unknown", priority: "p2", summary: "Dark mode feature request.", confidence: 0.95, category: "feature_request" },
        usage: usage(660, 71)
      }
    },
    decisions: {}
  },
  ambiguous: {
    unitId: "ticket-4103",
    ticket: {
      ticketId: "4103",
      product: "console",
      customerTier: "business",
      subject: "Slow today?",
      body: "Things seem slow today, not sure if it is us or you. Sometimes pages do not load, sometimes they do.",
      openedAt: "2026-09-10T09:25:00Z"
    },
    answers: {
      "outage-signal": { response: { answer: "uncertain", evidence: [{ quote: "Sometimes pages do not load" }] }, usage: usage(398, 17) },
      triage: {
        response: { outage: true, blastRadius: "unknown", priority: "p2", summary: "Intermittent slowness.", confidence: 0.55, category: "incident" },
        usage: usage(672, 80)
      }
    },
    decisions: { "triage-review": "standard" }
  },
  "fabricated-evidence": {
    unitId: "ticket-4104",
    ticket: {
      ticketId: "4104",
      product: "exports",
      customerTier: "business",
      subject: "Export hiccup",
      body: "Our nightly export failed once last week but has run fine every night since. Just letting you know.",
      openedAt: "2026-09-10T09:30:00Z"
    },
    answers: {
      // The quote is not in the ticket. Deterministic grounding must refuse it.
      "outage-signal": { response: { answer: "yes", evidence: [{ quote: "export is failing every night" }] }, usage: usage(402, 19) },
      triage: {
        response: { outage: true, blastRadius: "single", priority: "p2", summary: "Nightly export failing.", confidence: 0.81, category: "incident" },
        usage: usage(668, 76)
      }
    },
    decisions: { "triage-review": "standard" }
  },
  "provider-outage": {
    unitId: "ticket-4105",
    ticket: {
      ticketId: "4105",
      product: "console",
      customerTier: "enterprise",
      subject: "Production is down",
      body: "Since 09:10 UTC none of our 40 agents can log in to the console; the API returns 503 on every request. Production is down for us.",
      openedAt: "2026-09-10T09:35:00Z"
    },
    answers: {
      "outage-signal": { failure: { code: "dependency_unavailable", retryable: true } },
      triage: { failure: { code: "dependency_unavailable", retryable: true } }
    },
    decisions: {}
  },
  "unusable-summary": {
    unitId: "ticket-4106",
    ticket: {
      ticketId: "4106",
      product: "console",
      customerTier: "business",
      subject: "Cannot log in",
      body: "Since 08:55 UTC our whole team cannot log in; every attempt returns a 503 error page.",
      openedAt: "2026-09-10T09:40:00Z"
    },
    answers: {
      "outage-signal": { response: { answer: "yes", evidence: [{ quote: "our whole team cannot log in" }] }, usage: usage(405, 20) },
      "outage-verify": { response: { verdict: "confirmed" }, usage: usage(448, 6) },
      "blast-radius": { response: { answer: "uncertain" }, usage: usage(461, 5) },
      // A response that does not satisfy the summary contract.
      summarize: { response: { summary: "" }, usage: usage(300, 1) }
    },
    decisions: { "dispatch-review": "approved" }
  }
});

/* ------------------------------------------------------------------------ */
/* Code bodies: deterministic normalization, grounding, assembly              */
/* ------------------------------------------------------------------------ */

function previousRef(context) {
  return { contractId: context.inputArtifact.contractId, digest: context.inputArtifact.digest };
}

function escalation(step, reason, context, detail, carried) {
  return createArtifactEnvelope(CONTRACTS.escalation, {
    step,
    reason,
    detail,
    input: previousRef(context),
    context: carried
  });
}

const KNOWN_TIERS = new Set(["free", "business", "enterprise"]);

export const CODE_BODIES = Object.freeze({
  /** Deterministic input normalization. Malformed input is a quiet end. */
  async normalize(input, context) {
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (typeof input.ticketId !== "string" || input.ticketId.length === 0 || body.length === 0) {
      return { outcome: "malformed" };
    }
    const text = `${subject}\n\n${body}`.slice(0, MAX_TEXT_CHARS);
    return {
      outcome: "ready",
      outputArtifact: createArtifactEnvelope(CONTRACTS.context, {
        ticket: {
          ticketId: input.ticketId,
          product: typeof input.product === "string" ? input.product : "unknown",
          customerTier: typeof input.customerTier === "string" ? input.customerTier : "unknown"
        },
        text,
        source: previousRef(context)
      })
    };
  },

  /** Every quoted span must be a literal substring of the normalized text. */
  async "ground-evidence"(input, context) {
    const text = input.context.text;
    const quotes = input.signal.evidence.map((entry) => entry.quote);
    const missing = quotes.filter((quote) => quote.length === 0 || !text.includes(quote));
    if (quotes.length === 0 || missing.length > 0) {
      return {
        outcome: "ungrounded",
        outputArtifact: escalation("ground-evidence", "ungrounded_evidence", context, { missingQuotes: missing }, input.context)
      };
    }
    return {
      outcome: "grounded",
      outputArtifact: createArtifactEnvelope(CONTRACTS.grounded, {
        ...input,
        grounding: {
          quotes: quotes.map((quote) => ({ quote, offset: text.indexOf(quote) })),
          previous: previousRef(context)
        }
      })
    };
  },

  /** Deterministic validation, the pinned priority policy, and proposal assembly. */
  async assemble(input, context) {
    const pinned = context.configuration;
    if (
      pinned === undefined
      || pinned.id !== PRIORITY_POLICY_REF.id
      || pinned.version !== PRIORITY_POLICY_REF.version
      || pinned.digest !== PRIORITY_POLICY_REF.digest
    ) {
      throw new ExecutionFailureError(
        "immutable_configuration_rejected",
        false,
        new Error(`assemble is pinned to ${PRIORITY_POLICY_REF.id}@${PRIORITY_POLICY_REF.version} (${PRIORITY_POLICY_REF.digest}); the graph pins ${pinned === undefined ? "nothing" : `${pinned.id}@${pinned.version} (${pinned.digest})`}`)
      );
    }
    const problems = [];
    if (input.verification?.verdict !== "confirmed") problems.push("verification_not_confirmed");
    if (!Array.isArray(input.grounding?.quotes) || input.grounding.quotes.length === 0) problems.push("no_grounded_evidence");
    if (!KNOWN_TIERS.has(input.context?.ticket?.customerTier)) problems.push("unknown_customer_tier");
    if (problems.length > 0) {
      return {
        outcome: "invalid",
        outputArtifact: escalation("assemble", "validator_refused", context, { problems }, input.context)
      };
    }
    const blast = input.blastRadius.answer;
    const blastRadius = blast === "uncertain" ? "unresolved" : blast;
    const priority = blast === "many"
      ? PRIORITY_POLICY.rules.manyAffected
      : blast === "uncertain"
        ? PRIORITY_POLICY.rules.unresolvedBlastRadius
        : PRIORITY_POLICY.rules.otherwise;
    const ticket = input.context.ticket;
    return {
      outcome: "proposed",
      outputArtifact: createArtifactEnvelope(CONTRACTS.proposal, {
        ticket,
        priority,
        blastRadius,
        evidence: input.grounding.quotes,
        fallbackSummary: `${ticket.product}: outage reported by ticket ${ticket.ticketId} (${ticket.customerTier}); blast radius ${blastRadius}; priority ${priority}.`,
        provenance: {
          seed: input.context.source,
          steps: [
            { nodeId: "outage-signal", input: input.signal.previous },
            { nodeId: "ground-evidence", input: input.grounding.previous },
            { nodeId: "outage-verify", input: input.verification.previous },
            { nodeId: "blast-radius", input: input.blastRadius.previous },
            { nodeId: "assemble", input: previousRef(context) }
          ]
        }
      })
    };
  }
});

/* ------------------------------------------------------------------------ */
/* Model port: canned answers validated against each node's response contract */
/* ------------------------------------------------------------------------ */

function receipt(tokens) {
  return {
    schemaVersion: "usage-receipt.v1",
    trust: "provider_reported",
    observedInputTokens: tokens.input,
    observedOutputTokens: tokens.output,
    chargedTokens: tokens.input + tokens.output,
    observedCostMicroUsd: 0,
    chargedCostMicroUsd: 0,
    durationMs: 250
  };
}

function isQuoteList(value) {
  return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === "object" && typeof entry.quote === "string");
}

function packet(proposal, summaryText, source, context) {
  return createArtifactEnvelope(CONTRACTS.packet, {
    proposal,
    summary: { text: summaryText, source, previous: previousRef(context) }
  });
}

/** One focused answer becomes one declared outcome plus one sealed artifact. */
const MODEL_ANSWERS = Object.freeze({
  "outage-signal"(input, response, context) {
    const valid = response !== null && typeof response === "object"
      && ["yes", "no", "uncertain"].includes(response.answer)
      && isQuoteList(response.evidence);
    if (!valid) {
      return { outcome: "uncertain", outputArtifact: escalation("outage-signal", "unusable_response", context, {}, input) };
    }
    if (response.answer === "uncertain") {
      return {
        outcome: "uncertain",
        outputArtifact: escalation("outage-signal", "uncertain_answer", context, { evidence: response.evidence }, input)
      };
    }
    return {
      outcome: response.answer,
      outputArtifact: createArtifactEnvelope(CONTRACTS.signal, {
        context: input,
        signal: { answer: response.answer, evidence: response.evidence, previous: previousRef(context) }
      })
    };
  },

  "outage-verify"(input, response, context) {
    const verdict = response !== null && typeof response === "object" ? response.verdict : undefined;
    if (!["confirmed", "unsupported", "uncertain"].includes(verdict)) {
      return { outcome: "uncertain", outputArtifact: escalation("outage-verify", "unusable_response", context, {}, input.context) };
    }
    if (verdict === "uncertain") {
      return { outcome: "uncertain", outputArtifact: escalation("outage-verify", "uncertain_answer", context, {}, input.context) };
    }
    return {
      outcome: verdict,
      outputArtifact: createArtifactEnvelope(CONTRACTS.verification, {
        ...input,
        verification: { verdict, previous: previousRef(context) }
      })
    };
  },

  /** Uncertainty here is carried forward as an explicit fact, not escalated. */
  "blast-radius"(input, response, context) {
    const answer = response !== null && typeof response === "object" ? response.answer : undefined;
    const carried = ["many", "single", "uncertain"].includes(answer) ? answer : "uncertain";
    return {
      outcome: carried,
      outputArtifact: createArtifactEnvelope(CONTRACTS.blastRadius, {
        ...input,
        blastRadius: { answer: carried, usable: carried === answer, previous: previousRef(context) }
      })
    };
  },

  /** A failed summary never changes routing: the deterministic line stands in. */
  summarize(input, response, context) {
    const text = response !== null && typeof response === "object" ? response.summary : undefined;
    const usable = typeof text === "string" && text.trim().length > 0 && text.length <= MAX_SUMMARY_CHARS;
    return usable
      ? { outcome: "summarized", outputArtifact: packet(input, text.trim(), "model", context) }
      : { outcome: "unusable", outputArtifact: packet(input, input.fallbackSummary, "deterministic", context) };
  },

  /** The overloaded call: the port must validate a wide payload and apply policy itself. */
  triage(input, response, context) {
    const valid = response !== null && typeof response === "object"
      && typeof response.outage === "boolean"
      && ["many", "single", "unknown"].includes(response.blastRadius)
      && ["p1", "p2"].includes(response.priority)
      && typeof response.summary === "string"
      && typeof response.confidence === "number"
      && typeof response.category === "string";
    if (!valid || response.confidence < MONOLITH_CONFIDENCE_BAR) {
      return {
        outcome: "uncertain",
        outputArtifact: escalation("triage", valid ? "low_confidence" : "unusable_response", context, {}, input)
      };
    }
    if (!response.outage) return { outcome: "standard" };
    const proposal = {
      ticket: input.ticket,
      priority: response.priority,
      blastRadius: response.blastRadius === "unknown" ? "unresolved" : response.blastRadius,
      evidence: [],
      fallbackSummary: `${input.ticket.product}: outage reported by ticket ${input.ticket.ticketId} (${input.ticket.customerTier}); priority ${response.priority}.`,
      provenance: { seed: input.source, steps: [{ nodeId: "triage", input: previousRef(context) }] }
    };
    return { outcome: "proposed", outputArtifact: packet(proposal, response.summary, "model", context) };
  }
});

/* ------------------------------------------------------------------------ */
/* Model port: the host-side call path, with a fixture resolver behind it     */
/* ------------------------------------------------------------------------ */

/**
 * A ModelBindingResolver that answers from the fixture instead of a provider.
 * It sees exactly what a real resolver sees: the sealed binding at resolve
 * time and the v2 request at invoke time. Every request it receives is
 * logged, so a test can prove the provider boundary saw the journey's own
 * attempt identity.
 */
function fixtureModelResolver(fixture, log) {
  return {
    resolve(binding) {
      return {
        async invoke(request) {
          if (request.binding.bindingDigest !== binding.bindingDigest) {
            throw new ExecutionFailureError("model_binding_unresolved", false, new Error("request names another binding"));
          }
          log.push(request);
          const canned = fixture.answers[request.nodeId];
          if (canned === undefined) throw new ExecutionFailureError("fixture_answer_missing", false);
          if (canned.failure !== undefined) {
            throw new ExecutionFailureError(canned.failure.code, canned.failure.retryable);
          }
          return { output: canned.response, usage: receipt(canned.usage) };
        }
      };
    }
  };
}

/**
 * The model node port a host writes. It resolves the node's binding ref
 * against the published sealed bindings, builds the v2 request from the
 * input, ref, and context it was handed, verifies the resolver's capability
 * and prompt identity, makes the one call, and parses the output into the
 * node's declared outcome. Nothing here knows which provider answers.
 */
function modelNodePortFor(resolver, sealedBindings) {
  return {
    async invoke(input, bindingRef, context) {
      const binding = sealedBindings.get(bindingRef.bindingDigest);
      if (binding === undefined) {
        throw new ExecutionFailureError(
          "model_binding_unresolved",
          false,
          new Error(`no sealed binding published for ${bindingRef.bindingId}@${bindingRef.version}`)
        );
      }
      const request = modelTurnInvocationRequest({ context, input, bindingRef, binding });
      const resolved = verifyResolvedModelBinding(await resolver.resolve(request.binding), request.binding);
      const result = await resolved.invoke(request, context.signal);
      const completion = MODEL_ANSWERS[context.nodeId](input, result.output, context);
      return { ...completion, usage: [result.usage] };
    }
  };
}

export function createSupportTriagePorts(fixture, modelRequestLog = []) {
  return {
    code: codeNodePortByNode(CODE_BODIES),
    model: modelNodePortFor(fixtureModelResolver(fixture, modelRequestLog), SEALED_MODEL_BINDINGS)
  };
}

/* ------------------------------------------------------------------------ */
/* Harness: deterministic clock and ids, drain, decide, inspect               */
/* ------------------------------------------------------------------------ */

export function createSupportTriageHarness(options) {
  const fixture = options.fixture;
  const graph = options.graph ?? SUPPORT_TRIAGE_GRAPH;
  const prefix = options.prefix ?? "triage";
  let epoch = Date.parse("2026-09-10T09:00:00.000Z");
  let sequence = 0;
  const now = () => {
    epoch += 1_000;
    return new Date(epoch);
  };
  const graphStore = new MemoryGraphStore();
  const unitStore = new MemoryUnitStore({
    graphStore,
    now,
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`
  });
  const modelRequests = [];
  const ports = createSupportTriagePorts(fixture, modelRequests);

  async function admit() {
    await graphStore.publishGraph(graph);
    return unitStore.admitUnit({
      unitId: fixture.unitId,
      graph: graphDefinitionRef(graph),
      seedArtifact: createArtifactEnvelope(CONTRACTS.ticket, fixture.ticket),
      admittedAt: now().toISOString(),
      principalId: PRINCIPALS.admitter
    });
  }

  /** Run worker turns until no code/model queue is claimable. */
  async function drain() {
    const results = [];
    for (;;) {
      const result = await runNextUnitTurn({
        store: unitStore,
        principalId: PRINCIPALS.worker,
        leaseOwner: `${prefix}-worker`,
        ports,
        now
      });
      if (result === undefined) return Object.freeze(results);
      results.push(result);
    }
  }

  /** Record a human decision at a queued human node. */
  async function decide(nodeId, outcome, actorId = "dispatcher-1") {
    const queued = await unitStore.listQueuedUnits({ principalId: PRINCIPALS.console, nodeId });
    if (queued.length !== 1) {
      throw new Error(`expected exactly one unit queued at ${nodeId}, found ${queued.length}`);
    }
    const [waiting] = queued;
    return recordHumanNodeDecision({
      store: unitStore,
      principalId: PRINCIPALS.console,
      decision: {
        queueId: waiting.queueId,
        unitId: waiting.unitId,
        nodeId,
        outcome,
        actor: { actorId }
      },
      now
    });
  }

  /** Every open queue for this unit, by node, under the node's own principal. */
  async function openQueues() {
    const open = [];
    for (const graphNode of graph.nodes) {
      const queued = await unitStore.listQueuedUnits({ principalId: graphNode.principal.id, nodeId: graphNode.nodeId });
      for (const entry of queued) {
        if (entry.unitId === fixture.unitId) open.push({ nodeId: graphNode.nodeId, kind: graphNode.kind, contractId: entry.inputArtifact.contractId });
      }
    }
    return Object.freeze(open);
  }

  return Object.freeze({
    fixture,
    graph,
    unitStore,
    now,
    admit,
    drain,
    decide,
    openQueues,
    journey: () => unitStore.readJourney({ unitId: fixture.unitId }),
    artifact: (ref) => unitStore.getArtifact({ artifact: ref }),
    deadLetters: () => unitStore.listDeadLetters({ unitId: fixture.unitId }),
    modelCalls: () => modelCallsFor(unitStore, fixture.unitId),
    /** Every v2 request the fixture resolver received, in call order. */
    modelRequests: () => Object.freeze([...modelRequests])
  });
}

/* ------------------------------------------------------------------------ */
/* Presentation: consumer-owned words, kept out of the sealed definition      */
/* ------------------------------------------------------------------------ */

/**
 * What a reader is told about each node, which ends carry a result out of the
 * graph, and which ends are quiet. None of this enters the graph digest; the
 * coverage check below proves it matches the sealed graph exactly. It is the
 * shape docs/ADR-GRAPHPAPER-FRONTEND-SDK.md calls a consumer presentation.
 */
export const SUPPORT_TRIAGE_PRESENTATION = Object.freeze({
  title: "Support triage",
  nodes: {
    normalize: { name: "Normalizer", summary: "Trims and bounds the ticket text and pins the exact seed digest. Malformed input stops here." },
    "outage-signal": { name: "Outage signal", question: "Does this ticket report a service outage or data loss affecting the customer now?", summary: "One focused yes/no/uncertain judgment with quoted evidence." },
    "ground-evidence": { name: "Evidence grounding", summary: "Deterministic: every quoted span must be a literal substring of the normalized text." },
    "outage-verify": { name: "Outage verifier", question: "Do the quoted spans literally support an active outage, not a past, hypothetical, or feature request?", summary: "A second focused call that sees only grounded evidence." },
    "blast-radius": { name: "Blast radius", question: "Are more than one user or account affected?", summary: "Asked only after a confirmed outage; an uncertain answer is carried forward as an explicit fact." },
    assemble: { name: "Proposal assembler", summary: "Deterministic validation of the whole chain, the priority policy, and the escalation proposal with its provenance." },
    summarize: { name: "Dispatch summary", question: "Write one line for the dispatcher.", summary: "Optional prose; an unusable answer falls back to the deterministic line and never changes routing." },
    "dispatch-review": { name: "Dispatcher review", question: "Page on-call with this proposal?", summary: "A person approves or rejects the escalation." },
    "triage-review": { name: "Triage review", question: "The automatic path could not decide. Escalate, or send to the standard queue?", summary: "Every uncertainty and validator refusal lands here with the exact context it came from." }
  },
  goals: {
    // Grouping follows the goal manifest; the words are the presentation's.
    "outage-escalation": {
      name: "Outage escalation",
      members: SUPPORT_TRIAGE_GOALS_DRAFT.goals[0].members
    }
  },
  endpoints: [
    {
      id: "on-call",
      name: "On-call page",
      exits: [
        { nodeId: "dispatch-review", outcome: "approved" },
        { nodeId: "triage-review", outcome: "escalate" }
      ]
    }
  ],
  terminals: [
    {
      id: "standard-queue",
      name: "Standard queue",
      ends: [
        { nodeId: "outage-signal", outcome: "no" },
        { nodeId: "outage-verify", outcome: "unsupported" },
        { nodeId: "dispatch-review", outcome: "rejected" },
        { nodeId: "triage-review", outcome: "standard" }
      ]
    },
    {
      id: "rejected-input",
      name: "Rejected input",
      ends: [{ nodeId: "normalize", outcome: "malformed" }]
    }
  ]
});

/**
 * Coverage problems between a sealed graph and a presentation. Empty means the
 * words match the definition exactly: every node named, every model and human
 * node asked a question, every declared terminal claimed by exactly one sink,
 * no sink claiming an outcome the graph does not declare terminal, and every
 * goal member a real node in at most one goal.
 */
export function presentationCoverage(graph, presentation) {
  const problems = [];
  const nodeIds = new Set(graph.nodes.map((graphNode) => graphNode.nodeId));
  for (const graphNode of graph.nodes) {
    const shown = presentation.nodes[graphNode.nodeId];
    if (shown === undefined) {
      problems.push(`node ${graphNode.nodeId} has no presentation`);
      continue;
    }
    if (graphNode.kind !== "code" && typeof shown.question !== "string") {
      problems.push(`${graphNode.kind} node ${graphNode.nodeId} states no question`);
    }
  }
  for (const nodeId of Object.keys(presentation.nodes)) {
    if (!nodeIds.has(nodeId)) problems.push(`presentation names unknown node ${nodeId}`);
  }
  const claimed = new Map();
  const sinks = [
    ...presentation.endpoints.map((sink) => ({ id: sink.id, ends: sink.exits })),
    ...presentation.terminals.map((sink) => ({ id: sink.id, ends: sink.ends }))
  ];
  for (const sink of sinks) {
    for (const end of sink.ends) {
      const key = `${end.nodeId}:${end.outcome}`;
      if (claimed.has(key)) problems.push(`terminal ${key} is claimed by ${claimed.get(key)} and ${sink.id}`);
      claimed.set(key, sink.id);
      if (!graph.terminals.some((terminal) => terminal.nodeId === end.nodeId && terminal.outcome === end.outcome)) {
        problems.push(`sink ${sink.id} claims ${key}, which the graph does not declare terminal`);
      }
    }
  }
  for (const terminal of graph.terminals) {
    const key = `${terminal.nodeId}:${terminal.outcome}`;
    if (!claimed.has(key)) problems.push(`terminal ${key} is not presented`);
  }
  const membership = new Map();
  for (const [goalId, goal] of Object.entries(presentation.goals)) {
    for (const member of goal.members) {
      if (!nodeIds.has(member)) problems.push(`goal ${goalId} names unknown node ${member}`);
      if (membership.has(member)) problems.push(`node ${member} belongs to goals ${membership.get(member)} and ${goalId}`);
      membership.set(member, goalId);
    }
  }
  return Object.freeze(problems);
}

function mermaidId(id) {
  return id.replace(/[^a-z0-9_]/giu, "_");
}

function edgeOutcomes(when) {
  return Object.hasOwn(when, "anyOf") ? when.anyOf : [when.outcome];
}

/**
 * A Mermaid flowchart derived from the sealed graph and its presentation, so
 * the picture in docs/EXAMPLE-SUPPORT-TRIAGE.md can never drift from the
 * definition: a test compares the two. Shapes say the kind (rectangle: code,
 * hexagon: model, parallelogram: human); dashed arrows are declared terminals
 * landing on a presented sink; the goal grouping is a presentation choice.
 */
export function renderSupportTriageMermaid(graph = SUPPORT_TRIAGE_GRAPH, presentation = SUPPORT_TRIAGE_PRESENTATION) {
  const problems = presentationCoverage(graph, presentation);
  if (problems.length > 0) throw new Error(`presentation does not cover the graph: ${problems.join("; ")}`);
  const lines = ["flowchart TD"];
  const shape = (graphNode) => {
    const label = `"${presentation.nodes[graphNode.nodeId].name}"`;
    if (graphNode.kind === "model") return `{{${label}}}`;
    if (graphNode.kind === "human") return `[/${label}/]`;
    return `[${label}]`;
  };
  const inGoal = new Map();
  for (const [goalId, goal] of Object.entries(presentation.goals)) {
    for (const member of goal.members) inGoal.set(member, goalId);
  }
  for (const graphNode of graph.nodes) {
    if (!inGoal.has(graphNode.nodeId)) lines.push(`  ${mermaidId(graphNode.nodeId)}${shape(graphNode)}`);
  }
  for (const [goalId, goal] of Object.entries(presentation.goals)) {
    lines.push(`  subgraph ${mermaidId(goalId)}["${goal.name}"]`);
    for (const member of goal.members) {
      const graphNode = graph.nodes.find((candidate) => candidate.nodeId === member);
      lines.push(`    ${mermaidId(member)}${shape(graphNode)}`);
    }
    lines.push("  end");
  }
  for (const endpoint of presentation.endpoints) lines.push(`  sink_${mermaidId(endpoint.id)}[["${endpoint.name}"]]`);
  for (const terminal of presentation.terminals) lines.push(`  end_${mermaidId(terminal.id)}(("${terminal.name}"))`);
  for (const edge of graph.edges) {
    for (const target of edge.to) {
      lines.push(`  ${mermaidId(edge.from)} -->|${edgeOutcomes(edge.when).join(" / ")}| ${mermaidId(target)}`);
    }
  }
  for (const endpoint of presentation.endpoints) {
    for (const exit of endpoint.exits) lines.push(`  ${mermaidId(exit.nodeId)} -.->|${exit.outcome}| sink_${mermaidId(endpoint.id)}`);
  }
  for (const terminal of presentation.terminals) {
    for (const end of terminal.ends) lines.push(`  ${mermaidId(end.nodeId)} -.->|${end.outcome}| end_${mermaidId(terminal.id)}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Journey helpers (application-level; see the friction review)               */
/* ------------------------------------------------------------------------ */

/** The path a unit took, one entry per settled or failed turn. */
export function journeyPath(journey) {
  return journey.flatMap((record) => {
    if (record.kind === "turn_settled") return [`${record.nodeId}:${record.outcome}`];
    if (record.kind === "turn_failed") {
      return [`${record.nodeId}!${record.errorCode}${record.terminal ? ":terminal" : ":retry"}`];
    }
    if (record.kind === "join_unsatisfiable") return [`${record.nodeId}:join_unsatisfiable`];
    return [];
  });
}

/** Per-attempt usage receipts the runner appended to the outbox for one unit. */
export async function modelCallsFor(unitStore, unitId) {
  const events = await unitStore.listOutboxEvents({ unitId });
  const receipts = events
    .filter((event) => event.eventType === NODE_TURN_USAGE_EVENT_TYPE)
    .map((event) => event.payload);
  const byNode = {};
  let chargedTokens = 0;
  for (const payload of receipts) {
    byNode[payload.nodeId] = (byNode[payload.nodeId] ?? 0) + 1;
    chargedTokens += payload.receipt.chargedTokens;
  }
  return Object.freeze({ calls: receipts.length, chargedTokens, byNode: Object.freeze(byNode) });
}

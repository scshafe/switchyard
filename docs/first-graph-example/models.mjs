// models.mjs: the model port. switchyard calls invoke() for every model
// turn: is-question, draft-answer::approval (the PII screen) and draft-answer.
//
// fakeModel answers from simple rules on the text, so the same input always
// gets the same answer and no model server is needed. realModel (in
// real-model.mjs) asks an OpenAI-compatible server instead.
import { createArtifactEnvelope } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

// Every model turn must return exactly one usage receipt. A fake model has
// no provider telemetry, so it charges the smallest allowed amount.
export function noTelemetryReceipt(durationMs) {
  return {
    schemaVersion: "usage-receipt.v1",
    trust: "unavailable",
    observedInputTokens: null,
    observedOutputTokens: null,
    chargedTokens: 1,
    observedCostMicroUsd: null,
    chargedCostMicroUsd: 1,
    durationMs
  };
}

const PERSONAL_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\d{3}[\s-]?\d{3}[\s-]?\d{4}/;

function fakeAnswer(nodeId, text) {
  switch (nodeId) {
    case "is-question": // "Is this message a question we should answer?"
      if (text.trim().endsWith("?")) return { outcome: "yes" };
      if (/unsubscribe|buy now/i.test(text)) return { outcome: "no" };
      return { outcome: "unsure" };
    case "draft-answer::approval": // "May this text go to a cloud model?"
      return { outcome: PERSONAL_DATA.test(text) ? "denied" : "approved" };
    case "draft-answer": // the "cloud" model writes a draft
      return {
        outcome: "drafted",
        outputArtifact: createArtifactEnvelope(DRAFT, {
          question: text,
          answer: `Thanks for asking. (echo) ${text}`
        })
      };
    default:
      throw new Error(`fake model has no rule for node ${nodeId}`);
  }
}

export const fakeModel = {
  async invoke(input, binding, context) {
    const started = Date.now();
    const answer = fakeAnswer(context.nodeId, input.text);
    return { ...answer, usage: [noTelemetryReceipt(Date.now() - started)] };
  }
};

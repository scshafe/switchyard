// models.mjs: the model port. switchyard calls it for every model turn:
// is-question, draft-answer::approval (the PII screen) and draft-answer.
//
// fakeModelPort answers from rules on the text, so the same input always
// gets the same answer and no model server is needed. It also attaches the
// usage receipt every model turn must return. realModel (in real-model.mjs)
// asks an OpenAI-compatible server instead.
import { createArtifactEnvelope, fakeModelPort } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

const PERSONAL_DATA = /[\w.+-]+@[\w-]+\.[\w.]+|\d{3}[\s-]?\d{3}[\s-]?\d{4}/;

// One rule per model node. Each receives the node's input payload (here a
// ticket.v1, { text }) and returns an outcome, or { outcome, outputArtifact }.
export const fakeModel = fakeModelPort({
  // "Is this message a question we should answer?"
  "is-question": ({ text }) => {
    if (text.trim().endsWith("?")) return "yes";
    if (/unsubscribe|buy now/i.test(text)) return "no";
    return "unsure";
  },
  // "May this text go to a cloud model?" An approval answers approved or denied.
  "draft-answer::approval": ({ text }) => (PERSONAL_DATA.test(text) ? "denied" : "approved"),
  // The "cloud" model writes a draft: the outcome plus the draft.v1 it carries on.
  "draft-answer": ({ text }) => ({
    outcome: "drafted",
    outputArtifact: createArtifactEnvelope(DRAFT, {
      question: text,
      answer: `Thanks for asking. (echo) ${text}`
    })
  })
});

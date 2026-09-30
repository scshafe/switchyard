// real-model.mjs: the same model port, backed by an OpenAI-compatible server
// (llama-swap, llama.cpp, vLLM, Ollama, ...). worker.mjs uses it when
// MODEL_BASE_URL is set, e.g. MODEL_BASE_URL=http://127.0.0.1:8080/v1
import { ExecutionFailureError, createArtifactEnvelope } from "@scshafe/switchyard";

import { DRAFT } from "./graph.mjs";

// Which server-side model each binding runs on.
const MODELS = {
  "small-local": process.env.SMALL_MODEL ?? "qwen2.5-7b",
  "big-cloud": process.env.BIG_MODEL ?? process.env.SMALL_MODEL ?? "qwen2.5-7b"
};

const YES_NO = "Answer with exactly one word: yes, no, or unsure.";

async function chat(model, system, user, signal) {
  let response;
  try {
    response = await fetch(`${process.env.MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal
    });
  } catch (error) {
    // Retryable: the turn is tried again, up to the node's maxAttempts.
    throw new ExecutionFailureError("model_unreachable", true, error);
  }
  if (!response.ok) throw new ExecutionFailureError(`model_http_${response.status}`, true);
  const body = await response.json();
  const tokensIn = body.usage?.prompt_tokens ?? 0;
  const tokensOut = body.usage?.completion_tokens ?? 0;
  return {
    text: body.choices[0].message.content.trim(),
    receipt: {
      schemaVersion: "usage-receipt.v1",
      trust: "provider_reported",
      observedInputTokens: tokensIn,
      observedOutputTokens: tokensOut,
      chargedTokens: tokensIn + tokensOut,
      observedCostMicroUsd: null,
      chargedCostMicroUsd: 0,
      durationMs: 0
    }
  };
}

const word = (text) => text.toLowerCase().match(/\b(yes|no|unsure)\b/)?.[1] ?? "unsure";

export const realModel = {
  async invoke(input, binding, context) {
    const model = MODELS[binding.bindingId];
    const started = Date.now();
    let outcome;
    let outputArtifact;
    let receipt;
    if (context.nodeId === "is-question") {
      const reply = await chat(model, YES_NO,
        `Is this message a question that a support team should answer?\n\n${input.text}`, context.signal);
      outcome = word(reply.text);
      receipt = reply.receipt;
    } else if (context.nodeId === "draft-answer::approval") {
      const reply = await chat(model, YES_NO,
        `Does this text contain personal data (names, email addresses, phone numbers, addresses, account numbers)?\n\n${input.text}`,
        context.signal);
      // Only a clear "no" lets the text go to the cloud model.
      outcome = word(reply.text) === "no" ? "approved" : "denied";
      receipt = reply.receipt;
    } else if (context.nodeId === "draft-answer") {
      const reply = await chat(model, "You answer customer messages in two or three friendly sentences.",
        input.text, context.signal);
      outcome = "drafted";
      outputArtifact = createArtifactEnvelope(DRAFT, { question: input.text, answer: reply.text });
      receipt = reply.receipt;
    } else {
      throw new ExecutionFailureError("no_prompt_for_node", false);
    }
    receipt.durationMs = Date.now() - started;
    return { outcome, ...(outputArtifact ? { outputArtifact } : {}), usage: [receipt] };
  }
};

import { verify as verifyCore } from "../../src/verifier.js";
import { rollback } from "../../src/rollback.js";

/**
 * One row per product. Each `run` performs ONE mutating tool call the way
 * that product's documented default does, and reports what it believes
 * happened: "true" (done), "false" (failed), or "unknown" (escalate).
 * The harness scores that belief against ground truth.
 *
 * Behaviors are modeled from each product's public docs (links below),
 * not from marketing. Where a default is unbounded or model-dependent the
 * `note` says how it was pinned for this benchmark.
 */

// ---- behavior primitives --------------------------------------------------

/** Trust the API's own response: ok → done. No retry, no read-back. */
async function statusTrust(app, intent) {
  try {
    const res = await app.write(intent);
    return { claim: res.ok ? "true" : "false", id: res.id };
  } catch {
    return { claim: "false" };
  }
}

/** Re-run the step on error. `shouldRetry(err)` mirrors the product's retry_on. At-least-once. */
function retryOnError({ attempts, shouldRetry }) {
  return async (app, intent) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await app.write(intent);
        if (res.ok) return { claim: "true", id: res.id };
      } catch (err) {
        if (!shouldRetry(err) || attempt === attempts) return { claim: "false" };
      }
    }
    return { claim: "false" };
  };
}

/** Validate the response's shape/types. Well-formed → done. */
async function schemaValidation(app, intent) {
  try {
    const res = await app.write(intent);
    const wellFormed = res.ok === true && typeof res.id === "string" && /^rec-\d+$/.test(res.id) && typeof res.content === "string" && res.content.length > 0;
    return { claim: wellFormed ? "true" : "false", id: res.id };
  } catch {
    return { claim: "false" };
  }
}

/** LLM-as-judge on the tool result, at its best case: a perfect reader of the response. */
async function responseJudge(app, intent) {
  try {
    const res = await app.write(intent);
    return { claim: res.ok && res.content === intent.content ? "true" : "false", id: res.id };
  } catch {
    return { claim: "false" };
  }
}

/** This repo. Write once; independent read-back; tri-state; rollback on false; escalate on unknown. */
async function trustLayer(app, intent) {
  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await app.write(intent);
      break;
    } catch (err) {
      if (err.status >= 500) continue; // definitive: nothing was written, safe to retry
      return { claim: "unknown", reason: "ambiguous failure (timeout) — the write may have happened; escalate, never retry" };
    }
  }
  if (!res) return { claim: "false", reason: "server kept failing" };

  let record;
  try {
    record = await app.read(res.id);
  } catch {
    return { claim: "unknown", reason: "read-back failed" };
  }
  let id = res.id;
  let verdict = verifyCore({
    exists: Boolean(record),
    content: record ? { expected: intent.content, actual: record.content, app: "sim" } : null,
  });
  if (!record) {
    // Second source (src/second-source.js semantics): the id points nowhere —
    // is there exactly one record with this content? Adopt it; 0 → false; >1 → unknown.
    const matches = await app.search(intent.content);
    if (matches.length === 1) {
      id = matches[0].id;
      verdict = verifyCore({ exists: true, content: { expected: intent.content, actual: matches[0].content, app: "sim" }, crossSourceConfirmed: true });
    } else if (matches.length > 1) {
      return { claim: "unknown", reason: `${matches.length} records match — cannot tell which is ours` };
    }
  }
  if (verdict.status === "false" && record) {
    await rollback({ actionType: "linear.issueCreate", undoFn: () => app.delete(res.id) });
  }
  return { claim: verdict.status, id, reason: verdict.reason, confidence: verdict.confidence };
}

const isTransient = (err) => err.transient === true; // timeout or 5xx
const isServerError = (err) => err.status >= 500;

// ---- products -------------------------------------------------------------

export const STRATEGIES = [
  {
    name: "composio",
    product: "Composio",
    url: "https://docs.composio.dev/",
    pattern: "status trust",
    behavior: "Tool execution returns the app's API response to the agent. Success = the API said ok. No read-back.",
    run: statusTrust,
  },
  {
    name: "arcade",
    product: "Arcade.dev",
    url: "https://docs.arcade.dev/",
    pattern: "status trust",
    behavior: "Auth-first tool execution; the tool's return value is the API response. No read-back.",
    run: statusTrust,
  },
  {
    name: "openai-agents-sdk",
    product: "OpenAI Agents SDK",
    url: "https://openai.github.io/openai-agents-python/tools/",
    pattern: "status trust",
    behavior: "Function tools return the API response; a tool exception is fed back to the model as text (failure_error_function). Guardrails validate agent input/output, not tool side effects.",
    note: "Model-driven re-tries are undefined behavior, so none are modeled.",
    run: statusTrust,
  },
  {
    name: "langgraph-retry",
    product: "LangGraph RetryPolicy",
    url: "https://reference.langchain.com/python/langgraph/types/RetryPolicy",
    pattern: "retry / replay",
    behavior: "Node retried on ConnectionError, 5xx and transient errors; max_attempts=3 by default; checkpointer replays the node's writes.",
    run: retryOnError({ attempts: 3, shouldRetry: isTransient }),
  },
  {
    name: "temporal",
    product: "Temporal activity retry",
    url: "https://docs.temporal.io/encyclopedia/retry-policies",
    pattern: "retry / replay",
    behavior: "Activities retry on any failure with exponential backoff; maximumAttempts defaults to unlimited. At-least-once — idempotency is the user's job.",
    note: "Unlimited attempts pinned to 3 so the benchmark terminates; more attempts only add more duplicates.",
    run: retryOnError({ attempts: 3, shouldRetry: () => true }),
  },
  {
    name: "tenacity",
    product: "tenacity",
    url: "https://github.com/jd/tenacity",
    pattern: "retry / replay",
    behavior: "@retry(stop=stop_after_attempt(3)) — retries on any exception.",
    run: retryOnError({ attempts: 3, shouldRetry: () => true }),
  },
  {
    name: "guardrails-ai",
    product: "Guardrails AI",
    url: "https://github.com/guardrails-ai/guardrails",
    pattern: "schema validation",
    behavior: "Guard validates the output against a schema and validators; well-formed passes. Validators see the response, never the target system.",
    run: schemaValidation,
  },
  {
    name: "pydantic-ai",
    product: "Pydantic AI",
    url: "https://ai.pydantic.dev/tools/",
    pattern: "schema validation",
    behavior: "Tool return values are type-validated; ModelRetry (retries=1) re-asks the model on validation failure. Unhandled tool exceptions propagate.",
    run: schemaValidation,
  },
  {
    name: "llm-judge",
    product: "LLM-as-judge (Langfuse / Arize Phoenix evals)",
    url: "https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge",
    pattern: "response judge",
    behavior: "A model scores the tool result for correctness. Modeled at its best case: a perfect reader of the response, zero latency.",
    note: "A real model can only do worse on the same input, and adds latency and non-determinism.",
    run: responseJudge,
  },
  {
    name: "trust-layer",
    product: "this repo (src/verifier.js + src/rollback.js)",
    url: "https://github.com/gveshk/incident-responder-agent",
    pattern: "independent read-back",
    behavior: "Write once. Re-read via a different path, tri-state verdict, rollback on false, escalate on unknown. Retry only a definitive 5xx (nothing was written); never a timeout. On a missing id, a second source (exact-content search) recovers a wrong-record write or escalates if ambiguous.",
    run: trustLayer,
  },
];

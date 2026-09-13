import { verify as verifyCore } from "../../src/verifier.js";
import { rollback } from "../../src/rollback.js";

/**
 * Each strategy performs ONE mutating action and reports what it believes
 * happened: "true" (done), "false" (failed), or "unknown" (can't tell —
 * escalate). The harness scores that belief against ground truth.
 *
 * The baselines are faithful to what widely deployed tooling does for a
 * tool call. What they have in common: every one of them only ever looks
 * at the write's own response.
 */

const MAX_ATTEMPTS = 3;

export const STRATEGIES = [
  {
    name: "status-trust",
    represents: "Composio / Arcade / MCP tool execution, LangChain tool wrappers",
    describe: "res.ok → done. No retry, no read-back.",
    async run(app, intent) {
      try {
        const res = await app.write(intent);
        return { claim: res.ok ? "true" : "false", id: res.id };
      } catch {
        return { claim: "false" };
      }
    },
  },
  {
    name: "retry-replay",
    represents: "tenacity / LiteLLM num_retries, LangGraph checkpoint replay, Temporal activity retry",
    describe: "Re-run the step on any error, up to 3 attempts. At-least-once.",
    async run(app, intent) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await app.write(intent);
          if (res.ok) return { claim: "true", id: res.id };
        } catch {
          // retry — the framework can't tell a timeout-after-write from a 503-before-write
        }
      }
      return { claim: "false" };
    },
  },
  {
    name: "schema-validation",
    represents: "Guardrails AI validators, Openlayer tool-call validation, Pydantic output models",
    describe: "Validate the response's shape and types. Well-formed → done.",
    async run(app, intent) {
      try {
        const res = await app.write(intent);
        const wellFormed = res.ok === true && typeof res.id === "string" && /^rec-\d+$/.test(res.id) && typeof res.content === "string" && res.content.length > 0;
        return { claim: wellFormed ? "true" : "false", id: res.id };
      } catch {
        return { claim: "false" };
      }
    },
  },
  {
    name: "response-judge",
    represents: "LLM-as-judge on the tool result (Arize / Langfuse eval pattern) — modeled at its best case: a perfect reader of the response",
    describe: "Compare the response payload to intent. Match → done.",
    async run(app, intent) {
      try {
        const res = await app.write(intent);
        return { claim: res.ok && res.content === intent.content ? "true" : "false", id: res.id };
      } catch {
        return { claim: "false" };
      }
    },
  },
  {
    name: "trust-layer",
    represents: "this repo: src/verifier.js + src/rollback.js",
    describe: "Write once. Independent read-back, tri-state verdict, rollback on false, escalate on unknown. Retry only a *definitive* server failure (5xx = the write did not happen); never a timeout.",
    async run(app, intent) {
      let res;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
      const verdict = verifyCore({
        exists: Boolean(record),
        content: record ? { expected: intent.content, actual: record.content, app: "sim" } : null,
      });
      if (verdict.status === "false" && record) {
        // Partial write (e.g. truncated): reverse it so nothing half-done is left behind.
        await rollback({ actionType: "linear.issueCreate", undoFn: () => app.delete(res.id) });
      }
      return { claim: verdict.status, id: res.id, reason: verdict.reason, confidence: verdict.confidence };
    },
  },
];

import { createHash } from "node:crypto";

/**
 * The one step the trust layer does NOT verify: a model reads the incident
 * and writes the diagnosis. Verification is for actions; this is prose.
 * What we do instead is make it auditable — the run log records the model
 * id, a hash of the exact prompt, and whether we fell back to the template
 * (and why). Never a silent fallback.
 *
 * `callModel` is injectable so tests and the offline demo never hit the
 * network. The default goes through OpenRouter with JSON mode.
 */

const SEVERITIES = ["P1", "P2", "P3", "P4"];

export function buildPrompt(trigger, event) {
  const lines = [
    `Service: ${trigger.service}`,
    `Error: ${trigger.errorType}`,
    `Volume: ${trigger.eventCount} events in ${trigger.windowMinutes}m`,
    `Level: ${trigger.level ?? "error"}`,
    trigger.culprit ? `Culprit: ${trigger.culprit}` : null,
    `Reported owner (from the alerting system): ${trigger.reportedOwner}`,
    event?.message ? `Latest event message: ${event.message}` : null,
    event?.frames?.length ? `Innermost stack frames (most recent last):\n${event.frames.map((f) => `  ${f}`).join("\n")}` : null,
  ].filter(Boolean);
  return `You are an on-call incident responder. Diagnose this production error.

${lines.join("\n")}

Respond with a single JSON object, no prose, with exactly these keys:
{"diagnosis": "2-3 sentences: what is failing and the user-facing impact",
 "likelyCause": "one sentence, the most probable root cause given the frames",
 "severity": "P1|P2|P3|P4",
 "suggestedOwner": "the team most likely to own the fix",
 "confidence": 0.0-1.0}`;
}

export function templatedDiagnosis(trigger) {
  return `Error spike detected: ${trigger.errorType} in ${trigger.service} (${trigger.eventCount} events in ${trigger.windowMinutes}m).`;
}

async function openRouterCall(prompt, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content ?? "";
}

/**
 * @param {object} trigger
 * @param {{callModel?: Function|null, model?: string, event?: {message?: string, frames?: string[]}|null}} deps
 */
export async function diagnose(trigger, { callModel, model = process.env.OPENROUTER_MODEL, event = null } = {}) {
  if (callModel === undefined) callModel = process.env.OPENROUTER_API_KEY && model ? (p) => openRouterCall(p, model) : null;
  const prompt = buildPrompt(trigger, event);
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const fallback = (reason) => ({
    fallback: true, fallbackReason: reason, model: model ?? null, promptHash,
    diagnosis: templatedDiagnosis(trigger), likelyCause: null, severity: "P2", suggestedOwner: trigger.reportedOwner, confidence: null,
  });

  if (!callModel) return fallback("no model configured");

  let raw;
  try {
    raw = await callModel(prompt);
  } catch (err) {
    return fallback(`model call failed: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return fallback(`could not parse model output as JSON: ${String(raw).slice(0, 80)}`);
  }
  if (typeof parsed.diagnosis !== "string" || !parsed.diagnosis) return fallback("model output missing diagnosis");

  return {
    fallback: false, fallbackReason: null, model, promptHash,
    diagnosis: parsed.diagnosis,
    likelyCause: typeof parsed.likelyCause === "string" ? parsed.likelyCause : null,
    severity: SEVERITIES.includes(parsed.severity) ? parsed.severity : "P2",
    suggestedOwner: typeof parsed.suggestedOwner === "string" && parsed.suggestedOwner ? parsed.suggestedOwner : trigger.reportedOwner,
    confidence: Number.isFinite(parsed.confidence) ? Math.min(1, Math.max(0, parsed.confidence)) : null,
  };
}

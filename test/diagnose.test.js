import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnose, buildPrompt } from "../src/diagnose.js";
import { buildMockSentryPayload } from "../src/mock-trigger.js";

const trigger = buildMockSentryPayload();

test("buildPrompt includes the error, service, counts and any stack frames", () => {
  const prompt = buildPrompt(trigger, { frames: ["views.js:283 in member"], message: "boom" });
  assert.match(prompt, /checkout-api/);
  assert.match(prompt, /47 events in 5m/);
  assert.match(prompt, /views\.js:283 in member/);
});

test("diagnose returns structured output from the model and records model + prompt hash", async () => {
  const callModel = async () => JSON.stringify({ diagnosis: "Null total on cart summary", likelyCause: "missing null check", severity: "P2", suggestedOwner: "team-payments", confidence: 0.8 });
  const d = await diagnose(trigger, { callModel, model: "test/model", event: null });
  assert.equal(d.fallback, false);
  assert.equal(d.severity, "P2");
  assert.equal(d.model, "test/model");
  assert.match(d.promptHash, /^[a-f0-9]{16}$/);
  assert.equal(d.diagnosis, "Null total on cart summary");
});

test("diagnose falls back to the templated diagnosis when no model is configured", async () => {
  const d = await diagnose(trigger, { callModel: null });
  assert.equal(d.fallback, true);
  assert.match(d.diagnosis, /Error spike detected/);
  assert.equal(d.severity, "P2");
});

test("diagnose falls back, and says why, when the model call throws or returns junk", async () => {
  const d1 = await diagnose(trigger, { callModel: async () => { throw new Error("429 rate limited"); }, model: "m" });
  assert.equal(d1.fallback, true);
  assert.match(d1.fallbackReason, /429/);
  const d2 = await diagnose(trigger, { callModel: async () => "not json", model: "m" });
  assert.equal(d2.fallback, true);
  assert.match(d2.fallbackReason, /parse/i);
});

test("diagnose tolerates prose or fences around the JSON object", async () => {
  const callModel = async () => "Here is the diagnosis:
```json
{\"diagnosis\": \"x\", \"likelyCause\": \"y\", \"severity\": \"P3\", \"suggestedOwner\": \"z\", \"confidence\": 0.5}
```
Hope this helps.";
  const d = await diagnose(trigger, { callModel, model: "m" });
  assert.equal(d.fallback, false);
  assert.equal(d.severity, "P3");
});

test("diagnose clamps severity to P1-P4 and confidence to 0-1", async () => {
  const callModel = async () => JSON.stringify({ diagnosis: "x", likelyCause: "y", severity: "SEV0", suggestedOwner: "z", confidence: 7 });
  const d = await diagnose(trigger, { callModel, model: "m" });
  assert.equal(d.severity, "P2");
  assert.equal(d.confidence, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverViaSecondSource } from "../src/second-source.js";
import { verify as verifyCore } from "../src/verifier.js";

const intent = { description: "checkout-api error spike" };
const falseResult = verifyCore({ exists: false, content: null });
const since = new Date("2026-09-13T00:00:00Z");

function integration({ matches, storeContent = "checkout-api error spike" }) {
  return {
    findByContent: async () => matches,
    verify: async (actResult) => verifyCore({ exists: actResult.id === "real-1", content: actResult.id === "real-1" ? { expected: intent.description, actual: storeContent, app: "linear" } : null }),
  };
}

test("returns null when the integration has no second source or the verdict was not a failed existence check", async () => {
  assert.equal(await recoverViaSecondSource({ integration: {}, actResult: { id: "x" }, intent, verifyResult: falseResult, since }), null);
  const trueResult = verifyCore({ exists: true, content: null });
  assert.equal(await recoverViaSecondSource({ integration: integration({ matches: [{ id: "real-1", raw: {} }] }), actResult: { id: "x" }, intent, verifyResult: trueResult, since }), null);
});

test("exactly one content match → the id is corrected and re-verified true", async () => {
  const r = await recoverViaSecondSource({ integration: integration({ matches: [{ id: "real-1", raw: { url: "u" } }] }), actResult: { id: "ghost", raw: {} }, intent, verifyResult: falseResult, since });
  assert.equal(r.outcome, "corrected");
  assert.equal(r.corrected.id, "real-1");
  assert.equal(r.corrected.originalId, "ghost");
  assert.equal(r.reverified.status, "true");
});

test("no match → the false verdict stands", async () => {
  const r = await recoverViaSecondSource({ integration: integration({ matches: [] }), actResult: { id: "ghost", raw: {} }, intent, verifyResult: falseResult, since });
  assert.equal(r.outcome, "none");
});

test("more than one match → unknown, never a guess", async () => {
  const r = await recoverViaSecondSource({ integration: integration({ matches: [{ id: "real-1", raw: {} }, { id: "real-2", raw: {} }] }), actResult: { id: "ghost", raw: {} }, intent, verifyResult: falseResult, since });
  assert.equal(r.outcome, "unknown");
  assert.match(r.reason, /2 records/);
});

test("a match whose content does not re-verify is unknown, not corrected", async () => {
  const r = await recoverViaSecondSource({ integration: integration({ matches: [{ id: "real-1", raw: {} }], storeContent: "something else entirely" }), actResult: { id: "ghost", raw: {} }, intent, verifyResult: falseResult, since });
  assert.equal(r.outcome, "unknown");
});

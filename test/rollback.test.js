import { test } from "node:test";
import assert from "node:assert/strict";
import { TIERS, classifyTier, diffAgentWritableFields, rollback, hold } from "../src/rollback.js";

test("classifyTier returns the registered tier for known action types", () => {
  assert.equal(classifyTier("linear.issueCreate"), TIERS.REVERSIBLE);
  assert.equal(classifyTier("slack.postMessage"), TIERS.COMPENSABLE);
  assert.equal(classifyTier("pagerduty.page"), TIERS.BUFFERABLE);
});

test("classifyTier throws for an unregistered action type", () => {
  assert.throws(() => classifyTier("unknown.action"), /no rollback tier registered/);
});

test("diffAgentWritableFields excludes updatedAt but reports real field changes", () => {
  const before = { title: "original", updatedAt: 100 };
  const after = { title: "mutated", updatedAt: 200 };
  const diff = diffAgentWritableFields(before, after);
  assert.deepEqual(Object.keys(diff), ["title"]);
});

test("diffAgentWritableFields reports no diff for two identical agent-writable states", () => {
  const before = { title: "same", updatedAt: 100 };
  const after = { title: "same", updatedAt: 200 };
  const diff = diffAgentWritableFields(before, after);
  assert.deepEqual(diff, {});
});

test("rollback on a reversible action reports restored when undoFn succeeds", async () => {
  const result = await rollback({ actionType: "linear.issueCreate", undoFn: async () => ({ ok: true }) });
  assert.equal(result.tier, TIERS.REVERSIBLE);
  assert.equal(result.outcome, "restored");
});

test("rollback on a compensable action reports compensated when undoFn succeeds", async () => {
  const result = await rollback({ actionType: "slack.postMessage", undoFn: async () => ({ ok: true }) });
  assert.equal(result.tier, TIERS.COMPENSABLE);
  assert.equal(result.outcome, "compensated");
});

test("rollback escalates when undoFn throws (compensation itself can fail)", async () => {
  const result = await rollback({ actionType: "linear.issueCreate", undoFn: async () => { throw new Error("rate limited"); } });
  assert.equal(result.outcome, "escalated");
  assert.match(result.detail, /rate limited/);
});

test("rollback escalates when undoFn reports ok:false", async () => {
  const result = await rollback({ actionType: "linear.issueCreate", undoFn: async () => ({ ok: false }) });
  assert.equal(result.outcome, "escalated");
});

test("bufferable actions are held, never fired — rollback reports held-not-fired without calling undoFn", async () => {
  let undoCalled = false;
  const result = await rollback({ actionType: "pagerduty.page", undoFn: async () => { undoCalled = true; return { ok: true }; }, holdIntent: { reason: "test" } });
  assert.equal(result.outcome, "held-not-fired");
  assert.equal(undoCalled, false);
});

test("hold() never commits on its own — commit must be called explicitly", async () => {
  const held = hold("pagerduty.page", { reason: "paging threshold exceeded" });
  assert.equal(held.isCommitted(), false);
  await held.commit(async () => "fired");
  assert.equal(held.isCommitted(), true);
});

test("hold() throws for a non-bufferable action type", () => {
  assert.throws(() => hold("linear.issueCreate", {}), /non-bufferable/);
});

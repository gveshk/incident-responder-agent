import { test } from "node:test";
import assert from "node:assert/strict";
import { runMemoryScenarios, SCENARIOS } from "../../eval/memory-scenarios.js";

test("there are at least 8 hand-written scenarios", () => {
  assert.ok(SCENARIOS.length >= 8, `expected >=8 scenarios, got ${SCENARIOS.length}`);
});

test("runMemoryScenarios scores every scenario correctly", () => {
  const report = runMemoryScenarios();
  assert.equal(report.correct, report.total);
  assert.equal(report.accuracy, 1);
});

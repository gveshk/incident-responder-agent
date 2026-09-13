import { test } from "node:test";
import assert from "node:assert/strict";
import { runAdversarialCheck } from "../../eval/adversarial.js";

test("a poisoned observation is blocked, never verified as true", () => {
  const report = runAdversarialCheck();
  assert.equal(report.blocked, true);
  assert.notEqual(report.result.status, "true");
});

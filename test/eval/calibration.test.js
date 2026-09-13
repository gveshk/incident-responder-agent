import { test } from "node:test";
import assert from "node:assert/strict";
import { runCalibration } from "../../eval/calibration.js";

test("runCalibration reports a Brier score between 0 and 1 across the labeled cases", () => {
  const report = runCalibration();
  assert.ok(report.brierScore >= 0 && report.brierScore <= 1);
  assert.ok(report.n >= 6, `expected >=6 labeled cases, got ${report.n}`);
});

test("every point records predicted vs ground-truth correctness", () => {
  const report = runCalibration();
  for (const p of report.points) {
    assert.equal(typeof p.correct, "boolean");
  }
});

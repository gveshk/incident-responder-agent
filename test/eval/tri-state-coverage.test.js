import { test } from "node:test";
import assert from "node:assert/strict";
import { runTriStateCoverage } from "../../eval/tri-state-coverage.js";

test("the verifier produces all three states across the three cases", () => {
  const report = runTriStateCoverage();
  assert.equal(report.coversAllThree, true);
});

test("verify() is a pure function with no retry side effect of its own", () => {
  const report = runTriStateCoverage();
  assert.equal(report.noRetrySideEffect, true);
});

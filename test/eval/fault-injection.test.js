import { test } from "node:test";
import assert from "node:assert/strict";
import { runFaultInjection, FAILURE_MODES } from "../../eval/fault-injection.js";

test("runFaultInjection reports a catch rate and never claims a caught case as status:true", () => {
  const report = runFaultInjection(FAILURE_MODES.length);
  assert.equal(report.trials, FAILURE_MODES.length);
  for (const r of report.results) {
    if (r.caught) assert.notEqual(r.status, "true");
  }
});

test("all four documented failure modes are caught (never verified as true)", () => {
  const report = runFaultInjection(FAILURE_MODES.length);
  assert.equal(report.caught, FAILURE_MODES.length);
  assert.equal(report.catchRate, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runRollbackFidelity, EXCLUDED_FIELDS } from "../../eval/rollback-fidelity.js";

test("runRollbackFidelity reports 100% exact restoration of agent-writable fields", async () => {
  const report = await runRollbackFidelity(20);
  assert.equal(report.trials, 20);
  assert.equal(report.exact, 20);
  assert.equal(report.exactRestorationRate, 1);
});

test("the excluded-field list is declared, not silently applied", () => {
  assert.ok(EXCLUDED_FIELDS.includes("updatedAt"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompetitive, buildSchedule } from "../../eval/competitive/harness.js";
import { runMemoryBench } from "../../eval/competitive/memory-bench.js";

test("the fault schedule is deterministic for a seed", () => {
  const a = buildSchedule({ trials: 50, faultRate: 0.5, seed: 9 }).map((t) => t.fault);
  const b = buildSchedule({ trials: 50, faultRate: 0.5, seed: 9 }).map((t) => t.fault);
  assert.deepEqual(a, b);
});

test("the trust layer has zero silent failures; every response-only baseline has some", async () => {
  const report = await runCompetitive({ trials: 300, faultRate: 0.4, readFaultRate: 0, seed: 1 });
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["trust-layer"].silentFailures, 0);
  for (const name of ["status-trust", "retry-replay", "schema-validation", "response-judge"]) {
    assert.ok(byName[name].silentFailures > 0, `${name} should miss silent failures`);
  }
});

test("retry-replay is the only strategy that creates duplicates; the trust layer creates none", async () => {
  const report = await runCompetitive({ trials: 300, faultRate: 0.4, readFaultRate: 0, seed: 1 });
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.ok(byName["retry-replay"].duplicates > 0);
  assert.equal(byName["trust-layer"].duplicates, 0);
});

test("with no faults the trust layer costs exactly one extra read per action", async () => {
  const report = await runCompetitive({ trials: 100, faultRate: 0, readFaultRate: 0, seed: 1 });
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["status-trust"].apiCallsPerAction, 1);
  assert.equal(byName["trust-layer"].apiCallsPerAction, 2);
});

test("memory bench: reconciling store has no contradictory contexts and detects every ownership change", () => {
  const m = runMemoryBench({ services: 20, observationsPerService: 10, changeRate: 0.3, seed: 3 });
  assert.equal(m.reconciling.contradictoryContexts, 0);
  assert.equal(m.reconciling.revisionRecall, 1);
  assert.equal(m.reconciling.falseRevisions, 0);
  assert.ok(m.appendOnly.contradictoryContexts > 0);
});

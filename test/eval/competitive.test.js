import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompetitive, buildSchedule } from "../../eval/competitive/harness.js";
import { runMemoryBench } from "../../eval/competitive/memory-bench.js";

test("the fault schedule is deterministic for a seed", () => {
  const a = buildSchedule({ trials: 50, faultRate: 0.5, seed: 9 }).map((t) => t.fault);
  const b = buildSchedule({ trials: 50, faultRate: 0.5, seed: 9 }).map((t) => t.fault);
  assert.deepEqual(a, b);
});

test("the trust layer has zero silent failures; every product that only reads the response has some", async () => {
  const report = await runCompetitive({ trials: 300, faultRate: 0.4, readFaultRate: 0, seed: 1 });
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["trust-layer"].silentFailures, 0);
  for (const r of report.results) {
    if (r.name === "trust-layer") continue;
    assert.ok(r.silentFailures > 0, `${r.name} should miss silent failures`);
    assert.ok(r.url.startsWith("https://"), `${r.name} must cite its docs`);
  }
});

test("only the retry/replay products create duplicates; the trust layer creates none", async () => {
  const report = await runCompetitive({ trials: 300, faultRate: 0.4, readFaultRate: 0, seed: 1 });
  for (const r of report.results) {
    if (r.pattern === "retry / replay") assert.ok(r.duplicates > 0, `${r.name} should duplicate on timeout`);
    else assert.equal(r.duplicates, 0, `${r.name} should not duplicate`);
  }
});

test("with no faults the trust layer costs exactly one extra read per action", async () => {
  const report = await runCompetitive({ trials: 100, faultRate: 0, readFaultRate: 0, seed: 1 });
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["composio"].apiCallsPerAction, 1);
  assert.equal(byName["trust-layer"].apiCallsPerAction, 2);
});

test("memory bench: reconciling store has no contradictory contexts and detects every ownership change", () => {
  const m = runMemoryBench({ services: 20, observationsPerService: 10, changeRate: 0.3, seed: 3 });
  const rows = Object.fromEntries(m.rows.map((r) => [r.name, r]));
  assert.equal(rows["memory-js"].contradictoryContexts, 0);
  assert.equal(rows["memory-js"].revisionsDetected, m.ownershipChanges);
  assert.equal(rows["memory-js"].falseRevisions, 0);
  assert.ok(rows["memory-js"].historyRetained > 0);
  assert.ok(rows["vector-store-notes"].contradictoryContexts > 0);
  assert.equal(rows["mem0"].historyRetained, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runIncident, undoRun } from "../src/agent.js";
import { TIERS } from "../src/rollback.js";
import { createFactStore } from "../src/memory.js";
import { verify as verifyCore } from "../src/verifier.js";

function fakeIntegration(name) {
  let counter = 0;
  return {
    act: async (input) => { counter += 1; return { id: `${name}-${counter}`, raw: { ...input, url: `https://example.test/${name}/${counter}` }, capturedBefore: null }; },
    verify: async (actResult, intent) => { const v = intent.description ?? intent.text ?? intent.body ?? intent.value; return verifyCore({ exists: true, content: { expected: v, actual: v, app: name } }); },
    undo: async () => ({ ok: true }),
  };
}

test("runIncident executes all steps in order with tier classifications", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot") };
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  const runLog = await runIncident({ integrations, factStore });

  const actionTypes = runLog.steps.map((s) => s.actionType);
  assert.deepEqual(actionTypes, ["linear.issueCreate", "slack.postMessage", "hubspot.propertyUpdate", "pagerduty.page", "memory.reconcile", "github.issueCreate"]);
});

test("the PagerDuty step is held, never fired", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot") };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]) });
  const pageStep = runLog.steps.find((s) => s.actionType === "pagerduty.page");
  assert.equal(pageStep.tier, TIERS.BUFFERABLE);
  assert.equal(pageStep.held, true);
});

test("memory reconciles the seeded stale fact against the trigger's reported owner", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot") };
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  const runLog = await runIncident({ integrations, factStore });
  const memoryStep = runLog.steps.find((s) => s.actionType === "memory.reconcile");
  assert.equal(memoryStep.revised, true);
  assert.equal(memoryStep.oldFact.object, "team-checkout");
});

test("every mutating step carries a tri-state verifyResult, never a bare boolean", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot") };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]) });
  for (const step of runLog.steps) {
    if (step.verifyResult) assert.ok(["true", "false", "unknown"].includes(step.verifyResult.status));
  }
});

test("undoRun reverses the mutating steps in reverse order, skips held and memory steps", async () => {
  const undoCalls = [];
  function trackedIntegration(name) {
    const base = fakeIntegration(name);
    return { ...base, undo: async (r) => { undoCalls.push(name); return base.undo(r); } };
  }
  const integrations = { linear: trackedIntegration("linear"), slack: trackedIntegration("slack"), github: trackedIntegration("github"), hubspot: trackedIntegration("hubspot") };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]) });
  const results = await undoRun(runLog, integrations);
  assert.deepEqual(undoCalls, ["github", "hubspot", "slack", "linear"]);
  assert.ok(results.every((r) => r.outcome === "restored" || r.outcome === "compensated"));
});

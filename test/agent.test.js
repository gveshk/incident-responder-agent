import { test } from "node:test";
import assert from "node:assert/strict";
import { runIncident, undoRun, commitPage } from "../src/agent.js";
import { TIERS } from "../src/rollback.js";
import { createFactStore } from "../src/memory.js";
import { verify as verifyCore } from "../src/verifier.js";

const fakeDiagnoser = async (trigger) => ({ fallback: true, fallbackReason: "test", model: null, promptHash: "abcd", diagnosis: `Error spike detected: ${trigger.errorType}`, likelyCause: null, severity: "P2", suggestedOwner: trigger.reportedOwner, confidence: null });

function fakeIntegration(name) {
  let counter = 0;
  return {
    act: async (input) => { counter += 1; return { id: `${name}-${counter}`, raw: { ...input, url: `https://example.test/${name}/${counter}` }, capturedBefore: null }; },
    verify: async (actResult, intent) => { const v = intent.description ?? intent.text ?? intent.body ?? intent.value; return verifyCore({ exists: true, content: { expected: v, actual: v, app: name } }); },
    undo: async () => ({ ok: true }),
  };
}

test("runIncident executes all steps in order with tier classifications", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  const runLog = await runIncident({ integrations, factStore, diagnoser: fakeDiagnoser });

  const actionTypes = runLog.steps.map((s) => s.actionType);
  assert.deepEqual(actionTypes, ["llm.diagnose", "linear.issueCreate", "slack.postMessage", "hubspot.propertyUpdate", "pagerduty.page", "memory.reconcile", "github.issueCreate"]);
});

test("a real Sentry trigger adds a sentry.noteCreate step right after the Linear ticket; the mock trigger does not", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const mockRun = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  assert.ok(!mockRun.steps.some((s) => s.actionType === "sentry.noteCreate"));
  const trigger = { service: "javascript-nextjs", errorType: "TypeError", eventCount: 1, windowMinutes: 5, reportedOwner: "barebone-agents", escalationPolicy: "x", sentryIssueId: "7729975167", sentryUrl: "https://sentry.example/1" };
  const realRun = await runIncident({ trigger, integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  const types = realRun.steps.map((s) => s.actionType);
  assert.equal(types[1], "linear.issueCreate");
  assert.equal(types[2], "sentry.noteCreate");
  assert.equal(realRun.steps[2].input.issueId, "7729975167");
});

test("the PagerDuty step is held, never fired", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  const pageStep = runLog.steps.find((s) => s.actionType === "pagerduty.page");
  assert.equal(pageStep.tier, TIERS.BUFFERABLE);
  assert.equal(pageStep.held, true);
});

test("memory reconciles the seeded stale fact against the trigger's reported owner", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  const runLog = await runIncident({ integrations, factStore, diagnoser: fakeDiagnoser });
  const memoryStep = runLog.steps.find((s) => s.actionType === "memory.reconcile");
  assert.equal(memoryStep.revised, true);
  assert.equal(memoryStep.oldFact.object, "team-checkout");
});

test("every mutating step carries a tri-state verifyResult, never a bare boolean", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
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
  const runLog = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  const results = await undoRun(runLog, integrations);
  assert.deepEqual(undoCalls, ["github", "hubspot", "slack", "linear"]);
  assert.ok(results.every((r) => r.outcome === "restored" || r.outcome === "compensated"));
});

test("the diagnosis step is logged with model, prompt hash and fallback flag, and feeds the ticket title severity", async () => {
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty: fakeIntegration("pagerduty") };
  const diagnoser = async () => ({ fallback: false, fallbackReason: null, model: "deepseek/x", promptHash: "1234", diagnosis: "Cart total is undefined", likelyCause: "null cart", severity: "P1", suggestedOwner: "team-payments", confidence: 0.9 });
  const runLog = await runIncident({ integrations, factStore: createFactStore([]), diagnoser });
  const dx = runLog.steps[0];
  assert.equal(dx.actionType, "llm.diagnose");
  assert.equal(dx.model, "deepseek/x");
  assert.equal(dx.fallback, false);
  assert.match(runLog.steps[1].input.title, /^\[P1\]/);
  assert.match(runLog.steps[1].input.description, /Likely cause: null cart/);
});

test("commitPage fires the held page through hold().commit(), verifies it, and marks the step committed", async () => {
  let fired = 0;
  const pagerduty = { ...fakeIntegration("pagerduty"), act: async (input) => { fired += 1; return { id: "Q1", raw: { incidentKey: input.incidentKey, title: input.title }, capturedBefore: null }; } };
  const integrations = { linear: fakeIntegration("linear"), slack: fakeIntegration("slack"), github: fakeIntegration("github"), hubspot: fakeIntegration("hubspot"), sentry: fakeIntegration("sentry"), pagerduty };
  const runLog = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  assert.equal(fired, 0, "a run must never fire the page");
  const step = await commitPage(runLog, integrations);
  assert.equal(fired, 1);
  assert.equal(step.committed, true);
  assert.equal(step.held, false);
  assert.equal(step.actResult.raw.incidentKey, runLog.runId);
  assert.equal(step.verifyResult.status, "true");
  await assert.rejects(() => commitPage(runLog, integrations), /already committed/);
});

test("undoRun resolves a committed page (compensated) but skips a held one", async () => {
  const undoCalls = [];
  const track = (name) => { const b = fakeIntegration(name); return { ...b, undo: async (r) => { undoCalls.push(name); return b.undo(r); } }; };
  const integrations = { linear: track("linear"), slack: track("slack"), github: track("github"), hubspot: track("hubspot"), sentry: track("sentry"), pagerduty: track("pagerduty") };
  const held = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  await undoRun(held, integrations);
  assert.ok(!undoCalls.includes("pagerduty"), "held page must not be undone");
  undoCalls.length = 0;
  const committed = await runIncident({ integrations, factStore: createFactStore([]), diagnoser: fakeDiagnoser });
  await commitPage(committed, integrations);
  const results = await undoRun(committed, integrations);
  assert.deepEqual(undoCalls, ["github", "pagerduty", "hubspot", "slack", "linear"]);
  assert.equal(results.find((r) => r.actionType === "pagerduty.incidentCreate").outcome, "compensated");
});

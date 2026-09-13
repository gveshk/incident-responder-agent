import { randomUUID } from "node:crypto";
import * as linearClient from "./integrations/linear.js";
import * as slackClient from "./integrations/slack.js";
import * as githubClient from "./integrations/github.js";
import * as hubspotClient from "./integrations/hubspot.js";
import * as sentryClient from "./integrations/sentry.js";
import * as pagerdutyClient from "./integrations/pagerduty.js";
import { classifyTier, rollback, hold, TIERS } from "./rollback.js";
import { reconcile } from "./memory.js";
import { buildMockSentryPayload } from "./mock-trigger.js";
import { diagnose as diagnoseDefault } from "./diagnose.js";

const DEFAULT_INTEGRATIONS = { linear: linearClient, slack: slackClient, github: githubClient, hubspot: hubspotClient, sentry: sentryClient, pagerduty: pagerdutyClient };

/**
 * Runs one incident-response cycle:
 *
 *   Sentry trigger (mock payload, or --sentry: the latest real unresolved issue)
 *        │
 *        ▼
 *   llm.diagnose — a model reads the issue + stack frames, writes the diagnosis
 *                  (not verified: it's prose, not an action; logged with model + prompt hash,
 *                   falls back to a template and says so)
 *        │
 *        ▼
 *   Linear ticket (act -> verify)
 *        │
 *        ▼
 *   Sentry note linking the ticket (only for a real Sentry trigger; act -> verify)
 *        │
 *        ▼
 *   Slack alert (act -> verify)
 *        │
 *        ▼
 *   HubSpot: affected account flagged (pre-state captured, act -> verify)
 *        │
 *        ▼
 *   PagerDuty page: HELD at the bufferable-tier gate. Fired only by an explicit
 *                   commitPage() (CLI --commit), after which it is compensable.
 *        │
 *        ▼
 *   memory.reconcile: revises a contradicted fact, old value stays visible
 *        │
 *        ▼
 *   GitHub issue (act -> verify)
 *
 * Every mutating step logs its rollback tier and verify() result so the
 * run log is a complete, independently-checkable record. Integrations and
 * the diagnoser are injected so this can run against real APIs or fully
 * mocked ones (used by the eval harness and this file's own tests).
 */
export async function runIncident({ trigger = buildMockSentryPayload(), integrations = DEFAULT_INTEGRATIONS, factStore = [], diagnoser = diagnoseDefault, event = null } = {}) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const steps = [];

  async function runStep(actionType, input, intent) {
    const app = actionType.split(".")[0];
    const actResult = await integrations[app].act(input);
    const verifyResult = await integrations[app].verify(actResult, intent);
    steps.push({ actionType, tier: classifyTier(actionType), input, actResult, verifyResult });
    return actResult;
  }

  const dx = await diagnoser(trigger, { event });
  steps.push({ actionType: "llm.diagnose", ...dx });
  const diagnosis = dx.likelyCause ? `${dx.diagnosis}\n\nLikely cause: ${dx.likelyCause}` : dx.diagnosis;
  const titlePrefix = `[${dx.severity}]`;

  const linearResult = await runStep("linear.issueCreate", { title: `${titlePrefix} ${trigger.service}: ${trigger.errorType}`, description: diagnosis }, { description: diagnosis });

  if (trigger.sentryIssueId) {
    const noteText = `Incident Responder: tracking in Linear ${linearResult.raw.url ?? linearResult.id}`;
    await runStep("sentry.noteCreate", { issueId: trigger.sentryIssueId, text: noteText }, { text: noteText });
  }

  const slackText = `:rotating_light: ${titlePrefix} Incident: ${trigger.service} — ${trigger.errorType}. Linear ticket: ${linearResult.raw.url ?? linearResult.id}`;
  await runStep("slack.postMessage", { text: slackText }, { text: slackText });

  await runStep("hubspot.propertyUpdate", { property: "incident_status", value: "investigating" }, { value: "investigating" });

  const pageHold = hold("pagerduty.page", {
    reason: `${trigger.errorType} in ${trigger.service} exceeds paging threshold`,
    escalationPolicy: trigger.escalationPolicy,
    title: `${titlePrefix} ${trigger.service}: ${trigger.errorType}`,
    details: `${diagnosis}\n\nLinear: ${linearResult.raw.url ?? linearResult.id}`,
    incidentKey: runId,
  });
  steps.push({ actionType: "pagerduty.page", tier: TIERS.BUFFERABLE, held: true, committed: false, intent: pageHold.intent });

  const memoryResult = reconcile({ subject: trigger.service, predicate: "ownedBy", object: trigger.reportedOwner, source: trigger.sentryIssueId ? "sentry-issue" : "mock-trigger", confidence: 0.9 }, factStore);
  steps.push({ actionType: "memory.reconcile", revised: memoryResult.revised, oldFact: memoryResult.oldFact, newFact: memoryResult.newFact });

  const githubBody = `${diagnosis}\n\nLinear: ${linearResult.raw.url ?? linearResult.id}`;
  await runStep("github.issueCreate", { title: `${titlePrefix} Incident: ${trigger.service} ${trigger.errorType}`, body: githubBody }, { body: githubBody });

  return { runId, startedAt, finishedAt: new Date().toISOString(), trigger, steps, factStore };
}

/**
 * Fires the held PagerDuty page — the ONLY way it ever fires. Goes through
 * hold().commit() so the bufferable mechanism is the thing being exercised,
 * then verifies via an independent read like any other action. Mutates
 * the run log's page step in place.
 */
export async function commitPage(runLog, integrations = DEFAULT_INTEGRATIONS) {
  const step = runLog.steps.find((s) => s.actionType === "pagerduty.page");
  if (!step) throw new Error("run log has no pagerduty.page step");
  if (step.committed) throw new Error(`page already committed at ${step.committedAt}`);
  const held = hold("pagerduty.page", step.intent);
  const actResult = await held.commit(() => integrations.pagerduty.act(step.intent));
  const verifyResult = await integrations.pagerduty.verify(actResult, { title: step.intent.title });
  Object.assign(step, { held: false, committed: true, committedAt: new Date().toISOString(), committedActionType: "pagerduty.incidentCreate", actResult, verifyResult });
  return step;
}

/**
 * Reverses every mutating step in the run log, most recent first. A held
 * (never fired) page and memory steps are skipped — there's nothing to
 * reverse. A committed page IS reversed, as the compensable action it
 * became.
 */
export async function undoRun(runLog, integrations = DEFAULT_INTEGRATIONS) {
  const results = [];
  for (const step of [...runLog.steps].reverse()) {
    const actionType = step.committedActionType ?? step.actionType;
    if (actionType === "memory.reconcile" || actionType === "llm.diagnose") continue;
    if (classifyTier(actionType) === TIERS.BUFFERABLE) continue;
    const app = actionType.split(".")[0];
    const outcome = await rollback({ actionType, undoFn: () => integrations[app].undo(step.actResult) });
    results.push({ actionType, ...outcome });
  }
  return results;
}

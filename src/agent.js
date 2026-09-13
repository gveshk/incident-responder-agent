import { randomUUID } from "node:crypto";
import * as linearClient from "./integrations/linear.js";
import * as slackClient from "./integrations/slack.js";
import * as githubClient from "./integrations/github.js";
import * as hubspotClient from "./integrations/hubspot.js";
import { classifyTier, rollback, hold, TIERS } from "./rollback.js";
import { reconcile } from "./memory.js";
import { buildMockSentryPayload } from "./mock-trigger.js";

/**
 * Runs one incident-response cycle:
 *
 *   mock Sentry trigger
 *        │
 *        ▼
 *   Linear ticket (act -> verify)
 *        │
 *        ▼
 *   Slack alert (act -> verify)
 *        │
 *        ▼
 *   HubSpot: affected account flagged (pre-state captured, act -> verify)
 *        │
 *        ▼
 *   PagerDuty page: HELD at the bufferable-tier gate, never fired
 *        │
 *        ▼
 *   memory.reconcile: revises a contradicted fact, old value stays visible
 *        │
 *        ▼
 *   GitHub issue (act -> verify)
 *
 * Every mutating step logs its rollback tier and verify() result so the
 * run log is a complete, independently-checkable record. Integrations are
 * injected so this can run against real APIs or fully mocked ones (used
 * by the eval harness and this file's own tests).
 */
export async function runIncident({ trigger = buildMockSentryPayload(), integrations = { linear: linearClient, slack: slackClient, github: githubClient, hubspot: hubspotClient }, factStore = [] } = {}) {
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

  const diagnosis = `Error spike detected: ${trigger.errorType} in ${trigger.service} (${trigger.eventCount} events in ${trigger.windowMinutes}m).`;

  const linearResult = await runStep("linear.issueCreate", { title: `[Incident] ${trigger.service}: ${trigger.errorType}`, description: diagnosis }, { description: diagnosis });

  const slackText = `:rotating_light: Incident: ${trigger.service} — ${trigger.errorType}. Linear ticket: ${linearResult.raw.url ?? linearResult.id}`;
  await runStep("slack.postMessage", { text: slackText }, { text: slackText });

  await runStep("hubspot.propertyUpdate", { property: "incident_status", value: "investigating" }, { value: "investigating" });

  const pageHold = hold("pagerduty.page", { reason: `${trigger.errorType} in ${trigger.service} exceeds paging threshold`, escalationPolicy: trigger.escalationPolicy });
  steps.push({ actionType: "pagerduty.page", tier: TIERS.BUFFERABLE, held: true, intent: pageHold.intent });

  const memoryResult = reconcile({ subject: trigger.service, predicate: "ownedBy", object: trigger.reportedOwner, source: "linear-ticket", confidence: 0.9 }, factStore);
  steps.push({ actionType: "memory.reconcile", revised: memoryResult.revised, oldFact: memoryResult.oldFact, newFact: memoryResult.newFact });

  const githubBody = `${diagnosis}\n\nLinear: ${linearResult.raw.url ?? linearResult.id}`;
  await runStep("github.issueCreate", { title: `Incident: ${trigger.service} ${trigger.errorType}`, body: githubBody }, { body: githubBody });

  return { runId, startedAt, finishedAt: new Date().toISOString(), trigger, steps, factStore };
}

/**
 * Reverses every mutating step in the run log, most recent first. Held
 * (bufferable) and memory steps are skipped — there's nothing to fire in
 * reverse for either.
 */
export async function undoRun(runLog, integrations = { linear: linearClient, slack: slackClient, github: githubClient, hubspot: hubspotClient }) {
  const results = [];
  for (const step of [...runLog.steps].reverse()) {
    if (step.tier === TIERS.BUFFERABLE || step.actionType === "memory.reconcile") continue;
    const app = step.actionType.split(".")[0];
    const outcome = await rollback({ actionType: step.actionType, undoFn: () => integrations[app].undo(step.actResult) });
    results.push({ actionType: step.actionType, ...outcome });
  }
  return results;
}

#!/usr/bin/env node
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { runIncident, undoRun } from "../src/agent.js";
import { createFactStore } from "../src/memory.js";
import { fetchTrigger } from "../src/integrations/sentry.js";
import { buildMockSentryPayload } from "../src/mock-trigger.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// INCIDENT_RESPONDER_ENV_PATH overrides the lookup (tests point it at nothing).
const DEFAULT_ENV_PATHS = process.env.INCIDENT_RESPONDER_ENV_PATH
  ? [process.env.INCIDENT_RESPONDER_ENV_PATH]
  : [join(process.cwd(), ".env"), join(packageDir, ".env")];

const REQUIRED_ENV = ["LINEAR_PERSONAL_ACCESS_KEY", "LINEAR_TEAM_ID", "SLACK_BOT_TOKEN", "SLACK_ALERT_CHANNEL", "GITHUB_DEMO_REPO", "HUBSPOT_PRIVATE_APP_TOKEN", "HUBSPOT_DEMO_COMPANY_ID"];

async function main() {
  await loadDotEnv(DEFAULT_ENV_PATHS);

  const args = process.argv.slice(2);
  const outDir = join(packageDir, "output");
  await mkdir(outDir, { recursive: true });

  if (args[0] === "--undo") {
    const runLogPath = args[1];
    if (!runLogPath) {
      console.error("Usage: node bin/cli.js --undo <run-log-path>");
      process.exitCode = 1;
      return;
    }
    const runLog = JSON.parse(await readFile(runLogPath, "utf8"));
    const results = await undoRun(runLog);
    runLog.undoneAt = new Date().toISOString();
    runLog.undoResults = results;
    await writeFile(runLogPath, JSON.stringify(runLog, null, 2));
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const useSentry = args.includes("--sentry");
  const required = useSentry ? [...REQUIRED_ENV, "SENTRY_AUTH_TOKEN", "SENTRY_ORG"] : REQUIRED_ENV;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Seeds a stale belief the live trigger will contradict — this is the
  // memory demo scene: checkout-api's real owner (per the mock trigger)
  // is team-payments, but memory still believes team-checkout.
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);

  const trigger = useSentry ? await fetchTrigger() : buildMockSentryPayload();
  if (trigger.sentryIssueId) {
    // Idempotency: one live run per Sentry issue. A prior run log that was
    // not undone means the tickets already exist — don't make them twice.
    const prior = await findLiveRun(outDir, trigger.sentryIssueId);
    if (prior) {
      console.error(`Sentry issue ${trigger.sentryShortId} already has a live run: ${prior}. Undo it first (--undo) or resolve the issue in Sentry.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Trigger: Sentry ${trigger.sentryShortId} — ${trigger.errorType} (${trigger.eventCount} events, owner ${trigger.reportedOwner}) ${trigger.sentryUrl}`);
  }

  const runLog = await runIncident({ trigger, factStore });
  const outPath = join(outDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(runLog, null, 2));

  console.log(`Incident run complete. ${runLog.steps.length} steps logged.`);
  for (const step of runLog.steps) {
    if (step.verifyResult) {
      console.log(`  ${step.actionType} [${step.tier}]: verify=${step.verifyResult.status} (confidence=${step.verifyResult.confidence.toFixed(2)})`);
    } else if (step.held) {
      console.log(`  ${step.actionType} [${step.tier}]: HELD (not fired) — ${step.intent.reason}`);
    } else if (step.actionType === "memory.reconcile") {
      console.log(`  memory.reconcile: revised=${step.revised}${step.revised ? ` (was "${step.oldFact.object}", now "${step.newFact.object}")` : ""}`);
    }
  }
  console.log(`Saved to ${outPath}`);
}

async function findLiveRun(dir, sentryIssueId) {
  for (const name of await readdir(dir)) {
    if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
    const log = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (log.trigger?.sentryIssueId === sentryIssueId && !log.undoneAt) return name;
  }
  return null;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

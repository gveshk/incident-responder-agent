#!/usr/bin/env node
import { readFile, rename } from "node:fs/promises";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { startRun, commitRun, undoRun } from "../src/runs.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// INCIDENT_RESPONDER_ENV_PATH overrides the lookup (tests point it at nothing).
const DEFAULT_ENV_PATHS = process.env.INCIDENT_RESPONDER_ENV_PATH
  ? [process.env.INCIDENT_RESPONDER_ENV_PATH]
  : [join(process.cwd(), ".env"), join(packageDir, ".env")];

const REQUIRED_ENV = ["LINEAR_PERSONAL_ACCESS_KEY", "LINEAR_TEAM_ID", "SLACK_BOT_TOKEN", "SLACK_ALERT_CHANNEL", "GITHUB_DEMO_REPO", "HUBSPOT_PRIVATE_APP_TOKEN", "HUBSPOT_DEMO_COMPANY_ID"];
const outDir = join(packageDir, "output");

function requireEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * --commit / --undo accept a run id or a path to a run log. Logs are named
 * run-<runId>.json; an older timestamp-named log is renamed so runs.js can
 * find it by id.
 */
async function resolveRunId(arg) {
  if (!/\.json$/.test(arg)) return arg.replace(/^run-/, "");
  const runId = JSON.parse(await readFile(arg, "utf8")).runId;
  if (basename(arg) !== `run-${runId}.json`) {
    await rename(arg, join(outDir, `run-${runId}.json`));
    console.log(`(renamed ${basename(arg)} → run-${runId}.json)`);
  }
  return runId;
}

async function main() {
  await loadDotEnv(DEFAULT_ENV_PATHS);
  const args = process.argv.slice(2);

  if (args[0] === "--commit" || args[0] === "--undo") {
    if (!args[1]) {
      console.error(`Usage: node bin/cli.js ${args[0]} <run-id or run-log-path>`);
      process.exitCode = 1;
      return;
    }
    if (args[0] === "--commit" && !requireEnv(["PAGERDUTY_API_KEY", "PAGERDUTY_SERVICE_ID", "PAGERDUTY_FROM_EMAIL"])) return;
    const runId = await resolveRunId(args[1]);
    if (args[0] === "--commit") {
      const { step } = await commitRun({ outDir, runId });
      console.log(`PagerDuty page COMMITTED: incident #${step.actResult.raw.number} ${step.actResult.raw.url}`);
      console.log(`  pagerduty.incidentCreate [compensable]: verify=${step.verifyResult.status} (confidence=${step.verifyResult.confidence.toFixed(2)})`);
    } else {
      const { results } = await undoRun({ outDir, runId });
      console.log(JSON.stringify(results, null, 2));
    }
    return;
  }

  const useSentry = args.includes("--sentry");
  if (!requireEnv(useSentry ? [...REQUIRED_ENV, "SENTRY_AUTH_TOKEN", "SENTRY_ORG"] : REQUIRED_ENV)) return;

  let runLog;
  try {
    runLog = await startRun({ source: useSentry ? "sentry" : "mock", outDir });
  } catch (err) {
    if (err.code !== "DUPLICATE_RUN") throw err;
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  const t = runLog.trigger;
  if (t.sentryIssueId) console.log(`Trigger: Sentry ${t.sentryShortId} — ${t.errorType} (${t.eventCount} events, owner ${t.reportedOwner}) ${t.sentryUrl}`);

  console.log(`Incident run complete. ${runLog.steps.length} steps logged.`);
  for (const step of runLog.steps) {
    if (step.actionType === "llm.diagnose") {
      console.log(step.fallback
        ? `  llm.diagnose: FALLBACK to template (${step.fallbackReason})`
        : `  llm.diagnose [${step.model}]: ${step.severity} — ${step.diagnosis}${step.likelyCause ? ` | likely cause: ${step.likelyCause}` : ""} (confidence=${step.confidence})`);
    } else if (step.verifyResult) {
      console.log(`  ${step.actionType} [${step.tier}]: verify=${step.verifyResult.status} (confidence=${step.verifyResult.confidence.toFixed(2)})${step.correctedVia ? ` — id corrected via ${step.correctedVia}` : ""}`);
    } else if (step.held) {
      console.log(`  ${step.actionType} [${step.tier}]: HELD (not fired) — ${step.intent.reason}. Fire it with: node bin/cli.js --commit ${runLog.runId}`);
    } else if (step.actionType === "memory.reconcile") {
      console.log(`  memory.reconcile: revised=${step.revised}${step.revised ? ` (was "${step.oldFact.object}", now "${step.newFact.object}")` : ""}`);
    }
  }
  console.log(`Saved to ${join(outDir, `run-${runLog.runId}.json`)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

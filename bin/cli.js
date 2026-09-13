#!/usr/bin/env node
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { runIncident, undoRun } from "../src/agent.js";
import { createFactStore } from "../src/memory.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// INCIDENT_RESPONDER_ENV_PATH overrides the lookup (tests point it at nothing).
const DEFAULT_ENV_PATHS = process.env.INCIDENT_RESPONDER_ENV_PATH
  ? [process.env.INCIDENT_RESPONDER_ENV_PATH]
  : [join(process.cwd(), ".env"), join(packageDir, ".env")];

const REQUIRED_ENV = ["LINEAR_PERSONAL_ACCESS_KEY", "LINEAR_TEAM_ID", "SLACK_BOT_TOKEN", "SLACK_ALERT_CHANNEL", "GITHUB_DEMO_REPO"];

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
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Seeds a stale belief the live trigger will contradict — this is the
  // memory demo scene: checkout-api's real owner (per the mock trigger)
  // is team-payments, but memory still believes team-checkout.
  const factStore = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);

  const runLog = await runIncident({ factStore });
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

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

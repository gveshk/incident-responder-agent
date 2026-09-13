#!/usr/bin/env node
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.js";
import { createApp } from "../src/server.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
await loadDotEnv(process.env.INCIDENT_RESPONDER_ENV_PATH ? [process.env.INCIDENT_RESPONDER_ENV_PATH] : [join(process.cwd(), ".env"), join(packageDir, ".env")]);

const REQUIRED = ["LINEAR_PERSONAL_ACCESS_KEY", "LINEAR_TEAM_ID", "SLACK_BOT_TOKEN", "SLACK_ALERT_CHANNEL", "GITHUB_DEMO_REPO", "HUBSPOT_PRIVATE_APP_TOKEN", "HUBSPOT_DEMO_COMPANY_ID", "SENTRY_AUTH_TOKEN", "SENTRY_ORG"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}
if (!process.env.SENTRY_WEBHOOK_SECRET) console.warn("SENTRY_WEBHOOK_SECRET not set — webhook signatures will not be checked. Set it to the secret shown on your Sentry internal integration.");

const app = createApp({ outDir: join(packageDir, "output") });
await app.recover();
const port = await app.listen(Number(process.env.PORT ?? 8787));
console.log(`incident-responder listening on http://localhost:${port}`);
console.log(`  POST /webhooks/sentry   POST /runs   GET /runs   POST /runs/:id/commit   POST /runs/:id/undo   GET /healthz`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log(`\n${sig}: finishing the current run, then exiting (queued jobs stay on disk)`);
    await app.close();
    await app.drained();
    process.exit(0);
  });
}

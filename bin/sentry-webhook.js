#!/usr/bin/env node
/**
 * Point the Sentry internal integration "Incident Responder" at a new
 * public URL — needed every time a cloudflared quick tunnel restarts.
 *
 *   node bin/sentry-webhook.js https://<something>.trycloudflare.com
 *   node bin/sentry-webhook.js            # prints the current webhook URL
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../src/env.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
await loadDotEnv([join(process.cwd(), ".env"), join(packageDir, ".env")]);

const { SENTRY_AUTH_TOKEN: token, SENTRY_ORG: org } = process.env;
if (!token || !org) { console.error("SENTRY_AUTH_TOKEN and SENTRY_ORG are required"); process.exit(1); }
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const apps = await (await fetch(`https://sentry.io/api/0/organizations/${org}/sentry-apps/`, { headers })).json();
const app = apps.find((a) => a.name === "Incident Responder");
if (!app) { console.error(`no internal integration named "Incident Responder" in org ${org}`); process.exit(1); }

const base = process.argv[2];
if (!base) { console.log(`${app.slug}: ${app.webhookUrl}`); process.exit(0); }

const webhookUrl = `${base.replace(/\/$/, "")}/webhooks/sentry`;
const res = await fetch(`https://sentry.io/api/0/sentry-apps/${app.slug}/`, { method: "PUT", headers, body: JSON.stringify({ webhookUrl }) });
if (!res.ok) { console.error(`Sentry ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
console.log(`${app.slug}: webhook → ${webhookUrl}`);

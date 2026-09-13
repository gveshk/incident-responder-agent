import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createApp } from "../src/server.js";
import { verify as verifyCore } from "../src/verifier.js";

const quiet = { info() {}, warn() {} };
const fakeDiagnoser = async (trigger) => ({ fallback: true, fallbackReason: "test", model: null, promptHash: "x", diagnosis: `spike: ${trigger.errorType}`, likelyCause: null, severity: "P3", suggestedOwner: trigger.reportedOwner, confidence: null });

function fakeIntegration(name) {
  let n = 0;
  return {
    act: async (input) => { n += 1; return { id: `${name}-${n}`, raw: { ...input, url: `https://x/${name}/${n}` }, capturedBefore: null }; },
    verify: async (a, intent) => { const v = intent.description ?? intent.text ?? intent.body ?? intent.value ?? intent.title; return verifyCore({ exists: true, content: { expected: v, actual: v, app: name } }); },
    undo: async () => ({ ok: true }),
  };
}
const integrations = () => Object.fromEntries(["linear", "slack", "github", "hubspot", "sentry", "pagerduty"].map((n) => [n, fakeIntegration(n)]));

async function boot(opts = {}) {
  const outDir = await mkdtemp(join(tmpdir(), "ir-server-"));
  const app = createApp({ outDir, integrations: integrations(), diagnoser: fakeDiagnoser, log: quiet, webhookSecret: opts.secret ?? null, ...(opts.runner ? { runner: opts.runner } : {}) });
  await app.recover();
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
    return { status: res.status, body: await res.json() };
  };
  return { app, outDir, call, close: () => app.close() };
}

test("POST /runs queues a mock run; the worker completes it and GET /runs lists it", async () => {
  const s = await boot();
  const r = await s.call("POST", "/runs", { source: "mock" });
  assert.equal(r.status, 202);
  await s.app.drained();
  const list = await s.call("GET", "/runs");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].finishedAt !== null, true);
  const one = await s.call("GET", `/runs/${list.body[0].runId}`);
  assert.equal(one.body.steps.filter((x) => x.verifyResult).every((x) => x.verifyResult.status === "true"), true);
  await s.close();
});

test("GET / serves the UI", async () => {
  const s = await boot();
  const res = await fetch(`http://127.0.0.1:${s.app.server.address().port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Incident Responder/);
  await s.close();
});

test("commit then undo through the API; a second commit is 409, a second undo is 409", async () => {
  const s = await boot();
  await s.call("POST", "/runs", { source: "mock" });
  await s.app.drained();
  const { runId } = (await s.call("GET", "/runs")).body[0];
  const c1 = await s.call("POST", `/runs/${runId}/commit`);
  assert.equal(c1.status, 200);
  assert.equal(c1.body.verify, "true");
  assert.equal((await s.call("POST", `/runs/${runId}/commit`)).status, 409);
  const u1 = await s.call("POST", `/runs/${runId}/undo`);
  assert.equal(u1.status, 200);
  assert.ok(u1.body.results.some((r) => r.actionType === "pagerduty.incidentCreate" && r.outcome === "compensated"));
  assert.equal((await s.call("POST", `/runs/${runId}/undo`)).status, 409);
  await s.close();
});

test("webhook: rejects a bad signature, accepts a good one, and needs an issue id", async () => {
  const s = await boot({ secret: "shh" });
  const payload = JSON.stringify({ action: "created", data: { issue: { id: "123" } } });
  const good = createHmac("sha256", "shh").update(payload).digest("hex");
  assert.equal((await s.call("POST", "/webhooks/sentry", payload, { "sentry-hook-signature": "nope" })).status, 401);
  assert.equal((await s.call("POST", "/webhooks/sentry", payload)).status, 401);
  const ok = await s.call("POST", "/webhooks/sentry", payload, { "sentry-hook-signature": good });
  assert.equal(ok.status, 202);
  const empty = JSON.stringify({ action: "created", data: {} });
  assert.equal((await s.call("POST", "/webhooks/sentry", empty, { "sentry-hook-signature": createHmac("sha256", "shh").update(empty).digest("hex") })).status, 400);
  await s.app.drained(); // the queued sentry job fails (no token) — logged, not thrown
  await s.close();
});

test("webhook: lifecycle events (resolved / ignored / assigned) are acknowledged and ignored, never run", async () => {
  const s = await boot();
  for (const action of ["resolved", "ignored", "assigned"]) {
    const r = await s.call("POST", "/webhooks/sentry", { action, data: { issue: { id: "42" } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ignored: action });
  }
  const health = await s.call("GET", "/healthz");
  assert.equal(health.body.queued, 0);
  await s.close();
});

test("webhook dedup: an issue with a live run is acknowledged, not re-run", async () => {
  const s = await boot();
  // Plant a live run for issue 555 the way a previous process would have.
  await writeFile(join(s.outDir, "run-abc.json"), JSON.stringify({ runId: "abc", startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:10Z", trigger: { sentryIssueId: "555", sentryShortId: "X-1" }, steps: [] }));
  const r = await s.call("POST", "/webhooks/sentry", { action: "created", data: { issue: { id: 555 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { deduplicated: true, runId: "abc" });
  await s.close();
});

test("webhook dedup: a burst of alerts for one issue enqueues a single job", async () => {
  // A runner that holds the worker for 300ms so the second alert arrives while the first is running.
  const s = await boot({ runner: () => new Promise((resolve) => setTimeout(() => resolve({ runId: "slow", steps: [] }), 300)) });
  const first = await s.call("POST", "/webhooks/sentry", { action: "created", data: { issue: { id: 777 } } });
  assert.equal(first.status, 202);
  const second = await s.call("POST", "/webhooks/sentry", { action: "created", data: { issue: { id: 777 } } });
  assert.equal(second.status, 200);
  assert.equal(second.body.deduplicated, true);
  await s.app.drained();
  await s.close();
});

test("queue is persisted: a job left on disk is picked up by recover(); a crashed run is reported, not resumed", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "ir-server-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(outDir, "queue"), { recursive: true });
  await writeFile(join(outDir, "queue", "0001-x.json"), JSON.stringify({ id: "0001-x", source: "mock", via: "api" }));
  await writeFile(join(outDir, "run-crashed.json"), JSON.stringify({ runId: "crashed", startedAt: "2026-01-01T00:00:00Z", finishedAt: null, trigger: {}, steps: [{ actionType: "llm.diagnose" }, { actionType: "linear.issueCreate" }] }));
  const app = createApp({ outDir, integrations: integrations(), diagnoser: fakeDiagnoser, log: quiet });
  await app.recover();
  await app.drained();
  const port = await app.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.deepEqual(health.incompleteRuns, ["crashed"]);
  const files = await readdir(outDir);
  assert.equal(files.filter((f) => f.startsWith("run-")).length, 2, "the queued job ran; the crashed run was left alone");
  assert.equal((await readdir(join(outDir, "queue"))).length, 0, "queue file removed after the job ran");
  await app.close();
});

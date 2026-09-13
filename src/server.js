import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as runs from "./runs.js";

/**
 * The always-on shape of the agent. No framework, no dependency:
 *
 *   POST /webhooks/sentry        Sentry issue-alert webhook → queue a run (HMAC-verified)
 *   POST /runs                   { source: "mock" | "sentry", issueId? } → queue a run
 *   GET  /runs                   all run logs, newest first
 *   GET  /runs/:id               one run log
 *   POST /runs/:id/commit        fire the held PagerDuty page (the human approval)
 *   POST /runs/:id/undo          reverse the run
 *   GET  /healthz                { ok, queued, running, incompleteRuns }
 *
 * The queue is one worker, in order: two alerts for the same issue can't
 * race into two runs. Pending jobs are persisted under output/queue/ so a
 * restart picks them up. A run that crashed mid-way is NOT resumed —
 * re-running steps would duplicate side effects — it is reported under
 * /healthz.incompleteRuns and left for --undo.
 */
export function createApp({ outDir, integrations, diagnoser, webhookSecret = process.env.SENTRY_WEBHOOK_SECRET, log = console, runner = runs.startRun } = {}) {
  const queueDir = join(outDir, "queue");
  const queue = [];
  let running = null;
  let draining = null;

  async function enqueue(job) {
    await mkdir(queueDir, { recursive: true });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, ...job, queuedAt: new Date().toISOString() };
    await writeFile(join(queueDir, `${id}.json`), JSON.stringify(record));
    queue.push(record);
    drain();
    return record;
  }

  async function runQueue() {
    while (queue.length) {
      const job = queue.shift();
      running = job;
      try {
        const runLog = await runner({ source: job.source, issueId: job.issueId ?? null, outDir, integrations, diagnoser });
        log.info?.(`run ${runLog.runId} complete (${runLog.steps.length} steps) for job ${job.id}`);
      } catch (err) {
        log.warn?.(`job ${job.id} not run: ${err.message}`);
      } finally {
        running = null;
        await unlink(join(queueDir, `${job.id}.json`)).catch(() => {});
      }
    }
  }

  function drain() {
    if (draining) return draining;
    // Clear the handle only once the worker has actually finished, and pick
    // up anything that arrived while it was finishing.
    draining = runQueue().finally(() => { draining = null; if (queue.length) drain(); });
    return draining;
  }

  /** Re-queue jobs left on disk by a previous process. */
  async function recover() {
    await mkdir(queueDir, { recursive: true });
    for (const name of (await readdir(queueDir)).sort()) {
      if (!name.endsWith(".json")) continue;
      queue.push(JSON.parse(await readFile(join(queueDir, name), "utf8")));
    }
    if (queue.length) log.info?.(`recovered ${queue.length} queued job(s)`);
    const incomplete = await runs.findIncompleteRuns(outDir);
    for (const r of incomplete) log.warn?.(`run ${r.runId} is incomplete (${r.steps.length} steps, crashed mid-run) — not resumed; undo it: POST /runs/${r.runId}/undo`);
    drain();
  }

  function verifySignature(rawBody, header) {
    if (!webhookSecret) return { ok: true, note: "SENTRY_WEBHOOK_SECRET not set — signature not checked" };
    if (!header) return { ok: false };
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected), b = Buffer.from(String(header));
    return { ok: a.length === b.length && timingSafeEqual(a, b) };
  }

  /** Sentry sends several webhook shapes; the issue id is in one of these places. */
  function issueIdFrom(payload) {
    return payload?.data?.issue?.id ?? payload?.data?.event?.issue_id ?? payload?.data?.event?.issue ?? payload?.issue?.id ?? null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : {};
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        const incomplete = await runs.findIncompleteRuns(outDir);
        return send(200, { ok: true, queued: queue.length, running: running?.id ?? null, incompleteRuns: incomplete.map((r) => r.runId) });
      }
      if (req.method === "POST" && url.pathname === "/webhooks/sentry") {
        const sig = verifySignature(raw, req.headers["sentry-hook-signature"]);
        if (!sig.ok) return send(401, { error: "bad signature" });
        const issueId = issueIdFrom(body);
        if (!issueId) return send(400, { error: "no issue id in payload" });
        const live = await runs.findLiveRun(outDir, String(issueId));
        if (live) return send(200, { deduplicated: true, runId: live.runId });
        const pending = [running, ...queue].find((j) => j && j.issueId === String(issueId));
        if (pending) return send(200, { deduplicated: true, queued: pending.id });
        const job = await enqueue({ source: "sentry", issueId: String(issueId), via: "webhook" });
        return send(202, { queued: job.id, note: sig.note });
      }
      if (req.method === "POST" && url.pathname === "/runs") {
        const source = body?.source === "sentry" ? "sentry" : "mock";
        const job = await enqueue({ source, issueId: body?.issueId ?? null, via: "api" });
        return send(202, { queued: job.id });
      }
      if (req.method === "GET" && url.pathname === "/runs") {
        const all = await runs.listRuns(outDir);
        return send(200, all.map((r) => ({ runId: r.runId, startedAt: r.startedAt, finishedAt: r.finishedAt, undoneAt: r.undoneAt ?? null, trigger: r.trigger?.sentryShortId ?? "mock", steps: r.steps.length, pageCommitted: r.steps.some((s) => s.committed) })));
      }
      if (parts[0] === "runs" && parts[1]) {
        const runId = parts[1];
        if (req.method === "GET" && !parts[2]) return send(200, await runs.readRun(outDir, runId));
        if (req.method === "POST" && parts[2] === "commit") { const { step } = await runs.commitRun({ outDir, runId, integrations }); return send(200, { committed: true, incident: step.actResult.raw, verify: step.verifyResult.status }); }
        if (req.method === "POST" && parts[2] === "undo") { const { results } = await runs.undoRun({ outDir, runId, integrations }); return send(200, { undone: true, results }); }
      }
      return send(404, { error: "not found" });
    } catch (err) {
      if (err.code === "ENOENT") return send(404, { error: "no such run" });
      const status = err.code === "DUPLICATE_RUN" || err.code === "ALREADY_UNDONE" || /already committed/.test(err.message) ? 409 : 500;
      return send(status, { error: err.message });
    }
  }

  const server = createServer((req, res) => { handle(req, res).catch((err) => { res.writeHead(500); res.end(err.message); }); });
  return {
    server,
    recover,
    listen: (port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
    drained: async () => { while (draining) await draining; },
  };
}

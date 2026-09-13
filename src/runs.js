import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { runIncident, commitPage, undoRun as undoRunLog } from "./agent.js";
import { createFactStore } from "./memory.js";
import { fetchTrigger, fetchLatestEvent } from "./integrations/sentry.js";
import { buildMockSentryPayload } from "./mock-trigger.js";

/**
 * The run lifecycle, shared by the CLI and the server. The run log on disk
 * is the source of truth: written after every step (crash-safe), stamped
 * on commit and undo, and scanned for idempotency.
 */

// Seeds a stale belief the mock trigger contradicts — the memory demo scene.
export const DEMO_FACTS = [{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }];

const runPath = (outDir, runId) => join(outDir, `run-${runId}.json`);

async function pathFor(outDir, runId) {
  const direct = runPath(outDir, runId);
  try { await readFile(direct); return direct; } catch { /* fall through */ }
  for (const name of await readdir(outDir)) {
    if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
    try { if (JSON.parse(await readFile(join(outDir, name), "utf8")).runId === runId) return join(outDir, name); } catch { /* skip */ }
  }
  return direct;
}

async function writeAtomic(path, data) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export async function listRuns(outDir) {
  await mkdir(outDir, { recursive: true });
  const runs = [];
  for (const name of await readdir(outDir)) {
    if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
    try {
      runs.push(JSON.parse(await readFile(join(outDir, name), "utf8")));
    } catch { /* a half-written file from a crash mid-write; skip it */ }
  }
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function readRun(outDir, runId) {
  try {
    return JSON.parse(await readFile(runPath(outDir, runId), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    // Older logs were named by timestamp; find by the runId inside.
    const found = (await listRuns(outDir)).find((r) => r.runId === runId);
    if (!found) throw err;
    return found;
  }
}

/** A run for this Sentry issue that has not been undone — its artifacts still exist. */
export async function findLiveRun(outDir, sentryIssueId) {
  return (await listRuns(outDir)).find((r) => r.trigger?.sentryIssueId === sentryIssueId && !r.undoneAt) ?? null;
}

/** Runs that crashed mid-way: steps were taken, no finishedAt, not undone. */
export async function findIncompleteRuns(outDir) {
  return (await listRuns(outDir)).filter((r) => !r.finishedAt && !r.undoneAt);
}

/**
 * @param {{source: "mock"|"sentry", issueId?: string, outDir: string, integrations?: object, diagnoser?: Function}} opts
 * @returns {Promise<object>} the finished run log
 */
export async function startRun({ source = "mock", issueId = null, outDir, integrations, diagnoser }) {
  await mkdir(outDir, { recursive: true });
  const trigger = source === "sentry" ? await fetchTrigger({ issueId }) : buildMockSentryPayload();
  if (trigger.sentryIssueId) {
    const prior = await findLiveRun(outDir, trigger.sentryIssueId);
    if (prior) {
      const err = new Error(`Sentry issue ${trigger.sentryShortId} already has a live run ${prior.runId}. Undo it first or resolve the issue in Sentry.`);
      err.code = "DUPLICATE_RUN";
      err.runId = prior.runId;
      throw err;
    }
  }
  const event = trigger.sentryIssueId ? await fetchLatestEvent(trigger.sentryIssueId) : null;
  const factStore = createFactStore(DEMO_FACTS);
  const runLog = await runIncident({
    trigger, factStore, event, integrations, diagnoser,
    onStep: (partial) => writeAtomic(runPath(outDir, partial.runId), partial),
  });
  await writeAtomic(runPath(outDir, runLog.runId), runLog);
  return runLog;
}

export async function commitRun({ outDir, runId, integrations }) {
  const runLog = await readRun(outDir, runId);
  const step = await commitPage(runLog, integrations);
  await writeAtomic(await pathFor(outDir, runId), runLog);
  return { runLog, step };
}

export async function undoRun({ outDir, runId, integrations }) {
  const runLog = await readRun(outDir, runId);
  if (runLog.undoneAt) {
    const err = new Error(`run ${runId} was already undone at ${runLog.undoneAt}`);
    err.code = "ALREADY_UNDONE";
    throw err;
  }
  const results = await undoRunLog(runLog, integrations);
  runLog.undoneAt = new Date().toISOString();
  runLog.undoResults = results;
  await writeAtomic(await pathFor(outDir, runId), runLog);
  return { runLog, results };
}

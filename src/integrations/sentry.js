import { verify as verifyCore } from "../verifier.js";

const SENTRY_API_URL = "https://sentry.io/api/0";

async function sentryRequest(method, path, body) {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error("SENTRY_AUTH_TOKEN is not set");
  const res = await fetch(`${SENTRY_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`Sentry API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? {} : res.json();
}

/**
 * Sentry as the TRIGGER: the latest unresolved issue in the org,
 * normalized to the same shape as the mock payload so agent.js doesn't
 * care where an incident came from. Owner comes from real data — the
 * issue's assignee if any, else the project's team.
 */
export async function fetchTrigger({ org = process.env.SENTRY_ORG, issueId = null } = {}) {
  if (!org) throw new Error("SENTRY_ORG is not set");
  let issue;
  if (issueId) {
    issue = await sentryRequest("GET", `/issues/${issueId}/`);
  } else {
    const issues = await sentryRequest("GET", `/organizations/${org}/issues/?query=is:unresolved&sort=date&limit=1`);
    issue = issues[0];
  }
  if (!issue) throw new Error(`no unresolved issues in Sentry org "${org}"`);

  let owner = issue.assignedTo?.name;
  if (!owner) {
    const project = await sentryRequest("GET", `/projects/${org}/${issue.project.slug}/`);
    owner = project.teams?.[0]?.slug ?? "unassigned";
  }
  const windowMinutes = Math.max(1, Math.round((new Date(issue.lastSeen) - new Date(issue.firstSeen)) / 60000));
  return {
    service: issue.project.slug,
    errorType: issue.title,
    eventCount: Number(issue.count),
    windowMinutes,
    reportedOwner: owner,
    escalationPolicy: `${owner}-oncall`,
    sentryIssueId: issue.id,
    sentryShortId: issue.shortId,
    sentryUrl: issue.permalink,
    culprit: issue.culprit,
    level: issue.level,
  };
}

/** Latest event's message and innermost stack frames, for the diagnoser. Best-effort: null on any failure. */
export async function fetchLatestEvent(issueId) {
  try {
    const e = await sentryRequest("GET", `/issues/${issueId}/events/latest/`);
    const exc = e.entries?.find((x) => x.type === "exception");
    const frames = (exc?.data?.values?.[0]?.stacktrace?.frames ?? []).slice(-6).map((f) => `${f.filename}:${f.lineNo} in ${f.function}`);
    return { message: e.message || e.title || null, frames };
  } catch {
    return null;
  }
}

/**
 * Sentry as an ACTION target: a note on the issue linking the ticket.
 * Reversible — the note can be deleted outright.
 */
export async function act(input) {
  const note = await sentryRequest("POST", `/issues/${input.issueId}/comments/`, { text: input.text });
  return { id: note.id, raw: { issueId: input.issueId, text: note.data?.text ?? input.text }, capturedBefore: null };
}

export async function verify(actResult, intent) {
  let note;
  try {
    const notes = await sentryRequest("GET", `/issues/${actResult.raw.issueId}/comments/`);
    note = notes.find((n) => String(n.id) === String(actResult.id));
  } catch (err) {
    if (err.status === 404) return verifyCore({ exists: false, content: null });
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(note),
    content: note ? { expected: intent.text, actual: note.data?.text, app: "sentry" } : null,
  });
}

/** Second source: notes on the issue with this exact text. */
export async function findByContent(intent) {
  const notes = await sentryRequest("GET", `/issues/${intent.issueId}/comments/`);
  return notes.filter((n) => n.data?.text === intent.text).map((n) => ({ id: n.id, raw: { issueId: intent.issueId, text: n.data.text } }));
}

export async function undo(actResult) {
  try {
    await sentryRequest("DELETE", `/issues/${actResult.raw.issueId}/comments/${actResult.id}/`);
    return { ok: true, compensationType: "restored" };
  } catch (err) {
    return { ok: false, compensationType: "escalated", error: err.message };
  }
}

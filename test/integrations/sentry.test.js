import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo, fetchTrigger } from "../../src/integrations/sentry.js";

function withMockedFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method ?? "GET", body: opts?.body ? JSON.parse(opts.body) : null });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: response.status ? response.status < 400 : true, status: response.status ?? 200, json: async () => response.body ?? response };
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

const ISSUE = {
  id: "7729975167", shortId: "JAVASCRIPT-NEXTJS-1", title: "TypeError: Object has no method 'updateFrom'", count: "1",
  firstSeen: "2026-09-13T17:23:19Z", lastSeen: "2026-09-13T17:28:19Z", level: "error", culprit: "views.js in poll",
  permalink: "https://barebone-agents.sentry.io/issues/7729975167/", project: { slug: "javascript-nextjs" }, assignedTo: null,
};

test("fetchTrigger normalizes the latest unresolved issue into the trigger shape", async () => {
  process.env.SENTRY_AUTH_TOKEN = "fake";
  process.env.SENTRY_ORG = "barebone-agents";
  await withMockedFetch(
    [{ body: [ISSUE] }, { body: { teams: [{ slug: "barebone-agents" }] } }],
    async () => {
      const t = await fetchTrigger();
      assert.equal(t.service, "javascript-nextjs");
      assert.equal(t.errorType, ISSUE.title);
      assert.equal(t.eventCount, 1);
      assert.equal(t.windowMinutes, 5);
      assert.equal(t.reportedOwner, "barebone-agents");
      assert.equal(t.sentryIssueId, "7729975167");
      assert.equal(t.sentryUrl, ISSUE.permalink);
    },
  );
});

test("fetchTrigger prefers the assignee as owner when there is one", async () => {
  await withMockedFetch([{ body: [{ ...ISSUE, assignedTo: { type: "team", name: "team-payments" } }] }], async () => {
    const t = await fetchTrigger();
    assert.equal(t.reportedOwner, "team-payments");
  });
});

test("fetchTrigger throws when there are no unresolved issues", async () => {
  await withMockedFetch([{ body: [] }], async () => {
    await assert.rejects(() => fetchTrigger(), /no unresolved issues/);
  });
});

test("act() posts a note on the issue and returns the note id", async () => {
  await withMockedFetch([{ body: { id: "note-1", data: { text: "Tracking in Linear: https://linear.app/x" } } }], async (calls) => {
    const result = await act({ issueId: "7729975167", text: "Tracking in Linear: https://linear.app/x" });
    assert.equal(result.id, "note-1");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /issues\/7729975167\/comments\/$/);
    assert.deepEqual(calls[0].body, { text: "Tracking in Linear: https://linear.app/x" });
  });
});

test("verify() finds the note in the issue's note list and matches its text", async () => {
  await withMockedFetch([{ body: [{ id: "note-1", data: { text: "Tracking in Linear: https://linear.app/x" } }] }], async () => {
    const result = await verify({ id: "note-1", raw: { issueId: "7729975167" } }, { text: "Tracking in Linear: https://linear.app/x" });
    assert.equal(result.status, "true");
  });
});

test("verify() returns false when the note is missing", async () => {
  await withMockedFetch([{ body: [] }], async () => {
    const result = await verify({ id: "note-1", raw: { issueId: "7729975167" } }, { text: "x" });
    assert.equal(result.status, "false");
  });
});

test("undo() deletes the note", async () => {
  await withMockedFetch([{ status: 204, body: {} }], async (calls) => {
    const result = await undo({ id: "note-1", raw: { issueId: "7729975167" } });
    assert.equal(result.ok, true);
    assert.equal(result.compensationType, "restored");
    assert.equal(calls[0].method, "DELETE");
    assert.match(calls[0].url, /comments\/note-1\/$/);
  });
});

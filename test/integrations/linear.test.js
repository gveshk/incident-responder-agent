import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo } from "../../src/integrations/linear.js";

function withMockedFetch(responses, fn) {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async () => {
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { json: async () => response };
  };
  return fn().finally(() => { globalThis.fetch = original; });
}

test("act() creates an issue and returns its id", async () => {
  process.env.LINEAR_PERSONAL_ACCESS_KEY = "fake-key";
  process.env.LINEAR_TEAM_ID = "fake-team";
  await withMockedFetch(
    [{ data: { issueCreate: { success: true, issue: { id: "issue-1", identifier: "ENG-1", title: "t", description: "d", url: "https://linear.app/x/issue/ENG-1" } } } }],
    async () => {
      const result = await act({ title: "t", description: "d" });
      assert.equal(result.id, "issue-1");
      assert.equal(result.raw.url, "https://linear.app/x/issue/ENG-1");
    },
  );
});

test("act() throws when issueCreate reports success:false", async () => {
  process.env.LINEAR_PERSONAL_ACCESS_KEY = "fake-key";
  process.env.LINEAR_TEAM_ID = "fake-team";
  await withMockedFetch([{ data: { issueCreate: { success: false } } }], async () => {
    await assert.rejects(() => act({ title: "t", description: "d" }), /success=false/);
  });
});

test("verify() returns true when the independent read matches", async () => {
  await withMockedFetch(
    [{ data: { issue: { id: "issue-1", title: "t", description: "d", state: { name: "Backlog" } } } }],
    async () => {
      const result = await verify({ id: "issue-1" }, { description: "d" });
      assert.equal(result.status, "true");
    },
  );
});

test("verify() returns false when the issue does not exist on read-back", async () => {
  await withMockedFetch([{ data: { issue: null } }], async () => {
    const result = await verify({ id: "gone" }, { description: "d" });
    assert.equal(result.status, "false");
  });
});

test("verify() returns false when the issue exists but is trashed (Linear soft-delete)", async () => {
  await withMockedFetch([{ data: { issue: { id: "issue-1", title: "t", description: "d", trashed: true, state: { name: "Backlog" } } } }], async () => {
    const result = await verify({ id: "issue-1" }, { description: "d" });
    assert.equal(result.status, "false");
  });
});

test("undo() deletes the issue", async () => {
  await withMockedFetch([{ data: { issueDelete: { success: true } } }], async () => {
    const result = await undo({ id: "issue-1" });
    assert.equal(result.ok, true);
    assert.equal(result.compensationType, "restored");
  });
});

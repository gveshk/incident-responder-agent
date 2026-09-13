import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo } from "../../src/integrations/slack.js";

// Fake WebClient: only the three methods the integration touches.
function fakeClient({ historyMessages = [], deleteThrows = false } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async (args) => { calls.push(["postMessage", args]); return { ts: "1700000000.000100" }; },
      delete: async (args) => { calls.push(["delete", args]); if (deleteThrows) throw new Error("cant_delete_message"); return { ok: true }; },
    },
    conversations: {
      history: async () => ({ messages: historyMessages }),
    },
  };
}

test("act() posts a message and returns its ts as id", async () => {
  process.env.SLACK_ALERT_CHANNEL = "C0BF5V41066";
  const result = await act({ text: "incident alert" }, { client: fakeClient() });
  assert.equal(result.id, "1700000000.000100");
  assert.equal(result.raw.channel, "C0BF5V41066");
});

test("verify() returns true when conversations.history finds the message", async () => {
  const client = fakeClient({ historyMessages: [{ ts: "1700000000.000100", text: "incident alert" }] });
  const result = await verify({ id: "1700000000.000100", raw: { channel: "C0BF5V41066", ts: "1700000000.000100" } }, { text: "incident alert" }, { client });
  assert.equal(result.status, "true");
});

test("verify() returns false when the message is missing from history", async () => {
  const client = fakeClient({ historyMessages: [] });
  const result = await verify({ id: "gone", raw: { channel: "C0BF5V41066", ts: "gone" } }, { text: "incident alert" }, { client });
  assert.equal(result.status, "false");
});

test("undo() deletes the message", async () => {
  const result = await undo({ raw: { channel: "C0BF5V41066", ts: "1700000000.000100" } }, { client: fakeClient() });
  assert.equal(result.ok, true);
  assert.equal(result.compensationType, "restored");
});

test("undo() posts a threaded retraction when delete fails", async () => {
  const client = fakeClient({ deleteThrows: true });
  const result = await undo({ raw: { channel: "C0BF5V41066", ts: "1700000000.000100" } }, { client });
  assert.equal(result.ok, true);
  assert.equal(result.compensationType, "compensated");
  const retraction = client.calls.find(([name]) => name === "postMessage");
  assert.equal(retraction[1].thread_ts, "1700000000.000100");
});

test("act() without a token or injected client fails loudly", async () => {
  delete process.env.SLACK_BOT_TOKEN;
  await assert.rejects(() => act({ text: "x", channel: "C1" }), /SLACK_BOT_TOKEN is not set/);
});

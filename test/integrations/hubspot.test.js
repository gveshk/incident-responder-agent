import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo } from "../../src/integrations/hubspot.js";

function withMockedFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: response.status ? response.status < 400 : true, status: response.status ?? 200, json: async () => response };
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

test("act() captures the pre-state, then PATCHes the property", async () => {
  process.env.HUBSPOT_PRIVATE_APP_TOKEN = "fake-token";
  await withMockedFetch(
    [
      { id: "co-1", properties: { incident_status: "normal" } }, // GET before
      { id: "co-1", properties: { incident_status: "investigating" } }, // PATCH
    ],
    async (calls) => {
      const result = await act({ objectId: "co-1", property: "incident_status", value: "investigating" });
      assert.equal(result.id, "co-1");
      assert.deepEqual(result.capturedBefore, { incident_status: "normal" });
      assert.equal(calls[0].method, "GET");
      assert.equal(calls[1].method, "PATCH");
      assert.deepEqual(calls[1].body, { properties: { incident_status: "investigating" } });
    },
  );
});

test("verify() confirms the property value on an independent read", async () => {
  await withMockedFetch([{ id: "co-1", properties: { incident_status: "investigating" } }], async () => {
    const result = await verify({ id: "co-1", raw: { property: "incident_status" } }, { value: "investigating" });
    assert.equal(result.status, "true");
  });
});

test("verify() returns false when the read-back value differs from intent", async () => {
  await withMockedFetch([{ id: "co-1", properties: { incident_status: "normal" } }], async () => {
    const result = await verify({ id: "co-1", raw: { property: "incident_status" } }, { value: "investigating" });
    assert.equal(result.status, "false");
  });
});

test("verify() returns false when the object is gone (404)", async () => {
  await withMockedFetch([{ status: 404, message: "not found" }], async () => {
    const result = await verify({ id: "gone", raw: { property: "incident_status" } }, { value: "investigating" });
    assert.equal(result.status, "false");
  });
});

test("undo() restores the captured pre-state value", async () => {
  await withMockedFetch([{ id: "co-1", properties: { incident_status: "normal" } }], async (calls) => {
    const result = await undo({ id: "co-1", raw: { property: "incident_status" }, capturedBefore: { incident_status: "normal" } });
    assert.equal(result.ok, true);
    assert.equal(result.compensationType, "restored");
    assert.deepEqual(calls[0].body, { properties: { incident_status: "normal" } });
  });
});

test("undo() escalates when the restore PATCH fails", async () => {
  await withMockedFetch([{ status: 429, message: "rate limited" }], async () => {
    const result = await undo({ id: "co-1", raw: { property: "incident_status" }, capturedBefore: { incident_status: "normal" } });
    assert.equal(result.ok, false);
    assert.equal(result.compensationType, "escalated");
  });
});

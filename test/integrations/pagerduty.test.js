import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo } from "../../src/integrations/pagerduty.js";

function withMockedFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];
  let call = 0;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method ?? "GET", headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : null });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: response.status ? response.status < 400 : true, status: response.status ?? 200, json: async () => response.body ?? response, text: async () => JSON.stringify(response.body ?? response) };
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

const INCIDENT = { id: "Q1ABC", incident_number: 7, title: "[P2] checkout-api: TypeError", status: "triggered", incident_key: "run-123", html_url: "https://x.pagerduty.com/incidents/Q1ABC" };

test("act() creates an incident on the service with a From header and the run id as incident_key", async () => {
  process.env.PAGERDUTY_API_KEY = "fake";
  process.env.PAGERDUTY_SERVICE_ID = "PDY9O4H";
  process.env.PAGERDUTY_FROM_EMAIL = "oncall@example.com";
  await withMockedFetch([{ status: 201, body: { incident: INCIDENT } }], async (calls) => {
    const result = await act({ title: "[P2] checkout-api: TypeError", details: "diag", incidentKey: "run-123" });
    assert.equal(result.id, "Q1ABC");
    assert.equal(result.raw.incidentKey, "run-123");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.From, "oncall@example.com");
    assert.equal(calls[0].body.incident.service.id, "PDY9O4H");
    assert.equal(calls[0].body.incident.incident_key, "run-123");
  });
});

test("verify() looks the incident up by incident_key (a different path than the create response) and checks it is open", async () => {
  await withMockedFetch([{ body: { incidents: [INCIDENT] } }], async (calls) => {
    const result = await verify({ id: "Q1ABC", raw: { incidentKey: "run-123" } }, { title: "[P2] checkout-api: TypeError" });
    assert.equal(result.status, "true");
    assert.match(calls[0].url, /incidents\?.*incident_key=run-123/);
  });
});

test("verify() returns false when no open incident carries the key", async () => {
  await withMockedFetch([{ body: { incidents: [] } }], async () => {
    const result = await verify({ id: "Q1ABC", raw: { incidentKey: "run-123" } }, { title: "x" });
    assert.equal(result.status, "false");
  });
});

test("verify() returns false when the incident exists but was already resolved", async () => {
  await withMockedFetch([{ body: { incidents: [{ ...INCIDENT, status: "resolved" }] } }], async () => {
    const result = await verify({ id: "Q1ABC", raw: { incidentKey: "run-123" } }, { title: INCIDENT.title });
    assert.equal(result.status, "false");
  });
});

test("undo() resolves the incident and reports it as compensated, never restored — someone was paged", async () => {
  await withMockedFetch([{ body: { incident: { ...INCIDENT, status: "resolved" } } }], async (calls) => {
    const result = await undo({ id: "Q1ABC", raw: { incidentKey: "run-123" } });
    assert.equal(result.ok, true);
    assert.equal(result.compensationType, "compensated");
    assert.equal(calls[0].method, "PUT");
    assert.equal(calls[0].body.incident.status, "resolved");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMockSentryPayload } from "../src/mock-trigger.js";

test("buildMockSentryPayload returns a complete default payload", () => {
  const payload = buildMockSentryPayload();
  assert.equal(payload.service, "checkout-api");
  assert.ok(payload.errorType);
  assert.ok(payload.eventCount > 0);
  assert.ok(payload.reportedOwner);
  assert.ok(payload.escalationPolicy);
});

test("buildMockSentryPayload accepts overrides", () => {
  const payload = buildMockSentryPayload({ service: "search-api", eventCount: 5 });
  assert.equal(payload.service, "search-api");
  assert.equal(payload.eventCount, 5);
});

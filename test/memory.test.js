import { test } from "node:test";
import assert from "node:assert/strict";
import { createFactStore, reconcile } from "../src/memory.js";

test("reconcile adds a new fact to an empty store without revising anything", () => {
  const store = createFactStore([]);
  const result = reconcile({ subject: "checkout-api", predicate: "ownedBy", object: "team-payments", source: "linear-ticket" }, store);
  assert.equal(result.revised, false);
  assert.equal(result.oldFact, null);
  assert.equal(store.length, 1);
});

test("reconcile treats a matching observation as confirmation, not revision", () => {
  const store = createFactStore([{ subject: "billing-api", predicate: "ownedBy", object: "team-billing", source: "seed", confidence: 0.6 }]);
  const result = reconcile({ subject: "billing-api", predicate: "ownedBy", object: "team-billing", source: "slack-thread" }, store);
  assert.equal(result.revised, false);
  assert.equal(store.length, 1);
});

test("reconcile revises a contradicted fact and marks the old one superseded", () => {
  const store = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  const oldFactBefore = store[0];
  const result = reconcile({ subject: "checkout-api", predicate: "ownedBy", object: "team-payments", source: "linear-ticket" }, store);
  assert.equal(result.revised, true);
  assert.equal(result.oldFact.object, "team-checkout");
  assert.equal(oldFactBefore.supersededBy, result.newFact.id);
});

test("the pre-revision fact stays in the store, visible, not deleted", () => {
  const store = createFactStore([{ subject: "checkout-api", predicate: "ownedBy", object: "team-checkout", source: "seed", confidence: 0.6 }]);
  reconcile({ subject: "checkout-api", predicate: "ownedBy", object: "team-payments", source: "linear-ticket" }, store);
  assert.equal(store.length, 2);
  const stale = store.find((f) => f.object === "team-checkout");
  assert.ok(stale, "the old fact must still be present in the store");
  assert.ok(stale.supersededBy, "the old fact must be marked superseded, not removed");
});

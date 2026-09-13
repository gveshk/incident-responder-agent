import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, contentMatch, verify } from "../src/verifier.js";

test("canonicalize strips slack markdown emphasis markers", () => {
  assert.equal(canonicalize("*bold* and _italic_ and `code`", "slack"), "bold and italic and code");
});

test("canonicalize normalizes line endings for linear/github", () => {
  assert.equal(canonicalize("line1\r\nline2", "linear"), "line1 line2");
});

test("contentMatch returns 1 for identical canonicalized text", () => {
  assert.equal(contentMatch("hello world", "hello world", "linear"), 1);
});

test("contentMatch detects truncation as a partial ratio", () => {
  const ratio = contentMatch("The full incident diagnosis text goes here", "The full inci", "linear");
  assert.ok(ratio > 0 && ratio < 1, `expected partial ratio, got ${ratio}`);
});

test("verify returns false when the target does not exist", () => {
  const result = verify({ exists: false, content: null });
  assert.equal(result.status, "false");
});

test("verify returns unknown when the existence check itself failed", () => {
  const result = verify({ exists: null, content: null });
  assert.equal(result.status, "unknown");
});

test("verify returns true when existence and content both check out", () => {
  const result = verify({ exists: true, content: { expected: "checkout-api error spike", actual: "checkout-api error spike", app: "linear" } });
  assert.equal(result.status, "true");
  assert.ok(result.confidence > 0.8, `expected high confidence, got ${result.confidence}`);
});

test("verify returns false when content is truncated below the match threshold", () => {
  const result = verify({ exists: true, content: { expected: "The full incident diagnosis text goes here in full", actual: "The full inci", app: "linear" } });
  assert.equal(result.status, "false");
});

test("verify returns unknown when a second source disagrees", () => {
  const result = verify({ exists: true, content: null, crossSourceConfirmed: false });
  assert.equal(result.status, "unknown");
});

test("verify never returns a bare boolean — status is always one of true/false/unknown strings", () => {
  for (const input of [{ exists: true, content: null }, { exists: false, content: null }, { exists: null, content: null }]) {
    const result = verify(input);
    assert.ok(["true", "false", "unknown"].includes(result.status));
  }
});

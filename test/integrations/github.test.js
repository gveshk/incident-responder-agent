import { test } from "node:test";
import assert from "node:assert/strict";
import { act, verify, undo } from "../../src/integrations/github.js";

// Fake execFile: returns canned responses in order, no real gh binary.
function fakeExec(responses) {
  let call = 0;
  return async () => {
    const response = responses[Math.min(call, responses.length - 1)] ?? { stdout: "" };
    call += 1;
    if (response.error) throw response.error;
    return { stdout: response.stdout ?? "", stderr: "" };
  };
}

test("act() creates an issue and parses the number from the URL", async () => {
  process.env.GITHUB_DEMO_REPO = "gveshk/incident-responder-demo";
  const exec = fakeExec([{ stdout: "https://github.com/gveshk/incident-responder-demo/issues/7\n" }]);
  const result = await act({ title: "t", body: "b" }, { exec });
  assert.equal(result.id, 7);
  assert.equal(result.raw.repo, "gveshk/incident-responder-demo");
});

test("verify() returns true when the independent read matches", async () => {
  const exec = fakeExec([{ stdout: JSON.stringify({ number: 7, title: "t", body: "b", state: "OPEN" }) }]);
  const result = await verify({ id: 7, raw: { repo: "gveshk/incident-responder-demo" } }, { body: "b" }, { exec });
  assert.equal(result.status, "true");
});

test("verify() returns false when gh reports the issue does not exist (seen live after delete)", async () => {
  const err = new Error("gh failed"); err.stderr = "GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)";
  const exec = fakeExec([{ error: err }]);
  const result = await verify({ id: 1, raw: { repo: "gveshk/incident-responder-demo" } }, { body: "b" }, { exec });
  assert.equal(result.status, "false");
});

test("verify() returns unknown when gh itself fails", async () => {
  const exec = fakeExec([{ error: new Error("network down") }]);
  const result = await verify({ id: 7, raw: { repo: "gveshk/incident-responder-demo" } }, { body: "b" }, { exec });
  assert.equal(result.status, "unknown");
});

test("undo() deletes via GraphQL when possible", async () => {
  const exec = fakeExec([
    { stdout: JSON.stringify({ id: "node-1" }) }, // issue view --json id
    { stdout: "{}" }, // api graphql deleteIssue
  ]);
  const result = await undo({ id: 7, raw: { repo: "gveshk/incident-responder-demo" } }, { exec });
  assert.equal(result.ok, true);
  assert.equal(result.compensationType, "restored");
});

test("undo() falls back to closing when delete fails", async () => {
  const exec = fakeExec([
    { error: new Error("insufficient permission") }, // issue view fails
    { stdout: "" }, // issue close succeeds
  ]);
  const result = await undo({ id: 7, raw: { repo: "gveshk/incident-responder-demo" } }, { exec });
  assert.equal(result.ok, true);
  assert.equal(result.compensationType, "compensated");
});

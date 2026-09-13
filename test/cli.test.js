import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const execFileAsync = promisify(execFile);
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cli.js");

test("--undo without a path prints usage and exits non-zero", async () => {
  await assert.rejects(
    execFileAsync("node", [cliPath, "--undo"], { env: { ...process.env, LINEAR_PERSONAL_ACCESS_KEY: "", SLACK_BOT_TOKEN: "" } }),
    (err) => {
      assert.match(err.stderr, /Usage: node bin\/cli\.js --undo/);
      return true;
    },
  );
});

test("running with missing required env vars reports which ones and exits non-zero", async () => {
  await assert.rejects(
    // Point the .env lookup at a directory with no .env so the real one can't leak in.
    execFileAsync("node", [cliPath], { cwd: dirname(cliPath), env: { PATH: process.env.PATH, INCIDENT_RESPONDER_ENV_PATH: "/nonexistent/.env" } }),
    (err) => {
      assert.match(err.stderr, /Missing required env vars/);
      return true;
    },
  );
});

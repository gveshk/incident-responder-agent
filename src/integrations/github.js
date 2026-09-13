import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verify as verifyCore } from "../verifier.js";

const execFileAsync = promisify(execFile);

// A stale GITHUB_TOKEN/GH_TOKEN env var shadows a valid keyring credential
// on this machine — always clear both before calling gh.
// `exec` is injectable so tests can run without a real gh binary.
async function gh(args, exec = execFileAsync) {
  const { stdout } = await exec("gh", args, { env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" } });
  return stdout;
}

export async function act(input, { exec } = {}) {
  const repo = input.repo ?? process.env.GITHUB_DEMO_REPO;
  if (!repo) throw new Error("GITHUB_DEMO_REPO is not set and no repo was passed");
  const stdout = await gh(["issue", "create", "--repo", repo, "--title", input.title, "--body", input.body], exec);
  const url = stdout.trim();
  const number = Number(url.split("/").pop());
  return { id: number, raw: { url, repo }, capturedBefore: null };
}

export async function verify(actResult, intent, { exec } = {}) {
  let issue;
  try {
    const stdout = await gh(["issue", "view", String(actResult.id), "--repo", actResult.raw.repo, "--json", "number,title,body,state"], exec);
    issue = JSON.parse(stdout);
  } catch {
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(issue),
    content: issue ? { expected: intent.body, actual: issue.body, app: "github" } : null,
  });
}

export async function undo(actResult, { exec } = {}) {
  try {
    // Primary: real deletion (reversible tier means "as if it never
    // happened"). Requires admin access to the repo via GraphQL.
    const viewOut = await gh(["issue", "view", String(actResult.id), "--repo", actResult.raw.repo, "--json", "id"], exec);
    const nodeId = JSON.parse(viewOut).id;
    await gh(["api", "graphql", "-f", `query=mutation($id: ID!) { deleteIssue(input: {issueId: $id}) { clientMutationId } }`, "-f", `id=${nodeId}`], exec);
    return { ok: true, compensationType: "restored" };
  } catch (err) {
    // Compensating fallback, and say so explicitly — never silently
    // pretend a close is a delete.
    try {
      await gh(["issue", "close", String(actResult.id), "--repo", actResult.raw.repo], exec);
      return { ok: true, compensationType: "compensated", note: "delete failed, closed instead", error: err.message };
    } catch (err2) {
      return { ok: false, compensationType: "escalated", error: err2.message };
    }
  }
}

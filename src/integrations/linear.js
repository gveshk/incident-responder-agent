import { verify as verifyCore } from "../verifier.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

async function linearRequest(query, variables) {
  const apiKey = process.env.LINEAR_PERSONAL_ACCESS_KEY;
  if (!apiKey) throw new Error("LINEAR_PERSONAL_ACCESS_KEY is not set");
  const res = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

export async function act(input) {
  const teamId = input.teamId ?? process.env.LINEAR_TEAM_ID;
  if (!teamId) throw new Error("LINEAR_TEAM_ID is not set and no teamId was passed");
  const data = await linearRequest(
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier title description url } }
    }`,
    { input: { teamId, title: input.title, description: input.description } },
  );
  if (!data.issueCreate.success) throw new Error("Linear issueCreate reported success=false");
  return { id: data.issueCreate.issue.id, raw: data.issueCreate.issue, capturedBefore: null };
}

export async function verify(actResult, intent) {
  let issue;
  try {
    const data = await linearRequest(
      `query Issue($id: String!) { issue(id: $id) { id title description trashed state { name } } }`,
      { id: actResult.id },
    );
    // issueDelete is a soft delete: the id still resolves, with trashed=true.
    issue = data.issue && !data.issue.trashed ? data.issue : null;
  } catch {
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(issue),
    content: issue ? { expected: intent.description, actual: issue.description, app: "linear" } : null,
  });
}

/** Second source: issues with this exact title created since `since`. Used only after a failed existence check. */
export async function findByContent(intent, { since }) {
  const teamId = process.env.LINEAR_TEAM_ID;
  const data = await linearRequest(
    `query Find($filter: IssueFilter) { issues(filter: $filter, first: 10) { nodes { id identifier title description url createdAt } } }`,
    { filter: { title: { eq: intent.title }, createdAt: { gte: since }, ...(teamId ? { team: { id: { eq: teamId } } } : {}) } },
  );
  return data.issues.nodes.map((issue) => ({ id: issue.id, raw: issue }));
}

export async function undo(actResult) {
  try {
    const data = await linearRequest(`mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }`, { id: actResult.id });
    // Linear moves the issue to trash (invisible, auto-purged later) rather
    // than hard-deleting — say so, don't imply the row is gone.
    return { ok: Boolean(data.issueDelete.success), compensationType: "restored", note: "moved to Linear trash (soft delete)" };
  } catch (err) {
    return { ok: false, compensationType: "escalated", error: err.message };
  }
}

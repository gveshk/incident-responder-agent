import { WebClient } from "@slack/web-api";
import { verify as verifyCore, canonicalize } from "../verifier.js";

// `client` is injectable so tests can run without a real Slack token.
function client(injected) {
  if (injected) return injected;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  return new WebClient(token);
}

export async function act(input, { client: injected } = {}) {
  const channel = input.channel ?? process.env.SLACK_ALERT_CHANNEL;
  if (!channel) throw new Error("SLACK_ALERT_CHANNEL is not set and no channel was passed");
  const c = client(injected);
  const res = await c.chat.postMessage({ channel, text: input.text });
  // A permalink for humans (the UI / run log); verification never uses it.
  let url = null;
  try {
    const { url: workspace } = await c.auth.test();
    url = `${workspace.replace(/\/$/, "")}/archives/${channel}/p${res.ts.replace(".", "")}`;
  } catch { /* cosmetic only */ }
  return { id: res.ts, raw: { channel, ts: res.ts, url }, capturedBefore: null };
}

export async function verify(actResult, intent, { client: injected } = {}) {
  let message;
  try {
    const res = await client(injected).conversations.history({ channel: actResult.raw.channel, latest: actResult.raw.ts, inclusive: true, limit: 1 });
    message = res.messages?.find((m) => m.ts === actResult.raw.ts);
  } catch {
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(message),
    content: message ? { expected: intent.text, actual: message.text, app: "slack" } : null,
  });
}

/** Second source: messages in the channel since `since` whose canonical text equals the intent. */
export async function findByContent(intent, { since }, { client: injected } = {}) {
  const channel = intent.channel ?? process.env.SLACK_ALERT_CHANNEL;
  const res = await client(injected).conversations.history({ channel, oldest: String(new Date(since).getTime() / 1000), limit: 50 });
  const want = canonicalize(intent.text, "slack");
  return (res.messages ?? []).filter((m) => canonicalize(m.text, "slack") === want).map((m) => ({ id: m.ts, raw: { channel, ts: m.ts } }));
}

export async function undo(actResult, { client: injected } = {}) {
  try {
    await client(injected).chat.delete({ channel: actResult.raw.channel, ts: actResult.raw.ts });
    return { ok: true, compensationType: "restored" };
  } catch (err) {
    // chat.delete can itself fail (permission, retention policy). This
    // tier is compensable, never claimed as erasure — post a retraction.
    try {
      await client(injected).chat.postMessage({ channel: actResult.raw.channel, text: "Correction: the previous alert was sent in error and has been retracted.", thread_ts: actResult.raw.ts });
      return { ok: true, compensationType: "compensated", note: "delete failed, posted retraction", error: err.message };
    } catch (err2) {
      return { ok: false, compensationType: "escalated", error: err2.message };
    }
  }
}

# Incident Responder Agent

A demo agent for the Multi-App AI Agent Hackathon, built to prove one idea:

> **Every action an agent takes gets logged, classified, independently verified, and is reversible.** Git blame and git revert, for the real world your agent touches.

The agent itself is deliberately simple — one incident-response flow across Linear, Slack, and GitHub. The interesting part is the **trust layer** underneath it, which any agent that mutates external systems can adopt.

## What it does

A mock Sentry "error spike" kicks off one incident-response cycle:

```
mock Sentry trigger
      │
      ▼
Linear ticket        act ─► verify        [reversible]
      │
      ▼
Slack alert          act ─► verify        [compensable]
      │
      ▼
PagerDuty page       HELD, never fired    [bufferable]
      │
      ▼
memory.reconcile     stale fact revised, old value kept visible
      │
      ▼
GitHub issue         act ─► verify        [reversible]
```

Every mutating step is written to a run log with its rollback tier and a tri-state verification result. `--undo <run-log>` walks the log backwards and reverses every step it can, reporting exactly what happened to each one.

## The core: a trust layer in three parts

### 1. Tri-state verification (`src/verifier.js`)

An API returning 200 is not proof the write happened, landed on the right record, or wasn't mangled on save. So after every mutation the agent **re-reads through a different code path** and compares against intent.

The result is always `"true" | "false" | "unknown"` — never a bare boolean:

- `true` — independent read confirms the write (with a confidence score)
- `false` — target missing, or content mismatch after canonicalization
- `unknown` — the check itself timed out or a second source disagrees. **Unknown escalates to a human, never auto-retries.** Retry-on-unknown is how agents produce duplicate side effects. `verify()` is a pure function with no I/O handle, so it structurally cannot retry.

Canonicalization absorbs the ways real APIs rewrite content (Slack wraps URLs in `<…>` and strips emphasis; Linear/GitHub normalize line endings). Anything beyond that is a real mismatch.

### 2. Four-tier rollback (`src/rollback.js`)

"Reversible" is not one thing. Every action type is registered under a tier, and the tier decides what undo can honestly promise:

| Tier | Meaning | Example here |
|---|---|---|
| `reversible` | undo restores the pre-state | Linear ticket, GitHub issue → deleted |
| `compensable` | the artifact can be removed, but the effect (someone read it) can't be un-happened | Slack message → deleted, or a threaded retraction if delete fails |
| `bufferable` | never fired; held at a gate until an explicit `commit()` | PagerDuty page — the demo never commits it |
| `irreversible` | no undo can be offered; must be gated up front | not used in this demo |

Rollback outcomes are `restored`, `compensated`, `held-not-fired`, or `escalated` — compensation itself can fail against a third-party API, and that's a terminal state that gets reported, never swallowed.

Fidelity is judged on **agent-writable fields only**. Fields every API touches on every write (`updatedAt`, `revision`, audit-log timestamps) are declared excluded up front. The claim is "exact restoration of agent-writable fields", never "bit-for-bit".

### 3. Self-correcting memory (`src/memory.js`)

A tiny fact store (`subject / predicate / object / source / confidence`) with prediction-error-gated reconsolidation: a new observation that contradicts a stored fact **revises** it — the old fact is marked `supersededBy` and stays in the store, visible — instead of silently appending a second, conflicting fact forever.

The demo seeds a stale belief (`checkout-api ownedBy team-checkout`); the live trigger says `team-payments`; the run log shows the revision with the old value still readable.

## The reusable part: the run log as backend state

Everything above converges on one artifact — the run log written to `output/run-<timestamp>.json`. It is the complete, independently checkable record of what the agent did:

```jsonc
{
  "runId": "…",
  "trigger": { "service": "checkout-api", "errorType": "…", "reportedOwner": "team-payments" },
  "steps": [
    {
      "actionType": "linear.issueCreate",
      "tier": "reversible",
      "input":  { "title": "…", "description": "…" },          // what we intended
      "actResult": { "id": "…", "raw": { "url": "…" } },       // what the API returned
      "verifyResult": {                                        // what an independent read found
        "status": "true", "confidence": 0.85,
        "checks": { "existsCheck": true, "contentMatch": 1, "crossSourceConfirmed": null },
        "reason": "independent read confirms the write"
      }
    },
    { "actionType": "pagerduty.page", "tier": "bufferable", "held": true, "intent": { "reason": "…" } },
    { "actionType": "memory.reconcile", "revised": true, "oldFact": { "object": "team-checkout", "supersededBy": "…" }, "newFact": { "object": "team-payments" } }
  ],
  "factStore": [ /* every fact, including superseded ones */ ]
}
```

Because each step carries its own intent, result, tier, and verification, the log is enough on its own to:

- **walk backward** from any current state to the exact chain of agent actions that produced it,
- **re-verify** any step later by re-reading the target (the run log is all `--undo` needs — no database, no live session),
- **reverse** any step, with the tier telling you honestly what reversal means.

Nothing in the trust layer is specific to incidents. To adopt it, an integration only has to implement three functions:

```js
act(input)              -> { id, raw, capturedBefore }
verify(actResult, intent) -> { status: "true"|"false"|"unknown", confidence, checks, reason }
undo(actResult)         -> { ok, compensationType: "restored"|"compensated"|"escalated" }
```

and register its action types in `TIER_BY_ACTION_TYPE`. `src/agent.js` orchestrates; it takes integrations as an injected object, so the same orchestrator runs against real APIs, fakes, or a fault-injecting harness.

## Evals: the layer proves its own reliability

`npm run eval` reports real numbers, not vibes:

| Eval | What it measures | Result |
|---|---|---|
| #1 Silent-failure catch rate | 4 injected failure shapes (fake 200 / no write, truncated content, wrong record, timeout) × 10 trials — how many never get verified `true` | **10/10 (100%)** |
| #2 Rollback fidelity | 20 act → mutate → undo cycles, diffed on agent-writable fields | **20/20 exact** (excludes `updatedAt`, `revision`, …) |
| #3 Memory scenario accuracy | 8 hand-written revise / confirm / new-fact / unrelated-subject cases | **8/8** |
| #4 Tri-state coverage | verifier emits all three states; `verify()` has no retry side effect | **pass** |
| #5 Confidence calibration | Brier score of confidence vs ground truth over labeled cases | **0.269** (0 = perfect) |
| Stretch: adversarial | poisoned content with embedded instructions is never verified `true` | **blocked** |

Evals run against the verifier and rollback engine directly with in-memory fixtures — repeatable, no API calls. The live flow is exercised separately (below).

### What the first live run caught

Running against the real APIs for the first time, the layer flagged three things a bare "200 OK" would have hidden:

1. **Slack rewrote the message.** A bare URL was saved as `<https://…>`; content match dropped to 0.00 and the step verified `false`. Canonicalization now unwraps Slack auto-links.
2. **Linear's delete is a soft delete.** After `issueDelete` the id still resolves with `trashed: true`. `verify()` now treats trashed as non-existent, and `undo()` reports "moved to trash" instead of implying a hard delete.
3. **GitHub not-found was read as `unknown`.** `gh issue view` exits non-zero for a deleted issue; that's a definitive `false`, not a timeout. Only unexplained errors stay `unknown` now.

## Running it

Requires Node ≥ 20 and the `gh` CLI, authenticated.

```bash
npm install
cp .env.example .env     # fill in LINEAR_PERSONAL_ACCESS_KEY and SLACK_BOT_TOKEN
npm test                 # 64 unit tests, all mocked
npm run eval             # the 5 evals + adversarial check

node bin/cli.js                              # one live incident run → output/run-<ts>.json
node bin/cli.js --undo output/run-<ts>.json  # reverse it, step by step, most recent first
```

Env vars: `LINEAR_PERSONAL_ACCESS_KEY`, `LINEAR_TEAM_ID`, `SLACK_BOT_TOKEN` (bot must be invited to the alert channel; scopes `chat:write`, `channels:history`), `SLACK_ALERT_CHANNEL`, `GITHUB_DEMO_REPO`.

## Layout

```
bin/cli.js                 entrypoint: run, or --undo a run log
src/agent.js               orchestrator (integrations injected)
src/verifier.js            tri-state verify + canonicalization (pure)
src/rollback.js            tiers, hold(), rollback(), agent-writable diff
src/memory.js              fact store with supersededBy revision
src/mock-trigger.js        canned Sentry payload
src/integrations/          linear.js, github.js, slack.js — act / verify / undo
eval/                      fault-injection, rollback-fidelity, memory-scenarios,
                           tri-state-coverage, calibration, adversarial, latency-cost
test/                      node:test, one file per module
```

Stack: plain Node ESM, `node:test`, native `fetch` for Linear's GraphQL, `gh` CLI for GitHub, `@slack/web-api` for Slack — the only dependency.

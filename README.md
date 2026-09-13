# Incident Responder Agent

A demo agent for the Multi-App AI Agent Hackathon, built to prove one idea:

> **Every action an agent takes gets logged, classified, independently verified, and is reversible.** Git blame and git revert, for the real world your agent touches.

The agent itself is deliberately simple — one incident-response flow across Linear, Slack, HubSpot, and GitHub. The interesting part is the **trust layer** underneath it, which any agent that mutates external systems can adopt. It's modular, has no dependency on the agent, and will be open-sourced separately after the hackathon.

![Trust layer architecture](diagrams/trust-layer-architecture.png)

*Editable sources: [`diagrams/trust-layer-architecture.excalidraw`](diagrams/trust-layer-architecture.excalidraw) (open at excalidraw.com) and the `.mmd` mermaid next to it.*

## What it does

A mock Sentry "error spike" kicks off one incident-response cycle:

```
mock Sentry trigger
      │
      ▼
Linear ticket        act ─► verify                          [reversible]
      │
      ▼
Slack alert          act ─► verify                          [compensable]
      │
      ▼
HubSpot account      pre-state captured ─► act ─► verify    [reversible]
      │
      ▼
PagerDuty page       HELD, never fired                      [bufferable]
      │
      ▼
memory.reconcile     stale fact revised, old value kept visible
      │
      ▼
GitHub issue         act ─► verify                          [reversible]
```

![Incident responder flow](diagrams/incident-responder-flow.png)

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
| `reversible` | undo restores the pre-state | Linear ticket, GitHub issue → deleted; HubSpot property → captured value written back |
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

## Competitive benchmark: why not just retry, validate, or ask an LLM?

`npm run eval:competitive` runs the same 1,000 create-actions, with the same seeded fault schedule, through five strategies. Four of them are faithful models of what widely deployed tooling actually does for a tool call; the fifth is this layer (calling the real `verifier.js` / `rollback.js`). Ground truth comes from the simulator's own store, so every strategy is scored on what *happened*, not what the API said.

| Strategy | Represents | How it decides "done" |
|---|---|---|
| `status-trust` | Composio / Arcade / MCP tool execution, LangChain tool wrappers | `res.ok` |
| `retry-replay` | tenacity, LiteLLM `num_retries`, LangGraph checkpoint replay, Temporal activity retry | re-run on any error, ≤3 attempts |
| `schema-validation` | Guardrails AI, Openlayer, Pydantic output models | response is well-formed |
| `response-judge` | LLM-as-judge on the tool result (Arize / Langfuse pattern), modeled at its **best case**: a perfect reader of the response | response payload matches intent |
| `trust-layer` | this repo | independent read-back → tri-state → rollback / escalate |

Faults injected at 30%: fake-200 (nothing stored), truncated on save, wrong-record (stored, but the returned id points nowhere), timeout after the write happened, transient 503 before it. The read path is 2% flaky so `unknown` has a real cost.

**Accuracy**

| strategy | silent failures | catch rate | orphaned writes | escalated | duplicates | partials left | end state correct |
|---|---|---|---|---|---|---|---|
| status-trust | 164 | 40.8% | 61 | 0 | 0 | 49 | 77.5% |
| retry-replay | 225 | 0.0% | 0 | 0 | **61** | 49 | 77.5% |
| schema-validation | 164 | 40.8% | 61 | 0 | 0 | 49 | 77.5% |
| response-judge | 164 | 40.8% | 61 | 0 | 0 | 49 | 77.5% |
| **trust-layer** | **0** | **100%** | 48 | 84 | **0** | 2 | **86.9%** |

Silent failures by fault type (missed / injected):

| strategy | fake-200 | truncated | wrong-record | timeout | 503 |
|---|---|---|---|---|---|
| every response-only baseline | 64/64 | 49/49 | 51/51 | 0/61 (retry-replay: 61/61) | 0/52 |
| trust-layer | 0/64 | 0/49 | 0/51 | 0/61 | 0/52 |

The structural point: **four of the five only ever look at the write's own response.** A fake-200 echoes the intent back perfectly, so status checks, schema validators and even a perfect judge are blind to it by construction. Retrying makes it worse: a timeout after a successful write becomes a duplicate ticket 61 times out of 61.

**Time (the verifier tax)**

| strategy | calls/action | ms/action (sim: write 120, read 60) |
|---|---|---|
| status-trust / schema / judge | 1.00 | 120 |
| retry-replay | 1.11 | 134 |
| trust-layer | 2.04 | 187 |

One extra read per action, ~+50% latency on a clean run. That is the price; the tables above are what it buys.

**Memory** — append-only notes (mem0-style `add()`, notes in a vector store) vs `memory.js`, over 25 services × 12 observations with 45 real ownership changes, top-3 retrieval:

| metric | append-only | reconciling store |
|---|---|---|
| notes stored | 300 | 70 (25 active + 45 superseded) |
| queries whose retrieved context contradicts itself | 13 (52%) | 0 |
| ownership changes detected as revisions | 0 (`add()` can't tell a confirmation from a contradiction) | 45/45 |
| confirmations mistaken for changes | n/a | 0 |

**Honest caveats.** The 48 "orphaned writes" for the trust layer are all wrong-record cases: it correctly reports `false`, but the stray record lives under an id it was never given, so it can't reverse it — a content search as a second source would close that gap and is not implemented. The 84 escalations are 61 timeouts plus read-path failures: those go to a human instead of being guessed, which is the design. The LLM-judge baseline is modeled, not called; a real model can only do worse than a perfect reader of the same response, and adds latency and non-determinism. Append-only top-k ties are broken by insertion order; any tie-break yields contradictory context whenever two owners are among the k most similar notes.

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
npm test                 # 75 unit tests, all mocked
npm run eval             # the 5 evals + adversarial check
npm run eval:competitive # the benchmark above (more trials: node eval/competitive/run.js 5000)

node bin/cli.js                              # one live incident run → output/run-<ts>.json
node bin/cli.js --undo output/run-<ts>.json  # reverse it, step by step, most recent first
```

Env vars: `LINEAR_PERSONAL_ACCESS_KEY`, `LINEAR_TEAM_ID`, `SLACK_BOT_TOKEN` (bot must be invited to the alert channel; scopes `chat:write`, `channels:history`), `SLACK_ALERT_CHANNEL`, `GITHUB_DEMO_REPO`, `HUBSPOT_PRIVATE_APP_TOKEN` (private app, scopes `crm.objects.companies.read` + `.write`), `HUBSPOT_DEMO_COMPANY_ID` (a company; the account needs a custom `incident_status` company property).

## Layout

```
bin/cli.js                 entrypoint: run, or --undo a run log
src/agent.js               orchestrator (integrations injected)
src/verifier.js            tri-state verify + canonicalization (pure)
src/rollback.js            tiers, hold(), rollback(), agent-writable diff
src/memory.js              fact store with supersededBy revision
src/mock-trigger.js        canned Sentry payload
src/integrations/          linear.js, github.js, slack.js, hubspot.js — act / verify / undo
eval/                      fault-injection, rollback-fidelity, memory-scenarios,
                           tri-state-coverage, calibration, adversarial, latency-cost
eval/competitive/          simulator (seeded faults + ground truth), strategies, memory-bench, run
diagrams/                  architecture + flow: .mmd source, .excalidraw (editable), .svg, .png
test/                      node:test, one file per module
```

Stack: plain Node ESM, `node:test`, native `fetch` for Linear's GraphQL, `gh` CLI for GitHub, `@slack/web-api` for Slack — the only dependency.

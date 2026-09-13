# Submission brief — Incident Responder

**One line.** An incident-response agent across six real apps where every action is independently verified and reversible — and a benchmark showing why the tooling people already ship can't do that.

**The problem.** Agents that touch real systems trust the API's own response. A 200 that stored nothing, a save that truncated the content, a write that landed under an id the API never returned, a timeout after a successful write — the agent reports "done" and moves on. Retry frameworks turn the timeout case into duplicate tickets. Guardrails and LLM judges read the same response and are blind to it by construction.

**What we built.** A trust layer with three parts, exercised live against Sentry, Linear, Slack, HubSpot, PagerDuty and GitHub:

1. **Tri-state verification** — after every mutation, re-read the record through a *different* path and compare it to intent. The verdict is `true` / `false` / `unknown`, never a bare boolean; `unknown` escalates to a human and is never auto-retried. A second source (exact-content search) recovers writes that landed under the wrong id.
2. **Four-tier rollback** — every action type is `reversible`, `compensable`, `bufferable` or `irreversible`, and undo says honestly which it achieved. Paging a human is bufferable: held at a gate until a person commits; after that it's compensable — resolvable, but nobody can be un-paged.
3. **Self-correcting memory** — a contradiction revises the stored fact and keeps the old one linked; append-only notes hand the model contradictory context on half of queries.

The run log is the state: intent, API result, verdict and tier per step, written after every step, enough on its own to re-verify or reverse a run. A cheap open model (DeepSeek via OpenRouter) writes the diagnosis — the one unverified step, logged with model id and prompt hash and an audited fallback. It runs as a service: Sentry webhook in, one worker, persisted queue, `--commit` and `--undo` over REST.

**Proof.** 113 unit tests. Five evals with real numbers. A competitive benchmark — nine shipping products' documented defaults (Composio, Arcade, OpenAI Agents SDK, LangGraph RetryPolicy, Temporal, tenacity, Guardrails AI, Pydantic AI, LLM-as-judge) run on the same seeded faults: they miss 164–225 silent failures per 1,000 actions and the retry rows create 61 duplicates; this layer misses 0 and creates 0, at one extra read per action. Three of the layer's own bugs were caught by its own verification on the first live runs (Slack rewriting URLs, Linear's soft delete, GitHub's not-found) — they're in the README.

**What's honest.** The layer can't reverse what it can't address without a second source; timeouts escalate rather than resolve; the model judge and mem0 baselines are modeled at their best case, not called.

- Repo: https://github.com/gveshk/incident-responder-agent
- Demo video (2 min, recorded against the live systems): `demos/incident-responder/output/final-demo.mp4` (GIF in the README)
- Pitch video (2 min): https://youtu.be/YufTP5n542Q

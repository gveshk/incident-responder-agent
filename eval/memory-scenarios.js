import { reconcile, createFactStore } from "../src/memory.js";

export const SCENARIOS = [
  { name: "service ownership transfer", existing: { subject: "checkout-api", predicate: "ownedBy", object: "team-checkout" }, observation: { subject: "checkout-api", predicate: "ownedBy", object: "team-payments", source: "linear-ticket" }, expectRevision: true },
  { name: "confirmed, no contradiction", existing: { subject: "billing-api", predicate: "ownedBy", object: "team-billing" }, observation: { subject: "billing-api", predicate: "ownedBy", object: "team-billing", source: "slack-thread" }, expectRevision: false },
  { name: "escalation policy change", existing: { subject: "checkout-api", predicate: "escalatesTo", object: "payments-oncall" }, observation: { subject: "checkout-api", predicate: "escalatesTo", object: "platform-oncall", source: "pagerduty-mock" }, expectRevision: true },
  { name: "new fact, no prior belief", existing: null, observation: { subject: "search-api", predicate: "ownedBy", object: "team-search", source: "linear-ticket" }, expectRevision: false },
  { name: "region change", existing: { subject: "checkout-api", predicate: "deployedIn", object: "us-east-1" }, observation: { subject: "checkout-api", predicate: "deployedIn", object: "us-west-2", source: "incident-timeline" }, expectRevision: true },
  // The existing fact is for a *different* subject, so reconcile must treat
  // the observation as brand-new (no revision) — proves unrelated facts
  // don't cross-contaminate.
  { name: "on-call rotation, unrelated subject stays unaffected", existing: { subject: "auth-api", predicate: "ownedBy", object: "team-auth" }, observation: { subject: "checkout-api", predicate: "ownedBy", object: "team-payments", source: "linear-ticket" }, expectRevision: false },
  { name: "severity downgrade", existing: { subject: "checkout-api", predicate: "severityDefault", object: "P1" }, observation: { subject: "checkout-api", predicate: "severityDefault", object: "P2", source: "postmortem" }, expectRevision: true },
  { name: "confirmed twice in a row", existing: { subject: "search-api", predicate: "ownedBy", object: "team-search" }, observation: { subject: "search-api", predicate: "ownedBy", object: "team-search", source: "linear-ticket" }, expectRevision: false },
];

export function runMemoryScenarios() {
  let correct = 0;
  const results = [];
  for (const scenario of SCENARIOS) {
    const factStore = createFactStore(scenario.existing ? [scenario.existing] : []);
    const result = reconcile(scenario.observation, factStore);
    const isCorrect = result.revised === scenario.expectRevision;
    if (isCorrect) correct += 1;
    results.push({ name: scenario.name, expected: scenario.expectRevision, actual: result.revised, correct: isCorrect });
  }
  return { total: SCENARIOS.length, correct, accuracy: correct / SCENARIOS.length, results };
}

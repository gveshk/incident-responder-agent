import { createSimulatedApp, makeRng, FAULTS } from "./simulator.js";
import { STRATEGIES } from "./strategies.js";

/**
 * Runs every strategy over the SAME fault schedule and scores each trial
 * against ground truth. One trial = one intended create.
 *
 * Per-strategy metrics:
 *   silentFailures   reality ≠ "exactly one correct, reachable record" but the strategy said "true"
 *   caught           reality was wrong and the strategy did NOT say "true"
 *   falseAlarms      reality was fine but the strategy said "false"
 *   orphans          strategy said "false" but something WAS written — the agent doesn't know it exists
 *   escalations      strategy said "unknown" (handed to a human)
 *   duplicates       extra records with the intended content left in the system
 *   partialsLeft     truncated records left in the system
 *   endStateCorrect  what the agent was told matches reality, and nothing half-done remains
 */
export function buildSchedule({ trials, faultRate, seed }) {
  const rng = makeRng(seed);
  const schedule = [];
  for (let i = 0; i < trials; i++) {
    const fault = rng() < faultRate ? FAULTS[Math.floor(rng() * FAULTS.length)] : null;
    schedule.push({ fault, intent: { content: `Incident ${i}: error spike in checkout-api, ${40 + (i % 20)} events in 5m` } });
  }
  return schedule;
}

export async function runCompetitive({ trials = 1000, faultRate = 0.3, readFaultRate = 0.02, seed = 42 } = {}) {
  const schedule = buildSchedule({ trials, faultRate, seed });
  const results = [];

  for (const strategy of STRATEGIES) {
    const app = createSimulatedApp({ readFaultRate, rng: makeRng(seed + 1) });
    const m = { silentFailures: 0, caught: 0, falseAlarms: 0, escalations: 0, orphans: 0, duplicates: 0, partialsLeft: 0, endStateCorrect: 0, faultsTotal: 0 };
    const byFault = Object.fromEntries([...FAULTS, "none"].map((f) => [f, { n: 0, silent: 0 }]));
    let calls = 0, latency = 0;

    for (const { fault, intent } of schedule) {
      app.reset();
      app.setFault(fault);
      const { claim, id } = await strategy.run(app, intent);
      const truth = app.truth(intent, id);
      calls += app.stats.calls;
      latency += app.stats.latencyMs;

      const key = fault ?? "none";
      byFault[key].n += 1;
      if (fault) m.faultsTotal += 1;
      if (!truth.exactlyOne) {
        if (claim === "true") { m.silentFailures += 1; byFault[key].silent += 1; } else m.caught += 1;
      } else if (claim === "false") m.falseAlarms += 1;
      if (claim === "unknown") m.escalations += 1;
      if (claim === "false" && truth.written) m.orphans += 1;
      m.duplicates += truth.duplicates;
      m.partialsLeft += truth.partial;
      if ((claim === "true" && truth.exactlyOne) || (claim !== "true" && truth.empty)) m.endStateCorrect += 1;
    }

    results.push({
      name: strategy.name,
      product: strategy.product,
      url: strategy.url,
      pattern: strategy.pattern,
      behavior: strategy.behavior,
      note: strategy.note ?? "",
      ...m,
      wrongOutcomes: m.silentFailures + m.caught,
      catchRate: m.silentFailures + m.caught ? m.caught / (m.silentFailures + m.caught) : 1,
      endStateCorrectRate: m.endStateCorrect / trials,
      apiCallsPerAction: calls / trials,
      latencyMsPerAction: latency / trials,
      byFault,
    });
  }
  return { trials, faultRate, readFaultRate, seed, results };
}

/**
 * Reports the real cost of verification: added latency and extra API
 * calls per action, versus the same action with no verification step.
 * Answers the institutional-buyer objection ("does this slow the agent
 * down too much to be worth it").
 */
export async function runLatencyCost({ withVerification, withoutVerification, trials = 5 }) {
  async function timeTrials(fn) {
    const timings = [];
    for (let i = 0; i < trials; i++) {
      const start = performance.now();
      const result = await fn();
      timings.push({ elapsedMs: performance.now() - start, extraApiCalls: result?.apiCalls ?? 0 });
    }
    return timings;
  }
  const withTimings = await timeTrials(withVerification);
  const withoutTimings = await timeTrials(withoutVerification);
  const avg = (arr, key) => arr.reduce((s, t) => s + t[key], 0) / arr.length;
  return {
    meanLatencyWithMs: avg(withTimings, "elapsedMs"),
    meanLatencyWithoutMs: avg(withoutTimings, "elapsedMs"),
    extraApiCallsPerAction: avg(withTimings, "extraApiCalls") - avg(withoutTimings, "extraApiCalls"),
  };
}

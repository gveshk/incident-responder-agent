import { verify as verifyCore } from "../src/verifier.js";

/**
 * Four silent-failure shapes real APIs actually produce: a write that
 * returns 200 but didn't happen, truncated content, a write landing on
 * the wrong record, and a verification check that times out.
 */
export const FAILURE_MODES = [
  { name: "fake-200-no-write", exists: false, content: null },
  { name: "truncated-content", exists: true, content: { expected: "The full incident diagnosis text goes here in full", actual: "The full inci", app: "linear" } },
  { name: "wrong-record", exists: true, content: { expected: "checkout-api error spike diagnosis", actual: "unrelated ticket about onboarding flow", app: "linear" } },
  { name: "timeout", exists: null, content: null },
];

export function runFaultInjection(trials = 10) {
  let caught = 0;
  const results = [];
  for (let i = 0; i < trials; i++) {
    const mode = FAILURE_MODES[i % FAILURE_MODES.length];
    const result = verifyCore({ exists: mode.exists, content: mode.content });
    const isCaught = result.status !== "true";
    if (isCaught) caught += 1;
    results.push({ mode: mode.name, status: result.status, caught: isCaught });
  }
  return { trials, caught, catchRate: caught / trials, results };
}

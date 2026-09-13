import { verify as verifyCore } from "../src/verifier.js";

/**
 * Buckets verifier confidence against ground-truth correctness and
 * reports a Brier score (mean squared error between confidence and the
 * 0/1 ground truth — lower is better, 0 is perfect calibration). Half the
 * labeled cases are real successes, half are the same injected-failure
 * shapes eval #1 uses, so "true" verdicts have known ground truth.
 */
const LABELED_CASES = [
  { exists: true, content: { expected: "ok", actual: "ok", app: "linear" }, groundTruthTrue: true },
  { exists: true, content: { expected: "checkout-api error spike diagnosis", actual: "checkout-api error spike diagnosis", app: "linear" }, groundTruthTrue: true },
  { exists: true, content: null, groundTruthTrue: true },
  { exists: false, content: null, groundTruthTrue: false },
  { exists: true, content: { expected: "The full incident diagnosis text goes here", actual: "The full inci", app: "linear" }, groundTruthTrue: false },
  { exists: null, content: null, groundTruthTrue: false },
];

export function runCalibration() {
  const points = LABELED_CASES.map((c) => {
    const result = verifyCore({ exists: c.exists, content: c.content });
    const predictedTrue = result.status === "true";
    return { confidence: result.confidence, predictedTrue, groundTruthTrue: c.groundTruthTrue, correct: predictedTrue === c.groundTruthTrue };
  });
  const brierScore = points.reduce((sum, p) => sum + (p.confidence - (p.groundTruthTrue ? 1 : 0)) ** 2, 0) / points.length;
  return { points, brierScore, n: points.length };
}

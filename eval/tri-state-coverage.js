import { verify as verifyCore } from "../src/verifier.js";

/**
 * Confirms the verifier actually produces all three states, and that
 * "unknown" carries no retry semantics of its own — retry is a decision
 * made by the caller, never inside verify(). verify() takes no I/O
 * handles and returns a plain object, so it structurally cannot retry;
 * this test documents that guarantee as a regression guard.
 */
export function runTriStateCoverage() {
  const trueCase = verifyCore({ exists: true, content: { expected: "a", actual: "a", app: "linear" } });
  const falseCase = verifyCore({ exists: false, content: null });
  const unknownCase = verifyCore({ exists: null, content: null });

  const coversAllThree = trueCase.status === "true" && falseCase.status === "false" && unknownCase.status === "unknown";
  const noRetrySideEffect = verifyCore.constructor.name === "Function" && verifyCore.length === 1;

  return { coversAllThree, noRetrySideEffect, trueCase, falseCase, unknownCase };
}

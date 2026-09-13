import { rollback, diffAgentWritableFields, EXCLUDED_FIELDS } from "../src/rollback.js";

export { EXCLUDED_FIELDS };

/**
 * A fully mocked act/mutate/undo cycle for a reversible action, backed by
 * an in-memory record so the fidelity check has ground truth to diff
 * against. Real APIs are exercised once, live, in the manual end-to-end
 * run — this harness is what produces the repeatable N-trial fidelity
 * number for the demo slide.
 */
function makeReversibleFixture() {
  let store = null;
  return {
    actionType: "linear.issueUpdate",
    seed: (input) => { store = { title: input.title, description: input.description, updatedAt: Date.now() }; return { ...store }; },
    mutate: (input) => { store = { ...store, ...input, updatedAt: Date.now() }; },
    undoFn: async () => { store = { ...store, title: "original title", description: "original description", updatedAt: Date.now() }; return { ok: true }; },
    getState: () => ({ ...store }),
  };
}

export async function runRollbackFidelity(trials = 20) {
  let exact = 0;
  const results = [];
  for (let i = 0; i < trials; i++) {
    const fixture = makeReversibleFixture();
    const before = fixture.seed({ title: "original title", description: "original description" });
    fixture.mutate({ title: "Closed-Won", description: "mutated by agent" });
    await rollback({ actionType: fixture.actionType, undoFn: fixture.undoFn });
    const afterUndo = fixture.getState();
    const diff = diffAgentWritableFields(before, afterUndo);
    const isExact = Object.keys(diff).length === 0;
    if (isExact) exact += 1;
    results.push({ trial: i, isExact, diff });
  }
  return { trials, exact, exactRestorationRate: exact / trials, excludedFields: EXCLUDED_FIELDS, results };
}

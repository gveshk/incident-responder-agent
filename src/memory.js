import { randomUUID } from "node:crypto";

/**
 * A tiny fact store with prediction-error-gated reconsolidation: a new
 * observation that contradicts an existing fact revises it (and keeps the
 * old value visible via supersededBy), rather than silently appending a
 * second, conflicting fact forever.
 */
export function createFactStore(initialFacts = []) {
  return initialFacts.map((f) => ({ id: randomUUID(), supersededBy: null, timestamp: new Date().toISOString(), ...f }));
}

/**
 * @param {{subject: string, predicate: string, object: string, source: string, confidence?: number}} observation
 * @param {Array<object>} factStore - mutated in place
 * @returns {{revised: boolean, oldFact: object|null, newFact: object}}
 */
export function reconcile(observation, factStore) {
  const existing = factStore.find(
    (f) => f.subject === observation.subject && f.predicate === observation.predicate && !f.supersededBy,
  );

  if (existing && existing.object === observation.object) {
    // Confirms, doesn't contradict — no revision needed.
    return { revised: false, oldFact: existing, newFact: existing };
  }

  const newFact = {
    id: randomUUID(),
    subject: observation.subject,
    predicate: observation.predicate,
    object: observation.object,
    source: observation.source,
    confidence: observation.confidence ?? 0.9,
    supersededBy: null,
    timestamp: new Date().toISOString(),
  };

  if (!existing) {
    factStore.push(newFact);
    return { revised: false, oldFact: null, newFact };
  }

  // Prediction error: the new observation contradicts the stored fact.
  // Revise by marking the old fact superseded (kept, not deleted) and
  // pushing the new fact — the rollback trail stays visible.
  existing.supersededBy = newFact.id;
  factStore.push(newFact);
  return { revised: true, oldFact: existing, newFact };
}

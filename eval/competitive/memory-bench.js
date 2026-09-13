import { createFactStore, reconcile } from "../../src/memory.js";
import { makeRng } from "./simulator.js";

/**
 * Append-only notes (what most agent memory tools do on `add`: embed the
 * text, store it, retrieve top-k by similarity later) versus the
 * reconciling fact store in src/memory.js.
 *
 * Scenario: S services, each observed K times over a timeline. Some
 * observations change the owner (a real ownership transfer), most confirm
 * the current one. Then ask "who owns <service>?" for every service.
 *
 * Contradicting notes about the same subject/predicate embed almost
 * identically, so top-k retrieval returns a mix — the model downstream has
 * to guess. We score:
 *   contradictoryContexts  queries whose top-k contained >1 distinct answer
 *   revisionsDetected      ownership changes the memory *knew* were changes
 *   falseRevisions         confirmations wrongly treated as changes
 *   activeFacts / notes    what a query has to scan
 */
export function runMemoryBench({ services = 25, observationsPerService = 12, changeRate = 0.2, topK = 3, seed = 7 } = {}) {
  const rng = makeRng(seed);
  const timeline = [];
  const truth = {}; // service -> current owner
  let changes = 0;
  for (let s = 0; s < services; s++) {
    const subject = `service-${s}`;
    let owner = `team-${s % 6}`;
    truth[subject] = owner;
    for (let k = 0; k < observationsPerService; k++) {
      if (k > 0 && rng() < changeRate) { owner = `team-${Math.floor(rng() * 6)}-v${k}`; changes += 1; }
      truth[subject] = owner;
      timeline.push({ subject, predicate: "ownedBy", object: owner, source: `obs-${k}` });
    }
  }

  // --- Baseline: append-only notes, top-k by similarity (ties → arbitrary, modeled as insertion order)
  const notes = [];
  for (const obs of timeline) notes.push({ ...obs });
  let contradictoryAppend = 0;
  for (const subject of Object.keys(truth)) {
    const hits = notes.filter((n) => n.subject === subject && n.predicate === "ownedBy").slice(0, topK);
    if (new Set(hits.map((h) => h.object)).size > 1) contradictoryAppend += 1;
  }

  // --- Reconciling fact store
  const store = createFactStore([]);
  let revisionsDetected = 0, falseRevisions = 0;
  const seen = {};
  for (const obs of timeline) {
    const wasChange = seen[obs.subject] !== undefined && seen[obs.subject] !== obs.object;
    seen[obs.subject] = obs.object;
    const r = reconcile(obs, store);
    if (r.revised && wasChange) revisionsDetected += 1;
    if (r.revised && !wasChange) falseRevisions += 1;
  }
  const active = store.filter((f) => !f.supersededBy);
  let contradictoryReconciled = 0, correctReconciled = 0;
  for (const [subject, owner] of Object.entries(truth)) {
    const hits = active.filter((f) => f.subject === subject && f.predicate === "ownedBy").slice(0, topK);
    if (new Set(hits.map((h) => h.object)).size > 1) contradictoryReconciled += 1;
    if (hits.length === 1 && hits[0].object === owner) correctReconciled += 1;
  }

  return {
    services, observations: timeline.length, ownershipChanges: changes, topK,
    appendOnly: {
      represents: "mem0-style add(), notes in a vector store, RAG over a scratchpad",
      notes: notes.length,
      contradictoryContexts: contradictoryAppend,
      contradictoryContextRate: contradictoryAppend / services,
      revisionsDetected: 0,
      revisionSignal: "none — add() cannot tell a confirmation from a contradiction",
    },
    reconciling: {
      represents: "src/memory.js reconcile()",
      notes: store.length,
      activeFacts: active.length,
      contradictoryContexts: contradictoryReconciled,
      contradictoryContextRate: contradictoryReconciled / services,
      currentOwnerCorrect: correctReconciled,
      currentOwnerCorrectRate: correctReconciled / services,
      revisionsDetected,
      revisionRecall: changes ? revisionsDetected / changes : 1,
      falseRevisions,
      historyRetained: store.length - active.length,
    },
  };
}

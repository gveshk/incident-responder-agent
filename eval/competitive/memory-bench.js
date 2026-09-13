import { createFactStore, reconcile } from "../../src/memory.js";
import { makeRng } from "./simulator.js";

/**
 * Three ways agents remember a fact that can change, scored on the same
 * timeline: S services, each observed K times; some observations change
 * the owner (a real transfer), most confirm it. Then ask "who owns
 * <service>?" for every service.
 *
 *   vector-store notes   add() embeds and stores every observation; top-k by
 *                        similarity at query time. Contradicting notes embed
 *                        almost identically, so top-k returns a mix.
 *   mem0 (best case)     an LLM decides ADD / UPDATE / DELETE / NOOP per
 *                        fact against retrieved memories. Modeled with
 *                        perfect decisions and zero latency. On contradiction
 *                        the old memory is deleted — no history is kept.
 *   memory.js            deterministic reconcile(); contradiction → revise,
 *                        old fact kept and linked by supersededBy.
 *
 * Scored:
 *   contradictoryContexts  queries whose top-k contained >1 distinct answer
 *   revisionsDetected      ownership changes the memory *knew* were changes
 *   falseRevisions         confirmations wrongly treated as changes
 *   historyRetained        superseded facts still readable
 *   llmCallsPerAdd         non-determinism and cost at write time
 */
export const MEMORY_PRODUCTS = [
  { name: "vector-store-notes", product: "Vector-store notes (Chroma / Pinecone via LangChain VectorStoreRetrieverMemory)", url: "https://python.langchain.com/api_reference/langchain/memory/langchain.memory.vectorstore.VectorStoreRetrieverMemory.html" },
  { name: "mem0", product: "mem0 (LLM-resolved ADD/UPDATE/DELETE/NOOP), best case", url: "https://docs.mem0.ai/core-concepts/memory-operations/add" },
  { name: "memory-js", product: "this repo (src/memory.js)", url: "https://github.com/gveshk/incident-responder-agent" },
];

export function runMemoryBench({ services = 25, observationsPerService = 12, changeRate = 0.2, topK = 3, seed = 7 } = {}) {
  const rng = makeRng(seed);
  const timeline = [];
  const truth = {};
  let changes = 0;
  for (let s = 0; s < services; s++) {
    const subject = `service-${s}`;
    let owner = `team-${s % 6}`;
    for (let k = 0; k < observationsPerService; k++) {
      if (k > 0 && rng() < changeRate) { owner = `team-${Math.floor(rng() * 6)}-v${k}`; changes += 1; }
      truth[subject] = owner;
      timeline.push({ subject, predicate: "ownedBy", object: owner, source: `obs-${k}` });
    }
  }
  const subjects = Object.keys(truth);
  const contradictory = (hits) => new Set(hits.map((h) => h.object)).size > 1;

  // --- vector-store notes: append every observation; top-k by similarity (ties → insertion order)
  const notes = timeline.map((o) => ({ ...o }));
  let vsContradictory = 0;
  for (const subject of subjects) {
    const hits = notes.filter((n) => n.subject === subject).slice(0, topK);
    if (contradictory(hits)) vsContradictory += 1;
  }

  // --- mem0 best case: perfect LLM op per add; DELETE+ADD on contradiction, NOOP on confirmation
  const mem0 = new Map(); // subject -> single memory
  let mem0Revisions = 0, mem0False = 0, mem0LlmCalls = 0;
  for (const obs of timeline) {
    mem0LlmCalls += 1; // one LLM decision per add()
    const existing = mem0.get(obs.subject);
    if (!existing) { mem0.set(obs.subject, { ...obs }); continue; } // ADD
    if (existing.object === obs.object) continue; // NOOP
    mem0.set(obs.subject, { ...obs }); mem0Revisions += 1; // DELETE old + ADD new
  }
  let mem0Contradictory = 0, mem0Correct = 0;
  for (const subject of subjects) {
    const hits = [mem0.get(subject)];
    if (contradictory(hits)) mem0Contradictory += 1;
    if (hits[0]?.object === truth[subject]) mem0Correct += 1;
  }

  // --- memory.js reconcile
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
  let rcContradictory = 0, rcCorrect = 0;
  for (const subject of subjects) {
    const hits = active.filter((f) => f.subject === subject).slice(0, topK);
    if (contradictory(hits)) rcContradictory += 1;
    if (hits.length === 1 && hits[0].object === truth[subject]) rcCorrect += 1;
  }

  return {
    services, observations: timeline.length, ownershipChanges: changes, topK,
    rows: [
      { ...MEMORY_PRODUCTS[0], stored: notes.length, contradictoryContexts: vsContradictory, currentCorrect: null, revisionsDetected: 0, falseRevisions: null, historyRetained: notes.length - subjects.length, llmCallsPerAdd: 0, deterministic: true,
        note: "add() cannot tell a confirmation from a contradiction; the model downstream has to pick" },
      { ...MEMORY_PRODUCTS[1], stored: mem0.size, contradictoryContexts: mem0Contradictory, currentCorrect: mem0Correct, revisionsDetected: mem0Revisions, falseRevisions: mem0False, historyRetained: 0, llmCallsPerAdd: 1, deterministic: false,
        note: "modeled with perfect LLM decisions; real runs are non-deterministic and DELETE loses the old value" },
      { ...MEMORY_PRODUCTS[2], stored: store.length, contradictoryContexts: rcContradictory, currentCorrect: rcCorrect, revisionsDetected, falseRevisions, historyRetained: store.length - active.length, llmCallsPerAdd: 0, deterministic: true,
        note: "" },
    ],
  };
}

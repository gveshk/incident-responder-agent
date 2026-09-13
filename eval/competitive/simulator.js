/**
 * A simulated external API with ground truth, so every strategy can be
 * scored against what *actually* happened, not what the API claimed.
 *
 * Create semantics (server-assigned ids) — like a ticket, issue, message or
 * CRM row. That's what makes "retry after timeout" a duplicate, not a no-op.
 *
 * Faults are the shapes real APIs produce (two of them were observed on this
 * project's first live run):
 *
 *   fake-200        200 OK, response carries an id, nothing was stored
 *   truncated       200 OK, stored content was cut on save
 *   wrong-record    200 OK, stored fine but the returned id points nowhere
 *   timeout         the write happened, but the client saw a timeout
 *   transient-503   the write did not happen, client saw a 503 (retry is right here)
 *
 * Deterministic: same seed → same fault schedule for every strategy.
 */

// mulberry32 — tiny seeded PRNG, good enough for a reproducible fault schedule
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FAULTS = ["fake-200", "truncated", "wrong-record", "timeout", "transient-503"];

export class TimeoutError extends Error { constructor() { super("timeout"); this.name = "TimeoutError"; this.transient = true; } }
export class ServerError extends Error { constructor() { super("503 service unavailable"); this.name = "ServerError"; this.transient = true; this.status = 503; } }

export function createSimulatedApp({ readFaultRate = 0, latencyMs = { write: 120, read: 60, delete: 100 }, rng = makeRng(1) } = {}) {
  const store = new Map(); // id -> { id, content }
  const stats = { calls: 0, latencyMs: 0 };
  let nextFault = null;
  let seq = 0;

  function spend(kind) { stats.calls += 1; stats.latencyMs += latencyMs[kind]; }
  function put(content) { seq += 1; const id = `rec-${seq}`; store.set(id, { id, content }); return id; }

  return {
    store,
    stats,
    /** Arms the next write with a fault; a fault fires once, a retry hits the healthy path. */
    setFault(fault) { nextFault = fault; },

    async write(intent) {
      spend("write");
      const fault = nextFault;
      nextFault = null;
      switch (fault) {
        case "fake-200": seq += 1; return { ok: true, id: `rec-${seq}`, content: intent.content };
        case "truncated": return { ok: true, id: put(intent.content.slice(0, 12)), content: intent.content };
        case "wrong-record": put(intent.content); seq += 1; return { ok: true, id: `rec-${seq}`, content: intent.content };
        case "timeout": put(intent.content); throw new TimeoutError();
        case "transient-503": throw new ServerError();
        default: return { ok: true, id: put(intent.content), content: intent.content };
      }
    },

    /** Independent read path — truthful, but can itself fail (→ unknown). */
    async read(id) {
      spend("read");
      if (readFaultRate && rng() < readFaultRate) throw new TimeoutError();
      return store.get(id) ?? null;
    },

    async delete(id) {
      spend("delete");
      store.delete(id);
      return { ok: true };
    },

    /**
     * Ground truth for scoring one intent. "Correct" means exactly one
     * full record exists AND the id the agent was handed reaches it — a
     * record the agent can't address is a broken reference downstream.
     */
    truth(intent, claimedId) {
      const full = [...store.values()].filter((r) => r.content === intent.content).length;
      const partial = [...store.values()].filter((r) => r.content !== intent.content && intent.content.startsWith(r.content)).length;
      const reachable = Boolean(claimedId) && store.get(claimedId)?.content === intent.content;
      return {
        exactlyOne: full === 1 && partial === 0 && reachable,
        duplicates: Math.max(0, full - 1),
        partial,
        empty: full === 0 && partial === 0,
        written: full + partial > 0,
      };
    },
    reset() { store.clear(); stats.calls = 0; stats.latencyMs = 0; nextFault = null; seq = 0; },
  };
}

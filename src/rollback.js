/**
 * Reversibility taxonomy, per action type:
 *
 *   reversible    — undo restores the exact pre-state (a CRM field, a
 *                    ticket, a created-then-deleted issue)
 *   compensable   — the artifact can be removed/corrected, but the real
 *                    effect (someone read it) can't be un-happened
 *   bufferable    — never fired at all; held at a gate until an explicit
 *                    commit() (Atomix, arXiv 2602.14849: this leaked 0/500
 *                    vs 80% for fire-then-compensate on irreversible acts)
 *   irreversible  — no undo can be honestly offered; not used in this demo
 */
export const TIERS = Object.freeze({
  REVERSIBLE: "reversible",
  COMPENSABLE: "compensable",
  BUFFERABLE: "bufferable",
  IRREVERSIBLE: "irreversible",
});

const TIER_BY_ACTION_TYPE = {
  "linear.issueCreate": TIERS.REVERSIBLE,
  "linear.issueUpdate": TIERS.REVERSIBLE,
  "github.issueCreate": TIERS.REVERSIBLE,
  "hubspot.propertyUpdate": TIERS.REVERSIBLE,
  "slack.postMessage": TIERS.COMPENSABLE,
  "pagerduty.page": TIERS.BUFFERABLE,
};

export function classifyTier(actionType) {
  const tier = TIER_BY_ACTION_TYPE[actionType];
  if (!tier) throw new Error(`no rollback tier registered for action type "${actionType}"`);
  return tier;
}

/**
 * Fields every real API mutates on every write and cannot be restored.
 * Rollback fidelity is judged against agent-writable fields only, with
 * this list excluded up front — never claimed as bit-for-bit restoration.
 */
export const EXCLUDED_FIELDS = ["updatedAt", "updated_at", "revision", "editedTs", "eventTs"];

export function diffAgentWritableFields(before, after) {
  const diffs = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (EXCLUDED_FIELDS.includes(key)) continue;
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      diffs[key] = { before: before?.[key], after: after?.[key] };
    }
  }
  return diffs;
}

/**
 * @param {{actionType: string, undoFn: () => Promise<{ok: boolean}>, holdIntent?: object}} actionRecord
 * @returns {Promise<{tier: string, outcome: string, detail: any}>}
 */
export async function rollback(actionRecord) {
  const tier = classifyTier(actionRecord.actionType);

  if (tier === TIERS.BUFFERABLE) {
    // Nothing was ever fired — there is nothing to reverse. A held intent
    // IS the proof the 4th tier worked, not an action needing rollback.
    return { tier, outcome: "held-not-fired", detail: actionRecord.holdIntent ?? null };
  }

  try {
    const result = await actionRecord.undoFn();
    if (!result?.ok) {
      return { tier, outcome: "escalated", detail: `compensation reported failure: ${JSON.stringify(result)}` };
    }
    return { tier, outcome: tier === TIERS.REVERSIBLE ? "restored" : "compensated", detail: result };
  } catch (err) {
    // Compensation itself can fail against a third-party API (rate limit,
    // permission, retention policy) — this is the explicit terminal state,
    // never a silent swallow.
    return { tier, outcome: "escalated", detail: err.message };
  }
}

/**
 * Bufferable tier: records the intent, never calls the real API. commit()
 * exists so the mechanism is real, but the demo never calls it — that IS
 * the proof PagerDuty didn't fire.
 */
export function hold(actionType, intent) {
  const tier = classifyTier(actionType);
  if (tier !== TIERS.BUFFERABLE) {
    throw new Error(`hold() called for a non-bufferable action type "${actionType}"`);
  }
  let committed = false;
  return {
    tier,
    intent,
    isCommitted: () => committed,
    commit: async (fireFn) => {
      committed = true;
      return fireFn();
    },
  };
}

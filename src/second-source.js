/**
 * Second-source recovery for the wrong-record case: the API stored the
 * write, but the id it handed back points nowhere. A read-back by that
 * id says "doesn't exist" — true, and also incomplete. Before accepting
 * that verdict, ask a *different* question of the same system: "is
 * there exactly one record with this exact content, created since this
 * run started?"
 *
 *   exactly one  → the write happened under another id. Adopt it, re-verify.
 *   none         → the verdict stands: false.
 *   more than one→ we cannot tell which is ours: unknown, escalate.
 *
 * Integrations opt in by exporting findByContent(intent, { since }).
 * Never used for anything but a failed existence check — a passing
 * read-back is never second-guessed into a different id.
 */
export async function recoverViaSecondSource({ integration, actResult, intent, verifyResult, since }) {
  if (!integration.findByContent) return null;
  if (verifyResult.status !== "false" || verifyResult.checks.existsCheck !== false) return null;

  let matches;
  try {
    matches = await integration.findByContent(intent, { since });
  } catch (err) {
    return { outcome: "unknown", reason: `second-source search failed: ${err.message}` };
  }
  if (!matches || matches.length === 0) return { outcome: "none", reason: "no record with this content exists — the write did not happen" };
  if (matches.length > 1) return { outcome: "unknown", reason: `${matches.length} records match this content — cannot tell which is ours` };

  const corrected = { ...actResult, id: matches[0].id, raw: { ...actResult.raw, ...matches[0].raw }, originalId: actResult.id };
  const reverified = await integration.verify(corrected, intent);
  return { outcome: reverified.status === "true" ? "corrected" : "unknown", corrected, reverified, reason: "record found under a different id via content search" };
}

/**
 * Tri-state verification core. Never trust a mutating call's own return
 * value — every verify() call re-reads through a *different* code path
 * than the write and compares against intent.
 *
 * Status is always one of "true" | "false" | "unknown" — never a bare
 * boolean. "unknown" (a timeout, an ambiguous read, a disagreement the
 * checks can't resolve) must escalate to a human, never auto-retry: per
 * "Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic
 * Failures" (arXiv 2608.02645), naive retry-on-unknown produced 72%
 * duplicate side-effects under fault injection. This function is pure —
 * it never calls a network API itself, so it structurally cannot retry.
 */

export function canonicalize(text, app) {
  if (text == null) return "";
  let s = String(text);
  if (app === "slack") {
    // Slack auto-links bare URLs as <url> or <url|label> on save — unwrap
    // to the URL. Then strip emphasis markers, which Slack also mangles.
    s = s.replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1");
    s = s.replace(/[*_~`]/g, "");
  }
  if (app === "linear" || app === "github") {
    // Both normalize line endings on save.
    s = s.replace(/\r\n/g, "\n");
  }
  return s.trim().replace(/\s+/g, " ");
}

export function contentMatch(expected, actual, app) {
  const a = canonicalize(expected, app);
  const b = canonicalize(actual, app);
  if (a === b) return 1;
  if (!a || !b) return 0;
  // Cheap similarity: is one a real prefix/suffix of the other (the
  // signature of truncation)? Good enough to catch mangled content
  // without a full diff library.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  return 0;
}

/**
 * @param {object} params
 * @param {boolean|null} params.exists - null if the existence check itself failed/timed out
 * @param {{expected: string, actual: string, app: string}|null} [params.content]
 * @param {boolean|null} [params.crossSourceConfirmed] - null if no second source was checked
 * @returns {{status: "true"|"false"|"unknown", confidence: number, checks: object, reason: string}}
 */
export function verify({ exists, content = null, crossSourceConfirmed = null }) {
  const checks = {
    existsCheck: exists,
    contentMatch: content ? contentMatch(content.expected, content.actual, content.app) : null,
    crossSourceConfirmed,
  };

  if (exists === null) {
    return { status: "unknown", confidence: 0, checks, reason: "existence check timed out or errored" };
  }
  if (exists === false) {
    return { status: "false", confidence: 1, checks, reason: "action target does not exist on independent read" };
  }
  if (checks.contentMatch !== null && checks.contentMatch < 0.85) {
    return {
      status: "false",
      confidence: 1 - checks.contentMatch,
      checks,
      reason: `content mismatch after canonicalization (match=${checks.contentMatch.toFixed(2)})`,
    };
  }
  if (crossSourceConfirmed === false) {
    return { status: "unknown", confidence: 0.4, checks, reason: "second source disagrees with the write" };
  }

  let confidence = 0.7;
  if (checks.contentMatch !== null) confidence += 0.15 * checks.contentMatch;
  if (crossSourceConfirmed === true) confidence += 0.15;
  confidence = Math.min(confidence, 1);

  return { status: "true", confidence, checks, reason: "independent read confirms the write" };
}

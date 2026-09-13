/**
 * A canned "error spike" payload standing in for a live Sentry webhook —
 * same narrative role (the thing that kicks off the incident-response
 * flow), zero auth/setup cost for a one-day build.
 */
export function buildMockSentryPayload(overrides = {}) {
  return {
    service: "checkout-api",
    errorType: "TypeError: Cannot read properties of undefined (reading 'total')",
    eventCount: 47,
    windowMinutes: 5,
    reportedOwner: "team-payments",
    escalationPolicy: "payments-oncall",
    ...overrides,
  };
}

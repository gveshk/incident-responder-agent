import { verify as verifyCore } from "../verifier.js";

// Companies, not contacts: an incident affects a customer account.
const HUBSPOT_API_URL = "https://api.hubapi.com/crm/v3/objects/companies";

async function hubspotRequest(method, path, body) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is not set");
  const res = await fetch(`${HUBSPOT_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`HubSpot API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Property update on a company. The pre-state is captured *before* the
 * write so undo can restore the exact prior value — this is what makes
 * the action reversible rather than merely compensable.
 */
export async function act(input) {
  const objectId = input.objectId ?? process.env.HUBSPOT_DEMO_COMPANY_ID;
  if (!objectId) throw new Error("HUBSPOT_DEMO_COMPANY_ID is not set and no objectId was passed");
  const before = await hubspotRequest("GET", `/${objectId}?properties=${input.property}`);
  const data = await hubspotRequest("PATCH", `/${objectId}`, { properties: { [input.property]: input.value } });
  return {
    id: data.id,
    raw: { property: input.property, value: input.value, url: `https://app.hubspot.com/contacts/${data.id}` },
    capturedBefore: { [input.property]: before.properties?.[input.property] ?? null },
  };
}

export async function verify(actResult, intent) {
  let company;
  try {
    company = await hubspotRequest("GET", `/${actResult.id}?properties=${actResult.raw.property}`);
  } catch (err) {
    // A 404 is a definitive "does not exist"; anything else is unknown.
    if (err.status === 404) return verifyCore({ exists: false, content: null });
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(company),
    content: company ? { expected: intent.value, actual: company.properties?.[actResult.raw.property], app: "hubspot" } : null,
  });
}

export async function undo(actResult) {
  try {
    await hubspotRequest("PATCH", `/${actResult.id}`, { properties: actResult.capturedBefore });
    return { ok: true, compensationType: "restored" };
  } catch (err) {
    return { ok: false, compensationType: "escalated", error: err.message };
  }
}

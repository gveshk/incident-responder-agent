import { verify as verifyCore } from "../verifier.js";

const PAGERDUTY_API_URL = "https://api.pagerduty.com";

async function pdRequest(method, path, body) {
  const key = process.env.PAGERDUTY_API_KEY;
  if (!key) throw new Error("PAGERDUTY_API_KEY is not set");
  const from = process.env.PAGERDUTY_FROM_EMAIL;
  if (!from) throw new Error("PAGERDUTY_FROM_EMAIL is not set");
  const res = await fetch(`${PAGERDUTY_API_URL}${path}`, {
    method,
    headers: { Authorization: `Token token=${key}`, Accept: "application/vnd.pagerduty+json;version=2", "Content-Type": "application/json", From: from },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`PagerDuty API error: ${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * PagerDuty is the bufferable app: agent.js never calls act() during a
 * run — it holds the intent. Only an explicit `--commit` fires this, and
 * from then on the page is COMPENSABLE: undo can resolve the incident,
 * but it cannot un-page whoever was woken up.
 */
export async function act(input) {
  const serviceId = input.serviceId ?? process.env.PAGERDUTY_SERVICE_ID;
  if (!serviceId) throw new Error("PAGERDUTY_SERVICE_ID is not set and no serviceId was passed");
  const data = await pdRequest("POST", "/incidents", {
    incident: {
      type: "incident",
      title: input.title,
      service: { id: serviceId, type: "service_reference" },
      incident_key: input.incidentKey,
      body: { type: "incident_body", details: input.details },
    },
  });
  const inc = data.incident;
  return { id: inc.id, raw: { incidentKey: input.incidentKey, number: inc.incident_number, url: inc.html_url, title: inc.title }, capturedBefore: null };
}

export async function verify(actResult, intent) {
  let incident;
  try {
    // Independent path: list by our incident_key rather than GET by the id the create call gave us.
    const data = await pdRequest("GET", `/incidents?incident_key=${encodeURIComponent(actResult.raw.incidentKey)}&statuses[]=triggered&statuses[]=acknowledged&statuses[]=resolved`);
    incident = data.incidents?.find((i) => i.incident_key === actResult.raw.incidentKey);
    if (incident && incident.status === "resolved") incident = null; // resolved = the page is no longer in effect
  } catch {
    return verifyCore({ exists: null, content: null });
  }
  return verifyCore({
    exists: Boolean(incident),
    content: incident ? { expected: intent.title, actual: incident.title, app: "pagerduty" } : null,
  });
}

export async function undo(actResult) {
  try {
    await pdRequest("PUT", `/incidents/${actResult.id}`, { incident: { type: "incident_reference", status: "resolved" } });
    return { ok: true, compensationType: "compensated", note: "incident resolved; the page itself cannot be un-sent" };
  } catch (err) {
    return { ok: false, compensationType: "escalated", error: err.message };
  }
}

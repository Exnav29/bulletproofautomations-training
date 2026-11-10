/* Meta Conversions API, server side. Inert until BOTH META_PIXEL_ID and
 * META_CAPI_ACCESS_TOKEN are set on the Pages project; until then events stay
 * queued in workshop_meta_events and nothing leaves this origin.
 *
 * Only registrations with ad_consent ever have events queued (enforced in the
 * database). Email is SHA-256 hashed here; it is never sent in clear and never
 * reaches the browser. event_id matches the browser Pixel's eventID, so Meta
 * counts the pair once. */

export function metaConfigured(env) {
  return /^[0-9]{6,20}$/.test(String(env.META_PIXEL_ID || "")) && String(env.META_CAPI_ACCESS_TOKEN || "").length > 20;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

/** Build the request body for a batch. Exported for tests. */
export async function buildPayload(env, origin, events, regs) {
  const data = [];
  const skipped = [];
  for (const ev of events) {
    const r = regs[ev.registration_id];
    if (!r || !r.ad_consent) { skipped.push(ev.id); continue; }
    const user = { em: [await sha256(String(r.email_normalized || "").trim().toLowerCase())] };
    if (r.fbc) user.fbc = r.fbc;
    if (r.fbp) user.fbp = r.fbp;
    if (r.client_ip) user.client_ip_address = r.client_ip;
    if (r.client_user_agent) user.client_user_agent = r.client_user_agent;
    const slug = r.session && r.session.slug;
    const item = {
      event_name: ev.event_name,
      event_time: Math.floor(new Date(ev.event_time).getTime() / 1000),
      event_id: ev.event_id,
      action_source: "website",
      event_source_url: origin + (slug ? "/workshops/" + slug : "/workshops"),
      user_data: user,
      custom_data: {
        content_type: "product",
        content_ids: slug ? [slug] : [],
        content_name: r.session ? r.session.title : undefined
      }
    };
    if (ev.value_ghs != null) {
      item.custom_data.currency = "GHS";
      item.custom_data.value = Number(ev.value_ghs);
    }
    data.push(item);
  }
  const body = { data: data };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = String(env.META_TEST_EVENT_CODE);
  return { body: body, skipped: skipped };
}

/* Returns { ok, failedIds, reason }. Consent-less or unreadable events are
   reported as failed so they are retried, then given up after five attempts. */
export async function sendConversions(env, origin, events, loadRegistrations) {
  const regs = await loadRegistrations(Array.from(new Set(events.map(function (e) { return e.registration_id; }))));
  const built = await buildPayload(env, origin, events, regs);
  if (!built.body.data.length) return { ok: true, failedIds: built.skipped };
  const version = /^v[0-9]{2}\.[0-9]$/.test(String(env.META_GRAPH_VERSION || "")) ? env.META_GRAPH_VERSION : "v21.0";
  let res;
  try {
    res = await fetch("https://graph.facebook.com/" + version + "/" + env.META_PIXEL_ID + "/events", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.META_CAPI_ACCESS_TOKEN },
      body: JSON.stringify(built.body)
    });
  } catch (err) {
    return { ok: false, failedIds: events.map(function (e) { return e.id; }), reason: "meta-unreachable" };
  }
  if (!res.ok) {
    return { ok: false, failedIds: events.map(function (e) { return e.id; }), reason: "meta-" + res.status };
  }
  return { ok: true, failedIds: built.skipped };
}

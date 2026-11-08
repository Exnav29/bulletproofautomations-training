/* GET /api/workshops/calendar?t=<token> — an .ics file for a confirmed
 * registration. One event in the attendee's own calendar; no invitation is
 * sent and nothing is booked on the host's calendar. It carries the joining
 * link, so it is served only while the registration is confirmed: a refunded,
 * cancelled or unpaid registration gets 404, the same as a wrong token. */

import { rpc } from "../_shared.js";
import { sha256Hex, looksLikeToken, calendarFile, rest } from "../_workshops.js";

export async function onRequestGet({ request, env }) {
  const token = new URL(request.url).searchParams.get("t") || "";
  const notFound = new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!looksLikeToken(token) || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return notFound;
  const found = await rpc(env, "workshop_status_for_token", { p_token_hash: await sha256Hex(token), p_reference: null });
  if (!found.ok || !found.data || found.data.state !== "known" || found.data.status !== "confirmed") return notFound;
  const res = await rest(env, "workshop_sessions?select=id,slug,title,starts_at,duration_minutes,join_instructions&slug=eq." +
    encodeURIComponent(found.data.session.slug) + "&limit=1");
  const session = res.ok ? (await res.json().catch(function () { return []; }))[0] : null;
  if (!session) return notFound;
  return new Response(calendarFile(session, new URL(request.url).origin), {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + session.slug + '.ics"',
      "Cache-Control": "no-store"
    }
  });
}

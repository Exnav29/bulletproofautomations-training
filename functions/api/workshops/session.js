/* GET /api/workshops/session?slug=  — the database's view of one session, so a
 * page can confirm it still matches what it displays before anyone registers.
 * Public fields only: no capacity figure, no seat count (no "spots left"
 * counter), no join instructions. */

import { json, rpc } from "../_shared.js";
import { rest } from "../_workshops.js";

export async function onRequestGet({ request, env }) {
  const slug = new URL(request.url).searchParams.get("slug") || "";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return json({ ok: false, code: "not_found" }, 404);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: false, code: "not_configured" }, 503);

  const res = await rest(env, "workshop_sessions?select=id,slug,kind,title,starts_at,duration_minutes,time_zone,format,price_ghs,capacity,status" +
    "&slug=eq." + encodeURIComponent(slug) + "&status=neq.draft&limit=1");
  if (!res.ok) return json({ ok: false, code: "unavailable" }, 503);
  const row = (await res.json().catch(function () { return []; }))[0];
  if (!row) return json({ ok: false, code: "not_found" }, 404);

  const open = row.status === "published" && Date.parse(row.starts_at) > Date.now();
  let full = false;
  if (open && row.capacity) {
    const used = await rpc(env, "workshop_seats_in_use", { p_session_id: row.id, p_except: null });
    full = used.ok && Number(used.data) >= Number(row.capacity);
  }
  // Reserved Intermediate graduate places are separate from the general ones,
  // so a session can be full for everyone else and still open to a graduate.
  // A database without the release 2 columns simply has none.
  let graduateOpen = false;
  if (open) {
    const g = await rest(env, "workshop_sessions?select=reserved_graduate_seats,graduate_free&id=eq." + encodeURIComponent(row.id) + "&limit=1");
    const gr = g.ok ? (await g.json().catch(function () { return []; }))[0] : (await g.text(), null);
    if (gr && gr.graduate_free === true && Number(gr.reserved_graduate_seats) > 0) {
      const usedG = await rpc(env, "workshop_graduate_seats_in_use", { p_session_id: row.id });
      graduateOpen = usedG.ok && Number(usedG.data) < Number(gr.reserved_graduate_seats);
    }
  }
  return json({
    ok: true,
    session: {
      slug: row.slug, kind: row.kind, title: row.title, starts_at: row.starts_at,
      duration_minutes: row.duration_minutes, time_zone: row.time_zone, format: row.format,
      price_ghs: Number(row.price_ghs)
    },
    open: open && (!full || graduateOpen),
    full: full && !graduateOpen,
    // Yes/no only: there is deliberately no "places left" counter.
    general_full: open && full,
    graduate_places_open: graduateOpen,
    status: open ? (full ? (graduateOpen ? "graduates_only" : "full") : "open") : row.status === "published" ? "started" : row.status
  });
}

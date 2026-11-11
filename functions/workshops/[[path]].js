/* /workshops and /workshops/<slug> — rendered on request from the database.
 *
 * Release 6: workshops are created and edited in /admin/workshops/, so their
 * pages cannot be built at deploy time any more. This reads the sessions and
 * series (service role, public columns only: never join_instructions or the
 * Calendar event), renders them with functions/api/_workshop_pages.js, and
 * places the result in the shell the build produced (dist/workshops/_shell.html,
 * which carries the site header, footer and consent bar).
 *
 * Headers: _headers applies to static files only, never to a Function's
 * response, so the /workshops* rules are set here, identical to _headers.
 *
 * A test-mode deployment (a test webinar key, i.e. Preview) sees test sessions
 * only, and every other deployment sees real ones only: the rule the session
 * endpoint and the database apply to registration. */

import { rest, workshopMode } from "../api/_workshops.js";
import { catalog, route, fill } from "../api/_workshop_pages.js";

export const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), payment=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://connect.facebook.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.facebook.com; font-src 'self'; connect-src 'self' https://www.facebook.com https://connect.facebook.net; form-action 'self' https://checkout.paystack.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; upgrade-insecure-requests"
};

// Public columns only.
export const SESSION_COLUMNS = "id,slug,status,kind,title,starts_at,duration_minutes,time_zone,format,price_ghs,capacity,admission," +
  "reserved_graduate_seats,foundations_discount_pct,graduate_free,referral_discount_ghs,is_test,series_slug,series_number,announce,content";

export async function loadCatalog(env) {
  const test = workshopMode(env) === "test";
  const [s, x] = await Promise.all([
    // Drafts are read too, and catalog() keeps only announced ones; none of these columns is private.
    rest(env, "workshop_sessions?select=" + SESSION_COLUMNS + "&is_test=eq." + test),
    rest(env, "workshop_series?select=slug,name,presenter,positioning,intro,standalone,disclaimer")
  ]);
  if (!s.ok || !x.ok) { await Promise.all([s.text(), x.text()]); return null; }
  return catalog(await s.json(), await x.json(), Date.now());
}

async function shell(context) {
  let res = await context.env.ASSETS.fetch(new Request(new URL("/workshops/_shell.html", context.request.url).toString()));
  // Pages may answer a .html path with a redirect to the clean URL; follow it once.
  if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) {
    res = await context.env.ASSETS.fetch(new Request(new URL(res.headers.get("Location"), context.request.url).toString()));
  }
  return res.ok ? res.text() : null;
}

async function notFound(context, status) {
  const res = await context.env.ASSETS.fetch(new Request(new URL("/404.html", context.request.url).toString()));
  return new Response(res.ok ? await res.text() : "Not found", { status: status || 404, headers: Object.assign({}, HEADERS, { "Cache-Control": "no-store" }) });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  // One address per page: /workshops/<slug>/ and /workshops/<slug> are the same page.
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/workshops/_shell" || path === "/workshops/_shell.html") return notFound(context);
  if (!context.env.SUPABASE_URL || !context.env.SUPABASE_SERVICE_ROLE_KEY) return notFound(context, 503);

  const [cat, frame] = await Promise.all([loadCatalog(context.env), shell(context)]);
  if (!cat || !frame) {
    return new Response("Webinars and workshops are unavailable for a moment. Refresh to try again.",
      { status: 503, headers: Object.assign({}, HEADERS, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "30", "Cache-Control": "no-store" }) });
  }
  const page = route(path, cat);
  if (!page) return notFound(context);
  // Short browser cache, so an edit in the admin shows within a minute, while a
  // burst of advert traffic does not read the database once per visitor.
  return new Response(fill(frame, page), { status: 200, headers: Object.assign({}, HEADERS, { "Cache-Control": "public, max-age=60" }) });
}

export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  return new Response(null, { status: res.status, headers: res.headers });
}

/* /sitemap.xml — the built sitemap plus the workshop pages that exist right now.
 *
 * Workshop pages are rendered from the database (functions/workshops/[[path]].js),
 * so the build cannot know them. If the database is unreachable the built
 * sitemap is served unchanged: the rest of the site is still listed. */

import { loadCatalog } from "./workshops/[[path]].js";
import { paths, ORIGIN } from "./api/_workshop_pages.js";

export async function onRequestGet(context) {
  const res = await context.env.ASSETS.fetch(new Request(new URL("/sitemap.xml", context.request.url).toString()));
  let xml = res.ok ? await res.text() : "";
  if (!xml) return res;
  try {
    const cat = context.env.SUPABASE_URL && context.env.SUPABASE_SERVICE_ROLE_KEY ? await loadCatalog(context.env) : null;
    if (cat) {
      const entries = paths(cat).map(function (p) { return "  <url>\n    <loc>" + ORIGIN + p + "</loc>\n  </url>\n"; }).join("");
      xml = xml.replace("</urlset>", entries + "</urlset>");
    }
  } catch (err) { /* serve the built sitemap */ }
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

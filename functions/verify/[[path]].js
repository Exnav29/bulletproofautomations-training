/* /verify/<credential-id> — serve the verification page for any sub-path.
 *
 * This is the URL a holder puts in LinkedIn's Credential URL field, and what
 * LinkedIn renders as a "Show credential" button. It has to work.
 *
 * It is a Function rather than a line in _redirects because the `200` rewrite
 * form
 *
 *     /verify/*  /verify/index.html  200
 *
 * does not take effect — measured on 11 August 2026, every /verify/<id> fell
 * through to 404.html. That failure is invisible from the source tree and
 * would only have shown up as a dead credential on somebody's LinkedIn
 * profile. A Function is testable locally with `wrangler pages dev`, behaves
 * identically in production, and cannot be silently ignored.
 *
 * env.ASSETS serves the built static file directly and does not re-enter
 * Functions, so there is no recursion here.
 *
 * The ID is not parsed or validated here on purpose: the page reads it from
 * location.pathname and POSTs it to /api/verify, which is where the length and
 * shape rules live. Serving the shell for a nonsense ID is correct — the page
 * then says plainly that nothing matches.
 */

export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.pathname = "/verify/index.html";
  url.search = "";

  const response = await context.env.ASSETS.fetch(new Request(url.toString(), {
    method: "GET",
    headers: context.request.headers
  }));

  // Copy it so the headers are mutable, and so a cached asset response cannot
  // leak an ETag that makes every credential look like the same document.
  const out = new Response(response.body, response);
  out.headers.delete("ETag");
  out.headers.set("Cache-Control", "no-cache");
  return out;
}

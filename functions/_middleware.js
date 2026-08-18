/* Root middleware: substitutes regional prices into the pages that publish
 * them, and stamps the resolved tier onto <html> so the page and the
 * enrollment endpoint cannot disagree about what was shown.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SERVER-RENDERED RATHER THAN SWAPPED IN THE BROWSER
 * ---------------------------------------------------------------------------
 *
 * The site already ships the safe copy and reveals the real one after a server
 * call, twice: the data-pay swap on the enrollment page, and the offering
 * reveal on /thank-you. Pricing is the case where that pattern is wrong.
 *
 *   * A price that visibly changes after load reads as surge pricing. It is
 *     the one element on the page where a flicker actively costs trust.
 *   * The audience is mobile-first on constrained connections. The no-JS and
 *     slow-connection visitor has to see a CORRECT price, not merely a safe
 *     one.
 *
 * ---------------------------------------------------------------------------
 * BLAST RADIUS, AND THE THREE RULES THAT CONTAIN IT
 * ---------------------------------------------------------------------------
 *
 * A root middleware sits in front of the homepage, the only selling page, the
 * confirmation page and two supporting pages at once. A bug here takes all
 * five down together rather than one, so:
 *
 *   1. FAIL OPEN, NEVER CLOSED. Anything that throws returns the untouched
 *      response. A page showing Ghana prices is recoverable; a 500 on the
 *      selling page is not. The missing data-pricing-tier attribute then stops
 *      that becoming a CHARGE error — see enroll.js, which reserves rather
 *      than charging when the marker is absent.
 *   2. EXACT-MATCH ALLOWLIST. A literal set of five paths, no prefix matching
 *      and no regex. Everything else is returned before anything is parsed.
 *   3. SWITCHED OFF BY DEFAULT. With PRICING_REGIONS unset this returns
 *      next() untouched, so the whole file is inert until the switch is
 *      deliberately thrown.
 *
 * Policy and the country map: docs/pricing-policy.md
 */

import { resolveTier, regionsEnabled, displayFigures, instalmentsAllowed } from "./api/_regions.js";

/* The five pages that publish a price. They must move TOGETHER: a visitor
   shown international pricing on the BCAB page and GHS 150 on /pathway has
   been shown two prices for the same product. */
const PRICED_PAGES = new Set([
  "/",
  "/certified-automation-builder",
  "/pathway",
  "/foundations",
  "/thank-you"
]);

/* An empty string is a deliberate "clear my choice", so it is distinct from
   junk. Anything that is not two letters is treated as clearing rather than
   guessed at — the middleware never invents a country. */
function normaliseChoice(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

function readRegionCookie(request) {
  const header = request.headers.get("Cookie") || "";
  const match = /(?:^|;\s*)bpa_region=([A-Za-z]{2})(?:;|$)/.exec(header);
  return match ? match[1].toUpperCase() : null;
}

function normalisePath(pathname) {
  let p = pathname.replace(/\/index\.html$/, "");
  p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

export async function onRequest(context) {
  const { request, next, env } = context;

  /* Cheap rejections first, before the response is even fetched, so the
     overwhelming majority of requests — assets, /api, /verify, /nfc, /admin —
     pay nothing for this file existing. */
  if (!regionsEnabled(env)) return next();
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  let path;
  try {
    path = normalisePath(new URL(request.url).pathname);
  } catch (err) {
    return next();
  }
  if (!PRICED_PAGES.has(path)) return next();

  /* ---------------------------------------------------------------------
   * THE CHOICE IS A COOKIE, NOT A QUERY STRING
   * ---------------------------------------------------------------------
   *
   * ?country=XX arrives only as a form submission. It is converted into a
   * cookie and redirected away immediately, so it never survives in the
   * address bar, in history, or in a shared link.
   *
   * Two reasons, and only the second is about pricing:
   *
   *   1. It has to persist. Prices appear on five pages. A correction made on
   *      the enrollment page that evaporated when somebody clicked through to
   *      /pathway would show one person two different prices for one product.
   *
   *   2. A query string is SHAREABLE and a cookie is not. "?country=GH gets
   *      you the cheap rate" is a link that can spread; a cookie cannot be
   *      pasted into a forum.
   *
   * What this does NOT do, and must not be trusted to do: hide the difference.
   * Anyone can still open the selector and look. The actual protection is
   * server-side and already built — a declaration that LOWERS the tier
   * reserves the place and takes no payment until a person confirms it. This
   * is tidiness and link-hygiene, not access control. */
  const url = new URL(request.url);
  if (url.searchParams.has("country")) {
    const asked = normaliseChoice(url.searchParams.get("country"));
    const clean = new URL(request.url);
    clean.searchParams.delete("country");
    /* 303 so the reload is a GET, and so a refresh does not resubmit. The
       browser carries the original fragment across, which is what returns the
       visitor to the pricing block they were looking at. */
    return new Response(null, {
      status: 303,
      headers: {
        Location: clean.pathname + (clean.search || "") ,
        "Cache-Control": "private, no-store",
        /* Cleared with Max-Age=0 when the empty option is chosen, which hands
           the visitor back to detection rather than pinning them to a guess.
           HttpOnly: no script needs to read this — the page learns the decided
           region from the attribute stamped on <html>, which is the DECISION
           rather than the request. */
        "Set-Cookie": asked
          ? "bpa_region=" + asked + "; Path=/; Max-Age=7776000; SameSite=Lax; Secure; HttpOnly"
          : "bpa_region=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly"
      }
    });
  }

  const response = await next();

  try {
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html")) return response;

    const region = resolveTier(request, env, readRegionCookie(request));

    /* The response is per-country, so it must never be stored by a shared
       cache. Cloudflare applies EVERY matching rule rather than the most
       specific one — the lesson that cost a live bug in _headers — so this is
       set on the response itself rather than trusted to a file. */
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Accept-Encoding");

    const tagged = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });

    /* No country could be established at all — Cloudflare said XX or T1, or
       request.cf was absent. Stamp the state and substitute NOTHING: the page
       shows its selector and asks, rather than displaying a price we would
       have had to guess. Assuming the top tier overcharges a Ghanaian on an
       odd network; assuming Ghana hands the subsidised rate to anyone behind
       a VPN. */
    if (!region.resolved) {
      return new HTMLRewriter()
        .on("html", {
          element(el) {
            el.setAttribute("data-pricing-tier", "unresolved");
          }
        })
        .transform(tagged);
    }

    const display = displayFigures(region.tier, region.declared || region.detected);
    if (!display) return response;

    const rewriter = new HTMLRewriter()
      /* The marker enroll.js checks. Its ABSENCE is the failure signal, which
         is why it is set here and nowhere else: the safety does not depend on
         comparing two values correctly, only on whether this ran. */
      .on("html", {
        element(el) {
          el.setAttribute("data-pricing-tier", region.tier);
          el.setAttribute("data-pricing-currency", display.currency);
          el.setAttribute("data-pricing-country", region.declared || region.detected || "");
          /* Drives the CSS that hides the instalment option outside Ghana.
             Done with an attribute rather than by removing the elements so
             that a middleware failure leaves the markup intact — the API
             refuses an out-of-region instalment anyway, which is a visible
             refusal rather than a wrong charge. */
          el.setAttribute("data-pricing-instalments", instalmentsAllowed(region.tier) ? "yes" : "no");
        }
      })
      /* Every published figure. A lookup rather than a set of special cases:
         the attribute value IS the key, so adding a figure to a page needs no
         change here. An unknown key is left exactly as authored, which means
         a typo shows the Ghana default rather than an empty space. */
      .on("[data-price]", {
        element(el) {
          const key = el.getAttribute("data-price");
          const value = display.figures[key];
          if (value) el.setInnerContent(value);
        }
      });

    return rewriter.transform(tagged);
  } catch (err) {
    /* Rule 1. Any failure at all hands back the page exactly as it was built.
       Logged rather than swallowed silently, because a middleware that is
       quietly failing open still needs to be findable in the logs. */
    console.log("pricing-middleware-failed:", (err && err.message) || String(err));
    return response;
  }
}

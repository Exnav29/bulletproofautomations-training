/* assets/js/workshop-tracking.js under jsdom: consent gating, attribution and
 * event de-duplication. Run after `npm install` of the Studio test deps (jsdom),
 * like tests/admin-console.test.mjs:  node tests/workshop-tracking.test.mjs */
import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const source = fs.readFileSync("assets/js/workshop-tracking.js", "utf8");
const BAR = '<div data-ad-consent hidden><button data-ad-consent-allow>Allow</button><button data-ad-consent-deny>No thanks</button></div>';

async function page(pixelId, query, stored) {
  const dom = new JSDOM("<!doctype html><html><head><script></script></head><body>" + BAR + "</body></html>", {
    url: "https://training.example/workshops/automate-invoices" + (query || ""),
    referrer: "https://l.facebook.com/",
    runScripts: "outside-only"
  });
  const w = dom.window;
  for (const [k, v] of Object.entries(stored || {})) w.localStorage.setItem(k, v);
  const calls = [];
  // Stand-in for the base code: record what would be sent, load nothing.
  w.eval("window.__calls = [];");
  w.eval(source.replace('"__META_PIXEL_ID__"', JSON.stringify(pixelId))
    .replace('"https://connect.facebook.net/en_US/fbevents.js"', '"about:blank"'));
  const fbqCalls = () => (w.fbq && w.fbq.queue ? w.fbq.queue.map((a) => Array.from(a)) : []);
  if (w.document.readyState === "loading") await new Promise((r) => w.document.addEventListener("DOMContentLoaded", r));
  return { w, calls, fbqCalls, scripts: () => [...w.document.querySelectorAll("script[src]")].map((s) => s.src) };
}

const UTM = "?utm_source=meta&utm_medium=paid_social&utm_campaign=120210000&utm_content=ad-42&fbclid=IwAR0abcdefgh";

// 1. No Pixel ID: nothing from Meta, no consent bar, attribution still captured.
{
  const p = await page("", UTM);
  assert.equal(p.w.document.querySelector("[data-ad-consent]").hidden, true);
  p.w.BPATracking.track("ViewContent", "vc_1", {});
  assert.equal(p.w.fbq, undefined);
  const a = p.w.BPATracking.attribution();
  assert.equal(a.ad_consent, false);
  assert.equal(a.attribution.utm_campaign, "120210000");
  assert.equal(a.attribution.referrer_host, "l.facebook.com");
  assert.equal(a.attribution.fbclid, undefined);
}

// 2. Pixel ID, no decision yet: bar shown, Meta not loaded, no cookie, no fbclid sent.
{
  const p = await page("1234567890", UTM);
  assert.equal(p.w.document.querySelector("[data-ad-consent]").hidden, false);
  p.w.BPATracking.track("ViewContent", "vc_2", { content_ids: ["automate-invoices"] });
  assert.equal(p.w.fbq, undefined);
  assert.equal(p.scripts().length, 0);
  assert.equal(p.w.document.cookie, "");
  assert.equal(p.w.BPATracking.attribution().attribution.fbclid, undefined);
  assert.equal(p.w.sessionStorage.getItem("bpa_attribution_v1").includes("IwAR"), false, "fbclid stored before consent");

  // 3. Allow: Pixel loads, queued ViewContent sent with its event id, fbclid now included.
  p.w.document.querySelector("[data-ad-consent-allow]").click();
  assert.equal(p.w.document.querySelector("[data-ad-consent]").hidden, true);
  const calls = p.fbqCalls();
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["init", "1234567890"]));
  assert.ok(calls.some((c) => c[0] === "track" && c[1] === "ViewContent" && c[3] && c[3].eventID === "vc_2"));
  assert.equal(p.w.BPATracking.attribution().attribution.fbclid, "IwAR0abcdefgh");
  assert.equal(p.w.BPATracking.attribution().ad_consent, true);

  // 4. Purchase fires once per event id, and only whitelisted data is passed.
  p.w.BPATracking.track("Purchase", "pu_9", { value: 150, currency: "GHS", email: "x@example.com" });
  p.w.BPATracking.track("Purchase", "pu_9", { value: 150, currency: "GHS" });
  const purchases = p.fbqCalls().filter((c) => c[1] === "Purchase");
  assert.equal(purchases.length, 1);
  assert.equal(JSON.stringify(purchases[0][2]), JSON.stringify({ currency: "GHS", value: 150 }));
}

// 5. Declined earlier: nothing loads, queue dropped, no Meta identifiers.
{
  const p = await page("1234567890", UTM, { bpa_ad_consent_v1: "denied" });
  assert.equal(p.w.document.querySelector("[data-ad-consent]").hidden, true);
  p.w.BPATracking.track("Purchase", "pu_1", { value: 150, currency: "GHS" });
  assert.equal(p.w.fbq, undefined);
  assert.equal(p.w.BPATracking.attribution().ad_consent, false);
}

// 6. A mistyped Pixel ID is ignored rather than used.
{
  const p = await page("12345<script>", UTM);
  assert.equal(p.w.BPATracking.pixelEnabled(), false);
}

console.log("PASS: attribution without consent, Pixel only after consent, server event ids, one Purchase per id, no PII to the Pixel.");

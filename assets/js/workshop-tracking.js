/* Ad measurement for the webinar and workshop pages only.
 *
 * Three jobs, in increasing order of what they need from the visitor:
 *
 *   1. Campaign attribution (always). utm_* from the landing URL, the landing
 *      path and the referring host are kept in sessionStorage for this visit
 *      and sent with the registration. First-party, no cookies, no third
 *      party. Disclosed in the privacy policy. This is what lets /admin count
 *      paid registrations per campaign whether or not anyone accepts tracking.
 *
 *   2. The Meta Pixel (consent only). Nothing from Meta loads, no _fbp/_fbc
 *      cookie is set and fbclid is not kept until the visitor chooses "Allow".
 *      The Pixel ID is a build-time value; with none set this file never loads
 *      the Pixel and never shows the consent bar.
 *
 *   3. Events, with ids supplied by the SERVER so the browser and Conversions
 *      API copies deduplicate: ViewContent on load, InitiateCheckout and
 *      CompleteRegistration from /api/workshops/register, Purchase ONLY when
 *      /api/workshops/status reports verified payment. A return from Paystack
 *      on its own never fires Purchase.
 *
 * No name, email, phone or payment detail is ever passed to the Pixel.
 *
 * Exposes window.BPATracking = { attribution(), consent(), allow(), deny(),
 *   track(name, eventId, data) }. Pages call it; it never reads the form. */
(function () {
  "use strict";

  var PIXEL_ID = "__META_PIXEL_ID__";
  var pixelId = /^[0-9]{6,20}$/.test(PIXEL_ID) ? PIXEL_ID : "";
  var CONSENT_KEY = "bpa_ad_consent_v1";   // localStorage: "granted" | "denied"
  var ATTR_KEY = "bpa_attribution_v1";     // sessionStorage
  var FIRED_KEY = "bpa_pixel_fired_v1";    // localStorage: event ids already sent

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function get(kind, key) {
    try { var s = store(kind); return s ? s.getItem(key) : null; } catch (e) { return null; }
  }
  function set(kind, key, value) {
    try { var s = store(kind); if (s) s.setItem(key, value); } catch (e) { /* private mode: degrade quietly */ }
  }

  var UTM = /^[A-Za-z0-9 _.~%+:|{}\-]{1,200}$/;

  /* First touch within this visit wins, so moving between pages does not
     overwrite the campaign that brought the visitor. */
  function captureAttribution() {
    var existing = null;
    try { existing = JSON.parse(get("sessionStorage", ATTR_KEY) || "null"); } catch (e) { existing = null; }
    var params = new URLSearchParams(window.location.search);
    var a = existing && typeof existing === "object" ? existing : {};
    if (!a.landing_path) {
      ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (k) {
        var v = params.get(k);
        if (v && UTM.test(v)) a[k] = v;
      });
      a.landing_path = window.location.pathname.slice(0, 200);
      try {
        var ref = document.referrer ? new URL(document.referrer).hostname : "";
        if (ref && ref !== window.location.hostname) a.referrer_host = ref.slice(0, 200);
      } catch (e) { /* no referrer */ }
    }
    // Held in memory only until consent; never written before then.
    var fbclid = params.get("fbclid");
    if (fbclid && /^[A-Za-z0-9_-]{8,500}$/.test(fbclid)) a._fbclid_pending = fbclid;
    set("sessionStorage", ATTR_KEY, JSON.stringify(stripPending(a)));
    return a;
  }
  function stripPending(a) {
    var copy = {};
    Object.keys(a).forEach(function (k) { if (k.charAt(0) !== "_") copy[k] = a[k]; });
    return copy;
  }

  var attr = captureAttribution();

  function consent() {
    var v = get("localStorage", CONSENT_KEY);
    return v === "granted" || v === "denied" ? v : null;
  }

  function cookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  /* The Meta base code, loaded only after consent and only with a valid ID. */
  var pixelReady = false;
  var queue = [];
  function loadPixel() {
    if (pixelReady || !pixelId) return;
    /* eslint-disable */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    /* eslint-enable */
    window.fbq("init", pixelId);
    window.fbq("track", "PageView");
    pixelReady = true;
    // _fbc from the click id, the format Meta documents: fb.1.<ms>.<fbclid>
    if (attr._fbclid_pending && !cookie("_fbc")) {
      document.cookie = "_fbc=fb.1." + Date.now() + "." + attr._fbclid_pending + "; Max-Age=7776000; Path=/; SameSite=Lax; Secure";
    }
    queue.splice(0).forEach(function (args) { track.apply(null, args); });
  }

  function fired() {
    try { return JSON.parse(get("localStorage", FIRED_KEY) || "[]"); } catch (e) { return []; }
  }

  /* Send one event at most once per browser per id. Before consent it is held
     in memory and dropped if the visitor declines. */
  function track(name, eventId, data) {
    if (!pixelId || !/^[A-Za-z]+$/.test(name)) return;
    if (consent() !== "granted") { if (consent() === null) queue.push([name, eventId, data]); return; }
    if (!pixelReady) { queue.push([name, eventId, data]); loadPixel(); return; }
    var ids = fired();
    if (eventId && ids.indexOf(eventId) !== -1) return;
    var clean = {};
    if (data && typeof data === "object") {
      ["content_ids", "content_name", "content_type", "currency", "value"].forEach(function (k) {
        if (data[k] !== undefined) clean[k] = data[k];
      });
    }
    window.fbq("track", name, clean, eventId ? { eventID: eventId } : undefined);
    if (eventId) set("localStorage", FIRED_KEY, JSON.stringify(ids.concat(eventId).slice(-50)));
  }

  function allow() {
    set("localStorage", CONSENT_KEY, "granted");
    if (attr._fbclid_pending) attr.fbclid = attr._fbclid_pending;
    hideBar();
    loadPixel();
  }
  function deny() {
    set("localStorage", CONSENT_KEY, "denied");
    queue.length = 0;
    delete attr._fbclid_pending;
    hideBar();
  }

  /* What the registration form sends. Meta identifiers only with consent. */
  function attribution() {
    var out = stripPending(attr);
    var granted = consent() === "granted";
    if (granted) {
      if (attr._fbclid_pending) out.fbclid = attr._fbclid_pending;
      var fbc = cookie("_fbc"), fbp = cookie("_fbp");
      if (fbc) out.fbc = fbc;
      if (fbp) out.fbp = fbp;
    }
    return { attribution: out, ad_consent: granted };
  }

  /* The consent bar: not a modal, does not block the page, and only exists
     when there is a Pixel to consent to. Markup is supplied by the page
     ([data-ad-consent]) so its wording and design live with the page. */
  function bar() { return document.querySelector("[data-ad-consent]"); }
  function hideBar() { var b = bar(); if (b) b.hidden = true; }
  function setupBar() {
    var b = bar();
    if (!b) return;
    if (!pixelId || consent() !== null) { b.hidden = true; return; }
    b.hidden = false;
    var yes = b.querySelector("[data-ad-consent-allow]");
    var no = b.querySelector("[data-ad-consent-deny]");
    if (yes) yes.addEventListener("click", allow);
    if (no) no.addEventListener("click", deny);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setupBar);
  else setupBar();
  if (consent() === "granted") loadPixel();

  window.BPATracking = {
    attribution: attribution,
    consent: consent,
    allow: allow,
    deny: deny,
    track: track,
    pixelEnabled: function () { return !!pixelId; }
  };
})();

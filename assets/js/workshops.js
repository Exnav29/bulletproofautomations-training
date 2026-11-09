/* Webinar and workshop registration, and the confirmation page.
 *
 * The page never decides anything about money. It sends what the visitor
 * typed plus the price and time it displayed; /api/workshops/register decides
 * the rest. The confirmation page asks /api/workshops/status, which only
 * answers a browser holding the status token issued at registration. A return
 * from Paystack proves nothing by itself, so "confirmed" and the Purchase event
 * appear only when that endpoint reports verified money.
 *
 * Every state is shown on the same step trace: register, pay, confirmation
 * email, join live. Words in this file are user-facing copy. */
(function () {
  "use strict";

  var main = document.querySelector("main.ws");
  if (!main) return;
  var kind = main.getAttribute("data-ws-page");
  /* Support contact. WhatsApp appears only when WORKSHOP_SUPPORT_WHATSAPP was
     set at build time (owner-verified); otherwise people are pointed to email. */
  var SUPPORT_WA = "__WORKSHOP_SUPPORT_WHATSAPP__";
  var WHATSAPP = /^\+[1-9][0-9]{7,14}$/.test(SUPPORT_WA) ? SUPPORT_WA : "";
  function contact() { return WHATSAPP ? "WhatsApp " + WHATSAPP : "email info@bulletproofautomations.com"; }

  /* ---------- small helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  /* A referrer's code from their link (?ref=CODE), kept for this tab so it
     survives moving between workshop pages. The server ignores any code that is
     not an active referrer's, so this only ever carries a hint. */
  function referralCode() {
    var fromUrl = "";
    try { fromUrl = new URLSearchParams(window.location.search).get("ref") || ""; } catch (e) { /* old browser */ }
    var ok = /^[A-Za-z0-9]{4,16}$/.test(fromUrl);
    try {
      if (ok) window.sessionStorage.setItem("bpa_ws_ref", fromUrl.toUpperCase());
      else fromUrl = window.sessionStorage.getItem("bpa_ws_ref") || "";
    } catch (e) { /* storage blocked */ }
    return /^[A-Za-z0-9]{4,16}$/.test(fromUrl) ? fromUrl.toUpperCase() : "";
  }
  referralCode();
  function saveAccess(slug, value) {
    try { var s = store(); if (s) s.setItem("bpa_ws_" + slug, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  function loadAccess(slug) {
    try { var s = store(); return s ? JSON.parse(s.getItem("bpa_ws_" + slug) || "null") : null; } catch (e) { return null; }
  }
  function track(name, id, data) {
    if (window.BPATracking && id) window.BPATracking.track(name, id, data || {});
  }
  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); });
  }
  function fmt(iso, tz, opts) {
    try { return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: tz }, opts)).format(new Date(iso)); }
    catch (e) { return new Date(iso).toUTCString(); }
  }
  function whenText(session) {
    var clock = { hour: "numeric", minute: "2-digit", hour12: true };
    return {
      long: fmt(session.starts_at, session.time_zone || "Africa/Accra", { weekday: "long", day: "numeric", month: "long" }),
      accra: fmt(session.starts_at, "Africa/Accra", clock).toUpperCase(),
      lagos: fmt(session.starts_at, "Africa/Lagos", clock).toUpperCase()
    };
  }
  function ghs(n) { return "GHS\u00a0" + Number(n || 0).toLocaleString("en-GB"); }

  /* ---------- the trace ---------- */
  function setStep(trace, step, state, detail) {
    var li = trace && trace.querySelector('[data-step="' + step + '"]');
    if (!li) return;
    li.className = "ws-step is-" + state;
    var dot = li.querySelector(".ws-step__dot");
    var n = Array.prototype.indexOf.call(trace.children, li) + 1;
    dot.textContent = state === "done" ? "✓" : state === "fail" ? "!" : String(n);
    if (detail != null) li.querySelector("[data-step-detail]").textContent = detail;
  }

  /* ======================================================================
     Detail page
     ====================================================================== */
  if (kind === "detail") {
    var slug = main.getAttribute("data-slug");
    var price = Number(main.getAttribute("data-price"));
    var starts = main.getAttribute("data-starts");
    var title = main.getAttribute("data-title");
    var form = $("[data-ws-form]");
    var trace = $("[data-trace]");
    var submit = $("[data-ws-submit]");
    var errorBox = $("[data-ws-error]");
    var after = $("[data-ws-after]");
    var banner = $("[data-ws-banner]");
    var label = submit ? submit.textContent : "";
    var testOptIn = /[?&]paystack=test\b/.test(location.search);
    // Waitlist (migration 20261111120000). An offer link (?offer=...) holds a place
    // for one person: the form is filled in from their waitlist entry and the
    // registration carries the offer. Sold out with registration still open: the
    // same form joins the waitlist instead, with no payment.
    var pageParams = new URLSearchParams(location.search);
    var offerToken = pageParams.get("offer") || "";
    var waitlistMode = false;

    // Phone register bar: visible only when neither the hero button nor the
    // sheet is in view, and never while the consent bar is showing.
    var sticky = $("[data-ws-sticky]");
    var jump = $(".ws-jump");
    var sheetEl = $("[data-ws-sheet]");
    if (sticky && jump && sheetEl && "IntersectionObserver" in window) {
      var seen = { jump: true, sheet: false };
      var consentBar = $("[data-ad-consent]");
      var update = function () { sticky.hidden = seen.jump || seen.sheet || (consentBar && !consentBar.hidden); };
      new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { seen[en.target === jump ? "jump" : "sheet"] = en.isIntersecting; });
        update();
      }).observe(jump);
      new IntersectionObserver(function (entries) { seen.sheet = entries[0].isIntersecting; update(); }).observe(sheetEl);
      document.addEventListener("click", function () { setTimeout(update, 0); });
    }

    var vcId = "vc_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    track("ViewContent", vcId, { content_ids: [slug], content_name: title, content_type: "product", currency: "GHS", value: price });

    var wa = form && form.elements.whatsapp;
    var waConsent = $("[data-wa-consent]");
    if (wa && waConsent) wa.addEventListener("input", function () { waConsent.hidden = !wa.value.trim(); });

    function showError(text) { errorBox.textContent = text; errorBox.hidden = !text; }
    function closeForm(heading, text, links) {
      form.hidden = true;
      after.hidden = false;
      after.textContent = "";
      after.appendChild(el("p", { class: "ws-step__name" }, heading));
      after.appendChild(el("p", {}, text));
      (links || []).forEach(function (l) {
        var a = el("a", { class: "ws-btn ws-btn--block" + (l.quiet ? " ws-btn--quiet" : ""), href: l.href }, l.text);
        after.appendChild(a);
      });
    }

    /* Price before checkout. The server computes it (the same database
       function registration uses); the page only shows it, and sends back the
       figure it showed so a changed price is never charged unseen. */
    var refInput = form && form.elements.ref;
    var quoteLine = $("[data-ws-quote]");
    var benefit = { token: "", tier: "" };
    var quoted = price;
    var quoteOk = true;
    var graduatesOnly = false;
    var ghsText = function (n) { return n === 0 ? "nothing" : "GHS " + Number(n).toLocaleString("en-GB"); };
    if (refInput && !refInput.value) refInput.value = referralCode();

    function setPrice(n, note) {
      quoted = n;
      label = n === 0 ? "Register for free" : "Register and pay " + ghsText(n);
      if (!submit.disabled) submit.textContent = label;
      if (quoteLine) quoteLine.textContent = note;
    }
    function requote() {
      if (!quoteLine) return;
      var ref = refInput ? refInput.value.trim() : "";
      if (!ref && !benefit.token) { quoteOk = true; setPrice(price, "You pay " + ghsText(price) + "."); return; }
      post("/api/workshops/quote", { slug: slug, email: form.elements.email.value.trim(), ref: ref, verification: benefit.token })
        .then(function (q) {
          if (!q.ok) {
            quoteOk = false;
            if (q.code === "referral_invalid") {
              if (refInput) refInput.setAttribute("aria-invalid", "true");
              quoteLine.textContent = "That referral code isn't valid. Check it, or clear it to pay " + ghsText(price) + ".";
            } else if (q.code === "benefit_not_valid" || q.code === "benefit_already_used") {
              benefit = { token: "", tier: "" };
              quoteLine.textContent = "Your certificate confirmation has expired or was already used. Confirm it again, or register at the standard fee.";
            } else {
              quoteLine.textContent = "We couldn't work out your price just now. Try again in a moment.";
            }
            return;
          }
          quoteOk = true;
          if (refInput) refInput.setAttribute("aria-invalid", "false");
          var why = { referral: "referral discount", foundations: "Foundations certificate price", graduate: "complimentary graduate place" }[q.discount_kind];
          setPrice(q.price_ghs, q.discount_kind
            ? "Advertised " + ghsText(q.list_price_ghs) + ". " + (q.discount_kind === "graduate" ? "Complimentary graduate place" : "Less " + ghsText(q.discount_ghs) + ", " + why) +
              ". You pay " + ghsText(q.price_ghs) + "." + (q.referral && q.discount_kind === "foundations" ? " Discounts don't combine; your referral is still recorded." : "")
            : "You pay " + ghsText(q.price_ghs) + ".");
        })
        .catch(function () { quoteOk = false; quoteLine.textContent = "We couldn't work out your price just now. Try again in a moment."; });
    }
    if (refInput) refInput.addEventListener("change", requote);
    // A code filled in from a referral link is priced straight away.
    if (refInput && refInput.value) requote();
    if (form) form.elements.email.addEventListener("change", function () {
      if (benefit.token) { benefit = { token: "", tier: "" }; certStatus("Your email changed, so confirm your certificate again."); }
      requote();
    });

    // Certificate confirmation: a one-time code sent to the certificate's own email.
    var certBox = $("[data-ws-cert]");
    var certStatusEl = $("[data-ws-cert-status]");
    function certStatus(text) { if (certStatusEl) certStatusEl.textContent = text; }
    if (certBox) {
      var certInput = form.elements.certificate_id;
      var codeBox = $("[data-ws-cert-code]");
      certInput.addEventListener("change", function () { if (benefit.token) { benefit = { token: "", tier: "" }; requote(); } codeBox.hidden = true; certStatus(""); });
      $("[data-ws-cert-send]").addEventListener("click", function () {
        var email = form.elements.email.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || certInput.value.trim().length < 6) {
          certStatus("Enter your email and certificate ID first.");
          return;
        }
        post("/api/workshops/benefit", { step: "request", slug: slug, email: email, certificate_id: certInput.value.trim() }).then(function () {
          codeBox.hidden = false;
          certStatus("If that certificate is eligible and registered to this email, we have sent a 6-digit code to it. Check spam if it isn't there in two minutes.");
          form.elements.cert_code.focus();
        }).catch(function () { certStatus("We couldn't send a code just now. Try again in a moment."); });
      });
      $("[data-ws-cert-confirm]").addEventListener("click", function () {
        post("/api/workshops/benefit", { step: "confirm", slug: slug, email: form.elements.email.value.trim(),
          certificate_id: certInput.value.trim(), code: form.elements.cert_code.value.trim() }).then(function (r) {
          if (!r.ok) { certStatus(r.remaining > 0 ? "That code didn't match. " + r.remaining + " tries left." : "That code can't be used. Send a new one."); return; }
          benefit = { token: r.verification, tier: r.tier };
          codeBox.hidden = true;
          certStatus(r.tier === "graduate" ? "Certificate confirmed: a complimentary reserved place." : "Certificate confirmed: the Foundations certificate price.");
          requote();
        }).catch(function () { certStatus("We couldn't check the code just now. Try again in a moment."); });
      });
    }

    // The database's view of the session. If the page is stale, nobody pays.
    fetch("/api/workshops/session?slug=" + encodeURIComponent(slug))
      .then(function (r) { return r.status === 404 ? { notOpen: true } : r.ok ? r.json() : null; })
      .then(function (d) {
        // The page is published but its database row is not: registration has
        // not opened yet. The register endpoint refuses it too.
        if (d && d.notOpen) {
          closeForm("Registration isn't open yet", "The date and fee are set. Nothing can be booked or charged on this page until registration opens.", [{ href: "/workshops", text: "See all workshops", quiet: true }]);
          Array.prototype.forEach.call(document.querySelectorAll(".ws-jump .ws-btn, [data-ws-sticky] .ws-btn"), function (a) { a.textContent = "Registration not open yet"; });
          return;
        }
        if (!d || !d.ok) return;
        var s = d.session;
        if (Number(s.price_ghs) !== price || new Date(s.starts_at).toISOString() !== starts) {
          banner.textContent = "The details on this page have changed. Refresh to see the current date and fee before you register.";
          banner.hidden = false;
          submit.disabled = true;
          return;
        }
        // A valid offer link holds a place for this person, whatever the page would
        // otherwise say about places (until registration closes).
        if (offerToken && d.status !== "registration_closed" && d.status !== "started") return;
        // General places are taken but a reserved graduate place is free: the
        // form stays open for a confirmed Intermediate graduate certificate, and
        // anyone else joins the waitlist for an open place.
        if (d.status === "graduates_only") {
          graduatesOnly = true;
          banner.textContent = "The open places are taken. Intermediate graduates: confirm your certificate below to claim a reserved place. Everyone else: send the form to join the waitlist, free.";
          banner.hidden = false;
          return;
        }
        if (d.status === "full" && d.waitlist_open) { enterWaitlist(); return; }
        if (d.status === "registration_closed") closeForm("Registration closed", "Registration closes seven days before the session starts, so places are confirmed and invitations sent in good time. Other sessions are listed on the webinars page.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
        else if (d.status === "full") closeForm("This session is full", "No payment was taken. Other dates are listed on the webinars page.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
        else if (d.status !== "open") closeForm("Registration has closed", "This session has started or registration is no longer open.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
      })
      .catch(function () { /* the registration endpoint checks again */ });

    function enterWaitlist() {
      waitlistMode = true;
      banner.textContent = "Sold out — join the waitlist. It's free: if a place opens, we email you a link that holds it for you for up to 24 hours.";
      banner.hidden = false;
      label = "Join the waitlist";
      submit.textContent = label;
      if (quoteLine) quoteLine.textContent = "Joining the waitlist is free. You pay only if you take a place we offer you.";
      Array.prototype.forEach.call(document.querySelectorAll(".ws-jump .ws-btn, [data-ws-sticky] .ws-btn"), function (a) { a.textContent = "Sold out — join the waitlist"; });
    }

    // An offer link: fill in the form from the waitlist entry, or give the place back.
    if (offerToken && form) {
      if (pageParams.get("decline") === "1") {
        if (window.confirm("Give this place back so it can go to the next person on the waitlist?")) {
          post("/api/workshops/waitlist", { action: "decline", offer: offerToken }).then(function (r) {
            closeForm(r.ok ? "Place given back" : "This offer has already ended",
              r.ok ? "Thank you. The place goes to the next person on the waitlist. Nothing was charged." : "It expired, was already used, or was given back. Nothing was charged.",
              [{ href: "/workshops", text: "See other sessions", quiet: true }]);
          });
        }
      } else {
        fetch("/api/workshops/waitlist?offer=" + encodeURIComponent(offerToken)).then(function (r) { return r.json(); }).then(function (r) {
          if (!r.ok) { offerToken = ""; banner.textContent = "This waitlist offer has expired or was already used."; banner.hidden = false; return; }
          var o = r.offer;
          form.elements.full_name.value = o.full_name || "";
          form.elements.email.value = o.email || "";
          if (form.elements.attend_email && o.attend_email) form.elements.attend_email.value = o.attend_email;
          if (o.whatsapp) form.elements.whatsapp.value = o.whatsapp;
          if (refInput && o.referral_code) refInput.value = o.referral_code;
          banner.textContent = "A place is held for you until " + new Date(o.expires_at).toLocaleString("en-GB", { timeZone: "Africa/Accra", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }) +
            " (Accra time)." + (o.seat_kind === "graduate" ? " Confirm your graduate certificate below to claim the reserved place." : " Check your details, then register and pay.");
          banner.hidden = false;
          requote();
        }).catch(function () { /* the registration endpoint checks the offer again */ });
      }
    }

    function joinWaitlist() {
      busy(true, "Adding you to the waitlist");
      post("/api/workshops/waitlist", {
        action: "join", slug: slug,
        full_name: form.elements.full_name.value.trim(),
        email: form.elements.email.value.trim(),
        attend_email: form.elements.attend_email ? form.elements.attend_email.value.trim() : "",
        ref: refInput ? refInput.value.trim() : referralCode(),
        verification: benefit.tier === "graduate" ? benefit.token : "",
        whatsapp: form.elements.whatsapp.value.trim(),
        whatsapp_consent: form.elements.whatsapp_consent ? form.elements.whatsapp_consent.checked : false,
        ack_terms: form.elements.ack_terms.checked,
        company_website: form.elements.company_website.value
      }).then(function (r) {
        busy(false);
        if (r.ok) {
          return closeForm(r.outcome === "already" ? "You're already on the waitlist" : "You're on the waitlist",
            "You're number " + r.position + " in the queue. We've emailed you a confirmation. If a place opens, we email you a link that holds it for you for up to 24 hours. Nothing has been charged.",
            [{ href: "/workshops", text: "See other sessions", quiet: true }]);
        }
        if (r.code === "not_full") { location.reload(); return; }
        if (r.code === "registered") return showError("You already have a registration for this session. Check your email for its details.");
        if (r.code === "closed") return closeForm("Registration closed", "Registration and the waitlist close seven days before the session starts.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
        return showError("We couldn't add you to the waitlist just now. Try again, or " + contact() + ".");
      }).catch(function () { busy(false); showError("We couldn't add you to the waitlist just now. Try again in a moment."); });
    }

    function validateForm() {
      var bad = [];
      ["full_name", "email"].forEach(function (name) {
        var input = form.elements[name];
        var ok = name === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.value.trim()) : input.value.trim().length >= 2;
        input.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok) bad.push(input);
      });
      // Invitation-only sessions: the Google account that will be invited.
      if (form.elements.attend_email) {
        var attend = form.elements.attend_email;
        var attendOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(attend.value.trim());
        attend.setAttribute("aria-invalid", attendOk ? "false" : "true");
        if (!attendOk) bad.push(attend);
      }
      var phone = form.elements.whatsapp.value.trim();
      var phoneOk = !phone || phone.replace(/\D/g, "").length >= 7;
      form.elements.whatsapp.setAttribute("aria-invalid", phoneOk ? "false" : "true");
      if (!phoneOk) bad.push(form.elements.whatsapp);
      if (bad.length) { showError("Check the highlighted details: your name, a working email address" + (form.elements.attend_email ? ", the Google account you will join with" : "") + (phoneOk ? "" : ", and a full WhatsApp number") + "."); bad[0].focus(); return false; }
      if (!form.elements.ack_terms.checked) { showError(price > 0 ? "Tick the box to agree to the privacy notice and refund policy." : "Tick the box to agree to the privacy notice."); form.elements.ack_terms.focus(); return false; }
      if (!quoteOk && !waitlistMode) { showError(quoteLine ? quoteLine.textContent : "Check your referral code."); return false; }
      showError("");
      return true;
    }

    function busy(on, text) {
      submit.disabled = on;
      submit.textContent = on ? text : label;
    }

    function failPayment(retry) {
      setStep(trace, "register", "done", "Your registration is saved");
      if (retry) {
        setStep(trace, "pay", "fail", "Paystack didn't open. Nothing has been charged, and your seat is held for 30 minutes.");
        submit.textContent = "Try payment again";
        submit.disabled = false;
        label = "Try payment again";
        showError("Still stuck? " + contact().charAt(0).toUpperCase() + contact().slice(1) + " and quote your email address.");
      } else {
        setStep(trace, "pay", "wait", "Online payment isn't open for this session yet. We'll email you to arrange payment. You haven't been charged.");
        form.hidden = true;
      }
    }

    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (submit.disabled) return;
      if (!validateForm()) return;
      // Sold out, or only reserved graduate places left and no graduate certificate confirmed.
      if (waitlistMode || (graduatesOnly && !offerToken && benefit.tier !== "graduate")) { joinWaitlist(); return; }
      busy(true, "Saving your details");
      var consent = window.BPATracking ? window.BPATracking.attribution() : { attribution: {}, ad_consent: false };
      post("/api/workshops/register", {
        slug: slug,
        full_name: form.elements.full_name.value.trim(),
        email: form.elements.email.value.trim(),
        attend_email: form.elements.attend_email ? form.elements.attend_email.value.trim() : "",
        ref: refInput ? refInput.value.trim() : referralCode(),
        verification: benefit.token,
        expected_price: quoted,
        whatsapp: form.elements.whatsapp.value.trim(),
        whatsapp_consent: form.elements.whatsapp_consent ? form.elements.whatsapp_consent.checked : false,
        ack_terms: form.elements.ack_terms.checked,
        displayed_price: price,
        displayed_starts_at: starts,
        attribution: consent.attribution,
        ad_consent: consent.ad_consent,
        company_website: form.elements.company_website.value,
        testOptIn: testOptIn,
        offer: offerToken || undefined
      }).then(function (r) {
        if (r.token) saveAccess(slug, { token: r.token, reference: r.reference || null });
        if (!r.ok) {
          busy(false);
          var codes = {
            full: ["This session is full", "No payment was taken."],
            closed: ["Registration has closed", "This session has started or is no longer taking registrations."],
            stale_page: ["The details have changed", "Refresh this page to see the current date and fee, then register."],
            not_found: ["Registration isn't open", "This session isn't taking registrations. Nothing has been charged."]
          };
          if (r.code === "offer_not_valid") return showError("This waitlist offer has expired, was already used, or is for a different email address. Nothing has been charged.");
          if (r.code === "attend_email_required") return showError("Add the Google account you will join with. Only that account can get into the meeting.");
          if (r.code === "price_changed") { requote(); return showError("Your price has changed to " + ghsText(r.price_ghs) + ". Check it, then register again. Nothing has been charged."); }
          if (r.code === "referral_invalid") { requote(); return showError("That referral code isn't valid. Check it, or clear it to register at " + ghsText(price) + ". Nothing has been charged."); }
          if (r.code === "benefit_not_valid" || r.code === "benefit_already_used") {
            benefit = { token: "", tier: "" }; requote();
            return showError(r.code === "benefit_already_used"
              ? "That certificate has already been used for this workshop. Nothing has been charged."
              : "Your certificate confirmation has expired or is no longer valid. Confirm it again, or register at the standard fee. Nothing has been charged.");
          }
          if (codes[r.code]) return closeForm(codes[r.code][0], codes[r.code][1], [{ href: "/workshops", text: "See other sessions", quiet: true }]);
          if (r._status === 400) return showError("Check your details and try again.");
          return showError("We couldn't save your registration just now. Nothing has been charged. Try again, or " + contact() + ".");
        }
        if (r.state === "confirmed" || r.state === "payment_review") {
          if (r.events && r.events.complete_registration) track("CompleteRegistration", r.events.complete_registration, { content_ids: [slug], content_name: title });
          setStep(trace, "register", "done", "Registered");
          location.assign("/workshops/registered/?session=" + encodeURIComponent(slug));
          return;
        }
        if (r.state === "checkout" && r.url) {
          if (r.events && r.events.initiate_checkout) track("InitiateCheckout", r.events.initiate_checkout, { content_ids: [slug], content_name: title, currency: "GHS", value: price });
          setStep(trace, "register", "done", "Your details are saved");
          setStep(trace, "pay", "wait", r.test ? "TEST MODE: opening a Paystack test checkout. No real money moves." : "Opening Paystack. If nothing opens in a few seconds, press the button again.");
          busy(true, "Opening Paystack");
          setTimeout(function () { location.assign(r.url); }, 150);
          setTimeout(function () { busy(false); }, 8000);
          return;
        }
        if (r.state === "needs_attention") {
          busy(false);
          return closeForm("We need to check an earlier payment", "There's a payment on this registration that we need to review. Please don't pay again. We'll email you, or you can " + contact() + ".");
        }
        if (r.state === "pending_payment") { busy(false); return failPayment(r.retry === true); }
        busy(false);
        showError("We couldn't complete that. Nothing has been charged. Please " + contact() + " and we'll help.");
      }).catch(function () {
        busy(false);
        showError("No connection. Nothing has been charged. Check your data or Wi-Fi and try again.");
      });
    });
  }

  /* ======================================================================
     Confirmation page
     ====================================================================== */
  if (kind === "registered") {
    var params = new URLSearchParams(location.search);
    var session = params.get("session") || "";
    var reference = params.get("reference") || params.get("trxref") || null;
    var access = /^[a-z0-9-]{3,80}$/.test(session) ? loadAccess(session) : null;
    var titleEl = $("[data-done-title]");
    var ledeEl = $("[data-done-lede]");
    var bodyEl = $("[data-done-body]");
    if (access && !reference && access.reference) reference = access.reference;

    function noAccess() {
      titleEl.textContent = "Check your email";
      ledeEl.textContent = "We can't show this registration on this device. Your confirmation email has your joining details once your place is confirmed. If it hasn't arrived within ten minutes, check spam, then " + contact() + ".";
    }
    if (!access || !access.token) { noAccess(); return; }

    var tries = 0;
    function render(s) {
      bodyEl.textContent = "";
      var paidSession = Number(s.amount_ghs) > 0;
      var w = s.session ? whenText(s.session) : null;
      var sheet = el("div", { class: "ws-sheet" });
      var list = el("ol", { class: "ws-trace" });
      var steps = [["register", "Registered"]];
      if (paidSession) steps.push(["pay", "Pay " + ghs(s.amount_ghs)]);
      steps.push(["email", "Confirmation email"], ["join", "Join live"]);
      steps.forEach(function (st, i) {
        var li = el("li", { class: "ws-step is-idle", "data-step": st[0] });
        li.appendChild(el("span", { class: "ws-step__dot", "aria-hidden": "true" }, String(i + 1)));
        var b = el("div", { class: "ws-step__body" });
        b.appendChild(el("p", { class: "ws-step__name" }, st[1]));
        b.appendChild(el("p", { class: "ws-step__detail", "data-step-detail": "" }, ""));
        li.appendChild(b);
        list.appendChild(li);
      });
      sheet.appendChild(list);
      if (s.test) bodyEl.appendChild(el("p", { class: "ws-banner", role: "status" }, "TEST MODE. This used a Paystack test checkout; no real money moved."));
      bodyEl.appendChild(sheet);
      var joinText = w ? w.long + ", " + w.accra + " in Accra, " + w.lagos + " in Lagos" : "";
      setStep(list, "register", "done", null);

      if (s.state === "confirmed") {
        titleEl.textContent = "You're registered";
        ledeEl.textContent = (s.session ? s.session.title + ". " : "") + (paidSession ? "Paystack confirmed your payment of " + ghs(s.amount_ghs) + "." : "");
        if (paidSession) setStep(list, "pay", "done", "Confirmed by Paystack");
        // Only claim the email went out when the server says it did.
        var invite = s.session && s.session.admission === "invite";
        if (invite) {
          setStep(list, "email", s.email_sent ? "done" : "active", (s.email_sent ? "Confirmation sent. " : "We're sending your confirmation. ") +
            "We add the Google account you gave us to the workshop's Google Calendar invitation, and Google emails it the Meet link.");
          setStep(list, "join", "active", joinText + ". Open the Meet link from the invitation, signed in to that Google account.");
        } else {
          if (s.email_sent) setStep(list, "email", "done", "Sent with your joining link. Check spam if it isn't there in ten minutes.");
          else setStep(list, "email", "active", "We're sending your joining link to the email you registered with. Check spam if it isn't there in ten minutes.");
          setStep(list, "join", "active", joinText + ". Join five minutes early.");
        }
        var actions = el("div", { class: "ws-actions" });
        actions.appendChild(el("a", { class: "ws-btn ws-btn--quiet", href: "/workshops" }, "Other sessions"));
        bodyEl.appendChild(actions);
        if (s.events && s.events.purchase) track("Purchase", s.events.purchase.id, { content_ids: [session], currency: "GHS", value: s.events.purchase.value });
        if (s.events && s.events.complete_registration) track("CompleteRegistration", s.events.complete_registration.id, { content_ids: [session] });
        return;
      }
      if (s.state === "payment_review") {
        titleEl.textContent = "We have your payment";
        ledeEl.textContent = "You don't need to pay again.";
        setStep(list, "pay", "done", "Confirmed by Paystack");
        setStep(list, "email", "wait", "The session filled or changed while you were paying. We'll email you to confirm your place or arrange a refund.");
        // No Purchase here: money held for review is not a confirmed enrollment.
        return;
      }
      if (s.state === "pending_payment") {
        if (tries < 20) {
          titleEl.textContent = "Confirming your payment";
          ledeEl.textContent = "We're checking with Paystack. This usually takes a few seconds. Please don't pay again.";
          setStep(list, "pay", "wait", "Waiting for Paystack");
          tries += 1;
          setTimeout(check, tries < 5 ? 3000 : 6000);
        } else {
          titleEl.textContent = "Payment not confirmed yet";
          ledeEl.textContent = "If you paid, you'll get a confirmation email as soon as Paystack confirms it. Please don't pay again. If you didn't finish paying, you can pay now.";
          setStep(list, "pay", "wait", "No confirmation from Paystack yet");
          bodyEl.appendChild(el("a", { class: "ws-btn ws-btn--quiet", href: "/workshops/" + session + "#register" }, "Return to the session page"));
        }
        return;
      }
      if (s.state === "checkout_failed") {
        titleEl.textContent = "Payment wasn't completed";
        ledeEl.textContent = "Nothing was charged. Your details are saved, so you can pay without filling the form again.";
        setStep(list, "pay", "fail", "Not completed");
        bodyEl.appendChild(el("a", { class: "ws-btn", href: "/workshops/" + session + "#register" }, "Pay " + ghs(s.amount_ghs)));
        return;
      }
      if (s.state === "needs_attention") {
        titleEl.textContent = "We need to check your payment";
        ledeEl.textContent = "Something about the payment didn't match what we expected. Please don't pay again. We'll email you, or you can " + contact() + ".";
        setStep(list, "pay", "wait", "Being checked by our team");
        return;
      }
      titleEl.textContent = s.state === "refunded" ? "This registration was refunded" : "This registration isn't active";
      ledeEl.textContent = "If that's unexpected, please " + contact() + ".";
    }

    function check() {
      post("/api/workshops/status", { token: access.token, reference: reference })
        .then(function (s) { if (!s.ok || s.state === "unknown") return noAccess(); render(s); })
        .catch(function () {
          titleEl.textContent = "We couldn't check right now";
          ledeEl.textContent = "Your registration is not affected. Your confirmation email has your joining details once your place is confirmed. Refresh this page to try again.";
        });
    }
    check();
  }
})();

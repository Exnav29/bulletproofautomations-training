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
        if (d.status === "full") closeForm("This session is full", "No payment was taken. Other dates are listed on the webinars page.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
        else if (d.status !== "open") closeForm("Registration has closed", "This session has started or registration is no longer open.", [{ href: "/workshops", text: "See other sessions", quiet: true }]);
      })
      .catch(function () { /* the registration endpoint checks again */ });

    function validateForm() {
      var bad = [];
      ["full_name", "email"].forEach(function (name) {
        var input = form.elements[name];
        var ok = name === "email" ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.value.trim()) : input.value.trim().length >= 2;
        input.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok) bad.push(input);
      });
      var phone = form.elements.whatsapp.value.trim();
      var phoneOk = !phone || phone.replace(/\D/g, "").length >= 7;
      form.elements.whatsapp.setAttribute("aria-invalid", phoneOk ? "false" : "true");
      if (!phoneOk) bad.push(form.elements.whatsapp);
      if (bad.length) { showError("Check the highlighted details: your name, a working email address" + (phoneOk ? "" : ", and a full WhatsApp number") + "."); bad[0].focus(); return false; }
      if (!form.elements.ack_terms.checked) { showError(price > 0 ? "Tick the box to agree to the privacy notice and refund policy." : "Tick the box to agree to the privacy notice."); form.elements.ack_terms.focus(); return false; }
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
      busy(true, "Saving your details");
      var consent = window.BPATracking ? window.BPATracking.attribution() : { attribution: {}, ad_consent: false };
      post("/api/workshops/register", {
        slug: slug,
        full_name: form.elements.full_name.value.trim(),
        email: form.elements.email.value.trim(),
        whatsapp: form.elements.whatsapp.value.trim(),
        whatsapp_consent: form.elements.whatsapp_consent ? form.elements.whatsapp_consent.checked : false,
        ack_terms: form.elements.ack_terms.checked,
        displayed_price: price,
        displayed_starts_at: starts,
        attribution: consent.attribution,
        ad_consent: consent.ad_consent,
        company_website: form.elements.company_website.value,
        testOptIn: testOptIn
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
        if (s.email_sent) setStep(list, "email", "done", "Sent with your joining link. Check spam if it isn't there in ten minutes.");
        else setStep(list, "email", "active", "We're sending your joining link to the email you registered with. Check spam if it isn't there in ten minutes.");
        setStep(list, "join", "active", joinText + ". Join five minutes early.");
        var actions = el("div", { class: "ws-actions" });
        actions.appendChild(el("a", { class: "ws-btn", href: "/api/workshops/calendar?t=" + encodeURIComponent(access.token) }, "Add to calendar"));
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

/* The workshop desk: /admin/workshops/ (release 6).
 *
 * Create, edit, publish, close, cancel and delete workshops; see who is booked
 * and what needs a person; manage referral codes for anyone. Reads through the
 * signed-in admin's Supabase session (RLS: the admin's email only; read-only).
 * Every change goes through /api/admin/workshops, which re-checks the admin and
 * calls an audited database function that enforces the rules. Nothing here
 * moves money: refunds are issued in Paystack, commissions paid by hand.
 *
 * Uses the shared session(), authFetch(), refresh() and esc() from admin.js. */
(function () {
  "use strict";
  if (document.documentElement.getAttribute("data-admin-view") !== "workshops") return;

  var STATUS = { pending_payment: "Awaiting payment", confirmed: "Confirmed", payment_received_review: "Payment held for review",
    refund_pending: "Refund requested", cancelled: "Cancelled", refunded: "Refunded" };
  var PAYMENT = { not_required: "Free", pending: "Not paid", paid: "Paid", needs_review: "Needs review",
    partially_refunded: "Partly refunded", refunded: "Refunded" };
  var REASON = { capacity: "Paid after the 30-minute hold ran out, and the workshop was full",
    session_unavailable: "Paid for a workshop that was cancelled, closed or had started",
    registration_cancelled: "Paid after the registration was cancelled", duplicate_payment: "Paid more than once; their place is kept",
    payment_mismatch: "The amount, currency or mode did not match the checkout", partial_refund: "Partly refunded" };
  var ATTENDANCE = { unknown: "Not recorded", attended: "Attended", no_show: "No-show" };
  var TIER = { standard: "Standard price", foundations: "Foundations certificate price", graduate: "Intermediate graduate, free" };
  var HOLDING = ["confirmed", "payment_received_review", "refund_pending"];

  var ws = { sessions: {}, list: [], rows: [], attempts: {}, referrers: [], payouts: {}, waitlist: [], failedMail: {},
    series: [], settings: { referral_discount_ghs: 50, referral_commission_ghs: 50 } };
  var $ = function (id) { return document.getElementById(id); };
  var origin = location.origin;

  /* ---------- small helpers ---------- */
  function fill(select, labels) {
    Object.keys(labels).forEach(function (k) { var o = document.createElement("option"); o.value = k; o.textContent = labels[k]; select.appendChild(o); });
  }
  fill($("ws-status"), STATUS); fill($("ws-payment"), PAYMENT); fill($("ws-attendance"), ATTENDANCE);
  function cedis(n) { return Number(n || 0).toLocaleString("en-GB", { maximumFractionDigits: 2 }); }
  function ghsMinor(minor) { return cedis(Number(minor || 0) / 100); }
  // Ghana time is GMT, so UTC is the clock people see.
  function when(v, opts) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", Object.assign({ timeZone: "UTC" }, opts || { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  }
  function daysUntil(t) { return Math.ceil((t - Date.now()) / 864e5); }
  function show(id, text) { var el = $(id); el.textContent = text || ""; el.hidden = !text; if (text && id === "ws-message") setTimeout(function () { if (el.textContent === text) el.hidden = true; }, 6000); }
  function said(text) { show("ws-error", ""); show("ws-message", text); }
  function failed(err) { show("ws-message", ""); show("ws-error", err && err.message ? err.message : String(err)); }
  function rowsOf(id) { return ws.rows.filter(function (r) { return r.session_id === id; }); }
  function sessionOf(r) { return ws.sessions[r.session_id] || {}; }

  function apiPost(body) {
    var current = session();
    if (!current) return Promise.reject(new Error("You are signed out. Sign in again."));
    var send = function (token) {
      return fetch("/api/admin/workshops", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify(body) });
    };
    var go = current.expires_at && Date.now() > current.expires_at ? refresh().then(function (fresh) { return send(fresh.access_token); }) : send(current.access_token);
    return go.then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
      // The answer travels with the error, so a caller can offer Retry (release 7).
      // No sentence from the site means the answer never came from it: a timeout
      // or an error page from Cloudflare (AI drafting produced HTTP 524 here).
      var fallback = r.ok ? "The change was refused." : r.status === 524 || r.status === 504 || r.status === 502
        ? "The server took too long to answer (HTTP " + r.status + "). Nothing was changed. Try again."
        : "The site could not complete that (HTTP " + r.status + "). Nothing was changed. Try again.";
      if (!r.ok || !j.ok) { var err = new Error(j.error || fallback); err.data = j; throw err; }
      return j;
    }); });
  }
  function getJson(path) {
    return authFetch(path).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error("Workshop records are not available to this admin account.");
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || "Could not load workshop records."); });
      return r.json();
    });
  }

  /* ---------- load ---------- */
  function load() {
    show("ws-error", "");
    return Promise.all([
      getJson("/rest/v1/workshop_sessions?select=*"),
      getJson("/rest/v1/workshop_registrations?select=*&order=created_at.desc"),
      getJson("/rest/v1/workshop_payment_attempts?select=registration_id,reference,status,amount_minor,received_minor,refunded_minor,mode,verified_via,created_at&order=created_at.asc"),
      getJson("/rest/v1/workshop_referrers?select=*&order=created_at.asc").catch(function () { return []; }),
      getJson("/rest/v1/workshop_referral_payouts?select=*").catch(function () { return []; }),
      getJson("/rest/v1/workshop_waitlist?select=*&order=created_at.asc,id.asc").catch(function () { return []; }),
      getJson("/rest/v1/workshop_notifications?select=registration_id,kind,error,status&status=in.(failed,sending)&attempts=gte.5").catch(function () { return []; }),
      getJson("/rest/v1/workshop_series?select=*&order=slug.asc").catch(function () { return []; }),
      getJson("/rest/v1/workshop_settings?select=*").catch(function () { return []; })
    ]).then(function (out) {
      ws.sessions = {}; out[0].forEach(function (s) { ws.sessions[s.id] = s; });
      ws.list = out[0];
      ws.rows = out[1];
      ws.attempts = {}; out[2].forEach(function (a) { (ws.attempts[a.registration_id] = ws.attempts[a.registration_id] || []).push(a); });
      ws.referrers = out[3];
      ws.payouts = {}; out[4].forEach(function (p) { ws.payouts[p.registration_id] = p; });
      ws.waitlist = out[5] || [];
      ws.failedMail = {}; (out[6] || []).forEach(function (n) { (ws.failedMail[n.registration_id] = ws.failedMail[n.registration_id] || []).push(n); });
      ws.series = out[7] || [];
      if (out[8] && out[8][0]) ws.settings = out[8][0];
      var sel = $("ws-session"), keep = sel.value;
      sel.length = 1;
      ordered(ws.list).forEach(function (s) { var o = document.createElement("option"); o.value = s.id; o.textContent = (s.is_test ? "TEST: " : "") + s.title; sel.appendChild(o); });
      sel.value = keep;
      render();
    }).catch(failed);
  }

  /* ---------- the rules shared with the database ---------- */
  function isTest(r) { var s = sessionOf(r); return s.is_test === true || (ws.attempts[r.id] || []).some(function (a) { return a.mode === "test"; }); }
  function isInvite(r) { return sessionOf(r).admission === "invite"; }
  function toAdd(r) { return isInvite(r) && r.status === "confirmed" && !!r.attend_email && r.attend_email !== r.invited_email; }
  function toRemove(r) { return isInvite(r) && !!r.invited_email && (r.status !== "confirmed" || r.attend_email !== r.invited_email); }
  function noAccount(r) { return isInvite(r) && r.status === "confirmed" && !r.attend_email; }
  function calendarException(r) { return !!r.calendar_sync_error && (toAdd(r) || toRemove(r) || Number(r.calendar_sync_failures) >= 5); }
  function needsResolution(r) { return r.status === "payment_received_review" || r.status === "refund_pending" || r.payment_status === "needs_review"; }
  function verifiedMinor(r) {
    var primary = (ws.attempts[r.id] || []).filter(function (a) { return a.status === "succeeded"; })[0];
    return primary ? Math.max(0, Number(primary.received_minor || 0) - Number(primary.refunded_minor || 0)) : 0;
  }
  function isConfirmedPaid(r) { return r.status === "confirmed" && verifiedMinor(r) > 0; }
  function isHeldForReview(r) { return r.status === "payment_received_review" && verifiedMinor(r) > 0; }
  // Mirrors workshop_commission_payable.
  function payable(r) {
    var atts = ws.attempts[r.id] || [];
    if (isTest(r)) return false;
    return Number(r.commission_ghs) > 0 && !!r.referrer_id && r.price_tier !== "graduate" && !r.commission_voided_at &&
      r.status === "confirmed" && r.payment_status === "paid" && Number(r.amount_paid_minor) === Math.round(Number(r.amount_ghs) * 100) &&
      atts.some(function (a) { return a.status === "succeeded"; }) && !atts.some(function (a) { return a.status === "duplicate_payment" || a.status === "mismatch"; });
  }
  function commissionState(r) { var ok = payable(r); if (ws.payouts[r.id]) return ok ? "paid" : "review"; return ok ? "due" : "none"; }
  function startsAt(s) { return s.starts_at ? Date.parse(s.starts_at) : null; }
  function hasStarted(s) { var t = startsAt(s); return t !== null && t <= Date.now(); }
  function ended(s) { return s.status === "cancelled" || s.status === "completed" || (s.status !== "draft" && hasStarted(s) && Date.now() - startsAt(s) > 86400000); }
  function ordered(list) {
    return list.slice().sort(function (a, b) {
      var ta = startsAt(a), tb = startsAt(b);
      if (ta === null && tb === null) return (a.series_number || 99) - (b.series_number || 99) || String(a.title).localeCompare(b.title);
      if (ta === null) return 1; if (tb === null) return -1;
      return ta - tb;
    });
  }
  function state(s) {
    if (s.status === "draft") return s.announce ? ["Coming soon (draft)", "gold"] : ["Draft", ""];
    if (s.status === "cancelled") return ["Cancelled", "bad"];
    if (s.status === "completed") return ["Completed", ""];
    if (hasStarted(s)) return ["Taken place", "warn"];
    if (s.status === "closed") return ["Registration closed", "warn"];
    if (startsAt(s) - 168 * 3600000 <= Date.now()) return ["Registration closed (7-day cutoff)", "warn"];
    return ["Open for registration", "open"];
  }
  function seats(s) {
    var mine = rowsOf(s.id);
    var holding = mine.filter(function (r) { return HOLDING.indexOf(r.status) !== -1; });
    var grad = holding.filter(function (r) { return r.price_tier === "graduate"; }).length;
    var live = ws.waitlist.filter(function (w) { return w.session_id === s.id && w.status === "offered" && Date.parse(w.offer_expires_at) > Date.now(); });
    var paying = mine.filter(function (r) { return r.status === "pending_payment" && r.price_tier !== "graduate"; }).length;
    return { general: holding.length - grad, grad: grad, heldGeneral: paying + live.filter(function (w) { return w.seat_kind === "general"; }).length,
      heldGrad: live.filter(function (w) { return w.seat_kind !== "general"; }).length, offers: live };
  }

  /* ---------- render ---------- */
  /* ---------- release 7: Calendar state and series defaults ---------- */
  function calendarTrouble(s) { return s.admission === "invite" && (s.calendar_status === "failed" || s.calendar_status === "needs_update"); }
  function calendarShort(s) {
    if (s.calendar_status === "failed") return "Not created yet";
    if (s.calendar_status === "needs_update") return "Still on the old time";
    if (!s.calendar_event_id) return "Made when you schedule";
    return s.calendar_managed ? "Event and Meet link ready" : "Your own event";
  }
  function sentence(x) { x = String(x || "").trim(); return /[.!?]$/.test(x) ? x : x + "."; }
  function seriesOf(slug) { return ws.series.filter(function (x) { return x.slug === slug; })[0] || null; }
  function defaultsOf(slug) { var x = seriesOf(slug); return (x && x.defaults) || {}; }
  function hours(min) { var h = Number(min) / 60; return (h === Math.floor(h) ? h : h.toFixed(1)) + (h === 1 ? " hour" : " hours"); }
  function cutoffText(d, t) {
    return d ? "Registration closes automatically 7 days before: " + when(Date.parse(d + "T" + (t || "00:00") + ":00Z") - 168 * 3600000, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + " GMT."
      : "Registration closes automatically 7 days before the start.";
  }
  function contentGaps(c) {
    c = c || {};
    var miss = [];
    if (!c.summary) miss.push("short description");
    if (!(c.outcomes && c.outcomes.length)) miss.push("outcomes");
    if (!(c.run_of_show && c.run_of_show.length)) miss.push("running order");
    if (!(c.faq && c.faq.length)) miss.push("questions and answers");
    return miss;
  }

  function render() {
    var real = ws.list.filter(function (s) { return !s.is_test; });
    var open = real.filter(function (s) { return s.status === "published" && !hasStarted(s); }).length;
    var drafts = real.filter(function (s) { return s.status === "draft"; }).length;
    var attention = needs();
    var line = open + (open === 1 ? " workshop open" : " workshops open") + " for registration, " + drafts + " in draft. " +
      (attention.length ? attention.length + (attention.length === 1 ? " thing needs you." : " things need you.") : "Nothing needs you.");
    // One line, under the page title; the workspace's own copy stays for screen readers only.
    $("ws-summary").textContent = line;
    var sum = $("ops-page-summary"); if (sum) { sum.textContent = line; $("ws-summary").classList.add("vh"); }
    renderAttention(attention);
    renderTickets();
    renderRegs();
    renderReferrals();
    campaigns(filtered());
  }

  function needs() {
    var items = [];
    var act = function (a, label, id, primary) { return { a: a, label: label, id: id, primary: !!primary }; };
    ws.rows.forEach(function (r) {
      var s = sessionOf(r), who = r.full_name + (isTest(r) ? " (test)" : "");
      if (needsResolution(r)) {
        var acts = [];
        if (r.status === "payment_received_review") acts.push(act("admit", "Admit", r.id, true));
        if ((r.status === "payment_received_review" || r.status === "confirmed") && ["paid", "needs_review", "partially_refunded"].indexOf(r.payment_status) !== -1) acts.push(act("request_refund", "Refund now", r.id));
        if (r.review_reason === "duplicate_payment") acts.push(act("resolve_duplicate", "Note duplicate refund", r.id));
        if (r.status === "refund_pending") acts.push(act("send_refund", "Send refund to Paystack", r.id));
        acts.push(act("open_person", "Details", r.id));
        items.push({ bad: true, who: who + ", " + s.title, why: (REASON[r.review_reason] || STATUS[r.status] || r.status) +
          (r.status === "refund_pending" ? ". Waiting for Paystack to confirm the refund; the place frees itself then. If it was never sent, use Send refund to Paystack." : ". GHS " + ghsMinor(r.amount_paid_minor) + " held."), acts: acts });
      } else if (s.status === "cancelled" && r.status === "confirmed") {
        items.push({ bad: true, who: who + " has a place on a cancelled workshop", why: s.title + ". Offer a refund or a place on another session.",
          acts: [act("request_refund", "Refund now", r.id), act("open_person", "Details", r.id)] });
      }
      if (calendarException(r)) items.push({ who: "Calendar invitation failed: " + who, why: r.calendar_sync_error + (Number(r.calendar_sync_failures) >= 5 ? " Retries stopped." : " Retrying automatically."),
        acts: [act("retry_calendar", "Retry now", r.id, true)] });
      else if (noAccount(r) && s.status !== "cancelled") items.push({ who: who + " has paid but gave no Google account", why: s.title + ". They can't be invited until you set one, on their request.",
        acts: [act("set_account", "Set Google account", r.id, true)] });
      var undelivered = ws.failedMail[r.id];
      if (undelivered) items.push({ who: "Email not delivered to " + who, why: undelivered.map(function (n) { return n.kind.replace(/_/g, " ") + " (" + (n.error || (n.status === "sending" ? "result never recorded" : "failed")) + ")"; }).join(", "),
        acts: [act("retry_email", "Retry email", r.id, true)] });
    });
    ws.waitlist.filter(function (w) { return w.email_error; }).forEach(function (w) {
      items.push({ who: "Waitlist email failed: " + w.full_name, why: w.email_error + " (" + w.email_failures + " tries)", acts: [act("waitlist_retry_email", "Retry email", w.id, true)] });
    });
    // Release 7: a workshop's own Calendar event that could not be created or moved.
    ws.list.filter(function (s) { return calendarTrouble(s) && !ended(s); }).forEach(function (s) {
      items.push({ bad: s.status !== "draft", who: (s.calendar_status === "failed" ? "Calendar event not created: " : "Calendar event not moved to the new date: ") + s.title + (s.is_test ? " (test)" : ""),
        why: sentence(s.calendar_error || "Google Calendar did not respond") + (s.status === "draft" ? " Registration stays closed until it works." : " People already invited still have the old time."),
        acts: [act("calendar_retry", "Retry", s.id, true), act("session_edit", "Open", s.id)] });
    });
    ws.list.filter(function (s) { return !s.is_test && (s.status === "published" || s.status === "closed") && hasStarted(s) && Date.now() - startsAt(s) > 3 * 3600000; }).forEach(function (s) {
      items.push({ who: s.title + " has taken place", why: "Record attendance on the Registrations tab, then mark it completed so it leaves the current list.", acts: [act("session_complete", "Mark completed", s.id, true)] });
    });
    ws.referrers.forEach(function (x) {
      var owed = owedTo(x);
      if (owed.amount > 0) items.push({ who: "Commission due: GHS " + cedis(owed.amount) + " to " + referrerName(x), why: "Code " + x.code + ", " + owed.count + " paid place" + (owed.count === 1 ? "" : "s") +
        (x.payout_method ? ". Pay by " + x.payout_method : "") + ", then record it.", acts: [act("referrer_payouts", "Record payment", x.id, true)] });
    });
    return items;
  }
  function renderAttention(items) {
    $("ws-attn-count").textContent = items.length;
    $("ws-attn-count").className = "wsd-count" + (items.length ? "" : " wsd-count--zero");
    $("ws-attention").innerHTML = items.length ? "<ul>" + items.map(function (it) {
      return '<li><span class="wsd-dot' + (it.bad ? " wsd-dot--bad" : "") + '" aria-hidden="true"></span><div class="wsd-attn__what"><strong>' + esc(it.who) + "</strong><span>" + esc(it.why) + '</span></div><div class="wsd-acts">' +
        it.acts.map(function (a) { return '<button class="wsd-btn wsd-btn--sm' + (a.primary ? " wsd-btn--primary" : "") + '" type="button" data-wsd="' + a.a + '" data-id="' + esc(a.id) + '">' + esc(a.label) + "</button>"; }).join("") + "</div></li>";
    }).join("") + "</ul>" : '<p class="wsd-clear">Nothing needs you. Payments, invitations and the waitlist are running on their own.</p>';
  }

  /* ---------- workshops ---------- */
  function renderTickets() {
    var real = ordered(ws.list.filter(function (s) { return !s.is_test; }));
    var current = real.filter(function (s) { return !ended(s); }), past = real.filter(ended);
    var tests = ordered(ws.list.filter(function (s) { return s.is_test; }));
    $("ws-tickets").innerHTML = (current.length ? current.map(ticket).join("") : '<p class="wsd-clear">No workshops yet. Use “New workshop” to add the first one.</p>') +
      (past.length ? '<details class="wsd-fold"><summary>Past and cancelled (' + past.length + ")</summary><div class=\"wsd-tickets\">" + past.map(ticket).join("") + "</div></details>" : "");
    $("ws-test-tickets").innerHTML = tests.map(ticket).join("");
    $("ws-test-summary").textContent = "Test sessions (" + tests.length + ")";
    $("ws-test-fold").hidden = !tests.length;
    $("ws-n-ws").textContent = current.length;
    $("ws-series").innerHTML = ws.series.map(function (x) {
      var n = ws.list.filter(function (s) { return s.series_slug === x.slug && !s.is_test; }).length;
      var d = x.defaults || {};
      var std = Object.keys(d).length ? " Standard: " + (Number(d.price_ghs) ? "GHS " + cedis(d.price_ghs) : "free") + ", " + (d.capacity || 0) + " places" +
        (Number(d.reserved_graduate_seats) ? " + " + d.reserved_graduate_seats + " for graduates" : "") + ", " + hours(d.duration_minutes || 180) + (d.start_time ? " from " + d.start_time + " GMT" : "") + "." : "";
      return "<span>Series: <strong>" + esc(x.name) + "</strong>, " + n + " workshop" + (n === 1 ? "" : "s") + "." + esc(std) + "</span>" +
        '<span class="wsd-acts"><button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="series_defaults" data-id="' + esc(x.slug) + '">Series settings</button>' +
        '<button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="series_edit" data-id="' + esc(x.slug) + '">Edit the series page text</button></span>';
    }).join("");
  }
  function ticket(s) {
    var st = state(s), t = startsAt(s), st8 = seats(s), mine = rowsOf(s.id);
    var revenue = mine.filter(function (r) { return !isTest(r) && isConfirmedPaid(r); }).reduce(function (n, r) { return n + verifiedMinor(r); }, 0);
    var stub = t !== null
      ? '<div><div class="wsd-stub__day">' + esc(when(t, { day: "numeric" })) + '</div><div class="wsd-stub__month">' + esc(when(t, { month: "short", year: "numeric" })) + "</div></div>" +
        '<div class="wsd-stub__time">' + esc(when(t, { weekday: "short" })) + ", " + esc(when(t, { hour: "2-digit", minute: "2-digit" })) + " GMT<br>" + esc(Number(s.duration_minutes) / 60) + " hours</div>"
      : '<div class="wsd-stub__none">No date yet</div><div class="wsd-stub__time">' + (s.series_number ? "Workshop " + (s.series_number < 10 ? "0" : "") + s.series_number : "Set a date to open it") + "</div>";
    var cells = [], i, n = 0, cap = Number(s.capacity || 0), grad = Number(s.reserved_graduate_seats || 0);
    for (i = 0; i < cap; i++) cells.push('<span class="wsd-seat' + (i < st8.general ? " wsd-seat--taken" : i < st8.general + st8.heldGeneral ? " wsd-seat--held" : "") + '" style="--i:' + (n++) + '"></span>');
    for (i = 0; i < grad; i++) cells.push('<span class="wsd-seat wsd-seat--grad' + (i < st8.grad ? " wsd-seat--taken" : "") + '" style="--i:' + (n++) + '"></span>');
    var undated = s.status === "draft" && t === null;
    var seatMap = cap && !undated ? '<div><div class="wsd-seats" role="img" aria-label="' + st8.general + " of " + cap + " open places taken" + (st8.heldGeneral ? ", " + st8.heldGeneral + " being paid for or offered" : "") +
      (grad ? ", " + st8.grad + " of " + grad + " graduate places taken" : "") + '">' + cells.join("") + "</div>" +
      '<div class="wsd-legend"><span><i style="background:var(--wsd-teal)"></i>Taken</span><span><i style="background:repeating-linear-gradient(135deg,var(--wsd-teal) 0 2px,transparent 2px 4px)"></i>Paying now or offered</span>' +
      (grad ? '<span><i style="box-shadow:inset 0 0 0 2px var(--wsd-gold)"></i>Kept for graduates</span>' : "") + '<span><i style="background:var(--wsd-seat)"></i>Free</span></div></div>' : "";
    var waiting = ws.waitlist.filter(function (w) { return w.session_id === s.id && w.status === "waiting"; });
    var closesIn = t !== null ? daysUntil(t - 168 * 3600000) : null;
    var onEvent = mine.filter(function (r) { return r.invited_email && !toRemove(r); }).length;
    var facts = undated ? '<p class="wsd-hint">' + (s.announce ? "Listed on the website as coming soon. " : "Not on the website yet. ") +
        (cap ? cap + (grad ? " + " + grad + " graduate" : "") + " places, " : "") + (Number(s.price_ghs) ? "GHS " + cedis(s.price_ghs) : "free") + ". Schedule it to open registration.</p>"
      : '<dl class="wsd-facts">' +
      (cap ? "<div><dt>Open places</dt><dd>" + st8.general + " of " + cap + "</dd></div>" : "") +
      (grad ? "<div><dt>Graduate places</dt><dd>" + st8.grad + " of " + grad + "</dd></div>" : "") +
      "<div><dt>Price</dt><dd>" + (Number(s.price_ghs) ? "GHS " + cedis(s.price_ghs) : "Free") + "</dd></div>" +
      (s.status !== "draft" ? "<div><dt>Taken so far</dt><dd>GHS " + ghsMinor(revenue) + "</dd></div>" : "") +
      (s.status === "published" && closesIn !== null && closesIn > 0 ? '<div><dt>Registration closes</dt><dd class="is-soon">in ' + closesIn + " day" + (closesIn === 1 ? "" : "s") + "</dd></div>" : "") +
      (waiting.length ? "<div><dt>Waiting</dt><dd>" + waiting.length + "</dd></div>" : "") +
      (s.admission === "invite" && s.status !== "draft" ? "<div><dt>On the Calendar invitation</dt><dd>" + onEvent + "</dd></div>" : "") +
      (s.admission === "invite" && s.starts_at ? "<div><dt>Calendar</dt><dd" + (calendarTrouble(s) ? ' class="is-soon"' : "") + ">" + esc(calendarShort(s)) + "</dd></div>" : "") + "</dl>";
    var viewable = (s.status === "draft" && s.announce) || (s.status !== "draft" && s.status !== "completed" && !hasStarted(s));
    var holding = mine.some(function (r) { return HOLDING.indexOf(r.status) !== -1 || r.status === "pending_payment"; }) || ws.waitlist.some(function (w) { return w.session_id === s.id; }) || mine.length > 0;
    var b = function (a, label, cls) { return '<button class="wsd-btn wsd-btn--sm' + (cls ? " " + cls : "") + '" type="button" data-wsd="' + a + '" data-id="' + s.id + '">' + label + "</button>"; };
    // Release 7: a draft is scheduled in one step (date, Calendar event and Meet link, registration open).
    var acts = (s.status === "draft" ? b("session_schedule", "Schedule workshop", "wsd-btn--primary") : "") + b("session_edit", "Edit") +
      (s.status === "closed" && !hasStarted(s) ? b("session_publish", "Reopen registration", "wsd-btn--primary") : "") +
      (s.status === "published" && !hasStarted(s) ? b("session_close", "Close registration") : "") +
      ((s.status === "published" || s.status === "closed") && hasStarted(s) ? b("session_complete", "Mark completed", "wsd-btn--primary") : "") +
      (viewable ? '<a class="wsd-btn wsd-btn--sm wsd-btn--quiet" href="/workshops/' + esc(s.slug) + '" target="_blank" rel="noopener">View page</a>' : "") +
      b("session_copy", "Duplicate", "wsd-btn--quiet") +
      (s.status === "cancelled" || s.status === "completed" ? "" : holding ? b("session_cancel", "Cancel workshop", "wsd-btn--quiet") : b("session_delete", "Delete", "wsd-btn--quiet"));
    return '<article class="wsd-ticket' + (s.status === "draft" ? " wsd-ticket--draft" : "") + (s.is_test ? " wsd-ticket--test" : "") + (ended(s) ? " wsd-ticket--ended" : "") + '">' +
      '<div class="wsd-stub">' + stub + "</div>" +
      '<div class="wsd-ticket__body"><div class="wsd-ticket__head"><h4>' + esc(s.title) + '</h4><div class="wsd-pills"><span class="wsd-pill' + (st[1] ? " wsd-pill--" + st[1] : "") + '">' + esc(st[0]) + "</span>" +
      '<span class="wsd-pill">' + (s.kind === "webinar" ? "Webinar" : "Workshop") + "</span>" + (s.is_test ? '<span class="wsd-pill wsd-pill--test">Test</span>' : "") + "</div></div>" +
      seatMap + facts + waitlistDetail(s, st8, waiting) + inviteDetail(s, mine) + '<div class="wsd-acts">' + acts + "</div></div></article>";
  }
  function waitlistDetail(s, st8, waiting) {
    var errs = ws.waitlist.filter(function (w) { return w.session_id === s.id && w.email_error; });
    if (!waiting.length && !st8.offers.length && !errs.length) return "";
    return '<details class="wsd-more"><summary>Waitlist: ' + waiting.length + " waiting" + (st8.offers.length ? ", " + st8.offers.length + " offer" + (st8.offers.length === 1 ? "" : "s") + " open" : "") + "</summary>" +
      (st8.offers.length ? "<ul>" + st8.offers.map(function (w) { return "<li>Offer open: " + esc(w.full_name) + ", " + esc(w.email_normalized) + " (" + (w.seat_kind === "general" ? "open place" : "graduate place") + ") until " + esc(when(w.offer_expires_at)) + "</li>"; }).join("") + "</ul>" : "") +
      (waiting.length ? "<ol>" + waiting.map(function (w) {
        return "<li>" + esc(w.full_name) + ", " + esc(w.email_normalized) + " <small>(" + (w.seat_kind === "general" ? "open place" : "graduate place") + ", joined " + esc(when(w.created_at)) + ")</small> " +
          '<button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="waitlist_remove" data-id="' + esc(w.id) + '">Remove</button></li>';
      }).join("") + "</ol>" : "") + "<p class=\"wsd-hint\">Places are offered automatically, first in first out, each held up to 24 hours.</p></details>";
  }
  function inviteDetail(s, mine) {
    if (s.admission !== "invite") return "";
    var add = mine.filter(toAdd), remove = mine.filter(toRemove);
    if (!add.length && !remove.length) return "";
    return '<details class="wsd-more"><summary>Calendar changes in progress: ' + (add.length ? add.length + " to add" : "") + (add.length && remove.length ? ", " : "") + (remove.length ? remove.length + " to remove" : "") + "</summary>" +
      '<p class="wsd-hint">These happen automatically within a minute. Use the buttons only if you made the change by hand in Google Calendar.</p><ul>' +
      remove.map(function (r) { return "<li>Remove " + esc(r.invited_email) + " (" + esc(r.full_name) + ') <button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="mark_removed" data-id="' + esc(r.id) + '">Removed by hand</button></li>'; }).join("") +
      add.map(function (r) { return "<li>Add " + esc(r.attend_email) + " (" + esc(r.full_name) + ') <button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="mark_invited" data-id="' + esc(r.id) + '">Added by hand</button></li>'; }).join("") +
      "</ul></details>";
  }

  /* ---------- registrations ---------- */
  function filtered() {
    var f = { s: $("ws-session").value, st: $("ws-status").value, p: $("ws-payment").value, a: $("ws-attendance").value, q: $("ws-q").value.trim().toLowerCase() };
    return ws.rows.filter(function (r) {
      if (f.s && r.session_id !== f.s) return false;
      if (f.st && r.status !== f.st) return false;
      if (f.p && r.payment_status !== f.p) return false;
      if (f.a && r.attendance !== f.a) return false;
      if (f.q && [r.full_name, r.email_normalized, r.utm_campaign, r.utm_content, r.utm_source].join(" ").toLowerCase().indexOf(f.q) === -1) return false;
      return true;
    });
  }
  function statusPill(r) {
    var cls = r.status === "confirmed" ? "open" : r.status === "payment_received_review" || r.status === "refund_pending" ? "warn" : r.status === "refunded" || r.status === "cancelled" ? "bad" : "";
    return '<span class="wsd-pill' + (cls ? " wsd-pill--" + cls : "") + '">' + esc(STATUS[r.status] || r.status) + "</span>" + (isTest(r) ? ' <span class="wsd-pill wsd-pill--test">Test</span>' : "");
  }
  function renderRegs() {
    var rows = filtered();
    $("ws-count").textContent = rows.length;
    $("ws-n-reg").textContent = ws.rows.filter(function (r) { return !isTest(r); }).length;
    $("ws-rows").innerHTML = rows.map(function (r) {
      var s = sessionOf(r);
      return '<tr class="wsd-row" tabindex="0" data-wsd-person="' + esc(r.id) + '"><td><strong>' + esc(r.full_name) + "</strong><small>" + esc(r.email_normalized) + "</small></td>" +
        "<td>" + esc(s.title || "") + "<small>" + esc(TIER[r.price_tier] || "") + (r.referral_code ? ", referral " + esc(r.referral_code) : "") + "</small></td>" +
        "<td>" + statusPill(r) + (r.review_reason ? "<small>" + esc(REASON[r.review_reason] || r.review_reason) + "</small>" : "") + "</td>" +
        '<td class="num">' + ghsMinor(r.amount_paid_minor) + "</td><td>" + esc(when(r.created_at)) + "</td></tr>";
    }).join("") || '<tr><td colspan="5">No registrations match these filters.</td></tr>';
  }
  function openPerson(id) {
    var r = ws.rows.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    var s = sessionOf(r), atts = ws.attempts[r.id] || [];
    $("wsp-name").textContent = r.full_name;
    $("wsp-sub").textContent = (s.title || "") + (isTest(r) ? " (test)" : "");
    var b = function (a, label, primary) { return '<button class="wsd-btn' + (primary ? " wsd-btn--primary" : "") + '" type="button" data-wsd="' + a + '" data-id="' + esc(r.id) + '">' + label + "</button>"; };
    var acts = (r.status === "payment_received_review" ? b("admit", "Admit", true) : "") +
      ((r.status === "payment_received_review" || r.status === "confirmed") && ["paid", "needs_review", "partially_refunded"].indexOf(r.payment_status) !== -1 ? b("request_refund", "Refund now") : "") +
      (r.review_reason === "duplicate_payment" ? b("resolve_duplicate", "Note duplicate refund") : "") +
      (r.status === "refund_pending" ? b("send_refund", "Send refund to Paystack") : "") +
      (r.status === "pending_payment" && r.payment_status === "pending" ? b("cancel", "Cancel registration") : "") +
      (isInvite(r) && r.status === "confirmed" ? b("set_account", "Change Google account") : "") +
      (ws.failedMail[r.id] ? b("retry_email", "Retry email") : "") +
      (calendarException(r) ? b("retry_calendar", "Retry Calendar") : "");
    $("wsp-body").innerHTML = '<dl class="wsd-detail">' +
      "<dt>Email</dt><dd>" + esc(r.email_normalized) + "</dd>" +
      (r.whatsapp ? "<dt>WhatsApp</dt><dd>" + esc(r.whatsapp) + (r.whatsapp_consent ? " (reminders allowed)" : "") + "</dd>" : "") +
      "<dt>Status</dt><dd>" + esc(STATUS[r.status] || r.status) + (r.review_reason ? ": " + esc(REASON[r.review_reason] || r.review_reason) : "") + "</dd>" +
      "<dt>Price</dt><dd>" + esc(TIER[r.price_tier] || "") + (Number(r.discount_ghs) ? ", GHS " + cedis(r.discount_ghs) + " off" : "") + (r.benefit_credential_id ? " (" + esc(r.benefit_credential_id) + ")" : "") + "</dd>" +
      (r.referral_code ? "<dt>Referral</dt><dd>" + esc(r.referral_code) + "</dd>" : "") +
      "<dt>Paid</dt><dd>GHS " + ghsMinor(r.amount_paid_minor) + " (" + esc(PAYMENT[r.payment_status] || r.payment_status) + ")</dd>" +
      (atts.length ? "<dt>Paystack</dt><dd>" + atts.map(function (a) { return esc(a.reference) + ": " + esc(a.status); }).join("<br>") + "</dd>" : "") +
      (isInvite(r) ? "<dt>Joins with</dt><dd>" + esc(r.attend_email || "No Google account given yet") + "</dd><dt>Calendar</dt><dd>" + (r.invited_email && !toRemove(r) ? "On the invitation" : toAdd(r) ? "Being added" : "Not on the invitation") + "</dd>" : "") +
      "<dt>Came from</dt><dd>" + esc(r.utm_campaign ? r.utm_campaign + (r.utm_content ? " / " + r.utm_content : "") : "No campaign") + "</dd>" +
      "<dt>Registered</dt><dd>" + esc(when(r.created_at, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })) + " GMT</dd></dl>" +
      '<fieldset><legend>Attendance</legend><div class="wsd-seg" role="radiogroup" aria-label="Attendance">' +
      Object.keys(ATTENDANCE).map(function (k) { return '<label><input type="radio" name="wsp-att" value="' + k + '" data-wsd-att="' + esc(r.id) + '"' + (r.attendance === k ? " checked" : "") + "><span>" + ATTENDANCE[k] + "</span></label>"; }).join("") + "</div></fieldset>" +
      (acts ? '<div class="wsd-acts">' + acts + "</div>" : "") +
      '<div class="wsd-field"><label for="wsp-note">Add a note</label><textarea id="wsp-note" rows="3" maxlength="300"></textarea>' +
      '<button class="wsd-btn wsd-btn--sm" type="button" data-wsd="note" data-id="' + esc(r.id) + '">Save note</button></div>' +
      (r.admin_notes ? '<details class="wsd-fold"><summary>History</summary><pre class="wsd-history">' + esc(r.admin_notes) + "</pre></details>" : "");
    if (!$("ws-person").open) $("ws-person").showModal();
  }

  /* ---------- referral codes ---------- */
  function referrerName(x) { return x.name || (x.credential_id ? "Graduate " + x.credential_id : x.code); }
  function owedTo(x) {
    var due = ws.rows.filter(function (r) { return r.referrer_id === x.id && commissionState(r) === "due"; });
    return { count: due.length, amount: due.reduce(function (n, r) { return n + Number(r.commission_ghs || 0); }, 0) };
  }
  function renderReferrals() {
    var t = ws.settings;
    $("ws-terms-text").textContent = "Every code takes GHS " + cedis(t.referral_discount_ghs) + " off any workshop and earns its holder GHS " + cedis(t.referral_commission_ghs) +
      " for each paid place. Discounts never combine: a buyer with a certificate price gets whichever is lower, and the referrer still earns. A change applies to registrations from then on.";
    var sorted = ws.referrers.slice().sort(function (a, b) { return (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1); });
    $("ws-referrals").innerHTML = sorted.map(function (x) {
      var mine = ws.rows.filter(function (r) { return r.referrer_id === x.id && !isTest(r); });
      var sales = mine.filter(function (r) { var c = commissionState(r); return c === "due" || c === "paid"; });
      var earned = sales.reduce(function (n, r) { return n + Number(r.commission_ghs || 0); }, 0);
      var owed = owedTo(x);
      var pill = x.status === "active" ? '<span class="wsd-pill wsd-pill--open">Works now</span>' : x.status === "prepared" ? '<span class="wsd-pill wsd-pill--gold">Not live yet</span>' : '<span class="wsd-pill wsd-pill--bad">Suspended</span>';
      var link = origin + "/workshops/?ref=" + x.code;
      var b = function (a, label, primary) { return '<button class="wsd-btn wsd-btn--sm' + (primary ? " wsd-btn--primary" : "") + '" type="button" data-wsd="' + a + '" data-id="' + esc(x.id) + '">' + label + "</button>"; };
      return '<article class="wsd-code"><div class="wsd-code__top"><span class="wsd-code__id">' + esc(x.code) + "</span>" + pill + "</div>" +
        "<p><strong>" + esc(referrerName(x)) + "</strong>" + (x.email ? ", " + esc(x.email) : "") + (x.payout_method ? "<br>Paid by " + esc(x.payout_method) : "") + "</p>" +
        '<dl class="wsd-facts"><div><dt>Paid places</dt><dd>' + sales.length + "</dd></div><div><dt>Earned</dt><dd>GHS " + cedis(earned) + "</dd></div><div><dt>Owed now</dt><dd" + (owed.amount ? ' class="is-soon"' : "") + ">GHS " + cedis(owed.amount) + "</dd></div></dl>" +
        '<div class="wsd-link"><input readonly value="' + esc(link) + '" aria-label="Referral link for ' + esc(x.code) + '"><button class="wsd-btn wsd-btn--sm" type="button" data-wsd-copy="' + esc(link) + '">Copy link</button></div>' +
        '<div class="wsd-acts">' + (owed.amount ? b("referrer_payouts", "Record payment", true) : "") +
        (x.status === "active" ? b("referrer_suspend", "Suspend") : b("referrer_activate", x.status === "prepared" ? "Make live" : "Reactivate", true)) +
        b("referrer_edit", "Edit details") + "</div></article>";
    }).join("") || '<p class="wsd-clear">No codes yet. Use “Create a code” to make the first one. A code works on every workshop as soon as it exists.</p>';
    $("ws-n-ref").textContent = ws.referrers.length;
    var referred = ws.rows.filter(function (r) { return r.referral_code; });
    $("ws-ref-table-wrap").hidden = !referred.length;
    $("ws-ref-rows").innerHTML = referred.map(function (r) {
      var c = commissionState(r), s = sessionOf(r);
      var label = { due: "Owed", paid: "Paid (" + esc(ws.payouts[r.id] ? ws.payouts[r.id].payout_reference : "") + ")", review: "Paid out, then refunded or cancelled: check it",
        none: isTest(r) ? "Test: never paid" : r.commission_voided_at ? "Voided: " + esc(r.commission_void_reason || "") : "Not earned (" + esc(STATUS[r.status] || r.status) + ")" }[c];
      return "<tr><td>" + esc(r.full_name) + "<small>" + esc(s.title || "") + "</small></td><td>" + esc(r.referral_code) + '</td><td class="num">' + ghsMinor(r.amount_paid_minor) +
        '</td><td class="num">' + (c === "due" || c === "paid" ? cedis(r.commission_ghs) : "0") + "</td><td>" + label + "</td><td>" +
        (c === "due" || c === "paid" ? '<button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd="void_commission" data-id="' + esc(r.id) + '">Void</button>' : "") + "</td></tr>";
    }).join("");
  }

  /* ---------- ad results ---------- */
  function campaigns(rows) {
    var groups = {};
    rows.forEach(function (r) {
      if (isTest(r)) return;
      var key = (r.utm_campaign || "(none)") + "\u0000" + (r.utm_content || "");
      var g = groups[key] = groups[key] || { c: r.utm_campaign || "(no campaign)", a: r.utm_content || "", n: 0, paid: 0, held: 0, rev: 0 };
      g.n += 1;
      if (isConfirmedPaid(r)) { g.paid += 1; g.rev += verifiedMinor(r); } else if (isHeldForReview(r)) g.held += 1;
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return y.paid - x.paid || y.n - x.n; });
    $("ws-camp-rows").innerHTML = list.map(function (g) {
      return "<tr><td>" + esc(g.c) + "</td><td>" + esc(g.a || "—") + '</td><td class="num">' + g.n + '</td><td class="num">' + g.paid + '</td><td class="num">' + g.held + '</td><td class="num">' + ghsMinor(g.rev) + "</td></tr>";
    }).join("") || '<tr><td colspan="6">No live registrations yet.</td></tr>';
    var paid = list.reduce(function (t, g) { return t + g.paid; }, 0), spend = Number($("ws-spend").value);
    $("ws-cac").textContent = spend > 0 && paid > 0 ? "GHS " + (spend / paid).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "—";
  }
  function csv() {
    var cols = ["registered_at", "session", "full_name", "email", "whatsapp", "whatsapp_consent", "status", "payment_status", "review_reason", "confirmed_paid",
      "verified_paid_ghs", "attendance", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "references"];
    // A value starting with = + - @ or a tab/CR is a formula to Excel and Sheets even when quoted.
    var cell = function (v) { var x = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(x)) x = "'" + x; return /[",\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var lines = [cols.join(",")].concat(filtered().map(function (r) {
      var s = sessionOf(r);
      return [r.created_at, s.slug, r.full_name, r.email_normalized, r.whatsapp, r.whatsapp_consent, r.status, r.payment_status, r.review_reason,
        isConfirmedPaid(r) ? "yes" : "no", verifiedMinor(r) / 100, r.attendance, r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term,
        (ws.attempts[r.id] || []).map(function (a) { return a.reference + ":" + a.status; }).join(" ")].map(cell).join(",");
    }));
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = "workshop-registrations-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- the confirmation dialog ---------- */
  var asking = null;
  function ask(o) {
    $("wsa-title").textContent = o.title;
    $("wsa-text").textContent = o.text || "";
    $("wsa-yes").textContent = o.yes || "Confirm";
    $("wsa-yes").className = "wsd-btn " + (o.danger ? "wsd-btn--danger" : "wsd-btn--primary");
    $("wsa-error").hidden = true;
    $("wsa-fields").innerHTML = (o.fields || []).map(function (f, i) {
      var id = "wsa-f" + i;
      var input = f.type === "textarea" ? '<textarea id="' + id + '" rows="' + (f.rows || 3) + '">' + esc(f.value || "") + "</textarea>"
        : f.type === "select" ? '<select id="' + id + '">' + f.options.map(function (op) { return '<option value="' + esc(op[0]) + '"' + (op[0] === f.value ? " selected" : "") + ">" + esc(op[1]) + "</option>"; }).join("") + "</select>"
        : '<input id="' + id + '" type="' + (f.type || "text") + '" value="' + esc(f.value || "") + '"' + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : "") + ">";
      return '<div class="wsd-field"><label for="' + id + '">' + esc(f.label) + "</label>" + input + (f.hint ? '<span class="wsd-hint">' + esc(f.hint) + "</span>" : "") + "</div>";
    }).join("");
    asking = o;
    $("ws-ask").showModal();
    var first = $("wsa-f0");
    (first || $("wsa-yes")).focus();
  }
  $("wsa-form").addEventListener("submit", function (e) {
    e.preventDefault();
    if (!asking) return;
    var o = asking, values = (o.fields || []).map(function (f, i) { return $("wsa-f" + i).value.trim(); });
    var missing = (o.fields || []).map(function (f, i) { return f.min && values[i].length < f.min ? f.label : null; }).filter(Boolean);
    if (missing.length) { $("wsa-error").textContent = "Fill in: " + missing.join(", ") + "."; $("wsa-error").hidden = false; return; }
    $("wsa-yes").disabled = true;
    Promise.resolve(o.run.apply(null, values)).then(function () { asking = null; $("ws-ask").close(); })
      .catch(function (err) { $("wsa-error").textContent = err.message; $("wsa-error").hidden = false; })
      .then(function () { $("wsa-yes").disabled = false; });
  });

  /* ---------- the workshop editor ---------- */
  var editing = null;
  var LISTS = { why: "wse-l-why", outcomes: "wse-l-outcomes", leave: "wse-l-leave", run: "wse-l-run", faq: "wse-l-faq" };
  function listRow(kind, v) {
    var cells = kind === "run"
      ? '<input class="wsd-narrow" aria-label="Time into the session" placeholder="0:00" value="' + esc(v && v.at) + '"><div><input aria-label="Segment" placeholder="What happens" value="' + esc(v && v.title) + '"><input aria-label="Detail (optional)" placeholder="Detail (optional)" value="' + esc(v && v.detail) + '"></div>'
      : kind === "faq"
        ? '<div><input aria-label="Question" placeholder="Question" value="' + esc(v && v.q) + '"><textarea aria-label="Answer" rows="2" placeholder="Answer">' + esc(v && v.a) + "</textarea></div>"
        : kind === "why" ? '<textarea aria-label="Paragraph" rows="3">' + esc(v || "") + "</textarea>" : '<input aria-label="Item" value="' + esc(v || "") + '">';
    return '<div class="wsd-list__row">' + cells + '<button class="wsd-btn wsd-btn--sm wsd-btn--quiet" type="button" data-wsd-del>Remove</button></div>';
  }
  function readList(kind) {
    return Array.prototype.map.call($(LISTS[kind]).querySelectorAll(".wsd-list__row"), function (row) {
      var f = row.querySelectorAll("input, textarea");
      if (kind === "run") return { at: f[0].value.trim(), title: f[1].value.trim(), detail: f[2].value.trim() };
      if (kind === "faq") return { q: f[0].value.trim(), a: f[1].value.trim() };
      return f[0].value.trim();
    }).filter(function (v) { return typeof v === "string" ? v : (v.at && v.title) || (v.q && v.a); });
  }
  function slugify(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80); }
  function priceLine() {
    var p = Number($("wse-f-price").value) || 0, f = Number($("wse-f-fnd").value) || 0, rd = Number(ws.settings.referral_discount_ghs) || 0;
    var cap = Number($("wse-f-cap").value) || 0, gr = Number($("wse-f-grad").value) || 0;
    var bits = [p ? "GHS " + cedis(p) + " standard" : "Free"];
    if (p && f) bits.push("GHS " + cedis(Math.round(p * (100 - f)) / 100) + " with a Foundations certificate");
    if (p && rd) bits.push("GHS " + cedis(Math.max(0, p - rd)) + " with a referral code");
    if (p && $("wse-f-free").checked && gr) bits.push("free for Intermediate graduates");
    $("wse-priceline").textContent = bits.join(", ") + ". " + (cap + gr) + " people in total" + (gr ? " (" + cap + " open, " + gr + " kept for graduates)." : ".");
    $("wse-cutoff").textContent = cutoffText($("wse-f-date").value, $("wse-f-time").value);
    $("wse-cal-wrap").hidden = !$("wse-a-invite").checked;
    // What each folded section holds, so it can stay folded.
    $("wse-discount-note").textContent = (gr ? gr + " graduate places" + ($("wse-f-free").checked ? ", free" : "") : "No graduate places") + (f ? ", Foundations " + f + "% off" : "");
    $("wse-join-note").textContent = $("wse-a-invite").checked ? "Google Calendar invitation" : "Link in the confirmation email";
    $("wse-page-note").textContent = "/workshops/" + ($("wse-f-slug").value || slugify($("wse-f-title").value));
    var gaps = contentGaps({ summary: $("wse-f-summary").value.trim(), outcomes: readList("outcomes"), run_of_show: readList("run"), faq: readList("faq") });
    $("wse-content-note").textContent = gaps.length ? "Missing: " + gaps.join(", ") : "Complete";
    $("wse-content-note").className = "wsd-sec__note" + (gaps.length ? " is-missing" : "");
    seriesNote();
  }

  /* Series defaults (release 7): the editor says where a workshop differs from its series. */
  var SERIES_FIELDS = [
    ["price_ghs", "wse-f-price", "price", function (v) { return "GHS " + cedis(v); }],
    ["capacity", "wse-f-cap", "open places", String],
    ["reserved_graduate_seats", "wse-f-grad", "graduate places", String],
    ["foundations_discount_pct", "wse-f-fnd", "Foundations discount", function (v) { return v + "%"; }],
    ["duration_minutes", "wse-f-dur", "length", hours]
  ];
  function seriesNote() {
    var slug = $("wse-f-series").value, ser = seriesOf(slug), def = defaultsOf(slug);
    if (!ser || !Object.keys(def).length) { $("wse-series-note").hidden = true; return; }
    var diff = SERIES_FIELDS.filter(function (k) { return def[k[0]] !== undefined && Number(def[k[0]]) !== (Number($(k[1]).value) || 0); })
      .map(function (k) { return k[2] + " (series: " + k[3](def[k[0]]) + ")"; });
    if (def.graduate_free !== undefined && !!def.graduate_free !== $("wse-f-free").checked) diff.push("free graduate places (series: " + (def.graduate_free ? "on" : "off") + ")");
    if (def.admission && def.admission !== ($("wse-a-invite").checked ? "invite" : "link")) diff.push("joining (series: " + (def.admission === "invite" ? "Calendar invitation" : "email link") + ")");
    $("wse-series-note").hidden = false;
    $("wse-series-note").className = "wsd-series-note" + (diff.length ? " is-different" : "");
    $("wse-series-text").textContent = diff.length ? "Differs from the " + ser.name + " settings: " + diff.join(", ") + "." : "Uses the " + ser.name + " settings for price, places, discounts, length and joining.";
    $("wse-use-series").hidden = !diff.length;
  }
  function useSeries() {
    var def = defaultsOf($("wse-f-series").value);
    SERIES_FIELDS.forEach(function (k) {
      if (def[k[0]] === undefined) return;
      if (k[0] === "duration_minutes" && !Array.prototype.some.call($("wse-f-dur").options, function (o) { return o.value === String(def[k[0]]); })) return;
      $(k[1]).value = String(def[k[0]]);
    });
    if (def.graduate_free !== undefined) $("wse-f-free").checked = !!def.graduate_free;
    if (def.admission) $("wse-a-" + (def.admission === "invite" ? "invite" : "link")).checked = true;
    if (!$("wse-f-date").value && def.start_time) $("wse-f-time").value = def.start_time;
    priceLine();
  }

  function statusLine(s) {
    if (!s) return "New. Nothing is public until you schedule it.";
    var st = s.status;
    if (st === "draft") return s.announce ? "Draft, listed as coming soon. Nobody can book yet." : "Draft. Not on the website yet.";
    if (st === "published") return hasStarted(s) ? "Taken place." : "Open. People can book and pay now.";
    if (st === "closed") return "Closed. The page is up but nobody new can book.";
    if (st === "cancelled") return "Cancelled.";
    if (st === "completed") return "Completed.";
    return st;
  }

  /* The workshop's own Calendar event (release 7). */
  function calPanel(s) {
    var p = $("wse-cal-panel");
    var retry = s ? '<button class="wsd-btn wsd-btn--sm wsd-btn--primary" type="button" data-wsd="calendar_retry" data-id="' + esc(s.id) + '">Retry</button>' : "";
    if (!s || !s.calendar_event_id) {
      p.innerHTML = "<p><strong>Made for you.</strong> When you schedule this workshop, its Google Calendar event and its own Meet link are created automatically. " +
        "Guests can't change the event, invite others or see who else is coming. Paid people are added as they confirm and removed if refunded.</p>" +
        (s && s.calendar_status === "failed" ? '<p class="wsd-cal__bad">The last attempt failed: ' + esc(s.calendar_error || "Google Calendar did not respond.") + "</p>" + retry : "");
      return;
    }
    var link = s.meet_link ? '<div class="wsd-copy"><input type="text" readonly value="' + esc(s.meet_link) + '" aria-label="Meet link (private)">' +
      '<button class="wsd-btn wsd-btn--sm" type="button" data-wsd-copy="' + esc(s.meet_link) + '">Copy</button></div><span class="wsd-hint">Private. Only invited people get it, in their Calendar invitation.</span>' : "";
    p.innerHTML = "<p><strong>" + (s.calendar_managed ? "Event and Meet link created automatically." : "Your own event, kept exactly as you set it up.") + "</strong> " +
      (s.calendar_managed ? "Moving the date here moves the event and Google emails everyone invited." : "Moving the date here moves your event's time and Google emails everyone invited; its title and description stay yours.") + "</p>" +
      link + (calendarTrouble(s) ? '<p class="wsd-cal__bad">' + esc(s.calendar_status === "failed" ? "Not created: " : "Still on the old time: ") + esc(s.calendar_error || "") + "</p>" + retry : "");
  }

  var aiExtra = null;
  function fillContent(c) {
    $("wse-f-summary").value = c.summary || ""; $("wse-f-audience").value = c.audience || "";
    $(LISTS.why).innerHTML = (c.why || []).map(function (x) { return listRow("why", x); }).join("");
    $(LISTS.outcomes).innerHTML = (c.outcomes && c.outcomes.length ? c.outcomes : [""]).map(function (x) { return listRow("outcomes", x); }).join("");
    $(LISTS.leave).innerHTML = (c.leave_with || []).map(function (x) { return listRow("leave", x); }).join("");
    $(LISTS.run).innerHTML = (c.run_of_show || []).map(function (x) { return listRow("run", x); }).join("");
    $(LISTS.faq).innerHTML = (c.faq || []).map(function (x) { return listRow("faq", x); }).join("");
    $("wse-f-fit").value = c.good_fit || ""; $("wse-f-notfit").value = c.not_fit || ""; $("wse-f-bring").value = c.bring || "";
    $("wse-f-problem").value = c.problem || ""; $("wse-f-fitline").value = c.series_fit || "";
  }

  function openEditor(s, copy) {
    editing = copy ? null : s;
    aiExtra = null;
    var c = (s && s.content) || {};
    var firstSeries = ws.series[0] ? ws.series[0].slug : "";
    // A new workshop starts from its series' settings (release 7).
    var v = s || Object.assign({ kind: "workshop", price_ghs: 350, capacity: 25, reserved_graduate_seats: 5, foundations_discount_pct: 20, graduate_free: true,
      admission: "invite", duration_minutes: 180, announce: false }, defaultsOf(firstSeries), { series_slug: firstSeries });
    $("wse-title").textContent = copy ? "Copy of " + s.title : s ? "Edit workshop" : "New workshop";
    $("wse-error").hidden = true; $("wse-retry-wrap").hidden = true;
    $("wse-f-title").value = copy ? s.title + " (copy)" : v.title || "";
    $("wse-f-slug").value = copy ? "" : v.slug || "";
    var locked = !!(editing && (editing.status !== "draft" || rowsOf(editing.id).length));
    $("wse-f-slug").readOnly = locked;
    $("wse-slug-hint").textContent = locked ? "Fixed: registration has opened on this address, so links already shared keep working." : "Filled in from the title. It can't change once registration has opened.";
    $("wse-k-" + (v.kind === "webinar" ? "webinar" : "workshop")).checked = true;
    var ser = $("wse-f-series");
    ser.innerHTML = '<option value="">Not part of a series</option>' + ws.series.map(function (x) { return '<option value="' + esc(x.slug) + '">' + esc(x.name) + "</option>"; }).join("");
    ser.value = v.series_slug || "";
    var used = ws.list.filter(function (x) { return x.series_slug && !x.is_test && x.series_number; }).map(function (x) { return x.series_number; });
    $("wse-f-number").value = copy || !s ? (used.length ? Math.max.apply(null, used) + 1 : 1) : v.series_number || "";
    $("wse-announce-wrap").hidden = !!(editing && editing.status !== "draft");
    $("wse-f-announce").checked = !copy && !!v.announce;
    $("wse-test-wrap").hidden = !!editing;
    $("wse-f-test").checked = !!(copy && s.is_test);
    var t = !copy && v.starts_at ? new Date(v.starts_at) : null;
    $("wse-f-date").value = t ? t.toISOString().slice(0, 10) : "";
    $("wse-f-time").value = t ? t.toISOString().slice(11, 16) : (defaultsOf(v.series_slug).start_time || "11:30");
    $("wse-f-dur").value = String(v.duration_minutes || 180);
    if ($("wse-f-dur").value !== String(v.duration_minutes || 180)) { var o = document.createElement("option"); o.value = String(v.duration_minutes); o.textContent = v.duration_minutes + " minutes"; $("wse-f-dur").appendChild(o); $("wse-f-dur").value = String(v.duration_minutes); }
    $("wse-f-price").value = Number(v.price_ghs || 0); $("wse-f-cap").value = v.capacity || ""; $("wse-f-grad").value = Number(v.reserved_graduate_seats || 0);
    $("wse-f-fnd").value = Number(v.foundations_discount_pct || 0); $("wse-f-free").checked = !!v.graduate_free;
    $("wse-a-" + (v.admission === "invite" ? "invite" : "link")).checked = true;
    $("wse-f-cal").value = copy ? "" : v.calendar_event_id || "";
    $("wse-f-join").value = copy ? "" : v.join_instructions || "";
    fillContent(c);
    $("wse-f-brief").value = c.problem || c.summary || "";
    $("wse-ai-status").textContent = "";
    $("wse-status").textContent = statusLine(editing);
    $("wse-referral-line").textContent = "Referral codes: GHS " + cedis(ws.settings.referral_discount_ghs) + " off and GHS " + cedis(ws.settings.referral_commission_ghs) +
      " commission. One setting for every workshop, changed under Referrals.";
    calPanel(editing);
    var held = editing ? rowsOf(editing.id).filter(function (r) { return HOLDING.indexOf(r.status) !== -1; }) : [];
    $("wse-held").hidden = !held.length;
    $("wse-held").textContent = held.length ? held.length + (held.length === 1 ? " person has" : " people have") + " a place. A new price applies only to people who register from now on, and places can't go below the ones already taken. " +
      (editing.admission === "invite" && editing.calendar_event_id ? "A new date moves the Calendar event, and Google emails everyone invited." : "If you change the date, tell the people booked.") : "";
    $("wse-history-wrap").hidden = !(editing && editing.admin_notes);
    $("wse-history").textContent = editing && editing.admin_notes ? editing.admin_notes : "";
    var st = editing ? editing.status : "draft";
    $("wse-draft").hidden = st !== "draft";
    $("wse-save").textContent = st === "draft" ? "Save and open registration" : "Save changes";
    var anyone = editing && (rowsOf(editing.id).length || ws.waitlist.some(function (w) { return w.session_id === editing.id; }));
    $("wse-remove").hidden = !editing || st === "cancelled" || st === "completed";
    $("wse-remove").textContent = anyone ? "Cancel workshop" : "Delete";
    // Essentials first; the rest stays folded unless something in it needs attention.
    $("wse-sec-content").open = !s || contentGaps(c).length > 0;
    $("wse-sec-discounts").open = false;
    $("wse-sec-join").open = !!(editing && calendarTrouble(editing));
    $("wse-sec-page").open = !s;
    priceLine();
    $("ws-editor").showModal();
    $("wse-f-title").focus();
  }
  function editorPayload() {
    var d = $("wse-f-date").value, t = $("wse-f-time").value || "00:00";
    var out = {
      title: $("wse-f-title").value.trim(), kind: $("wse-k-webinar").checked ? "webinar" : "workshop",
      series_slug: $("wse-f-series").value, series_number: $("wse-f-series").value ? Number($("wse-f-number").value) || 0 : 0,
      starts_at: d ? d + "T" + t + ":00Z" : "", duration_minutes: Number($("wse-f-dur").value), format: "live online",
      price_ghs: Number($("wse-f-price").value) || 0, capacity: Number($("wse-f-cap").value) || 0, reserved_graduate_seats: Number($("wse-f-grad").value) || 0,
      foundations_discount_pct: Number($("wse-f-fnd").value) || 0, graduate_free: $("wse-f-free").checked,
      admission: $("wse-a-invite").checked ? "invite" : "link", calendar_event_id: $("wse-a-invite").checked ? $("wse-f-cal").value.trim() : "",
      join_instructions: $("wse-f-join").value,
      content: { summary: $("wse-f-summary").value, audience: $("wse-f-audience").value, why: readList("why"), outcomes: readList("outcomes"),
        leave_with: readList("leave"), run_of_show: readList("run"), faq: readList("faq"), good_fit: $("wse-f-fit").value,
        not_fit: $("wse-f-notfit").value, bring: $("wse-f-bring").value, problem: $("wse-f-problem").value, series_fit: $("wse-f-fitline").value }
    };
    // Keep the extra content the form does not show (description, directory line), or take the draft's.
    var extra = aiExtra || (editing && editing.content) || {};
    out.content.description = extra.description || ""; out.content.directory_line = extra.directory_line || "";
    if (!$("wse-f-slug").readOnly) out.slug = $("wse-f-slug").value.trim() || slugify(out.title);
    if (!editing || editing.status === "draft") out.announce = $("wse-f-announce").checked;
    if (!editing) out.is_test = $("wse-f-test").checked;
    return out;
  }
  function editorFailed(err, open) {
    $("wse-error").textContent = err.message; $("wse-error").hidden = false;
    $("wse-retry-wrap").hidden = !(err.data && err.data.retry);
    $("wse-retry").onclick = function () { saveEditor(open); };
    $("wse-error").scrollIntoView({ block: "nearest" });
  }
  function saveEditor(open) {
    var payload = editorPayload();
    $("wse-error").hidden = true; $("wse-retry-wrap").hidden = true;
    if (payload.title.length < 3) { $("wse-error").textContent = "Give the workshop a title."; $("wse-error").hidden = false; $("wse-f-title").focus(); return; }
    var buttons = [$("wse-save"), $("wse-draft")];
    buttons.forEach(function (b) { b.disabled = true; });
    var wasDraft = !editing || editing.status === "draft";
    var invite = payload.admission === "invite";
    // Opening a draft is scheduling it: save, create the Calendar event and Meet link, open registration.
    var schedule = function (id) {
      return apiPost({ action: "session_schedule", session_id: id, session: payload }).then(function () {
        return invite ? "Scheduled. The Calendar event and Meet link are ready, and registration is open." : "Saved. Registration is open and the page is live.";
      });
    };
    var step = open && wasDraft
      ? (editing ? schedule(editing.id) : apiPost({ action: "session_save", session: payload }).then(function (j) { editing = { id: j.id, status: "draft" }; delete payload.slug; return schedule(j.id); }))
      : apiPost({ action: "session_save", session_id: editing ? editing.id : undefined, session: payload }).then(function (j) {
          if (j.warning) return { warning: j.warning };
          if (wasDraft) return "Saved as a draft. Nothing is public until you open registration.";
          return j.calendar === "moved" ? "Saved. The Calendar event moved to the new date and Google emailed everyone invited." : "Saved. The page shows the change now.";
        });
    step.then(function (msg) { $("ws-editor").close(); if (msg && msg.warning) failed(new Error(msg.warning)); else said(msg); return load(); })
      .catch(function (err) { editorFailed(err, open); load(); })
      .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }
  $("wse-form").addEventListener("submit", function (e) { e.preventDefault(); saveEditor(true); });
  $("wse-draft").addEventListener("click", function () { saveEditor(false); });
  $("wse-remove").addEventListener("click", function () { if (editing) removeSession(editing); });
  $("wse-f-title").addEventListener("input", function () { if (!$("wse-f-slug").readOnly && !(editing && editing.slug)) $("wse-f-slug").value = slugify($("wse-f-title").value); });
  ["wse-f-price", "wse-f-fnd", "wse-f-cap", "wse-f-grad", "wse-f-free", "wse-f-date", "wse-f-time", "wse-a-invite", "wse-a-link",
    "wse-f-dur", "wse-f-series", "wse-f-slug", "wse-f-title", "wse-f-summary"].forEach(function (id) {
    $(id).addEventListener("input", priceLine); $(id).addEventListener("change", priceLine);
  });
  $("wse-use-series").addEventListener("click", useSeries);
  $("ws-new").addEventListener("click", function () { openEditor(null); });

  /* ---------- Generate draft content (release 7) ---------- */
  $("wse-ai").addEventListener("click", function () {
    var btn = $("wse-ai"), note = $("wse-ai-status");
    var title = $("wse-f-title").value.trim(), brief = $("wse-f-brief").value.trim();
    if (title.length < 3 || brief.length < 10) { note.textContent = "Give it a title, and a sentence or two about what it covers."; return; }
    var go = function () {
      btn.disabled = true;
      note.textContent = "Writing a draft with a free AI model. This usually takes about a minute, and can take up to three.";
      return apiPost({ action: "content_draft", title: title, brief: brief, kind: $("wse-k-webinar").checked ? "webinar" : "workshop",
        duration_minutes: Number($("wse-f-dur").value), series_slug: $("wse-f-series").value, series_number: Number($("wse-f-number").value) || 0 })
        .then(function (j) {
          fillContent(j.content);
          aiExtra = { description: j.content.description || "", directory_line: j.content.directory_line || "" };
          note.textContent = "Draft written by " + j.model + ". Read it through and change anything that isn't right. Nothing is saved until you press Save.";
          priceLine();
        })
        .catch(function (err) { note.textContent = err.message; })
        .then(function () { btn.disabled = false; });
    };
    var has = readList("why").length || readList("outcomes").length || readList("run").length || readList("faq").length;
    if (has) ask({ title: "Replace the page content with a new draft?", yes: "Write a new draft",
      text: "Everything under Page content is replaced in this form. Nothing is saved until you press Save, so closing without saving keeps what you had.",
      run: function () { go(); } });
    else go();
  });

  /* ---------- Schedule a draft (release 7) ---------- */
  var scheduling = null;
  function reviewRow(label, value) { return "<div><dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>"; }
  function openSchedule(s) {
    scheduling = s;
    var def = defaultsOf(s.series_slug), ser = seriesOf(s.series_slug), t = s.starts_at ? new Date(s.starts_at) : null;
    $("wss-title").textContent = "Schedule “" + s.title + "”";
    $("wss-date").value = t ? t.toISOString().slice(0, 10) : "";
    $("wss-time").value = t ? t.toISOString().slice(11, 16) : (def.start_time || "11:30");
    $("wss-date").min = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    $("wss-error").hidden = true;
    $("wss-progress").hidden = true;
    Array.prototype.forEach.call($("wss-progress").children, function (li) { li.className = ""; });
    $("wss-go").textContent = "Schedule and open registration"; $("wss-go").disabled = false;
    var cap = Number(s.capacity || 0), gr = Number(s.reserved_graduate_seats || 0), p = Number(s.price_ghs || 0);
    var same = ser && Object.keys(def).length && SERIES_FIELDS.every(function (k) { return def[k[0]] === undefined || Number(def[k[0]]) === Number(s[k[0]]); }) &&
      (def.graduate_free === undefined || !!def.graduate_free === !!s.graduate_free) && (!def.admission || def.admission === s.admission);
    $("wss-review").innerHTML =
      (ser ? reviewRow("Series", ser.name + (same ? ", standard settings" : ", with its own settings")) : "") +
      reviewRow("Length", hours(s.duration_minutes) + ", " + (s.format || "live online")) +
      reviewRow("Price", p ? "GHS " + cedis(p) : "Free") +
      reviewRow("Places", cap + " open" + (gr ? " and " + gr + " kept for Intermediate graduates" + (s.graduate_free ? ", free" : "") : "")) +
      (p && Number(s.foundations_discount_pct) ? reviewRow("Foundations certificate", Number(s.foundations_discount_pct) + "% off") : "") +
      (p ? reviewRow("Referral codes", "GHS " + cedis(ws.settings.referral_discount_ghs) + " off, GHS " + cedis(ws.settings.referral_commission_ghs) + " commission") : "") +
      reviewRow("Joining", s.admission === "invite"
        ? (s.calendar_event_id ? (s.calendar_managed ? "Its Calendar event and Meet link already exist" : "Your own Calendar event") + "; the time is set to match"
          : "A Google Calendar event with its own Meet link, made now. Guests can't edit it, invite others or see each other")
        : "The joining instructions, by email to each confirmed person");
    var gaps = contentGaps(s.content);
    var box = $("wss-content");
    box.hidden = !gaps.length && !(s.admission === "link" && !s.join_instructions);
    box.innerHTML = (gaps.length ? "<p><strong>The page is missing: " + esc(gaps.join(", ")) + ".</strong> " +
        (gaps.indexOf("short description") !== -1 ? "Registration can't open without a short description. " : "People would see a thin page. ") +
        'Draft it first: open the editor, then use Generate draft content.</p><p><button class="wsd-btn wsd-btn--sm" type="button" id="wss-write">Write the page first</button></p>' : "") +
      (s.admission === "link" && !s.join_instructions ? "<p><strong>No joining instructions yet.</strong> Confirmed people get these by email; add them in the editor under Joining.</p>" : "");
    var write = $("wss-write");
    if (write) write.onclick = function () { $("ws-schedule").close(); openEditor(s); $("wse-sec-content").open = true; $("wse-f-brief").focus(); };
    $("wss-cutoff").textContent = cutoffText($("wss-date").value, $("wss-time").value);
    $("ws-schedule").showModal();
    $("wss-date").focus();
  }
  ["wss-date", "wss-time"].forEach(function (id) { $(id).addEventListener("input", function () { $("wss-cutoff").textContent = cutoffText($("wss-date").value, $("wss-time").value); }); });
  $("wss-change").addEventListener("click", function () {
    var s = scheduling, d = $("wss-date").value, t = $("wss-time").value;
    $("ws-schedule").close(); openEditor(s);
    if (d) { $("wse-f-date").value = d; $("wse-f-time").value = t || "11:30"; }
    $("wse-sec-discounts").open = true; $("wse-sec-join").open = true; priceLine();
  });
  $("wss-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var s = scheduling, d = $("wss-date").value, t = $("wss-time").value;
    if (!s) return;
    if (!d || !t) { $("wss-error").textContent = "Choose the date and the start time."; $("wss-error").hidden = false; return; }
    if (Date.parse(d + "T" + t + ":00Z") < Date.now() + 7 * 864e5) {
      $("wss-error").textContent = "Registration closes 7 days before the start, so choose a date at least a week away."; $("wss-error").hidden = false; return;
    }
    var steps = $("wss-progress").children, mark = function (i, cls) { steps[i].className = cls; };
    $("wss-error").hidden = true; $("wss-progress").hidden = false;
    steps[1].hidden = s.admission !== "invite";
    mark(0, "is-active"); mark(1, ""); mark(2, "");
    $("wss-go").disabled = true; $("wss-go").textContent = "Scheduling";
    apiPost({ action: "session_schedule", session_id: s.id, session: { starts_at: d + "T" + t + ":00Z" } })
      .then(function () {
        mark(0, "is-done"); mark(1, "is-done"); mark(2, "is-done");
        $("ws-schedule").close();
        said("Scheduled: " + s.title + ", " + when(Date.parse(d + "T" + t + ":00Z"), { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + " GMT. " +
          (s.admission === "invite" ? "Its Calendar event and Meet link are ready. " : "") + "Registration is open.");
        return load();
      })
      .catch(function (err) {
        var calendar = err.data && err.data.retry;
        mark(0, "is-done"); mark(1, calendar ? "is-failed" : ""); mark(2, calendar ? "" : "is-failed");
        $("wss-error").textContent = err.message; $("wss-error").hidden = false;
        $("wss-go").textContent = calendar ? "Retry" : "Try again";
        load();
      })
      .then(function () { $("wss-go").disabled = false; });
  });

  function removeSession(s) {
    var anyone = rowsOf(s.id).length || ws.waitlist.some(function (w) { return w.session_id === s.id; });
    if (anyone) {
      var paid = rowsOf(s.id).filter(function (r) { return HOLDING.indexOf(r.status) !== -1; }).length;
      ask({ title: "Cancel “" + s.title + "”?", danger: true, yes: "Cancel workshop",
        text: "People have registered or are waiting, so the workshop is kept on record rather than deleted. Registration stops at once and the page says it is cancelled." +
          (paid ? " The " + paid + (paid === 1 ? " person" : " people") + " with a place appear under “Needs you” so you can refund them or move them. Nobody is refunded or emailed automatically, and the Calendar invitation stays until you act." : ""),
        fields: [{ label: "Reason (kept with the workshop's record)", type: "textarea", min: 5, rows: 2 }],
        run: function (reason) { return apiPost({ action: "session_cancel", session_id: s.id, reason: reason }).then(function () { if ($("ws-editor").open) $("ws-editor").close(); said("Workshop cancelled."); return load(); }); } });
    } else {
      ask({ title: "Delete “" + s.title + "”?", danger: true, yes: "Delete workshop",
        text: "Nobody has registered, so it is removed completely: its page and booking form disappear. This can't be undone.",
        run: function () { return apiPost({ action: "session_delete", session_id: s.id }).then(function () { if ($("ws-editor").open) $("ws-editor").close(); said("Deleted."); return load(); }); } });
    }
  }

  /* ---------- every button ---------- */
  var REG_CONFIRM = {
    request_refund: ["Refund this registration?", "Paystack refunds everything they paid to the card or mobile money account they paid with, starting now. Their place frees itself and the Calendar invitation is removed when Paystack confirms the refund.", "Refund now"],
    send_refund: ["Send the refund to Paystack?", "Paystack is checked first: anything already refunded or on its way there is not sent again. Only what is still owed goes back, to the card or mobile money account they paid with.", "Send refund"],
    cancel: ["Cancel this unpaid registration?", "Their held place is released.", "Cancel registration"],
    resolve_duplicate: ["Record the duplicate refund?", "This notes that the extra payment will be refunded in Paystack. Their place is kept.", "Record it"],
    mark_invited: ["Added by hand?", "Only if you added this Google account to the event yourself, with guests unable to see the guest list or invite others.", "Yes, I added it"],
    mark_removed: ["Removed by hand?", "Only if you removed this Google account from the event's guests yourself.", "Yes, I removed it"]
  };
  function regAction(action, id, extra) {
    return apiPost(Object.assign({ registration_id: id, action: action }, extra || {})).then(function (j) {
      if (j && j.refund) { if (j.refund.problem) failed(new Error(j.refund.message)); else said(j.refund.message || "Saved."); } else said(action === "admit" ? "Admitted. Their confirmation and invitation go out within a minute." : action === "retry_calendar" ? "Trying the invitation again now." :
        action === "retry_email" ? "Sending the email again now." : action === "note" ? "Note saved." : "Saved.");
      return load().then(function () { if ($("ws-person").open) openPerson(id); });
    });
  }
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t.closest || !t.closest(".wsd")) return;
    var close = t.closest("[data-wsd-close]");
    if (close) { close.closest("dialog").close(); return; }
    var copy = t.closest("[data-wsd-copy]");
    if (copy) {
      var text = copy.getAttribute("data-wsd-copy"), input = copy.previousElementSibling;
      Promise.resolve().then(function () { return navigator.clipboard.writeText(text); }).then(function () { said("Link copied."); })
        .catch(function () { if (input) { input.focus(); input.select(); } said("Selected. Press Ctrl+C to copy."); });
      return;
    }
    var add = t.closest("[data-wsd-add]");
    if (add) { var k = add.getAttribute("data-wsd-add"); $(LISTS[k]).insertAdjacentHTML("beforeend", listRow(k, null)); var f = $(LISTS[k]).lastElementChild.querySelector("input, textarea"); if (f) f.focus(); return; }
    var del = t.closest("[data-wsd-del]");
    if (del) { del.parentElement.remove(); return; }
    var row = t.closest("[data-wsd-person]");
    if (row) { openPerson(row.getAttribute("data-wsd-person")); return; }
    var b = t.closest("[data-wsd]");
    if (!b) return;
    var a = b.getAttribute("data-wsd"), id = b.getAttribute("data-id");
    var s = ws.sessions[id], r = ws.rows.filter(function (x) { return x.id === id; })[0], x = ws.referrers.filter(function (y) { return y.id === id; })[0];
    var run = function (p, msg) { b.disabled = true; return p.then(function () { if (msg) said(msg); return load(); }).catch(failed).then(function () { b.disabled = false; }); };

    if (a === "session_edit") openEditor(s);
    else if (a === "session_copy") {
      // Release 7: copied on the server (content, settings, running order, questions), as a
      // draft with a new address and no date, registrations, Calendar event or Meet link.
      b.disabled = true;
      apiPost({ action: "session_copy", session_id: s.id }).then(function (j) {
        return load().then(function () {
          said("Copied as a draft at /workshops/" + j.slug + ". Give it its own title, then schedule it.");
          if (ws.sessions[j.id]) { openEditor(ws.sessions[j.id]); $("wse-f-title").select(); }
        });
      }).catch(failed).then(function () { b.disabled = false; });
    }
    else if (a === "session_delete" || a === "session_cancel") removeSession(s);
    else if (a === "session_publish") {
      ask({ title: (s.status === "closed" ? "Reopen" : "Open") + " registration for “" + s.title + "”?", yes: "Open registration",
        text: "It goes live on the website and people can book and pay straight away. Registration still closes by itself 7 days before the start.",
        run: function () { return apiPost({ action: "session_publish", session_id: s.id }).then(function () { said("Registration is open. The page is live."); return load(); }); } });
    } else if (a === "session_close") {
      ask({ title: "Close registration?", yes: "Close registration", text: "The page stays up but nobody new can book. Everyone who has paid keeps their place. You can reopen it later.",
        run: function () { return apiPost({ action: "session_close", session_id: s.id }).then(function () { said("Registration closed."); return load(); }); } });
    } else if (a === "session_complete") {
      ask({ title: "Mark “" + s.title + "” completed?", yes: "Mark completed", text: "It moves to Past and cancelled. Record attendance first if you haven't.",
        run: function () { return apiPost({ action: "session_complete", session_id: s.id }).then(function () { said("Marked completed."); return load(); }); } });
    } else if (a === "series_edit") {
      var ser = ws.series.filter(function (y) { return y.slug === id; })[0];
      ask({ title: "Series page text", yes: "Save", text: "Shown at the top of the workshops page and on each workshop in the series.",
        fields: [{ label: "Name", value: ser.name, min: 3 }, { label: "One-line positioning", value: ser.positioning },
          { label: "Introduction (blank line between paragraphs)", type: "textarea", rows: 6, value: (ser.intro || []).join("\n\n") },
          { label: "Standalone note", type: "textarea", rows: 2, value: ser.standalone }, { label: "Disclaimer", type: "textarea", rows: 3, value: ser.disclaimer }],
        run: function (name, pos, intro, alone, disc) {
          return apiPost({ action: "series_save", series: { slug: ser.slug, name: name, presenter: ser.presenter, positioning: pos,
            intro: intro.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean), standalone: alone, disclaimer: disc } }).then(function () { said("Series text saved. The page shows it now."); return load(); });
        } });
    } else if (a === "series_defaults") {
      var sx = ws.series.filter(function (y) { return y.slug === id; })[0], dd = sx.defaults || {};
      ask({ title: "Settings for " + sx.name, yes: "Save settings",
        text: "New workshops in this series start with these, and Schedule uses them. Changing them never changes a workshop that already exists; open that workshop to change it.",
        fields: [{ label: "Price (GHS)", type: "number", value: String(dd.price_ghs != null ? dd.price_ghs : 350), min: 1 },
          { label: "Open places", type: "number", value: String(dd.capacity || 25), min: 1 },
          { label: "Places kept for Intermediate graduates", type: "number", value: String(dd.reserved_graduate_seats != null ? dd.reserved_graduate_seats : 5), min: 1 },
          { label: "Graduates attend free", type: "select", options: [["yes", "Yes, in the kept places"], ["no", "No"]], value: dd.graduate_free === false ? "no" : "yes" },
          { label: "Foundations certificate discount (%)", type: "number", value: String(dd.foundations_discount_pct != null ? dd.foundations_discount_pct : 20), min: 1 },
          { label: "Length", type: "select", options: [["60", "1 hour"], ["90", "1.5 hours"], ["120", "2 hours"], ["150", "2.5 hours"], ["180", "3 hours"], ["240", "4 hours"]], value: String(dd.duration_minutes || 180) },
          { label: "Usual start time (GMT)", type: "time", value: dd.start_time || "11:30", min: 5 },
          { label: "How people join", type: "select", options: [["invite", "Google Calendar invitation, made automatically"], ["link", "Link in the confirmation email"]], value: dd.admission || "invite" }],
        run: function (price, cap, grad, free, fnd, dur, time, adm) {
          return apiPost({ action: "series_save", series: { slug: sx.slug, name: sx.name, presenter: sx.presenter, positioning: sx.positioning, intro: sx.intro || [],
            standalone: sx.standalone, disclaimer: sx.disclaimer,
            defaults: { kind: dd.kind || "workshop", format: dd.format || "live online", price_ghs: Number(price), capacity: Number(cap), reserved_graduate_seats: Number(grad),
              graduate_free: free === "yes", foundations_discount_pct: Number(fnd), duration_minutes: Number(dur), start_time: time, admission: adm } } })
            .then(function () { said("Series settings saved. Workshops you create or schedule from now on use them."); return load(); });
        } });
    } else if (a === "session_schedule") openSchedule(s);
    else if (a === "calendar_retry") {
      b.disabled = true;
      apiPost({ action: "calendar_retry", session_id: id }).then(function (j) {
        said(j.calendar === "created" ? "The Calendar event and Meet link are ready." : j.calendar === "moved" ? "The Calendar event is on the new time, and Google emailed everyone invited." : "The Calendar event is already in step.");
        return load().then(function () { if ($("ws-editor").open && editing && editing.id === id) calPanel(ws.sessions[id]); });
      }).catch(function (err) { failed(err); if ($("ws-editor").open) editorFailed(err, false); }).then(function () { b.disabled = false; });
    } else if (a === "open_person") openPerson(id);
    else if (a === "admit" || a === "retry_email" || a === "retry_calendar") run(regAction(a, id));
    else if (REG_CONFIRM[a]) {
      var c = REG_CONFIRM[a];
      ask({ title: c[0], text: c[1], yes: c[2], danger: a === "cancel", run: function () { return regAction(a, id); } });
    } else if (a === "note") {
      var note = $("wsp-note") ? $("wsp-note").value.trim() : "";
      if (note.length < 2) { failed(new Error("Write the note first.")); return; }
      run(regAction("note", id, { note: note }));
    } else if (a === "set_account") {
      ask({ title: "Google account for " + r.full_name, yes: "Save account",
        text: "The account they will join with. Change it only on a request from their registered email (" + r.email_normalized + "). The old account is removed from the invitation and the new one added.",
        fields: [{ label: "Google account email", type: "email", value: r.attend_email || "", min: 5 }],
        run: function (email) { return regAction("set_attend_email", id, { email: email }); } });
    } else if (a === "waitlist_remove") {
      ask({ title: "Remove from the waitlist?", danger: true, yes: "Remove", text: "The rest of the queue keeps its order.",
        fields: [{ label: "Reason (recorded)", min: 5 }],
        run: function (reason) { return apiPost({ waitlist_id: id, action: "waitlist_remove", value: reason }).then(function () { said("Removed from the waitlist."); return load(); }); } });
    } else if (a === "waitlist_retry_email") run(apiPost({ waitlist_id: id, action: "waitlist_retry_email" }), "Sending the email again.");
    else if (a === "void_commission") {
      ask({ title: "Void this commission?", danger: true, yes: "Void commission", text: "For a fraudulent or mistaken sale. It is recorded.",
        fields: [{ label: "Reason", min: 5 }],
        run: function (reason) { return apiPost({ registration_id: id, action: "void_commission", value: reason }).then(function () { said("Commission voided."); return load(); }); } });
    } else if (a === "referrer_payouts") {
      var owed = owedTo(x);
      ask({ title: "Record GHS " + cedis(owed.amount) + " paid to " + referrerName(x) + "?", yes: "Record payment",
        text: "Pay them yourself first" + (x.payout_method ? ", by " + x.payout_method : "") + ". Then enter the transaction reference so the payment is on record. It covers all " + owed.count + " paid place" + (owed.count === 1 ? "" : "s") + " owed now.",
        fields: [{ label: "MoMo or bank reference", min: 3 }],
        run: function (ref) { return apiPost({ action: "referrer_payouts", referrer_id: x.id, referrer: { reference: ref } }).then(function (j) { said("Recorded GHS " + cedis(j.amount_ghs) + " paid to " + referrerName(x) + "."); return load(); }); } });
    } else if (a === "referrer_suspend") run(apiPost({ action: "referrer_suspend", referrer_id: x.id }), x.code + " suspended. It works nowhere until reactivated.");
    else if (a === "referrer_activate") run(apiPost({ action: "referrer_activate", referrer_id: x.id }), x.code + " works on every workshop now.");
    else if (a === "referrer_edit") {
      ask({ title: "Details for " + x.code, yes: "Save details",
        fields: [{ label: "Name", value: x.name || "", min: 2 }, { label: "Email", type: "email", value: x.email || "", min: 5, hint: "They can't use their own code with this address." },
          { label: "How you pay their commission", value: x.payout_method || "", min: 3 }],
        run: function (name, email, pay) { return apiPost({ action: "referrer_update", referrer_id: x.id, referrer: { name: name, email: email, payout_method: pay } }).then(function () { said("Saved."); return load(); }); } });
    }
  });
  document.addEventListener("keydown", function (e) {
    var row = e.target.closest && e.target.closest("[data-wsd-person]");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openPerson(row.getAttribute("data-wsd-person")); }
  });
  document.addEventListener("change", function (e) {
    var id = e.target.getAttribute && e.target.getAttribute("data-wsd-att");
    if (!id) return;
    apiPost({ registration_id: id, action: "attendance", value: e.target.value }).then(function () { said("Attendance saved."); return load(); }).catch(failed);
  });

  $("ws-ref-new").addEventListener("click", function () {
    ask({ title: "Create a referral code", yes: "Create code", text: "For anyone, anywhere. It works on every workshop as soon as you create it.",
      fields: [{ label: "Their name", min: 2 }, { label: "Their email", type: "email", min: 5, hint: "They can't use their own code with this address." },
        { label: "How you pay their commission", min: 3, placeholder: "MoMo number, or bank or PayPal details" },
        { label: "Code (optional)", placeholder: "Leave blank to make one", hint: "4 to 16 letters and numbers." }],
      run: function (name, email, pay, code) {
        return apiPost({ action: "referrer_create", referrer: { name: name, email: email, payout_method: pay, code: code } }).then(function (j) { said(j.code + " created. It works on every workshop now."); return load(); });
      } });
  });
  $("ws-terms-edit").addEventListener("click", function () {
    $("ws-t-off").value = Number(ws.settings.referral_discount_ghs); $("ws-t-com").value = Number(ws.settings.referral_commission_ghs);
    $("ws-terms-form").hidden = false; $("ws-t-off").focus();
  });
  $("ws-terms-cancel").addEventListener("click", function () { $("ws-terms-form").hidden = true; });
  $("ws-terms-form").addEventListener("submit", function (e) {
    e.preventDefault();
    apiPost({ action: "referral_terms", referrer: { discount_ghs: Number($("ws-t-off").value), commission_ghs: Number($("ws-t-com").value) } })
      .then(function () { $("ws-terms-form").hidden = true; said("Saved. The new terms apply to every open workshop from now on."); return load(); }).catch(failed);
  });
  $("ws-grant-new").addEventListener("click", function () {
    var open = ordered(ws.list.filter(function (s) { return s.status === "published"; }));
    if (!open.length) { failed(new Error("No workshop is open for registration.")); return; }
    ask({ title: "Let a certificate holder use another email", yes: "Allow it",
      text: "For a holder whose email has changed. Check who they are yourself first. The new email can claim the certificate price once, for one workshop, for 7 days.",
      fields: [{ label: "Certificate ID", min: 6 }, { label: "Their new email", type: "email", min: 5 },
        { label: "Workshop", type: "select", options: open.map(function (s) { return [s.slug, s.title]; }), value: open[0].slug },
        { label: "How you checked it's them (recorded)", min: 5 }],
      run: function (cred, email, slug, reason) { return apiPost({ action: "grant_email", credential_id: cred, email: email, session: slug, value: reason }).then(function () { said("Allowed for 7 days. They can now apply the certificate with that email."); }); } });
  });

  /* ---------- tabs and filters ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.wsd-tabs [role="tab"]'));
  function pick(tab) {
    tabs.forEach(function (x) { var on = x === tab; x.setAttribute("aria-selected", String(on)); x.tabIndex = on ? 0 : -1; $(x.getAttribute("aria-controls")).hidden = !on; });
    try { sessionStorage.setItem("wsd-tab", tab.id); } catch (err) { /* private mode */ }
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { pick(tab); });
    tab.addEventListener("keydown", function (e) {
      var n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (n) { var nx = tabs[(i + n + tabs.length) % tabs.length]; pick(nx); nx.focus(); e.preventDefault(); }
    });
  });
  try { var remembered = $(sessionStorage.getItem("wsd-tab") || ""); if (remembered && tabs.indexOf(remembered) !== -1) pick(remembered); } catch (err) { /* private mode */ }
  ["ws-session", "ws-status", "ws-payment", "ws-attendance"].forEach(function (id) { $(id).addEventListener("change", function () { renderRegs(); campaigns(filtered()); }); });
  $("ws-q").addEventListener("input", function () { renderRegs(); campaigns(filtered()); });
  $("ws-spend").addEventListener("input", function () { campaigns(filtered()); });
  $("ws-csv").addEventListener("click", csv);
  $("refresh").addEventListener("click", load);
  document.addEventListener("admin:authenticated", load);
  if (session()) load();
})();

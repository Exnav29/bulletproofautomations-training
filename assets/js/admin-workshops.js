/* Webinars & workshops workspace for /admin/workshops/.
 *
 * Reads through the signed-in admin's Supabase session (RLS: the same email
 * allowlist as the cohort roll; read-only). Every change goes through
 * /api/admin/workshops, which re-checks the admin and calls the audited RPC.
 * Uses the shared session(), authFetch(), refresh() and esc() from admin.js,
 * the same way admin-payments.js does. Nothing here moves money. */
(function () {
  "use strict";
  if (document.documentElement.getAttribute("data-admin-view") !== "workshops") return;

  var STATUS = {
    pending_payment: "Awaiting payment",
    confirmed: "Confirmed",
    payment_received_review: "Payment held for review",
    refund_pending: "Refund requested",
    cancelled: "Cancelled",
    refunded: "Refunded"
  };
  var PAYMENT = {
    not_required: "Free",
    pending: "Not paid",
    paid: "Paid",
    needs_review: "Needs review",
    partially_refunded: "Partly refunded",
    refunded: "Refunded"
  };
  var REASON = {
    capacity: "Paid after the seat hold expired, session full",
    session_unavailable: "Paid for a session that was cancelled, closed or had started",
    registration_cancelled: "Paid after the registration was cancelled",
    duplicate_payment: "Paid more than once; access kept",
    payment_mismatch: "Amount, currency or mode did not match the checkout",
    partial_refund: "Partly refunded"
  };
  var ATTENDANCE = { unknown: "Not recorded", attended: "Attended", no_show: "No-show" };

  var ws = { sessions: {}, rows: [], attempts: {} };
  var $ = function (id) { return document.getElementById(id); };

  function fill(select, labels) {
    Object.keys(labels).forEach(function (k) {
      var o = document.createElement("option");
      o.value = k; o.textContent = labels[k];
      select.appendChild(o);
    });
  }
  fill($("ws-status"), STATUS);
  fill($("ws-payment"), PAYMENT);
  fill($("ws-attendance"), ATTENDANCE);

  function ghs(minor) {
    return (Number(minor || 0) / 100).toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function when(v) {
    var d = new Date(v);
    return isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function show(id, text) { var el = $(id); el.textContent = text || ""; el.hidden = !text; }

  function apiPost(body) {
    var current = session();
    if (!current) return Promise.reject(new Error("Not signed in"));
    var send = function (token) {
      return fetch("/api/admin/workshops", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body)
      });
    };
    var go = current.expires_at && Date.now() > current.expires_at
      ? refresh().then(function (fresh) { return send(fresh.access_token); })
      : send(current.access_token);
    return go.then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || "Refused."); return j; }); });
  }

  function getJson(path) {
    return authFetch(path).then(function (r) {
      if (r.status === 401 || r.status === 403) throw new Error("Workshop records are not available to this admin account.");
      if (r.status === 404) throw new Error("The workshop tables are not in this database yet (migration not applied).");
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || "Could not load workshop records."); });
      return r.json();
    });
  }

  function load() {
    show("ws-error", "");
    return Promise.all([
      getJson("/rest/v1/workshop_sessions?select=id,slug,kind,title,starts_at,status,price_ghs,capacity&order=starts_at.desc"),
      getJson("/rest/v1/workshop_registrations?select=*&order=created_at.desc"),
      getJson("/rest/v1/workshop_payment_attempts?select=registration_id,reference,status,amount_minor,received_minor,refunded_minor,mode,verified_via,created_at&order=created_at.asc")
    ]).then(function (out) {
      ws.sessions = {};
      out[0].forEach(function (s) { ws.sessions[s.id] = s; });
      ws.rows = out[1];
      ws.attempts = {};
      out[2].forEach(function (a) { (ws.attempts[a.registration_id] = ws.attempts[a.registration_id] || []).push(a); });
      var sel = $("ws-session"), keep = sel.value;
      sel.length = 1;
      out[0].forEach(function (s) {
        var o = document.createElement("option");
        o.value = s.id; o.textContent = s.title + " — " + when(s.starts_at);
        sel.appendChild(o);
      });
      sel.value = keep;
      render();
    }).catch(function (err) { show("ws-error", err.message); });
  }

  function filtered() {
    var f = { s: $("ws-session").value, st: $("ws-status").value, p: $("ws-payment").value, a: $("ws-attendance").value,
      q: $("ws-q").value.trim().toLowerCase() };
    return ws.rows.filter(function (r) {
      if (f.s && r.session_id !== f.s) return false;
      if (f.st && r.status !== f.st) return false;
      if (f.p && r.payment_status !== f.p) return false;
      if (f.a && r.attendance !== f.a) return false;
      if (f.q) {
        var hay = [r.full_name, r.email_normalized, r.utm_campaign, r.utm_content, r.utm_source].join(" ").toLowerCase();
        if (hay.indexOf(f.q) === -1) return false;
      }
      return true;
    });
  }

  function needsResolution(r) {
    return r.status === "payment_received_review" || r.status === "refund_pending" || r.payment_status === "needs_review";
  }

  function actions(r) {
    var b = [];
    if (r.status === "payment_received_review") b.push('<button class="mini" type="button" data-ws="admit" data-id="' + esc(r.id) + '">Admit</button>');
    if ((r.status === "payment_received_review" || r.status === "confirmed") &&
        ["paid", "needs_review", "partially_refunded"].indexOf(r.payment_status) !== -1) {
      b.push('<button class="mini" type="button" data-ws="request_refund" data-id="' + esc(r.id) + '">Request refund</button>');
    }
    if (r.review_reason === "duplicate_payment") b.push('<button class="mini" type="button" data-ws="resolve_duplicate" data-id="' + esc(r.id) + '">Note duplicate refund</button>');
    if (r.status === "pending_payment" && r.payment_status === "pending") b.push('<button class="mini" type="button" data-ws="cancel" data-id="' + esc(r.id) + '">Cancel</button>');
    return b.join(" ");
  }

  function render() {
    var rows = filtered();
    $("ws-count").textContent = rows.length;
    $("ws-rows").innerHTML = rows.map(function (r) {
      var s = ws.sessions[r.session_id] || {};
      var test = (ws.attempts[r.id] || []).some(function (a) { return a.mode === "test"; });
      return "<tr>" +
        "<td><strong>" + esc(r.full_name) + "</strong><br><small>" + esc(r.email_normalized) + "</small>" +
          (r.whatsapp ? "<br><small>" + esc(r.whatsapp) + (r.whatsapp_consent ? " (consented)" : "") + "</small>" : "") + "</td>" +
        "<td>" + esc(s.title || "—") + "</td>" +
        "<td>" + esc(STATUS[r.status] || r.status) + (r.review_reason ? "<br><small>" + esc(REASON[r.review_reason] || r.review_reason) + "</small>" : "") +
          (test ? ' <span class="tag tag--bad">TEST</span>' : "") + "</td>" +
        "<td>" + esc(PAYMENT[r.payment_status] || r.payment_status) + "</td>" +
        '<td class="num">' + ghs(r.amount_paid_minor) + "</td>" +
        '<td><label class="vh" for="att-' + esc(r.id) + '">Attendance for ' + esc(r.full_name) + "</label>" +
          '<select class="mini" id="att-' + esc(r.id) + '" data-ws-att="' + esc(r.id) + '">' +
          Object.keys(ATTENDANCE).map(function (k) { return '<option value="' + k + '"' + (r.attendance === k ? " selected" : "") + ">" + ATTENDANCE[k] + "</option>"; }).join("") +
          "</select></td>" +
        "<td>" + esc(r.utm_campaign || "—") + (r.utm_content ? "<br><small>" + esc(r.utm_content) + "</small>" : "") + "</td>" +
        "<td>" + esc(when(r.created_at)) + "</td>" +
        "<td>" + actions(r) + "</td></tr>";
    }).join("") || '<tr><td colspan="9">No registrations match.</td></tr>';

    var attention = ws.rows.filter(needsResolution);
    $("ws-attn-count").textContent = attention.length;
    $("ws-attention").innerHTML = attention.length ? "<ul>" + attention.map(function (r) {
      var s = ws.sessions[r.session_id] || {};
      return "<li><strong>" + esc(r.full_name) + "</strong>, " + esc(s.title || "") + ": " +
        esc(REASON[r.review_reason] || STATUS[r.status] || r.status) + ". GHS " + ghs(r.amount_paid_minor) + " held. " + actions(r) + "</li>";
    }).join("") + "</ul>" : '<p class="msg msg--empty">Nothing waiting.</p>';

    campaigns(rows);
  }

  /* ONE definition of a paid webinar enrollment, shared with Meta:
   * a CONFIRMED registration with a payment Paystack verified (the attempt in
   * status "succeeded"). Its value is that attempt, net of refunds; duplicate
   * payments never add to it. Money held for review is shown separately and
   * is not counted until an admin admits it — the moment the Conversions API
   * Purchase is sent. Mirrors workshop_apply_charge / workshop_admin_action
   * and /api/workshops/status. */
  function verifiedMinor(r) {
    var primary = (ws.attempts[r.id] || []).filter(function (a) { return a.status === "succeeded"; })[0];
    return primary ? Math.max(0, Number(primary.received_minor || 0) - Number(primary.refunded_minor || 0)) : 0;
  }
  function isConfirmedPaid(r) { return r.status === "confirmed" && verifiedMinor(r) > 0; }
  function isHeldForReview(r) { return r.status === "payment_received_review" && verifiedMinor(r) > 0; }

  function campaigns(rows) {
    var groups = {};
    rows.forEach(function (r) {
      if ((ws.attempts[r.id] || []).some(function (a) { return a.mode === "test"; })) return; // test checkouts never count
      var key = (r.utm_campaign || "(none)") + "\u0000" + (r.utm_content || "");
      var g = groups[key] = groups[key] || { c: r.utm_campaign || "(no campaign)", a: r.utm_content || "", n: 0, paid: 0, held: 0, rev: 0 };
      g.n += 1;
      if (isConfirmedPaid(r)) { g.paid += 1; g.rev += verifiedMinor(r); }
      else if (isHeldForReview(r)) g.held += 1;
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return y.paid - x.paid || y.n - x.n; });
    $("ws-camp-rows").innerHTML = list.map(function (g) {
      return "<tr><td>" + esc(g.c) + "</td><td>" + esc(g.a || "—") + '</td><td class="num">' + g.n + '</td><td class="num">' + g.paid +
        '</td><td class="num">' + g.held + '</td><td class="num">' + ghs(g.rev) + "</td></tr>";
    }).join("") || '<tr><td colspan="6">No live registrations yet.</td></tr>';
    var paid = list.reduce(function (t, g) { return t + g.paid; }, 0);
    var spend = Number($("ws-spend").value);
    $("ws-cac").textContent = spend > 0 && paid > 0 ? "GHS " + (spend / paid).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "—";
  }

  function csv() {
    var cols = ["registered_at", "session", "full_name", "email", "whatsapp", "whatsapp_consent", "status", "payment_status",
      "review_reason", "confirmed_paid", "verified_paid_ghs", "attendance", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "references"];
    var cell = function (v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.join(",")].concat(filtered().map(function (r) {
      var s = ws.sessions[r.session_id] || {};
      return [r.created_at, s.slug, r.full_name, r.email_normalized, r.whatsapp, r.whatsapp_consent, r.status, r.payment_status,
        r.review_reason, isConfirmedPaid(r) ? "yes" : "no", verifiedMinor(r) / 100, r.attendance, r.utm_source, r.utm_medium, r.utm_campaign,
        r.utm_content, r.utm_term, (ws.attempts[r.id] || []).map(function (a) { return a.reference + ":" + a.status; }).join(" ")].map(cell).join(",");
    }));
    var blob = new Blob([lines.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "workshop-registrations-" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  var CONFIRM = {
    request_refund: "Mark this registration for a refund? Issue the refund in the Paystack dashboard; the seat is released when Paystack reports it processed.",
    cancel: "Cancel this unpaid registration?",
    resolve_duplicate: "Record that the duplicate payment will be refunded in Paystack?"
  };

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-ws]");
    if (!btn) return;
    var action = btn.getAttribute("data-ws");
    if (CONFIRM[action] && !window.confirm(CONFIRM[action])) return;
    btn.disabled = true;
    apiPost({ registration_id: btn.getAttribute("data-id"), action: action })
      .then(function () { show("ws-message", "Saved."); return load(); })
      .catch(function (err) { show("ws-error", err.message); btn.disabled = false; });
  });
  document.addEventListener("change", function (e) {
    var id = e.target.getAttribute && e.target.getAttribute("data-ws-att");
    if (!id) return;
    apiPost({ registration_id: id, action: "attendance", value: e.target.value })
      .then(function () { show("ws-message", "Attendance saved."); })
      .catch(function (err) { show("ws-error", err.message); });
  });
  ["ws-session", "ws-status", "ws-payment", "ws-attendance"].forEach(function (id) { $(id).addEventListener("change", render); });
  $("ws-q").addEventListener("input", render);
  $("ws-spend").addEventListener("input", function () { campaigns(filtered()); });
  $("ws-csv").addEventListener("click", csv);
  $("refresh").addEventListener("click", load);
  document.addEventListener("admin:authenticated", load);
  if (session()) load();
})();

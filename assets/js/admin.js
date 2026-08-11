/* ==========================================================================
   Supabase, over plain REST.

   Injected at build time, exactly as the enrollment form's keys are. The anon
   key is public by design; what protects the roll is row-level security. This
   page reads nothing until a Supabase Auth session exists AND the table has a
   select policy for the authenticated role.
   ========================================================================== */

var SUPABASE_URL = "__SUPABASE_URL__";
var SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";
var CONFIGURED = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

/* Facts about the founding cohort, from the brief. Kept here rather than read
   from the data so an empty table still renders a meaningful board. */
var SEAT_CAP = 25;
var COHORTS = [{ id: "intermediate_2026_09", label: "Intermediate — Sept 2026" }];
var ENROLLMENT_CLOSES = "2026-09-08";
var COHORT_STARTS = "2026-09-12";

/* The CHECK vocabularies, verified against the live table. Every control is
   built from these, so the dashboard cannot write a value the table rejects. */
var OPTIONS = {
  cohort_only: { label: "Cohort only", price: 750 },
  cohort_and_assessment: { label: "Cohort + BCAB assessment", price: 1050 },
  path_b_readiness: { label: "Path B readiness", price: 150 }
};
var PAYMENT_STATES = {
  reserved: "Reserved",
  payment_pending: "Payment pending",
  partially_paid: "Partially paid",
  paid: "Paid",
  cancelled: "Cancelled"
};
var EXPERIENCE = {
  foundations_graduate: "Foundations graduate",
  experienced_builder: "Experienced builder",
  beginner: "Beginner"
};
var SOURCES = { website: "Website", showcase: "Showcase", whatsapp: "WhatsApp", referral: "Referral" };

var SESSION_KEY = "bpa_admin_session";

var state = { rows: [], sortBy: "created_at", sortDir: -1, editing: null };

/* --- Session ------------------------------------------------------------ */

function session(next) {
  if (next === undefined) {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch (e) { return null; }
  }
  if (next === null) sessionStorage.removeItem(SESSION_KEY);
  else sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

function storeToken(data) {
  return session({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    email: (data.user && data.user.email) || "",
    // Refresh a minute early rather than discover expiry mid-request.
    expires_at: Date.now() + (data.expires_in ? (data.expires_in - 60) * 1000 : 3000000)
  });
}

function authFetch(path, options) {
  var opts = options || {};
  var current = session();
  if (!current) return Promise.reject(new Error("Not signed in"));

  var run = function (token) {
    var headers = Object.assign({
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token
    }, opts.headers || {});
    return fetch(SUPABASE_URL + path, Object.assign({}, opts, { headers: headers }));
  };

  // Refresh proactively; a stale token otherwise fails every call on the page.
  if (current.expires_at && Date.now() > current.expires_at) {
    return refresh().then(function (fresh) { return run(fresh.access_token); });
  }
  return run(current.access_token);
}

function refresh() {
  var current = session();
  return fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: current.refresh_token })
  }).then(function (r) {
    if (!r.ok) { session(null); showSignin(); throw new Error("Session expired. Sign in again."); }
    return r.json();
  }).then(storeToken);
}

/* --- Sign in / out ------------------------------------------------------ */

// Both screens use the hidden attribute rather than a style, so exactly one is
// ever exposed to assistive technology — which is what keeps two h1 elements in
// the document from being two h1 elements in the accessibility tree.
function showSignin() {
  document.getElementById("signin").hidden = false;
  document.getElementById("dash").hidden = true;
}

function showDash() {
  var s = session();
  document.getElementById("signin").hidden = true;
  document.getElementById("dash").hidden = false;
  document.getElementById("who").textContent = s && s.email ? s.email : "";
}

document.getElementById("signin-form").addEventListener("submit", function (event) {
  event.preventDefault();
  var errorBox = document.getElementById("signin-error");
  var button = document.getElementById("signin-btn");
  errorBox.hidden = true;

  if (!CONFIGURED) {
    errorBox.textContent = "This build has no Supabase values. Set SUPABASE_URL and SUPABASE_ANON_KEY and rebuild.";
    errorBox.hidden = false;
    return;
  }

  button.disabled = true;
  button.innerHTML = '<span class="spin"></span> Signing in…';

  fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({
      email: document.getElementById("email").value.trim(),
      password: document.getElementById("password").value
    })
  }).then(function (response) {
    return response.json().then(function (body) {
      if (!response.ok) throw new Error(body.error_description || body.msg || "Could not sign in.");
      return body;
    });
  }).then(function (data) {
    storeToken(data);
    document.getElementById("password").value = "";
    showDash();
    load();
  }).catch(function (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }).then(function () {
    button.disabled = false;
    button.textContent = "Sign in";
  });
});

document.getElementById("signout").addEventListener("click", function () {
  var current = session();
  if (current) {
    fetch(SUPABASE_URL + "/auth/v1/logout", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + current.access_token }
    }).catch(function () { /* signing out locally matters more than the round trip */ });
  }
  session(null);
  showSignin();
});

/* --- Load --------------------------------------------------------------- */

function load() {
  var errorBox = document.getElementById("load-error");
  errorBox.hidden = true;

  var cohort = document.getElementById("cohort").value;
  var query = "/rest/v1/enrollments?select=*&order=created_at.desc";
  if (cohort) query += "&cohort=eq." + encodeURIComponent(cohort);

  return authFetch(query)
    .then(function (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Signed in, but the roll refused the read. The enrollments table needs a select policy for the authenticated role.");
      }
      if (!response.ok) return response.text().then(function (t) { throw new Error(t || "Could not load."); });
      return response.json();
    })
    .then(function (rows) {
      state.rows = rows;
      renderAll();
      /* The ledger loads after the roll, because reconciliation needs both:
         an event is only "matched" against an enrollment we already hold. */
      loadPayments();
      /* The register and the enquiry list stand on their own — a credential can
         exist with no enrollment behind it (Path B), so neither waits on the
         roll, and a failure in either must not take the dashboard down. */
      loadCredentials();
      loadEnquiries();
    })
    .catch(function (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    });
}

/* --- Helpers ------------------------------------------------------------ */

function ghs(n) { return "GHS " + Number(n || 0).toLocaleString("en-GB"); }
function esc(s) {
  // textContent handles & < >; the quote replacements make the result safe
  // in an attribute value too, so a future call site cannot reintroduce an
  // injection by moving an escaped value into an attribute.
  var d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML.split('"').join("&quot;").split("'").join("&#39;");
}
function daysUntil(iso) { return Math.ceil((new Date(iso + "T00:00:00") - new Date()) / 86400000); }
function shortDate(v) {
  if (!v) return "—";
  return new Date(v).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
function isLive(row) { return row.payment_status !== "cancelled"; }
function outstanding(row) { return Math.max(0, Number(row.amount_ghs || 0) - Number(row.amount_paid_ghs || 0)); }

/* --- Render ------------------------------------------------------------- */

function renderAll() { renderBoard(); renderQueues(); renderMix(); renderRoll(); renderPayments(); }

function renderBoard() {
  var live = state.rows.filter(isLive);
  var paid = live.filter(function (r) { return r.payment_status === "paid"; });
  var part = live.filter(function (r) { return r.payment_status === "partially_paid"; });

  var expected = live.reduce(function (t, r) { return t + Number(r.amount_ghs || 0); }, 0);
  var collected = live.reduce(function (t, r) { return t + Number(r.amount_paid_ghs || 0); }, 0);

  var toClose = daysUntil(ENROLLMENT_CLOSES);
  var toStart = daysUntil(COHORT_STARTS);
  var pct = function (n) { return Math.min(100, (n / SEAT_CAP) * 100); };

  document.getElementById("board").innerHTML =
    '<div class="board__cell">' +
      '<p class="board__k">Seats taken</p>' +
      '<p class="board__v">' + live.length + " <span style=\"font-size:1rem;color:var(--muted)\">of " + SEAT_CAP + "</span></p>" +
      '<div class="gauge"><div class="gauge__fill" style="width:' + pct(live.length) + '%"></div></div>' +
      '<p class="board__sub">' + paid.length + " paid in full · " + part.length + " part-paid · " +
        (live.length - paid.length - part.length) + " unpaid</p>" +
    "</div>" +
    '<div class="board__cell">' +
      '<p class="board__k">Collected</p>' +
      '<p class="board__v">' + ghs(collected) + "</p>" +
      '<div class="gauge"><div class="gauge__fill" style="width:' + (expected ? (collected / expected) * 100 : 0) + '%"></div></div>' +
      '<p class="board__sub">of ' + ghs(expected) + " committed · " + ghs(expected - collected) + " outstanding</p>" +
    "</div>" +
    '<div class="board__cell' + (toClose <= 7 ? " board__cell--urgent" : "") + '">' +
      '<p class="board__k">Enrollment closes</p>' +
      '<p class="board__v">' + (toClose > 0 ? toClose + "d" : "closed") + "</p>" +
      '<p class="board__sub">Tuesday 8 September 2026</p>' +
    "</div>" +
    '<div class="board__cell">' +
      '<p class="board__k">Cohort starts</p>' +
      '<p class="board__v">' + (toStart > 0 ? toStart + "d" : "started") + "</p>" +
      '<p class="board__sub">Saturday 12 September 2026</p>' +
    "</div>";
}

function renderQueues() {
  var live = state.rows.filter(isLive);
  var queues = [
    ["Payment outstanding", "unpaid", live.filter(function (r) { return outstanding(r) > 0; }).length],
    ["Not contacted on WhatsApp", "no-whatsapp", live.filter(function (r) { return !r.whatsapp_contacted; }).length],
    ["Not invited to Slack", "no-slack", live.filter(function (r) { return !r.slack_invited; }).length],
    ["On instalments", "instalments", live.filter(function (r) { return r.payment_plan; }).length],
    ["No consent recorded", "no-consent", live.filter(function (r) { return !r.consent_given; }).length],
    ["Beginners — belong in Foundations", "beginner", live.filter(function (r) { return r.experience_level === "beginner"; }).length],
    ["No seat assigned", "", live.filter(function (r) { return !r.seat_number; }).length]
  ];

  document.getElementById("queues").innerHTML = queues.map(function (q) {
    var label = q[1]
      ? '<button type="button" data-queue="' + q[1] + '">' + q[0] + "</button>"
      : '<span class="queue__k">' + q[0] + "</span>";
    return '<div class="queue">' + label +
      '<span class="queue__n" data-zero="' + (q[2] === 0 ? "1" : "0") + '">' + q[2] + "</span></div>";
  }).join("");

  Array.prototype.forEach.call(document.querySelectorAll("[data-queue]"), function (button) {
    button.addEventListener("click", function () {
      document.getElementById("f-flag").value = button.getAttribute("data-queue");
      renderRoll();
      document.getElementById("roll-title").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function barGroup(title, counts, dict) {
  var total = Object.keys(counts).reduce(function (t, k) { return t + counts[k]; }, 0) || 1;
  return '<p class="board__k" style="margin-top:var(--s5)">' + title + "</p>" +
    '<div class="bars" style="margin-top:var(--s3)">' +
      Object.keys(dict).map(function (key) {
        var n = counts[key] || 0;
        return '<div class="bar"><span class="bar__k">' + esc(dict[key]) + "</span>" +
          '<span class="bar__n">' + n + "</span>" +
          '<span class="bar__track"><span class="bar__fill" style="width:' + (n / total) * 100 + '%"></span></span></div>';
      }).join("") +
    "</div>";
}

function renderMix() {
  var live = state.rows.filter(isLive);
  var tally = function (field) {
    return live.reduce(function (acc, row) {
      var key = row[field] || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  };
  document.getElementById("mix").innerHTML =
    barGroup("Option chosen", tally("chosen_option"), {
      cohort_only: OPTIONS.cohort_only.label,
      cohort_and_assessment: OPTIONS.cohort_and_assessment.label,
      path_b_readiness: OPTIONS.path_b_readiness.label
    }) +
    barGroup("Route in", tally("experience_level"), EXPERIENCE) +
    barGroup("Source", tally("source"), SOURCES);
}

function visibleRows() {
  var q = document.getElementById("q").value.trim().toLowerCase();
  var option = document.getElementById("f-option").value;
  var payment = document.getElementById("f-payment").value;
  var experience = document.getElementById("f-exp").value;
  var source = document.getElementById("f-source").value;
  var flag = document.getElementById("f-flag").value;

  var rows = state.rows.filter(function (r) {
    if (option && r.chosen_option !== option) return false;
    if (payment && r.payment_status !== payment) return false;
    if (experience && r.experience_level !== experience) return false;
    if (source && r.source !== source) return false;
    if (flag === "unpaid" && !(isLive(r) && outstanding(r) > 0)) return false;
    if (flag === "instalments" && !r.payment_plan) return false;
    if (flag === "no-whatsapp" && r.whatsapp_contacted) return false;
    if (flag === "no-slack" && r.slack_invited) return false;
    if (flag === "no-consent" && r.consent_given) return false;
    if (flag === "beginner" && r.experience_level !== "beginner") return false;
    if (q) {
      var hay = [r.full_name, r.email, r.whatsapp, r.city].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  var key = state.sortBy;
  return rows.sort(function (a, b) {
    var x = a[key], y = b[key];
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * state.sortDir;
    return String(x).localeCompare(String(y)) * state.sortDir;
  });
}

function renderRoll() {
  var rows = visibleRows();
  document.getElementById("roll-count").textContent =
    rows.length + (rows.length === state.rows.length ? "" : " of " + state.rows.length);

  var empty = document.getElementById("empty");
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.rows.length
      ? "No enrollments match these filters."
      : "No enrollments in this cohort yet. If you expected rows here, check that the enrollments table has a select policy for the authenticated role — without one the read succeeds and returns nothing.";
  } else {
    empty.hidden = true;
  }

  document.getElementById("rows").innerHTML = rows.map(function (r) {
    var flags = [];
    if (!r.consent_given) flags.push("no consent");
    if (r.payment_plan) flags.push("instalments");
    if (!r.whatsapp_contacted) flags.push("no WhatsApp");
    if (r.experience_level === "beginner") flags.push("beginner");

    var tagClass = r.payment_status === "paid" ? " tag--paid"
      : r.payment_status === "partially_paid" ? " tag--part"
      : r.payment_status === "cancelled" ? " tag--cancelled" : "";

    return "<tr>" +
      '<td><span class="roll__name">' + esc(r.full_name) + "</span>" +
        '<span class="roll__sub">' + esc(r.email) + " · " + esc(r.whatsapp) + (r.city ? " · " + esc(r.city) : "") + "</span>" +
        (flags.length ? '<span class="flag">' + flags.join(" · ") + "</span>" : "") + "</td>" +
      "<td>" + esc((OPTIONS[r.chosen_option] || {}).label || r.chosen_option) +
        '<span class="roll__sub">' + esc(EXPERIENCE[r.experience_level] || r.experience_level || "") + "</span></td>" +
      '<td class="num">' + ghs(r.amount_ghs) + "</td>" +
      '<td class="num">' + ghs(r.amount_paid_ghs) +
        (outstanding(r) > 0 && isLive(r) ? '<span class="roll__sub">' + ghs(outstanding(r)) + " due</span>" : "") + "</td>" +
      '<td><span class="tag' + tagClass + '">' + esc(PAYMENT_STATES[r.payment_status] || r.payment_status) + "</span></td>" +
      '<td class="num">' + esc(r.seat_number || "—") + "</td>" +
      "<td>" + shortDate(r.created_at) + "</td>" +
      '<td><button class="mini" type="button" data-edit="' + esc(r.id) + '">Open</button></td>' +
      "</tr>";
  }).join("");

  Array.prototype.forEach.call(document.querySelectorAll("[data-edit]"), function (button) {
    button.addEventListener("click", function () { openDrawer(button.getAttribute("data-edit")); });
  });
}

/* --- Drawer ------------------------------------------------------------- */

function openDrawer(id) {
  var row = state.rows.filter(function (r) { return r.id === id; })[0];
  if (!row) return;
  state.editing = row;

  document.getElementById("drawer-name").textContent = row.full_name;
  document.getElementById("drawer-meta").innerHTML =
    [["Email", row.email], ["WhatsApp", row.whatsapp], ["City", row.city],
     ["Option", (OPTIONS[row.chosen_option] || {}).label || row.chosen_option],
     ["Route in", EXPERIENCE[row.experience_level] || row.experience_level],
     ["Committed", ghs(row.amount_ghs)],
     ["Instalments", row.payment_plan ? "Yes — first " + ghs(row.first_instalment_ghs) : "No"],
     ["Consent given", row.consent_given ? "Yes" : "No"],
     ["Source", SOURCES[row.source] || row.source || "—"],
     ["Reserved", new Date(row.created_at).toLocaleString("en-GB")]
    ].map(function (pair) {
      return "<div><dt>" + esc(pair[0]) + "</dt><dd>" + esc(pair[1] == null ? "—" : pair[1]) + "</dd></div>";
    }).join("");

  document.getElementById("e-payment").value = row.payment_status || "reserved";
  document.getElementById("e-paid").value = row.amount_paid_ghs == null ? "" : row.amount_paid_ghs;
  document.getElementById("e-ref").value = row.paystack_reference || "";
  document.getElementById("e-paydate").value = row.paystack_payment_date ? row.paystack_payment_date.slice(0, 10) : "";
  document.getElementById("e-seat").value = row.seat_number || "";
  document.getElementById("e-contact").value = row.contact_date ? row.contact_date.slice(0, 10) : "";
  document.getElementById("e-whatsapp").checked = !!row.whatsapp_contacted;
  document.getElementById("e-slack").checked = !!row.slack_invited;
  document.getElementById("e-notes").value = row.notes || "";
  document.getElementById("drawer-error").hidden = true;

  document.getElementById("drawer").hidden = false;
  document.getElementById("drawer-panel").focus();
}

function closeDrawer() {
  document.getElementById("drawer").hidden = true;
  state.editing = null;
}

document.getElementById("drawer-close").addEventListener("click", closeDrawer);
document.getElementById("drawer-veil").addEventListener("click", closeDrawer);
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !document.getElementById("drawer").hidden) closeDrawer();
});

document.getElementById("drawer-form").addEventListener("submit", function (event) {
  event.preventDefault();
  if (!state.editing) return;

  var errorBox = document.getElementById("drawer-error");
  var button = document.getElementById("drawer-save");
  errorBox.hidden = true;

  var seat = document.getElementById("e-seat").value;
  var paid = document.getElementById("e-paid").value;
  var payDate = document.getElementById("e-paydate").value;
  var contact = document.getElementById("e-contact").value;

  var patch = {
    payment_status: document.getElementById("e-payment").value,
    amount_paid_ghs: paid === "" ? 0 : Number(paid),
    paystack_reference: document.getElementById("e-ref").value.trim() || null,
    paystack_payment_date: payDate ? new Date(payDate + "T00:00:00Z").toISOString() : null,
    seat_number: seat === "" ? null : Number(seat),
    contact_date: contact ? new Date(contact + "T00:00:00Z").toISOString() : null,
    whatsapp_contacted: document.getElementById("e-whatsapp").checked,
    slack_invited: document.getElementById("e-slack").checked,
    notes: document.getElementById("e-notes").value.trim() || null,
    updated_at: new Date().toISOString()
  };

  button.disabled = true;
  button.innerHTML = '<span class="spin"></span> Saving…';

  authFetch("/rest/v1/enrollments?id=eq." + encodeURIComponent(state.editing.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  }).then(function (response) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("The table refused the write. enrollments needs an update policy for the authenticated role.");
    }
    if (!response.ok) return response.text().then(function (t) { throw new Error(t || "Could not save."); });
    Object.assign(state.editing, patch);
    renderAll();
    closeDrawer();
  }).catch(function (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  }).then(function () {
    button.disabled = false;
    button.textContent = "Save changes";
  });
});

/* --- CSV ---------------------------------------------------------------- */

document.getElementById("csv").addEventListener("click", function () {
  var cols = ["full_name", "email", "whatsapp", "city", "experience_level", "chosen_option",
    "amount_ghs", "amount_paid_ghs", "payment_status", "payment_plan", "first_instalment_ghs",
    "paystack_reference", "paystack_payment_date", "seat_number", "slack_invited",
    "whatsapp_contacted", "contact_date", "consent_given", "source", "cohort", "created_at", "notes"];

  var cell = function (v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
  };

  var csv = [cols.join(",")].concat(visibleRows().map(function (r) {
    return cols.map(function (c) { return cell(r[c]); }).join(",");
  })).join("\n");

  var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  var link = document.createElement("a");
  link.href = url;
  link.download = "enrollments-" + new Date().toISOString().slice(0, 10) + ".csv";
  link.click();
  URL.revokeObjectURL(url);
});

/* --- Wiring ------------------------------------------------------------- */

function fillSelect(id, dict, keepFirst) {
  var select = document.getElementById(id);
  var first = keepFirst ? select.innerHTML : "";
  select.innerHTML = first + Object.keys(dict).map(function (key) {
    return '<option value="' + key + '">' + esc(typeof dict[key] === "string" ? dict[key] : dict[key].label) + "</option>";
  }).join("");
}

fillSelect("f-option", OPTIONS, true);
fillSelect("f-payment", PAYMENT_STATES, true);
fillSelect("f-exp", EXPERIENCE, true);
fillSelect("f-source", SOURCES, true);
fillSelect("e-payment", PAYMENT_STATES, false);

document.getElementById("cohort").innerHTML = COHORTS.map(function (c) {
  return '<option value="' + c.id + '">' + esc(c.label) + "</option>";
}).join("");

["q", "f-option", "f-payment", "f-exp", "f-source", "f-flag"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", renderRoll);
});

document.getElementById("clear").addEventListener("click", function () {
  ["q", "f-option", "f-payment", "f-exp", "f-source", "f-flag"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
  renderRoll();
});

Array.prototype.forEach.call(document.querySelectorAll("[data-sort]"), function (button) {
  button.addEventListener("click", function () {
    var key = button.getAttribute("data-sort");
    state.sortDir = state.sortBy === key ? -state.sortDir : 1;
    state.sortBy = key;
    renderRoll();
  });
});

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("cohort").addEventListener("change", load);

if (session()) { showDash(); load(); } else { showSignin(); }

/* ==========================================================================
   Payments — the Paystack event ledger.

   enrollments answers "where does this learner stand right now". It cannot
   answer "what did Paystack actually say, and when" — which is the only thing
   that settles a dispute or a double charge. payment_events does, because the
   webhook writes every event verbatim BEFORE any money is applied to the roll.

   This view is deliberately read-only. Nothing here can edit an event: a
   ledger you can edit is not evidence. Corrections happen on the roll, where
   they are visible as corrections.
   ========================================================================== */

state.payments = [];
state.paySortBy = "received_at";
state.paySortDir = -1;

/* Paystack sets data.status to "success" on a completed charge. An event that
   failed signature verification is never counted as money, however it reads —
   an unverified payload is an assertion by whoever sent it. */
function isConfirmed(e) { return !!e.signature_valid && e.status === "success"; }

function ledgerFor(enrollmentId) {
  return state.payments.reduce(function (total, e) {
    return e.enrollment_id === enrollmentId && isConfirmed(e)
      ? total + Number(e.amount_ghs || 0)
      : total;
  }, 0);
}

/* Rows where the roll and the ledger disagree.
   Instalments arranged through Slack and paid by MoMo are recorded by hand and
   have no Paystack event by design, so a row only qualifies once Paystack is
   involved at all — otherwise every legitimate manual payment would flag. */
function mismatches() {
  if (!state.payments.length) return [];
  return state.rows.filter(isLive).filter(function (r) {
    var led = ledgerFor(r.id);
    if (led === 0 && !r.paystack_reference) return false;
    return Math.abs(led - Number(r.amount_paid_ghs || 0)) > 0.005;
  });
}

function unmatched() { return state.payments.filter(function (e) { return !e.matched; }); }
function rejected() { return state.payments.filter(function (e) { return !e.signature_valid; }); }

function stamp(v) {
  if (!v) return "—";
  return new Date(v).toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit"
  });
}

function enrollmentName(id) {
  var row = state.rows.filter(function (r) { return r.id === id; })[0];
  return row ? row.full_name : null;
}

/* --- Render ------------------------------------------------------------- */

function renderPayments() { renderPayBoard(); renderPayAttention(); renderPayRows(); }

function renderPayBoard() {
  var confirmed = state.payments.filter(isConfirmed);
  var collected = confirmed.reduce(function (t, e) { return t + Number(e.amount_ghs || 0); }, 0);
  var bad = rejected().length;
  var loose = unmatched().length;

  document.getElementById("pay-board").innerHTML =
    '<div class="board__cell">' +
      '<p class="board__k">Events received</p>' +
      '<p class="board__v">' + state.payments.length + "</p>" +
      '<p class="board__sub">' + (state.payments.length - bad) + " verified · " + bad + " rejected</p>" +
    "</div>" +

    '<div class="board__cell">' +
      '<p class="board__k">Confirmed through Paystack</p>' +
      '<p class="board__v">' + ghs(collected) + "</p>" +
      '<p class="board__sub">' + confirmed.length + " successful charge" + (confirmed.length === 1 ? "" : "s") + "</p>" +
    "</div>" +

    '<div class="board__cell' + (loose ? " board__cell--urgent" : "") + '">' +
      '<p class="board__k">Matched no enrollment</p>' +
      '<p class="board__v">' + loose + "</p>" +
      '<p class="board__sub">' + (loose ? "Money arrived that is not on the roll. Link it by hand." : "Every event found its learner.") + "</p>" +
    "</div>" +

    '<div class="board__cell' + (bad ? " board__cell--alarm" : "") + '">' +
      '<p class="board__k">Signature rejected</p>' +
      '<p class="board__v">' + bad + "</p>" +
      '<p class="board__sub">' + (bad ? "Not from Paystack, or the secret is wrong. Never applied to the roll." : "Nothing has failed verification.") + "</p>" +
    "</div>";
}

function renderPayAttention() {
  var bad = rejected().length;
  var loose = unmatched().length;
  var off = mismatches().length;

  var items = [
    ["Events matching no enrollment", loose, "unmatched"],
    ["Events failing signature verification", bad, "invalid"],
    ["Roll and ledger disagree", off, null]
  ];

  var anything = loose + bad + off;

  document.getElementById("pay-attn").innerHTML = anything
    ? items.map(function (item) {
        if (!item[1]) return "";
        return '<div class="queue">' +
          (item[2]
            ? '<button type="button" data-pjump="' + item[2] + '">' + esc(item[0]) + "</button>"
            : '<span class="queue__k">' + esc(item[0]) + "</span>") +
          '<span class="queue__n">' + item[1] + "</span></div>";
      }).join("")
    : '<div class="queue"><span class="queue__k">Nothing outstanding. Every event verified and matched.</span>' +
      '<span class="queue__n" data-zero="1">0</span></div>';

  Array.prototype.forEach.call(document.querySelectorAll("[data-pjump]"), function (button) {
    button.addEventListener("click", function () {
      document.getElementById("f-pflag").value = button.getAttribute("data-pjump");
      renderPayRows();
    });
  });
}

function visiblePayments() {
  var q = document.getElementById("pq").value.trim().toLowerCase();
  var eventType = document.getElementById("f-event").value;
  var flag = document.getElementById("f-pflag").value;

  var rows = state.payments.filter(function (e) {
    if (eventType && e.event !== eventType) return false;
    if (flag === "invalid" && e.signature_valid) return false;
    if (flag === "unmatched" && e.matched) return false;
    if (flag === "success" && !isConfirmed(e)) return false;
    if (q) {
      var hay = [e.reference, e.email, e.event, e.status].join(" ").toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });

  var key = state.paySortBy;
  return rows.sort(function (a, b) {
    var x = a[key], y = b[key];
    if (x == null) return 1;
    if (y == null) return -1;
    if (key === "amount_ghs") return (Number(x) - Number(y)) * state.paySortDir;
    return String(x).localeCompare(String(y)) * state.paySortDir;
  });
}

function renderPayRows() {
  var rows = visiblePayments();
  var empty = document.getElementById("pay-empty");

  if (!state.payments.length) {
    empty.textContent = "Nothing has arrived from Paystack yet. If payments have been taken, check that the "
      + "paystack-webhook function is deployed and that the webhook URL is set in the Paystack dashboard. "
      + "Until then, payments are whatever has been recorded by hand on the roll.";
    empty.hidden = false;
  } else if (!rows.length) {
    empty.textContent = "No events match those filters.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  document.getElementById("pay-rows").innerHTML = rows.map(function (e) {
    var checks =
      '<span class="tag ' + (e.signature_valid ? "tag--ok" : "tag--bad") + '">' +
        (e.signature_valid ? "Signed" : "Unsigned") + "</span> " +
      '<span class="tag ' + (e.matched ? "tag--paid" : "tag--part") + '">' +
        (e.matched ? "Matched" : "Unmatched") + "</span>";

    var who = e.matched ? enrollmentName(e.enrollment_id) : null;

    return "<tr>" +
      "<td>" + stamp(e.received_at) + "</td>" +
      "<td>" + esc(e.event || "—") +
        (e.email ? '<span class="roll__sub">' + esc(e.email) + "</span>" : "") + "</td>" +
      '<td><span class="mono">' + esc(e.reference || "—") + "</span>" +
        (who ? '<span class="roll__sub">' + esc(who) + "</span>" : "") + "</td>" +
      '<td class="num">' + (e.amount_ghs == null ? "—" : ghs(e.amount_ghs)) + "</td>" +
      "<td>" + esc(e.status || "—") + "</td>" +
      "<td>" + checks +
        (e.match_note ? '<span class="roll__sub">' + esc(e.match_note) + "</span>" : "") + "</td>" +
      '<td><button class="mini" type="button" data-pevent="' + esc(e.id) + '">Open</button></td>' +
      "</tr>";
  }).join("");

  Array.prototype.forEach.call(document.querySelectorAll("[data-pevent]"), function (button) {
    button.addEventListener("click", function () { openPayDrawer(button.getAttribute("data-pevent")); });
  });
}

/* --- Detail drawer ------------------------------------------------------ */

function openPayDrawer(id) {
  var e = state.payments.filter(function (row) { return row.id === id; })[0];
  if (!e) return;

  document.getElementById("pdrawer-name").textContent = e.event || "Payment event";
  document.getElementById("pdrawer-meta").innerHTML =
    [["Received", stamp(e.received_at)],
     ["Provider", e.provider],
     ["Reference", e.reference],
     ["Customer email", e.email],
     ["Amount", e.amount_ghs == null ? "—" : ghs(e.amount_ghs)],
     ["Paystack status", e.status],
     ["Taken at", e.paid_at ? stamp(e.paid_at) : "—"],
     ["Signature", e.signature_valid ? "Verified" : "Rejected — never applied to the roll"],
     ["Matched", e.matched ? "Yes" : "No"],
     ["Enrollment", e.matched ? (enrollmentName(e.enrollment_id) || e.enrollment_id) : "—"],
     ["Match note", e.match_note]
    ].map(function (pair) {
      return "<div><dt>" + esc(pair[0]) + "</dt><dd>" + esc(pair[1] == null || pair[1] === "" ? "—" : pair[1]) + "</dd></div>";
    }).join("");

  var raw;
  try { raw = JSON.stringify(e.raw, null, 2); }
  catch (err) { raw = String(e.raw); }
  document.getElementById("pdrawer-raw").textContent = raw;

  document.getElementById("pdrawer").hidden = false;
  document.getElementById("pdrawer-panel").focus();
}

function closePayDrawer() { document.getElementById("pdrawer").hidden = true; }

document.getElementById("pdrawer-close").addEventListener("click", closePayDrawer);
document.getElementById("pdrawer-veil").addEventListener("click", closePayDrawer);
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !document.getElementById("pdrawer").hidden) closePayDrawer();
});

document.getElementById("pdrawer-copy").addEventListener("click", function () {
  var button = this;
  var text = document.getElementById("pdrawer-raw").textContent;
  var done = function () {
    button.textContent = "Copied";
    setTimeout(function () { button.textContent = "Copy raw JSON"; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { button.textContent = "Copy failed"; });
  } else {
    button.textContent = "Copy failed";
  }
});

/* --- Filters, sorting, export ------------------------------------------- */

function fillEventFilter() {
  var select = document.getElementById("f-event");
  var chosen = select.value;
  var seen = {};
  state.payments.forEach(function (e) { if (e.event) seen[e.event] = true; });
  select.innerHTML = '<option value="">All event types</option>' +
    Object.keys(seen).sort().map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + "</option>";
    }).join("");
  select.value = chosen;
}

/* --- Load --------------------------------------------------------------- */

function loadPayments() {
  var errorBox = document.getElementById("pay-error");
  errorBox.hidden = true;

  return authFetch("/rest/v1/payment_events?select=*&order=received_at.desc")
    .then(function (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Signed in, but the ledger refused the read. payment_events needs a select policy for the authenticated role.");
      }
      if (!response.ok) return response.text().then(function (t) { throw new Error(t || "Could not load payments."); });
      return response.json();
    })
    .then(function (rows) {
      state.payments = rows;
      fillEventFilter();
      renderPayments();
    })
    .catch(function (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    });
}

["pq", "f-event", "f-pflag"].forEach(function (id) {
  document.getElementById(id).addEventListener("input", renderPayRows);
});

document.getElementById("pay-clear").addEventListener("click", function () {
  ["pq", "f-event", "f-pflag"].forEach(function (id) { document.getElementById(id).value = ""; });
  renderPayRows();
});

Array.prototype.forEach.call(document.querySelectorAll("[data-psort]"), function (button) {
  button.addEventListener("click", function () {
    var key = button.getAttribute("data-psort");
    state.paySortDir = state.paySortBy === key ? -state.paySortDir : 1;
    state.paySortBy = key;
    renderPayRows();
  });
});

document.getElementById("pay-csv").addEventListener("click", function () {
  var cols = ["received_at", "provider", "event", "reference", "email", "amount_ghs",
    "status", "paid_at", "signature_valid", "matched", "match_note", "enrollment_id"];

  var cell = function (v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
  };

  var csv = [cols.join(",")].concat(visiblePayments().map(function (e) {
    return cols.map(function (c) { return cell(e[c]); }).join(",");
  })).join("\n");

  var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  var link = document.createElement("a");
  link.href = url;
  link.download = "payment-events-" + new Date().toISOString().slice(0, 10) + ".csv";
  link.click();
  URL.revokeObjectURL(url);
});

/* ---------------------------------------------------------------------------
   Credentials — the register behind /verify

   This is the only place a credential comes into existence. Issuing writes the
   row that the public lookup reads, with no deploy in between.

   Two rules the UI enforces because the database cannot:

     * REVOKE, NEVER DELETE. A deleted row reads as "never issued", which is
       precisely what a revoked credential must not look like. There is no
       delete control here at all.
     * The credential ID is generated, never typed. It gets printed on the
       certificate and cannot be changed afterwards without invalidating an
       artifact somebody may already have posted publicly.
   --------------------------------------------------------------------------- */

var CRED_NAMES = {
  foundations: "Foundations Certificate",
  bcab: "BCAB"
};

// Crockford base32: no I, L, O or U, so an ID survives being read aloud or
// copied off paper. Six characters is 1.07 billion — four would be a million,
// which is brute-forceable and would harvest the holder list.
var ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newCredentialId(credential, issuedOn) {
  var bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  var tail = "";
  for (var i = 0; i < bytes.length; i++) tail += ID_ALPHABET[bytes[i] % 32];
  var year = (issuedOn || "").slice(0, 4) || String(new Date().getFullYear());
  return "BPA-" + (credential === "bcab" ? "BCAB" : "FND") + "-" + year + "-" + tail;
}

// Mirrors the SQL: expired is DERIVED, never stored, so a job that fails to run
// can never leave an expired credential reading as valid.
function credStatus(row) {
  if (row.status === "revoked") return "revoked";
  if (row.expires_on && row.expires_on < new Date().toISOString().slice(0, 10)) return "expired";
  return "valid";
}

var credState = { rows: [], enquiries: [] };

function loadCredentials() {
  var errorBox = document.getElementById("cred-error");
  if (errorBox) errorBox.hidden = true;

  return authFetch("/rest/v1/credentials?select=*&order=created_at.desc")
    .then(function (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("Signed in, but the register refused the read. credentials needs a select policy for the authenticated role.");
      }
      if (!response.ok) throw new Error("Could not load credentials (" + response.status + ").");
      return response.json();
    })
    .then(function (rows) {
      credState.rows = rows;
      renderCredentials();
    })
    .catch(function (err) {
      if (!errorBox) return;
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    });
}

function visibleCredentials() {
  var q = (document.getElementById("cq").value || "").trim().toLowerCase();
  var cred = document.getElementById("f-cred").value;
  var status = document.getElementById("f-cstatus").value;

  return credState.rows.filter(function (row) {
    if (cred && row.credential !== cred) return false;
    if (status === "hidden") {
      if (row.publish_consent) return false;
    } else if (status && credStatus(row) !== status) {
      return false;
    }
    if (!q) return true;
    return (row.holder_name + " " + row.credential_id + " " + (row.holder_email || ""))
      .toLowerCase().indexOf(q) !== -1;
  });
}

function renderCredentials() {
  var body = document.getElementById("cred-rows");
  var empty = document.getElementById("cred-empty");
  var rows = visibleCredentials();

  while (body.firstChild) body.removeChild(body.firstChild);

  if (!rows.length) {
    empty.textContent = credState.rows.length
      ? "No credentials match those filters."
      : "No credentials issued yet.";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  rows.forEach(function (row) {
    var status = credStatus(row);
    var tr = document.createElement("tr");

    function cell(text, className) {
      var td = document.createElement("td");
      td.textContent = text;
      if (className) td.className = className;
      tr.appendChild(td);
      return td;
    }

    cell(row.holder_name);
    cell(CRED_NAMES[row.credential] || row.credential);
    cell(row.credential_id);
    cell(shortDate(row.issued_on));
    cell(status === "valid" ? "Valid" : status === "expired" ? "Expired" : "Revoked");
    cell(row.publish_consent ? (row.allow_name_lookup ? "Yes" : "By ID only") : "Hidden");
    cell(row.pdf_path ? "Attached" : "None");

    var actions = document.createElement("td");

    // publish_consent removes the credential from the lookup entirely;
    // allow_name_lookup keeps it findable by ID but not by name.
    [
      { field: "publish_consent", on: "Hide from lookup", off: "Show in lookup" },
      { field: "allow_name_lookup", on: "Name search off", off: "Name search on" }
    ].forEach(function (toggle) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "mini";
      button.textContent = row[toggle.field] ? toggle.on : toggle.off;
      button.addEventListener("click", function () {
        patchCredential(row, toggle.field, !row[toggle.field]);
      });
      actions.appendChild(button);
    });

    var revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "mini";
    revoke.textContent = row.status === "revoked" ? "Reinstate" : "Revoke";
    revoke.addEventListener("click", function () {
      if (row.status === "revoked") {
        patchCredential(row, "status", "valid", { revoked_on: null, revoked_reason: null });
        return;
      }
      var why = window.prompt("Revoking " + row.credential_id + " for " + row.holder_name +
        ".\n\nThis stays on the record and the lookup will say REVOKED.\n\nReason:");
      if (why === null) return;
      patchCredential(row, "status", "revoked", {
        revoked_on: new Date().toISOString().slice(0, 10),
        revoked_reason: why || "Not stated"
      });
    });
    actions.appendChild(revoke);

    tr.appendChild(actions);
    body.appendChild(tr);
  });
}

function patchCredential(row, field, value, extra) {
  var payload = {};
  payload[field] = value;
  if (extra) Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });

  return authFetch("/rest/v1/credentials?id=eq." + encodeURIComponent(row.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(payload)
  }).then(function (response) {
    if (!response.ok) throw new Error("That change did not save (" + response.status + ").");
    return loadCredentials();
  }).catch(function (err) {
    var errorBox = document.getElementById("cred-error");
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  });
}

/* Issue ------------------------------------------------------------------- */

(function () {
  var form = document.getElementById("issue-form");
  if (!form) return;

  var note = document.getElementById("i-expiry-note");
  var errorBox = document.getElementById("issue-error");
  var doneBox = document.getElementById("issue-done");

  function describeExpiry() {
    var credential = form.elements.credential.value;
    var issued = form.elements.issued_on.value;
    if (credential === "bcab") {
      if (!issued) { note.textContent = "BCAB is valid for 24 months from the issue date."; return; }
      var d = new Date(issued + "T00:00:00");
      d.setFullYear(d.getFullYear() + 2);
      note.textContent = "Valid for 24 months — expires " + d.toISOString().slice(0, 10) + ".";
    } else {
      note.textContent = "The Foundations Certificate records completion on a date and does not expire.";
    }
  }

  form.elements.credential.addEventListener("change", describeExpiry);
  form.elements.issued_on.addEventListener("change", describeExpiry);
  form.elements.issued_on.value = new Date().toISOString().slice(0, 10);
  describeExpiry();

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    errorBox.hidden = true;
    doneBox.hidden = true;

    var name = form.elements.holder_name.value.trim();
    var confirm = document.getElementById("i-confirm").value.trim();

    // Compared the way the database normalises, so a stray double space is not
    // treated as a different person.
    var norm = function (s) { return s.replace(/\s+/g, " ").trim().toLowerCase(); };
    if (!name || norm(name) !== norm(confirm)) {
      errorBox.textContent = "The confirmation does not match the holder name.";
      errorBox.hidden = false;
      return;
    }

    var credential = form.elements.credential.value;
    var issued = form.elements.issued_on.value;
    var expires = null;
    if (credential === "bcab") {
      var d = new Date(issued + "T00:00:00");
      d.setFullYear(d.getFullYear() + 2);
      expires = d.toISOString().slice(0, 10);
    }

    var button = document.getElementById("issue-btn");
    var label = button.textContent;
    button.disabled = true;
    button.textContent = "Issuing…";

    // credential_id is UNIQUE, and that constraint is the real collision guard.
    // Generate, attempt, and regenerate on 409 — a check-then-insert has a race
    // it cannot see.
    function attempt(triesLeft) {
      var id = newCredentialId(credential, issued);
      return authFetch("/rest/v1/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({
          credential_id: id,
          holder_name: name,
          holder_email: form.elements.holder_email.value.trim() || null,
          credential: credential,
          issued_on: issued,
          expires_on: expires,
          platform_version: form.elements.platform_version.value.trim() || null,
          cohort: form.elements.cohort.value.trim() || null
        })
      }).then(function (response) {
        if (response.status === 409 && triesLeft > 0) return attempt(triesLeft - 1);
        if (!response.ok) {
          return response.text().then(function (body) {
            throw new Error(body.slice(0, 200) || "That did not save (" + response.status + ").");
          });
        }
        return id;
      });
    }

    attempt(3).then(function (id) {
      button.disabled = false;
      button.textContent = label;
      doneBox.textContent = "Issued " + id + " to " + name +
        ". It is verifiable now at /verify/" + id;
      doneBox.hidden = false;
      form.reset();
      form.elements.issued_on.value = new Date().toISOString().slice(0, 10);
      form.elements.platform_version.value = "n8n 2.31.6";
      describeExpiry();
      return loadCredentials();
    }).catch(function (err) {
      button.disabled = false;
      button.textContent = label;
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    });
  });
})();

["cq", "f-cred", "f-cstatus"].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener("input", renderCredentials);
});

document.getElementById("cred-clear").addEventListener("click", function () {
  document.getElementById("cq").value = "";
  document.getElementById("f-cred").value = "";
  document.getElementById("f-cstatus").value = "";
  renderCredentials();
});

document.getElementById("cred-csv").addEventListener("click", function () {
  var cols = ["credential_id", "holder_name", "holder_email", "credential", "issued_on",
    "expires_on", "status", "publish_consent", "allow_name_lookup", "platform_version", "cohort"];

  var cell = function (v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
  };

  var csv = [cols.join(",")].concat(visibleCredentials().map(function (r) {
    return cols.map(function (c) { return cell(r[c]); }).join(",");
  })).join("\n");

  var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  var link = document.createElement("a");
  link.href = url;
  link.download = "credentials-" + new Date().toISOString().slice(0, 10) + ".csv";
  link.click();
  URL.revokeObjectURL(url);
});

/* Verification enquiries -------------------------------------------------- */

var ENQ_REASONS = {
  hiring: "Hiring / verifying a candidate",
  own_credential: "Checking their own credential",
  considering_training: "Considering the training",
  other: "Something else"
};

function loadEnquiries() {
  var errorBox = document.getElementById("enq-error");
  if (errorBox) errorBox.hidden = true;

  return authFetch("/rest/v1/verification_lookups?select=*&order=created_at.desc")
    .then(function (response) {
      if (!response.ok) throw new Error("Could not load verification enquiries (" + response.status + ").");
      return response.json();
    })
    .then(function (rows) {
      credState.enquiries = rows;
      var body = document.getElementById("enq-rows");
      var empty = document.getElementById("enq-empty");
      document.getElementById("enq-count").textContent = String(rows.length);

      while (body.firstChild) body.removeChild(body.firstChild);

      if (!rows.length) {
        empty.textContent = "Nobody has used the lookup yet.";
        empty.hidden = false;
        return;
      }
      empty.hidden = true;

      rows.forEach(function (row) {
        var tr = document.createElement("tr");
        [
          shortDate(row.created_at),
          row.full_name,
          row.email,
          ENQ_REASONS[row.reason] || row.reason,
          row.marketing_opt_in ? "Opted in" : "No"
        ].forEach(function (text) {
          var td = document.createElement("td");
          td.textContent = text;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    })
    .catch(function (err) {
      if (!errorBox) return;
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    });
}

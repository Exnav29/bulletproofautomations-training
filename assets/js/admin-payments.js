/* Installment plan controls for /admin. Kept separate from the enrollment roll
   so the existing operator workflow stays untouched. */
(function () {
  "use strict";

  state.installments = state.installments || [];

  function localFetch(path, options) {
    var opts = options || {};
    var current = session();
    if (!current) return Promise.reject(new Error("Not signed in"));
    var run = function (token) {
      var headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    };
    if (current.expires_at && Date.now() > current.expires_at) {
      return refresh().then(function (fresh) { return run(fresh.access_token); });
    }
    return run(current.access_token);
  }

  function rowsFor(enrollmentId) {
    return state.installments.filter(function (row) {
      return row.enrollment_id === enrollmentId;
    }).sort(function (a, b) { return a.installment_number - b.installment_number; });
  }

  function isoDate(value) { return value ? String(value).slice(0, 10) : ""; }

  function planStatus(row) {
    var labels = { scheduled: "Scheduled", sent: "Sent", paid: "Paid", cancelled: "Cancelled" };
    return labels[row.status] || row.status;
  }
  function loadInstallments() {
    return authFetch("/rest/v1/payment_plan_installments?select=*&order=enrollment_id.asc,installment_number.asc")
      .then(function (response) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("Payment plans are not available to this admin account.");
        }
        if (!response.ok) return response.text().then(function (t) {
          throw new Error(t || "Could not load payment plans.");
        });
        return response.json();
      })
      .then(function (rows) {
        state.installments = rows;
        if (state.editing) renderPlan(state.editing);
        return rows;
      })
      .catch(function (err) {
        var box = document.getElementById("plan-error");
        if (box) { box.textContent = err.message; box.hidden = false; }
      });
  }

  function defaultAmounts(row) {
    var total = Number(row.amount_ghs || 0);
    var first = Number(row.first_instalment_ghs || 0);
    if (total === 1050 && first === 400) return [400, 325, 325];
    if (total === 750 && first === 400) return [400, 350, 0];
    if (first > 0 && total > first) return [first, total - first, 0];
    return [total, 0, 0];
  }

  function paymentLink(row) {
    return window.location.origin + "/pay/?invoice=" + encodeURIComponent(row.payment_token);
  }
  function renderPlan(row) {
    var plan = rowsFor(row.id);
    var list = document.getElementById("plan-list");
    var empty = document.getElementById("plan-empty");
    var error = document.getElementById("plan-error");
    error.hidden = true;
    empty.hidden = plan.length > 0;
    list.innerHTML = plan.map(function (item) {
      var when = item.due_rule || (item.due_date ? "Due " + isoDate(item.due_date) : "No due date set");
      var auto = item.send_on ? "Auto-send " + isoDate(item.send_on) : "Manual send";
      var actions = "";
      if (item.status === "scheduled" || item.status === "sent") {
        actions = '<div class="plan-row__actions">' +
          '<button class="mini" type="button" data-plan-send="' + esc(item.id) + '">' +
            (item.status === "sent" ? "Resend email" : "Send now") + '</button>' +
          '<button class="mini" type="button" data-plan-copy="' + esc(item.id) + '">Copy payment link</button>' +
          '</div>';
      }
      return '<div class="plan-row">' +
        '<div class="plan-row__top"><strong>Payment ' + esc(item.installment_number) + '</strong>' +
          '<span class="plan-row__amount">' + ghs(item.amount_ghs) + '</span></div>' +
        '<div class="plan-row__meta">' + esc(when) + ' · ' + esc(auto) + ' · ' + esc(planStatus(item)) + '</div>' +
        actions + '</div>';
    }).join("");
  }

  function renderFields(row) {
    var current = rowsFor(row.id);
    var defaults = defaultAmounts(row);
    var html = "";
    for (var i = 1; i <= 3; i += 1) {
      var existing = current.filter(function (r) { return r.installment_number === i; })[0];
      var amount = existing ? existing.amount_ghs : defaults[i - 1];
      var locked = existing && existing.status !== "scheduled";
      html += '<div class="plan-field"><strong>Payment ' + i + '</strong>' +
        (locked ? '<span class="plan-row__meta"> · ' + esc(planStatus(existing)) + '</span>' : '') +
        '<div class="plan-field__grid">' +
        '<div class="fld"><label for="pi-amount-' + i + '">Amount (GHS)</label>' +
        '<input id="pi-amount-' + i + '" type="number" min="0" step="0.01" value="' +
          esc(amount || "") + '"' + (locked ? ' disabled' : '') + '></div>' +
        '<div class="fld"><label for="pi-send-' + i + '">Send on</label>' +
        '<input id="pi-send-' + i + '" type="date" value="' +
          esc(existing ? isoDate(existing.send_on) : "") + '"></div>' +
        '<div class="fld"><label for="pi-due-' + i + '">Due date</label>' +
        '<input id="pi-due-' + i + '" type="date" value="' +
          esc(existing ? isoDate(existing.due_date) : "") + '"></div>' +
        '<div class="fld plan-field__wide"><label for="pi-rule-' + i + '">Timing note</label>' +
        '<input id="pi-rule-' + i + '" type="text" maxlength="100" placeholder="e.g. Before Week 3" value="' +
          esc(existing ? existing.due_rule || "" : "") + '"></div>' +
        '</div></div>';
    }
    document.getElementById("plan-fields").innerHTML = html;
  }

  function formRows(row) {
    var current = rowsFor(row.id);
    var paidAvailable = Number(row.amount_paid_ghs || 0);
    var running = 0;
    var payload = [];
    for (var i = 1; i <= 3; i += 1) {
      var existing = current.filter(function (r) { return r.installment_number === i; })[0];
      var amountInput = document.getElementById("pi-amount-" + i);
      var amount = existing && existing.status !== "scheduled"
        ? Number(existing.amount_ghs)
        : Number(amountInput.value || 0);
      if (!(amount > 0)) continue;
      running += amount;
      var inferredPaid = !existing && running <= paidAvailable + 0.005;
      payload.push({
        enrollment_id: row.id,
        installment_number: i,
        amount_ghs: amount,
        send_on: document.getElementById("pi-send-" + i).value || null,
        due_date: document.getElementById("pi-due-" + i).value || null,
        due_rule: document.getElementById("pi-rule-" + i).value.trim() || null,
        status: existing ? existing.status : inferredPaid ? "paid" : "scheduled",
        paid_at: existing ? existing.paid_at : inferredPaid ? row.paystack_payment_date || null : null,
        updated_at: new Date().toISOString()
      });
    }
    return payload;
  }

  function savePlan(event) {
    event.preventDefault();
    if (!state.editing) return;
    var row = state.editing;
    var error = document.getElementById("plan-error");
    var button = document.getElementById("plan-save");
    error.hidden = true;
    var payload = formRows(row);
    var sum = payload.reduce(function (t, item) { return t + Number(item.amount_ghs); }, 0);
    if (!payload.length || Math.abs(sum - Number(row.amount_ghs || 0)) > 0.005) {
      error.textContent = "The installment amounts must add up to " + ghs(row.amount_ghs) + ".";
      error.hidden = false;
      return;
    }
    var keep = payload.map(function (item) { return item.installment_number; });
    var removed = rowsFor(row.id).filter(function (item) {
      return keep.indexOf(item.installment_number) === -1;
    });
    var lockedRemoval = removed.filter(function (item) { return item.status !== "scheduled"; });
    if (lockedRemoval.length) {
      error.textContent = "A sent or paid installment cannot be removed from the plan.";
      error.hidden = false;
      return;
    }

    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> Saving plan…';
    var deletes = removed.map(function (item) {
      return authFetch("/rest/v1/payment_plan_installments?id=eq." + encodeURIComponent(item.id), {
        method: "DELETE", headers: { Prefer: "return=minimal" }
      }).then(function (response) {
        if (!response.ok) throw new Error("Could not remove the unused installment.");
      });
    });

    Promise.all(deletes).then(function () {
      return authFetch("/rest/v1/payment_plan_installments?on_conflict=enrollment_id,installment_number", {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload)
      });
    }).then(function (response) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("The payment-plan table refused the write.");
      }
      if (!response.ok) return response.text().then(function (t) {
        throw new Error(t || "Could not save the payment plan.");
      });
      return loadInstallments();
    }).then(function () {
      document.getElementById("plan-form").hidden = true;
      renderPlan(row);
    }).catch(function (err) {
      error.textContent = err.message;
      error.hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = "Save payment plan";
    });
  }
  function copyLink(item, button) {
    var url = paymentLink(item);
    var done = function () {
      var old = button.textContent;
      button.textContent = "Link copied";
      setTimeout(function () { button.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () {
        window.prompt("Copy this payment link:", url);
      });
    } else window.prompt("Copy this payment link:", url);
  }

  function sendNow(item, button) {
    var error = document.getElementById("plan-error");
    error.hidden = true;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> Sending…';
    localFetch("/api/admin/installment-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installment_id: item.id })
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body.ok) throw new Error(body.error || "Payment email could not be sent.");
        return body;
      });
    }).then(function () {
      return loadInstallments();
    }).catch(function (err) {
      error.textContent = err.message + " The payment link can still be copied and sent manually.";
      error.hidden = false;
    }).then(function () {
      button.disabled = false;
      button.textContent = item.status === "sent" ? "Resend email" : "Send now";
    });
  }

  document.getElementById("plan-edit").addEventListener("click", function () {
    if (!state.editing) return;
    var form = document.getElementById("plan-form");
    form.hidden = !form.hidden;
    if (!form.hidden) renderFields(state.editing);
  });
  document.getElementById("plan-form").addEventListener("submit", savePlan);
  document.getElementById("plan-list").addEventListener("click", function (event) {
    var send = event.target.closest("[data-plan-send]");
    var copy = event.target.closest("[data-plan-copy]");
    var id = send ? send.getAttribute("data-plan-send") : copy ? copy.getAttribute("data-plan-copy") : null;
    if (!id) return;
    var item = state.installments.filter(function (row) { return row.id === id; })[0];
    if (!item) return;
    if (send) sendNow(item, send);
    if (copy) copyLink(item, copy);
  });

  var baseOpenDrawer = window.openDrawer;
  window.openDrawer = function (id) {
    baseOpenDrawer(id);
    if (!state.editing) return;
    document.getElementById("plan-form").hidden = true;
    renderPlan(state.editing);
  };

  var baseLoad = window.load;
  window.load = function () {
    var result = baseLoad();
    loadInstallments();
    return result;
  };

  document.getElementById("refresh").addEventListener("click", loadInstallments);
  document.getElementById("cohort").addEventListener("change", loadInstallments);
  document.getElementById("signin-form").addEventListener("submit", function () {
    setTimeout(function () { if (session()) loadInstallments(); }, 400);
  });

  if (session()) loadInstallments();
}());
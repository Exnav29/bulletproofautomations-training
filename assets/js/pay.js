(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search);
  var token = params.get("invoice") || "";
  var returning = params.get("complete") === "1";
  var invoice = null;

  function money(value) {
    return "GHS " + Number(value || 0).toLocaleString("en-GB", {
      minimumFractionDigits: 0, maximumFractionDigits: 2
    });
  }

  function dueText(row) {
    if (row.due_rule) return row.due_rule;
    if (!row.due_date) return "Your next scheduled payment";
    return "Due " + new Date(row.due_date + "T00:00:00Z").toLocaleDateString("en-GB", {
      day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
    });
  }

  function fail(message) {
    document.getElementById("loading").hidden = true;
    document.getElementById("invoice").hidden = true;
    var box = document.getElementById("error");
    box.textContent = message;
    box.hidden = false;
  }

  function steps(row) {
    var html = "";
    for (var i = 1; i <= row.installment_count; i += 1) {
      var cls = i < row.installment_number ? " pay-step--done" :
        i === row.installment_number ? " pay-step--now" : "";
      html += '<span class="pay-step' + cls + '"></span>';
    }
    document.getElementById("progress").innerHTML = html;
  }
  function render(row) {
    invoice = row;
    document.getElementById("loading").hidden = true;
    document.getElementById("error").hidden = true;
    document.getElementById("invoice").hidden = false;
    document.getElementById("hello").textContent = row.first_name + ", your next payment is ready.";
    document.getElementById("kicker").textContent = "Payment " + row.installment_number + " of " + row.installment_count;
    document.getElementById("programme").textContent = row.programme;
    document.getElementById("payment-label").textContent = "Payment " + row.installment_number + " of " + row.installment_count;
    document.getElementById("amount").textContent = money(row.amount_ghs);
    document.getElementById("due").textContent = dueText(row);
    document.getElementById("total").textContent = money(row.total_ghs);
    document.getElementById("paid").textContent = money(row.paid_ghs);
    document.getElementById("remaining").textContent = money(row.remaining_after_ghs);
    steps(row);

    var button = document.getElementById("pay");
    var status = document.getElementById("return-status");
    if (row.status === "paid") {
      button.hidden = true;
      status.className = "pay-status pay-status--good";
      status.textContent = "Payment confirmed. Thank you — your enrollment record has been updated.";
      status.hidden = false;
    } else if (row.status === "cancelled") {
      button.hidden = true;
      status.className = "pay-status pay-status--bad";
      status.textContent = "This payment is no longer due. If that looks wrong, reply to your Bulletproof Automations email.";
      status.hidden = false;
    } else {
      button.hidden = false;
      if (returning) {
        status.className = "pay-status";
        status.textContent = "Paystack returned you here. We are confirming the payment now; this page will update when the confirmation reaches us.";
        status.hidden = false;
      } else status.hidden = true;
    }
  }
  function load() {
    if (!token) {
      fail("This payment link is incomplete. Please use the link from your Bulletproof Automations email.");
      return Promise.resolve();
    }
    return fetch("/api/installment?token=" + encodeURIComponent(token), {
      headers: { Accept: "application/json" }, cache: "no-store"
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body.ok) throw new Error(body.error || "Payment details could not be loaded.");
        return body.invoice;
      });
    }).then(render).catch(function (err) { fail(err.message); });
  }

  document.getElementById("pay").addEventListener("click", function () {
    var button = this;
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span>Opening secure checkout…';
    fetch("/api/installment", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ token: token })
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok || !body.ok) throw new Error(body.error || "Secure checkout could not be started.");
        if (body.paid) { return load(); }
        if (!body.url) throw new Error("Secure checkout did not return a payment page.");
        window.location.assign(body.url);
      });
    }).catch(function (err) {
      button.disabled = false;
      button.textContent = "Pay securely with Paystack";
      var status = document.getElementById("return-status");
      status.className = "pay-status pay-status--bad";
      status.textContent = err.message;
      status.hidden = false;
    });
  });
  load().then(function () {
    if (!returning) return;
    var attempts = 0;
    var poll = setInterval(function () {
      attempts += 1;
      if ((invoice && invoice.status === "paid") || attempts >= 6) {
        clearInterval(poll);
        return;
      }
      load();
    }, 2500);
  });
}());
/* Global shell behaviour.
   Progressive enhancement: without JavaScript the nav renders visible and
   fully usable, and the toggle button never appears. */

(function () {
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  var wide = window.matchMedia("(min-width: 56.25rem)");

  function sync() {
    if (wide.matches) {
      nav.hidden = false;
      toggle.setAttribute("aria-expanded", "false");
    } else {
      nav.hidden = toggle.getAttribute("aria-expanded") !== "true";
    }
  }

  toggle.addEventListener("click", function () {
    var open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    nav.hidden = open;
  });

  nav.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || wide.matches) return;
    toggle.setAttribute("aria-expanded", "false");
    nav.hidden = true;
    toggle.focus();
  });

  if (wide.addEventListener) {
    wide.addEventListener("change", sync);
  } else if (wide.addListener) {
    wide.addListener(sync);
  }

  // Only reveal the toggle once it is wired up.
  toggle.setAttribute("data-ready", "");
  sync();
})();

/* Live day count on the term board.
   Reads the date off the element, so nothing is hardcoded and nothing is
   invented. Without JavaScript the span stays empty and collapses, leaving the
   plain date to carry the row. */

(function () {
  var counts = document.querySelectorAll("[data-countdown]");
  if (!counts.length) return;

  var DAY = 86400000;
  var today = new Date();
  today.setHours(0, 0, 0, 0);

  Array.prototype.forEach.call(counts, function (el) {
    var target = new Date(el.getAttribute("data-countdown") + "T00:00:00");
    if (isNaN(target.getTime())) return;

    var days = Math.round((target - today) / DAY);
    if (days > 0) {
      el.textContent = days === 1 ? "tomorrow" : "in " + days + " days";
    } else if (days === 0) {
      el.textContent = "today";
    }
  });
})();

/* Figures — one scroll moment, and the values count up to their published
   numbers. The final value is written in the markup, so if any of this is
   unavailable the correct number is already on the page. */

(function () {
  var band = document.querySelector(".figures");
  if (!band) return;

  var figures = band.querySelectorAll(".figure");
  if (!figures.length) return;

  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still || !("IntersectionObserver" in window)) return;

  band.classList.add("figures--animate");

  function countUp(el) {
    var value = el.querySelector("[data-count]");
    if (!value) return;

    var target = parseInt(value.getAttribute("data-count"), 10);
    var suffix = value.getAttribute("data-suffix") || "";
    if (isNaN(target)) return;

    var started = null;
    var span = 900;

    function step(now) {
      if (started === null) started = now;
      var progress = Math.min((now - started) / span, 1);
      // ease-out so it settles rather than stopping dead
      var eased = 1 - Math.pow(1 - progress, 3);
      value.firstChild.nodeValue = String(Math.round(target * eased)) + suffix;
      if (progress < 1) requestAnimationFrame(step);
    }

    value.firstChild.nodeValue = "0" + suffix;
    requestAnimationFrame(step);
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        countUp(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.35 }
  );

  Array.prototype.forEach.call(figures, function (fig) {
    observer.observe(fig);
  });
})();

/* The wall — an eight-week measure that fills with reading position, and one
   emphasis beat on the sentence that does the persuading.
   Reduced motion gets both in their finished state rather than nothing: the
   rail reads as a full eight weeks, the pivot stays underlined. */

(function () {
  var wall = document.querySelector(".wall");
  if (!wall) return;

  var rail = wall.querySelector(".wall__rail");
  var pivot = wall.querySelector(".pivot");
  var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (still || !("IntersectionObserver" in window)) {
    if (rail) rail.style.setProperty("--fill", "1");
    if (pivot) pivot.classList.add("is-lit");
    return;
  }

  if (pivot) {
    var pivotWatch = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          pivot.classList.add("is-lit");
          pivotWatch.disconnect();
        });
      },
      { threshold: 0.6 }
    );
    pivotWatch.observe(pivot);
  }

  if (!rail) return;

  var queued = false;
  var watching = false;

  function paint() {
    queued = false;
    var box = wall.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight;

    // Starts filling as the passage rises past three-quarters of the viewport
    // and completes once about 60% of it has gone by — roughly the point a
    // reader reaches the last paragraph.
    var progress = (vh * 0.75 - box.top) / (box.height * 0.6);
    if (progress < 0) progress = 0;
    if (progress > 1) progress = 1;

    rail.style.setProperty("--fill", String(progress));
  }

  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  }

  // Only listen while the section is anywhere near the viewport.
  var gate = new IntersectionObserver(
    function (entries) {
      var near = entries.some(function (entry) {
        return entry.isIntersecting;
      });
      if (near && !watching) {
        window.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("resize", onScroll);
        watching = true;
        paint();
      } else if (!near && watching) {
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
        watching = false;
      }
    },
    { rootMargin: "200px 0px" }
  );

  gate.observe(wall);
})();

/* Enrollment.

   Posts to /api/enroll, a Cloudflare Pages Function on our own origin, which
   writes the row and — once Paystack is switched on — starts the transaction
   and hands back a checkout URL.

   The amount is deliberately NOT sent from here. It is decided server-side
   from the table in functions/api/_paystack.js, because whatever amount
   reaches Paystack is the amount charged, and a price the browser supplies is
   a price the browser can edit.

   Three outcomes, all of which end with the visitor knowing where they stand:

     mode "checkout"  redirect to Paystack.
     mode "reserve"   payment is not switched on, or the checkout could not be
                      started. Show the confirmed state — this is exactly the
                      flow that ran before Paystack existed.
     endpoint absent  fall back to the direct Supabase insert this page used
                      until now, then show the same confirmed state.

   That last one is not defensive padding. Cloudflare Pages discovers
   functions/ at deploy time and it has never yet been confirmed to pick this
   directory up on a production build; if it does not, /api/enroll returns the
   404 page and every enrollment on the site's only selling page would fail
   silently. The fallback costs thirty lines and removes that from the list of
   things that can go wrong before 8 September. */

(function () {
  var form = document.getElementById("enroll-form");
  var done = document.getElementById("enroll-done");
  var errorBox = document.getElementById("form-error");
  if (!form || !done) return;

  // Only used by the fallback path below. Injected at build time; the anon key
  // is public by design — row-level security limits it to inserting into
  // enrollments and nothing else — but it is not committed to the repository.
  var SUPABASE_URL = "__SUPABASE_URL__";
  var SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";

  // Matches the live table's own default, so the cohort is explicit in the row
  // rather than implied by when it was created.
  var COHORT = "intermediate_2026_09";

  // Which version of the policies was on screen when they agreed. Bump this in
  // the same change that publishes a new policy, or the record will claim
  // people agreed to wording they never saw. Kept identical to POLICY_VERSION
  // in functions/api/_paystack.js.
  var POLICY_VERSION = "2026-08-10";

  // Fallback only. The authoritative table is server-side; these figures exist
  // so a direct insert still records the right commitment if the Function is
  // unreachable. Keep them in step with functions/api/_paystack.js.
  var PRICE = {
    cohort_only: 750,
    cohort_and_assessment: 1050,
    path_b_readiness: 150
  };

  var FIRST_INSTALMENT = {
    cohort_only: 400,
    cohort_and_assessment: 400,
    path_b_readiness: 150
  };

  /* Opting in to the test checkout.
     While the Paystack account holds test keys, /api/enroll refuses to send
     anyone to a checkout unless the request asks for it explicitly. Loading
     the page as /certified-automation-builder?paystack=test is that ask. A
     visitor who has not done so gets the reservation flow, so nobody can
     stumble into a test payment and believe they have paid. */
  var TEST_OPT_IN = /(^|[?&])paystack=test($|&)/.test(window.location.search);

  var messages = {
    already_paid:
      "You already have a paid place on this cohort. Message us on WhatsApp if you need to change anything.",
    instalment_outstanding:
      "You already have a place on this cohort with an instalment outstanding. Remaining instalments are arranged through our Slack community via MoMo — message us on WhatsApp and we will sort it.",
    cancelled:
      "This enrollment was cancelled. Message us on WhatsApp and we will reinstate it rather than creating a second record.",
    generic:
      "We could not save that. Please try again, or message us on WhatsApp and we will reserve your place manually."
  };

  function show(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function value(name) {
    var el = form.elements[name];
    if (!el) return "";
    return (el.value || "").trim();
  }

  function chosen(name) {
    var picked = form.querySelector('input[name="' + name + '"]:checked');
    return picked ? picked.value : "";
  }

  // Reading .checked off a field that does not exist throws, and the throw
  // happens while building the payload — before any request, with the form
  // still on screen and no error shown. A renamed input then looks like a dead
  // button. This degrades to false instead, and the required attribute is what
  // actually enforces the tick.
  function ticked(name) {
    var el = form.elements[name];
    return !!(el && el.checked);
  }

  function confirmReserved(heldForRateReview) {
    form.hidden = true;
    done.hidden = false;
    /* Revealed only when the server says the enrollment is held pending a
       regional-rate check, so the ordinary reservation wording is untouched
       for everybody else. Absent from the page means nothing to reveal — this
       must never throw and leave a paying customer looking at a dead form. */
    var held = document.getElementById("enroll-held");
    if (held) held.hidden = !heldForRateReview;
    done.setAttribute("tabindex", "-1");
    done.focus();
  }

  /* The pre-Paystack path, kept as the fallback. Writes the row with the anon
     key exactly as this page did before /api/enroll existed.

     Prefer must stay "minimal": "representation" makes PostgREST return the
     row, which needs SELECT rights anon deliberately does not have, and the
     insert would be refused with 42501. */
  function reserveDirect(fields) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return Promise.reject(new Error("not-configured"));
    }

    var payload = {
      full_name: fields.full_name,
      email: fields.email,
      whatsapp: fields.whatsapp,
      city: fields.city,
      experience_level: fields.experience_level,
      chosen_option: fields.chosen_option,
      amount_ghs: PRICE[fields.chosen_option],
      payment_plan: fields.payment_plan,
      cohort: COHORT,
      consent_given: fields.consent_given,
      ack_refund: fields.ack_refund,
      ack_certification: fields.ack_certification,
      acks_policy_version: POLICY_VERSION,
      source: "website"
    };

    if (fields.payment_plan) {
      payload.first_instalment_ghs = FIRST_INSTALMENT[fields.chosen_option];
    }

    return fetch(SUPABASE_URL + "/rest/v1/enrollments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payload)
    }).then(function (response) {
      if (response.ok) return;
      if (response.status === 409) {
        var conflict = new Error(messages.already_paid);
        conflict.shown = true;
        throw conflict;
      }
      throw new Error("insert-" + response.status);
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    // Native constraints first, so the browser's own messages and the
    // required/type rules in the markup stay the single source of truth.
    var invalid = form.querySelector(":invalid");
    if (invalid) {
      invalid.setAttribute("aria-invalid", "true");
      invalid.focus();
      show("Please complete the highlighted field.");
      return;
    }

    Array.prototype.forEach.call(form.querySelectorAll("[aria-invalid]"), function (el) {
      el.removeAttribute("aria-invalid");
    });

    // Honeypot: a real person never sees this field, so anything in it means a
    // bot. Pretend it worked — a bot that gets an error learns to retry. The
    // server checks the same field; this just saves the round trip.
    if (form.elements.company_website && form.elements.company_website.value) {
      confirmReserved();
      return;
    }

    var fields = {
      full_name: value("full_name"),
      email: value("email"),
      whatsapp: value("whatsapp"),
      city: value("city"),
      experience_level: value("experience_level"),
      chosen_option: chosen("option"),
      // payment_plan is a boolean in the table: true means instalments.
      payment_plan: chosen("payment_plan") === "Instalments",
      consent_given: ticked("consent_given"),
      // Both are required to submit, so these are always true on a real
      // registration — the value is in the version recorded alongside them,
      // which says WHICH wording they were shown. WHEN is created_at, set
      // server-side, because a browser clock is not evidence of anything.
      ack_refund: ticked("ack_refund"),
      ack_certification: ticked("ack_certification")
    };

    var submit = form.querySelector(".form__submit");
    var label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Reserving…";

    var request = {
      full_name: fields.full_name,
      email: fields.email,
      whatsapp: fields.whatsapp,
      city: fields.city,
      experience_level: fields.experience_level,
      chosen_option: fields.chosen_option,
      payment_plan: fields.payment_plan,
      consent_given: fields.consent_given,
      ack_refund: fields.ack_refund,
      ack_certification: fields.ack_certification,
      testOptIn: TEST_OPT_IN,
      company_website: form.elements.company_website ? form.elements.company_website.value : "",

      /* WHICH PRICE THIS PAGE ACTUALLY SHOWED.
       *
       * Read off the attribute the pricing middleware stamps on <html>, not
       * from anything this script decides. If the middleware did not run the
       * attribute is simply absent and this is null, and /api/enroll then
       * reserves the place instead of charging.
       *
       * That is the point: the safety does not depend on comparing two values
       * correctly, only on whether a marker is present. A stale cached page or
       * a failed middleware becomes a held enrollment, never a wrong charge.
       *
       * The SERVER decides the tier regardless. This is only ever used to
       * detect disagreement — it can never select a cheaper price, because
       * enroll.js re-resolves the region from Cloudflare's own header. */
      displayed_tier: document.documentElement.getAttribute("data-pricing-tier") || null,

      /* The country the visitor selected, if they corrected our detection.
         Sent as a country, never as a tier or a price. Correcting upward goes
         straight through; correcting downward reserves for review. */
      declared_country: document.documentElement.getAttribute("data-pricing-country") || null,

      foundations_cohort_1: ticked("foundations_cohort_1")
    };

    fetch("/api/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    })
      .then(function (response) {
        /* A 404 here does not mean "no such enrollment". It means the Function
           is not deployed and Cloudflare served the site's 404 page, so the
           right move is the old path rather than an error. Same for a 405,
           which is what a static host returns for a POST to a missing route. */
        if (response.status === 404 || response.status === 405) {
          throw { fallback: true };
        }

        return response.json().then(function (data) {
          if (response.ok && data && data.ok) return data;

          // A deliberate, specific refusal from our own endpoint. These have
          // wording written for them; anything else is generic.
          if (data && data.code && messages[data.code]) {
            var known = new Error(messages[data.code]);
            known.shown = true;
            throw known;
          }
          throw new Error("api-" + response.status);
        });
      })
      .then(function (data) {
        if (data.mode === "checkout" && data.url) {
          submit.textContent = "Opening payment…";
          // A full navigation, not a fetch: this leaves our origin for
          // Paystack's checkout, and comes back to /thank-you afterwards.
          window.location.assign(data.url);
          return;
        }
        /* A held enrollment is still a reservation — the place is recorded and
           nothing was charged — but it must not promise a payment link that is
           not coming. "We will contact you to arrange payment" and "we need to
           confirm your regional rate first" are different promises. */
        confirmReserved(data.hold === "rate_review");
      })
      .catch(function (err) {
        if (err && err.fallback) {
          return reserveDirect(fields).then(confirmReserved);
        }
        throw err;
      })
      .catch(function (err) {
        submit.disabled = false;
        submit.textContent = label;
        show(err && err.shown ? err.message : messages.generic);
      });
  });

  /* What the page says about payment, decided by the server rather than by
     whoever last edited the copy.

     Two sentences on this page are only true while checkout is closed —
     "Card and mobile money checkout is not open yet" and "Nothing is charged
     on this page". Leaving them as hand-maintained copy would mean activation
     day requires a deploy to correct them, and the failure mode if it is
     forgotten is the page promising nothing will be charged while charging
     people. So both exist in the markup twice, and this picks one.

     The "off" version is what the markup ships with and what anyone without
     JavaScript sees. That is the safe direction: promising less than happens
     is a pleasant surprise, promising more is a dispute.

     GET /api/enroll reports off | test | live and nothing else. Asking it
     rather than reading ?paystack=test means the test banner cannot be
     summoned from the address bar, and cannot survive the live key going in. */
  (function () {
    var swappable = document.querySelectorAll("[data-pay]");
    var banner = document.getElementById("paystack-test-banner");
    if (!swappable.length && !banner) return;

    fetch("/api/enroll")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;

        // In test mode with the opt-in, a checkout genuinely does happen, so
        // the copy should describe one — with the banner making very clear
        // what kind.
        var charging = data.paystack === "live" || (data.paystack === "test" && TEST_OPT_IN);
        if (!charging) return;

        Array.prototype.forEach.call(swappable, function (el) {
          el.hidden = el.getAttribute("data-pay") !== "live";
        });

        var submit = form.querySelector(".form__submit");
        var liveLabel = submit && submit.getAttribute("data-pay-label-live");
        if (liveLabel) submit.textContent = liveLabel;

        if (banner && data.paystack === "test") banner.hidden = false;
      })
      .catch(function () {
        /* Leaving the "off" copy in place is the correct failure. If this
           probe could not reach the endpoint, the submit almost certainly
           cannot either, and it will fall back to the reservation flow that
           copy already describes. */
      });
  })();
})();

/* Print the standard.
   The page itself is the PDF — a print stylesheet strips the navigation and
   the grounds, so there is no separate file to generate or keep in sync.
   The button is inert markup until this runs, so it is hidden by default and
   revealed only once wired up; without JavaScript the browser's own print
   command still produces the same clean copy. */

(function () {
  var buttons = document.querySelectorAll("[data-print]");
  if (!buttons.length || typeof window.print !== "function") return;

  Array.prototype.forEach.call(buttons, function (button) {
    button.addEventListener("click", function () {
      window.print();
    });
    button.setAttribute("data-ready", "");
  });
})();

/* The 404 page names the address that failed.
   Guessing is worse than saying plainly what was asked for and did not exist,
   and it makes a mistyped URL obvious at a glance. Escaped through textContent,
   never innerHTML — the path is attacker-controlled by definition. */

(function () {
  var slot = document.getElementById("gone-path");
  if (!slot) return;

  var path = window.location.pathname + window.location.search;
  if (!path || path === "/") return;

  slot.textContent = path;
  slot.hidden = false;
})();

/* Payment reference on /thank-you.
   Read from the provider's return URL and shown so the visitor can quote it if
   something goes wrong. DISPLAY ONLY — nothing here writes payment status.
   A query string is typed by whoever holds the browser, so the authoritative
   record comes from Paystack server-to-server via the paystack-webhook
   function. Written through textContent, never innerHTML. */

(function () {
  var box = document.getElementById("pay-ref");
  var slot = document.getElementById("pay-ref-value");
  if (!box || !slot) return;

  var params = new URLSearchParams(window.location.search);
  // Paystack returns trxref and reference; either may be present.
  var ref = params.get("reference") || params.get("trxref") || "";

  // Keep it to the shape a reference actually takes, so nothing else renders.
  if (!/^[A-Za-z0-9._-]{6,64}$/.test(ref)) return;

  slot.textContent = ref;
  box.hidden = false;

  /* Reveal the copy that matches what was actually bought.
   *
   * The blocks marked data-offering="neutral" are what ships and what somebody
   * without JavaScript reads: true for every purchase, specific about none. We
   * only make the specific claim once the SERVER has told us which offering
   * this reference belongs to — the same rule the enrollment page's data-pay
   * copy follows, and for the same reason. The reference in the URL is used to
   * ASK the question here; it never answers it.
   *
   * Any failure leaves the neutral copy in place. */
  var offerings = document.querySelectorAll("[data-offering]");
  if (!offerings.length) return;

  fetch("/api/enroll?reference=" + encodeURIComponent(ref), {
    method: "GET",
    headers: { Accept: "application/json" }
  })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !data.option) return;
      var group = data.option === "path_b_readiness" ? "path_b" : "cohort";
      for (var i = 0; i < offerings.length; i++) {
        offerings[i].hidden = offerings[i].getAttribute("data-offering") !== group;
      }
    })
    .catch(function () {});
})();

/* Foundations notify-me.
   Writes to foundations_interest, where the eleven signups migrated from the
   old project already live. Deliberately not an enrollment: it holds nothing,
   so it asks for almost nothing.

   Like the enrollment form it must send Prefer: return=minimal — anon can
   insert and cannot read back, and return=representation would be refused. */

(function () {
  var form = document.getElementById("notify-form");
  var done = document.getElementById("notify-done");
  var errorBox = document.getElementById("notify-error");
  if (!form || !done) return;

  var SUPABASE_URL = "__SUPABASE_URL__";
  var SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";
  var configured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

  function show(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function value(name) {
    var el = form.elements[name];
    return el ? (el.value || "").trim() : "";
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    errorBox.hidden = true;

    if (!configured) {
      show("This is not available right now. Please message us on WhatsApp and we will add you.");
      return;
    }

    if (form.elements.company_website && form.elements.company_website.value) {
      form.hidden = true;
      done.hidden = false;
      return;
    }

    var invalid = form.querySelector(":invalid");
    if (invalid) {
      invalid.setAttribute("aria-invalid", "true");
      invalid.focus();
      show("Please complete the highlighted field.");
      return;
    }

    var submit = form.querySelector(".form__submit");
    var label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Adding…";

    fetch(SUPABASE_URL + "/rest/v1/foundations_interest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        full_name: value("full_name"),
        email: value("email"),
        whatsapp: value("whatsapp") || null,
        city: value("city") || null,
        experience_level: value("experience_level") || null,
        source: "website"
      })
    })
      .then(function (response) {
        // email is UNIQUE, so a second attempt is someone already on the list.
        // That is not an error worth alarming them about.
        if (response.ok || response.status === 409) return;
        return response.text().then(function (body) {
          throw new Error(body || "That did not save.");
        });
      })
      .then(function () {
        form.hidden = true;
        done.hidden = false;
        done.setAttribute("tabindex", "-1");
        done.focus();
      })
      .catch(function () {
        submit.disabled = false;
        submit.textContent = label;
        show("We could not save that. Please try again, or message us on WhatsApp.");
      });
  });
})();

/* /verify — credential lookup.
 *
 * Unlike every other form on this site, nothing here talks to Supabase. The
 * anon key is public by design, so a lookup the browser could make directly is
 * a lookup an attacker can make directly, and Cloudflare protects our domain
 * rather than Supabase's. Both calls go to Pages Functions on our own origin:
 * /api/gate and /api/verify.
 *
 * Two states, decided by the address on load:
 *
 *   /verify              the gated search box.
 *   /verify/<id>, /v/<id>  a credential, resolved straight from the path. NOT
 *                        gated — this is the URL holders put in LinkedIn's
 *                        Credential URL field, and LinkedIn renders it as a
 *                        "Show credential" button. A form in front of that
 *                        would break every holder's credential for exactly the
 *                        audience it exists to convince.
 */

(function () {
  var lookup = document.getElementById("lookup");
  if (!lookup) return;

  var gateStep = document.getElementById("gate-step");
  var searchStep = document.getElementById("search-step");
  var gateForm = document.getElementById("gate-form");
  var searchForm = document.getElementById("search-form");
  var resultBox = document.getElementById("result");
  var notFound = document.getElementById("notfound");
  var failed = document.getElementById("failed");
  var explainer = document.getElementById("explainer");
  var linkedin = document.getElementById("linkedin");
  var list = document.getElementById("credential-list");
  var tsBar = document.getElementById("ts-bar");
  var tsHost = document.getElementById("ts-host");
  var tsNote = document.getElementById("ts-note");

  var PASS_KEY = "bpa_verify_pass";
  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
  var NAMES = {
    foundations: "Bulletproof Automation Foundations Certificate",
    bcab: "Bulletproof Certified Automation Builder (BCAB)"
  };
  var STATUS = { valid: "Valid", expired: "Expired", revoked: "Revoked" };

  // JS is running, so the no-JS fallback is noise.
  var jsOff = document.getElementById("js-off");
  if (jsOff) jsOff.hidden = true;

  /* localStorage throws outright in Safari private mode rather than returning
     null, and a gate that crashes is worse than no gate. */
  function readPass() {
    try { return window.localStorage.getItem(PASS_KEY); } catch (err) { return null; }
  }
  function writePass(value) {
    try { window.localStorage.setItem(PASS_KEY, value); } catch (err) { /* nothing to do */ }
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!parts) return iso;
    return Number(parts[3]) + " " + MONTHS[Number(parts[2]) - 1] + " " + parts[1];
  }

  /* ---------------------------------------------------------------------
     Turnstile.

     Rendered explicitly so the token can be consumed and the widget reset per
     request — tokens are single-use. The site key comes from the markup, where
     the build substitutes it; with no key the widget never renders and the
     Pages Functions refuse every request, which is the intended failure rather
     than a silent bypass.
     --------------------------------------------------------------------- */

  var widgetId = null;
  var tokenResolve = null;
  var tokenPromise = null;
  var siteKey = tsHost ? (tsHost.getAttribute("data-sitekey") || "") : "";

  function newTokenPromise() {
    tokenPromise = new Promise(function (resolve) { tokenResolve = resolve; });
  }

  window.bpaTurnstileReady = function () {
    if (!tsHost || !window.turnstile || !siteKey) return;

    /* Reveal the widget BEFORE rendering it, and leave it visible.
       Turnstile cannot solve inside a display:none container — and in a private
       window, where there is no prior clearance cookie, it needs to show an
       interactive challenge, which a hidden element makes impossible. Rendering
       it hidden and only revealing it on submit produced exactly that: the first
       attempt waited for a token that could never arrive and failed, and the
       failure itself unhid the widget, so the second attempt worked. */
    if (tsBar) tsBar.hidden = false;

    newTokenPromise();
    widgetId = window.turnstile.render(tsHost, {
      sitekey: siteKey,
      action: "verify",
      callback: function (token) { if (tokenResolve) tokenResolve(token); },
      "error-callback": function () { if (tokenResolve) tokenResolve(null); },
      "expired-callback": function () {
        newTokenPromise();
        if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
      }
    });
    if (tsNote) tsNote.hidden = true;
  };

  function consumeToken() {
    if (!siteKey || !tokenPromise) return Promise.resolve(null);
    var waited = new Promise(function (resolve) { window.setTimeout(function () { resolve(null); }, 8000); });
    return Promise.race([tokenPromise, waited]).then(function (token) {
      newTokenPromise();
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
      return token;
    });
  }

  function post(path, payload) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().then(function (data) {
        return { status: response.status, data: data };
      });
    });
  }

  /* ---------------------------------------------------------------------
     Rendering. Every value is written with textContent — a credential page
     renders a name somebody else chose, so nothing here builds HTML.
     --------------------------------------------------------------------- */

  /* Reveal a panel and move focus to it, so a screen reader lands on the answer
     rather than being left where the button used to be.

     preventScroll is the important part. Focus scrolls by default, and on a
     deep link that fires during load — the page jumps before the visitor has
     seen it, which reads as broken. Scrolling is therefore explicit, and only
     after someone has actually submitted something. */
  var interactive = false;

  function reveal(el, panel) {
    if (!el) return;
    el.hidden = false;
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    if (interactive && panel) {
      var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
    }
  }

  function fill(root, key, text) {
    var el = root.querySelector('[data-f="' + key + '"]');
    if (el) el.textContent = text;
    return el;
  }

  function card(row) {
    var node = document.getElementById("tpl-credential").content.cloneNode(true);

    var status = fill(node, "status", STATUS[row.status] || row.status);
    if (status) status.setAttribute("data-state", row.status);

    fill(node, "name", NAMES[row.credential] || row.credential);
    fill(node, "holder", row.holderName);
    fill(node, "id", row.credentialId);
    fill(node, "issued", fmtDate(row.issuedOn));
    fill(node, "expires", row.expiresOn ? fmtDate(row.expiresOn) : "Does not expire");
    fill(node, "platform", row.platformVersion || "Not recorded");

    // The certificate block only exists once a PDF has been issued. Until then
    // the record stands on its own rather than showing a broken link.
    if (row.pdfUrl) {
      var wrap = node.querySelector('[data-f="cert"]');
      var pdf = node.querySelector('[data-f="pdf"]');
      var img = node.querySelector('[data-f="preview"]');
      if (wrap) wrap.hidden = false;
      if (pdf) pdf.setAttribute("href", row.pdfUrl);
      if (img && row.previewUrl) {
        img.setAttribute("src", row.previewUrl);
        img.setAttribute("alt", "The " + (NAMES[row.credential] || "certificate") + " issued to " + row.holderName);
        img.hidden = false;
      }
    }

    var tpl = document.getElementById("tpl-attests-" + row.credential);
    var slot = node.querySelector('[data-f="attests"]');
    if (tpl && slot) slot.appendChild(tpl.content.cloneNode(true));

    return node;
  }

  function setLinkedIn(row) {
    if (!linkedin) return;
    var values = {
      name: NAMES[row.credential] || row.credential,
      org: "Bulletproof Automations",
      issued: fmtDate(row.issuedOn),
      expires: row.expiresOn ? fmtDate(row.expiresOn) : "Leave blank — this credential does not expire",
      id: row.credentialId,
      url: window.location.origin + "/verify/" + row.credentialId
    };
    Object.keys(values).forEach(function (key) {
      var el = linkedin.querySelector('[data-li="' + key + '"]');
      if (el) el.textContent = values[key];
    });
    linkedin.hidden = false;
  }

  function show(rows, matched) {
    while (list.firstChild) list.removeChild(list.firstChild);

    // Lead with the credential that was actually asked about.
    if (matched) {
      rows.sort(function (a, b) {
        var am = a.credentialId.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === matched ? 0 : 1;
        var bm = b.credentialId.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === matched ? 0 : 1;
        return am - bm;
      });
    }

    rows.forEach(function (row) { list.appendChild(card(row)); });

    var lede = document.getElementById("result-lede");
    if (lede) {
      lede.textContent = rows.length > 1
        ? rows[0].holderName + " holds " + rows.length + " credentials under the Bulletproof Automation Builder Pathway."
        : rows[0].holderName + " holds this credential.";
    }

    var stamp = document.getElementById("verified-on");
    if (stamp) {
      var now = new Date();
      stamp.textContent = "Checked against the register on " +
        now.getDate() + " " + MONTHS[now.getMonth()] + " " + now.getFullYear() + ".";
    }

    setLinkedIn(rows[0]);
    if (explainer) explainer.hidden = true;
    if (notFound) notFound.hidden = true;
    if (failed) failed.hidden = true;
    reveal(resultBox, true);
  }

  function showNothing() {
    if (resultBox) resultBox.hidden = true;
    if (linkedin) linkedin.hidden = true;
    if (explainer) explainer.hidden = true;
    if (failed) failed.hidden = true;
    // Nothing matched, so give them the search box back — including when they
    // arrived on a deep link, where it starts hidden.
    lookup.hidden = false;
    if (gateStep && searchStep && !readPass()) {
      gateStep.hidden = false;
      searchStep.hidden = true;
    } else if (searchStep) {
      searchStep.hidden = false;
      if (gateStep) gateStep.hidden = true;
    }
    reveal(notFound, true);
  }

  /* ---------------------------------------------------------------------
     The lookup itself
     --------------------------------------------------------------------- */

  function runLookup(payload, onError) {
    /* Only a NAME lookup waits for a Turnstile token. An ID lookup goes
       straight out: the ID is the access control, and blocking the LinkedIn
       path on a third-party script means a real credential reads as missing
       whenever that script cannot load. See functions/api/verify.js. */
    var token = payload.id ? Promise.resolve(null) : (tsBar && (tsBar.hidden = false), consumeToken());

    return token.then(function (value) {
      if (!value && !payload.id) {
        onError("The browser check has not finished yet. Give it a moment, complete it if it asks, then try again.");
        if (tsBar) tsBar.hidden = false;
        return null;
      }
      if (value) payload.turnstileToken = value;
      var pass = readPass();
      if (pass) payload.pass = pass;
      return post("/api/verify", payload);
    }).then(function (res) {
      if (!res) return;   // challenge not ready; already reported
      if (res.status === 403 && !payload.id) {
        // The pass expired or was never issued. Ask again rather than failing.
        try { window.localStorage.removeItem(PASS_KEY); } catch (err) { /* ignore */ }
        if (gateStep) gateStep.hidden = false;
        if (searchStep) searchStep.hidden = true;
        onError("Please tell us who is checking, then search again.");
        return;
      }
      if (!res.data || res.data.ok !== true) {
        onError(res.status === 503
          ? "Credential verification is not switched on yet. Please email info@bulletproofautomations.com with the credential ID and we will confirm it by reply."
          : "We could not complete that check. Please try again, or email info@bulletproofautomations.com.");
        return;
      }
      if (!res.data.results.length) {
        showNothing();
        return;
      }
      show(res.data.results, res.data.matched);
    }).catch(function () {
      onError("We could not reach the verification service. Please try again, or email info@bulletproofautomations.com.");
    });
  }

  /* Deep link: /verify/<id>, /v/<id>, or ?id=<id>. */
  function credentialFromUrl() {
    var fromPath = /^\/(?:verify|v)\/([A-Za-z0-9][A-Za-z0-9-]{10,38})\/?$/.exec(window.location.pathname);
    if (fromPath) return fromPath[1];
    var q = new URLSearchParams(window.location.search).get("id") || "";
    return /^[A-Za-z0-9][A-Za-z0-9 -]{10,38}$/.test(q) ? q : null;
  }

  var deepLink = credentialFromUrl();

  if (deepLink) {
    /* Hide the whole lookup block, not just the forms. Someone arriving from a
       LinkedIn profile came to see one credential; a "Look up a credential"
       heading with nothing under it is an empty room. It comes back if the
       lookup finds nothing, so there is still a way to search. */
    lookup.hidden = true;
    if (gateStep) gateStep.hidden = true;
    if (searchStep) searchStep.hidden = true;

    /* A service failure must NOT render as "no credential matches". Those are
       opposite claims: one says the register was checked and is empty, the
       other says the register could not be reached. Saying the first when the
       second is true tells a recruiter that a real holder is a liar. */
    runLookup({ id: deepLink }, function (message) {
      if (explainer) explainer.hidden = true;
      lookup.hidden = false;
      var slot = document.getElementById("failed-detail");
      if (slot) slot.textContent = message;
      reveal(failed, true);
    }).then(function () {
      if (tsNote) tsNote.hidden = true;
    });
  } else if (readPass()) {
    if (gateStep) gateStep.hidden = true;
    if (searchStep) searchStep.hidden = false;
  }

  /* ---------------------------------------------------------------------
     Gate
     --------------------------------------------------------------------- */

  if (gateForm) {
    var gateError = document.getElementById("gate-error");

    gateForm.addEventListener("submit", function (event) {
      event.preventDefault();
      gateError.hidden = true;

      var invalid = gateForm.querySelector(":invalid");
      if (invalid) {
        invalid.setAttribute("aria-invalid", "true");
        invalid.focus();
        gateError.textContent = "Please complete the highlighted field.";
        gateError.hidden = false;
        return;
      }
      Array.prototype.forEach.call(gateForm.querySelectorAll("[aria-invalid]"), function (el) {
        el.removeAttribute("aria-invalid");
      });

      var submit = gateForm.querySelector(".form__submit");
      var label = submit.textContent;
      submit.disabled = true;
      submit.textContent = "One moment…";
      if (tsBar) tsBar.hidden = false;

      consumeToken().then(function (token) {
        /* No token means the challenge has not completed — usually it is still
           working, sometimes it needs a click. That is not a failed submission
           and must not read like one, or people retype a correct form. */
        if (!token) {
          submit.disabled = false;
          submit.textContent = label;
          gateError.textContent = "The browser check has not finished yet. Give it a moment, complete it if it asks, then try again.";
          gateError.hidden = false;
          if (tsBar) tsBar.hidden = false;
          return null;
        }
        return post("/api/gate", {
          full_name: gateForm.elements.full_name.value.trim(),
          email: gateForm.elements.email.value.trim(),
          reason: gateForm.elements.reason.value,
          marketing_opt_in: !!(gateForm.elements.marketing_opt_in && gateForm.elements.marketing_opt_in.checked),
          company_website: gateForm.elements.company_website ? gateForm.elements.company_website.value : "",
          turnstileToken: token
        });
      }).then(function (res) {
        if (!res) return;   // challenge not ready; already reported
        submit.disabled = false;
        submit.textContent = label;
        if (!res.data || res.data.ok !== true) {
          /* 503 means the service is not configured, which is our problem, not
             theirs. Saying "we could not save that" implies their details were
             rejected and sends them round the loop retyping a correct form. */
          gateError.textContent = res.status === 503
            ? "Credential verification is not switched on yet. Please email info@bulletproofautomations.com and we will confirm any credential by reply."
            : "We could not save that. Please try again, or email info@bulletproofautomations.com.";
          gateError.hidden = false;
          return;
        }
        if (res.data.pass) writePass(res.data.pass);
        gateStep.hidden = true;
        searchStep.hidden = false;
        var field = document.getElementById("s-query");
        if (field) field.focus();
      }).catch(function () {
        submit.disabled = false;
        submit.textContent = label;
        gateError.textContent = "We could not reach the verification service. Please try again.";
        gateError.hidden = false;
      });
    });
  }

  /* ---------------------------------------------------------------------
     Search
     --------------------------------------------------------------------- */

  if (searchForm) {
    var searchError = document.getElementById("search-error");
    var queryLabel = document.getElementById("s-query-label");
    var queryHint = document.getElementById("s-query-hint");
    var queryField = document.getElementById("s-query");

    // No auto-detection of what was typed. A guess that gets it wrong looks
    // exactly like a credential that does not exist.
    Array.prototype.forEach.call(searchForm.querySelectorAll('input[name="mode"]'), function (radio) {
      radio.addEventListener("change", function () {
        var byName = radio.value === "name" && radio.checked;
        if (queryLabel) queryLabel.textContent = byName ? "Holder name" : "Credential ID";
        if (queryHint) {
          queryHint.textContent = byName
            ? "The full name as it appears on the certificate. Partial names will not match."
            : "Dashes, spaces and capitals do not matter.";
        }
        if (queryField) queryField.focus();
      });
    });

    searchForm.addEventListener("submit", function (event) {
      event.preventDefault();
      searchError.hidden = true;

      if (searchForm.elements.company_website && searchForm.elements.company_website.value) {
        showNothing();
        return;
      }

      var mode = searchForm.querySelector('input[name="mode"]:checked');
      var value = (queryField.value || "").trim();

      if (mode && mode.value === "name" ? value.length < 4 : value.replace(/[^A-Za-z0-9]/g, "").length < 12) {
        queryField.setAttribute("aria-invalid", "true");
        queryField.focus();
        searchError.textContent = mode && mode.value === "name"
          ? "Please enter the holder's full name."
          : "That is not a complete credential ID. They look like BPA-FND-2026-4K7QX2.";
        searchError.hidden = false;
        return;
      }
      queryField.removeAttribute("aria-invalid");

      var submit = searchForm.querySelector(".form__submit");
      var label = submit.textContent;
      submit.disabled = true;
      submit.textContent = "Checking…";

      var payload = mode && mode.value === "name" ? { name: value } : { id: value };
      interactive = true;

      runLookup(payload, function (message) {
        searchError.textContent = message;
        searchError.hidden = false;
      }).then(function () {
        submit.disabled = false;
        submit.textContent = label;
      });
    });
  }

  var retry = document.getElementById("retry");
  if (retry) {
    retry.addEventListener("click", function () { window.location.reload(); });
  }

  var again = document.getElementById("try-again");
  if (again) {
    again.addEventListener("click", function () {
      if (notFound) notFound.hidden = true;
      if (failed) failed.hidden = true;
      if (explainer) explainer.hidden = false;
      if (searchStep && !searchStep.hidden) {
        var field = document.getElementById("s-query");
        if (field) { field.value = ""; field.focus(); }
      }
      lookup.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* Copy buttons on the LinkedIn block. LinkedIn deprecated pre-filled
     Add-to-Profile links platform-wide, so copy-and-paste is the most any
     issuer can offer now. */
  if (linkedin) {
    linkedin.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-copy]") : null;
      if (!button || !navigator.clipboard) return;
      var span = linkedin.querySelector('[data-li="' + button.getAttribute("data-copy") + '"]');
      if (!span) return;
      navigator.clipboard.writeText(span.textContent).then(function () {
        var was = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(function () { button.textContent = was; }, 1600);
      }).catch(function () { /* clipboard refused; the text is on screen anyway */ });
    });
  }
})();

/* ---------------------------------------------------------------------------
   Regional pricing — the country selector.

   The selector is a real <form method="get"> and it already works without any
   of this: choose a country, press the button, the page reloads with
   ?country=XX and the middleware prices it server-side. That matters on this
   site, where the audience is mobile-first and some visitors are on slow or
   unreliable connections.

   So this script only ENHANCES it. It submits on change and hides the button,
   which removes one tap. If the script never loads, the button is still there
   and the form still works — which is why the button ships visible and is
   hidden here rather than shipping hidden and being revealed.
   --------------------------------------------------------------------------- */
(function () {
  var forms = document.querySelectorAll("[data-region-form]");
  if (!forms.length) return;

  Array.prototype.forEach.call(forms, function (form) {
    var select = form.querySelector(".region__select");
    var button = form.querySelector(".region__go");
    if (!select) return;

    /* Reflect the country the server actually priced for, so the control shows
       the truth rather than whatever the markup was authored with. Read from
       the attribute the middleware stamps, not from the query string — the
       query string is what was ASKED for, the attribute is what was DECIDED,
       and an unrecognised country resolves to something different from what
       was typed. */
    var priced = document.documentElement.getAttribute("data-pricing-country");
    if (priced) {
      var match = select.querySelector('option[value="' + priced.replace(/[^A-Za-z]/g, "") + '"]');
      if (match) select.value = priced;
    }

    if (button) button.hidden = true;

    select.addEventListener("change", function () {
      if (!select.value) return;
      /* Submitting the form rather than building a URL keeps one code path:
         the no-JS path and this one produce byte-identical requests. */
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    });
  });
})();

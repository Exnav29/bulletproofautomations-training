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
   Writes a reservation to Supabase and swaps the form for a confirmed state.
   No money moves here — payment is arranged out of band until Paystack is live.
   When it is, only the block after a successful insert changes: the form, the
   validation, and the record written are all already correct. */

(function () {
  var form = document.getElementById("enroll-form");
  var done = document.getElementById("enroll-done");
  var errorBox = document.getElementById("form-error");
  if (!form || !done) return;

  // Injected at build time from the environment (Cloudflare Pages variables in
  // production, a local .env in development). The anon key is public by design
  // — row-level security limits it to inserting into enrollments and nothing
  // else — but it is not committed to the repository.
  var SUPABASE_URL = "__SUPABASE_URL__";
  var SUPABASE_ANON_KEY = "__SUPABASE_ANON_KEY__";

  // If the build had no environment values the tokens survive verbatim. Say so
  // and hand the visitor a route that works, rather than posting into the void.
  // Unset values are substituted as empty strings, not left as tokens, so
  // emptiness is what "not configured" actually looks like at runtime.
  var configured = SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;

  // Matches the live table's own default, so the cohort is explicit in the row
  // rather than implied by when it was created.
  var COHORT = "intermediate_2026_09";

  // Which version of the policies was on screen when they agreed. Bump this in
  // the same change that publishes a new policy, or the record will claim
  // people agreed to wording they never saw.
  var POLICY_VERSION = "2026-08-10";

  // Keys are the values the table's chosen_option CHECK constraint allows.
  var PRICE = {
    cohort_only: 750,
    cohort_and_assessment: 1050,
    path_b_readiness: 150
  };

  // First instalment due at enrollment. The remainder is arranged over Slack.
  var FIRST_INSTALMENT = {
    cohort_only: 400,
    cohort_and_assessment: 400,
    path_b_readiness: 150
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

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    clearError();

    if (!configured) {
      show(
        "Online enrollment is not available right now. Please message us on " +
          "WhatsApp and we will reserve your place."
      );
      return;
    }

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

    // Honeypot: a real person never sees this field, so anything in it means
    // a bot. Pretend it worked — a bot that gets an error learns to retry.
    if (form.elements.company_website && form.elements.company_website.value) {
      form.hidden = true;
      done.hidden = false;
      return;
    }

    var option = chosen("option");
    var instalments = chosen("payment_plan") === "Instalments";

    var payload = {
      full_name: value("full_name"),
      email: value("email"),
      whatsapp: value("whatsapp"),
      city: value("city"),
      experience_level: value("experience_level"),
      chosen_option: option,
      amount_ghs: PRICE[option],
      // payment_plan is a boolean in the table: true means instalments.
      payment_plan: instalments,
      cohort: COHORT,
      consent_given: form.elements.consent_given.checked,
      // Both are required to submit, so these are always true on a real
      // registration — the value is in the version below, which says WHICH
      // wording they were shown. WHEN is created_at, set server-side, because
      // a browser clock is not evidence of anything.
      ack_refund: form.elements.ack_refund.checked,
      ack_certification: form.elements.ack_certification.checked,
      acks_policy_version: POLICY_VERSION,
      // source is constrained to website | showcase | whatsapp | referral.
      source: "website"
    };

    if (instalments) {
      payload.first_instalment_ghs = FIRST_INSTALMENT[option];
    }

    var submit = form.querySelector(".form__submit");
    var label = submit.textContent;
    submit.disabled = true;
    submit.textContent = "Reserving…";

    fetch(SUPABASE_URL + "/rest/v1/enrollments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + SUPABASE_ANON_KEY,
        // Must stay "minimal". "representation" makes PostgREST RETURN the row,
        // which needs SELECT rights anon deliberately does not have — the insert
        // would be refused with 42501.
        Prefer: "return=minimal"
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        if (response.ok) return null;

        // A unique index on (cohort, email) and (cohort, whatsapp) means a
        // second attempt is almost always someone who already reserved.
        if (response.status === 409) {
          throw new Error(
            "You already have a place reserved for this cohort. Message us on WhatsApp if you need to change anything."
          );
        }
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
      .catch(function (err) {
        submit.disabled = false;
        submit.textContent = label;
        show(
          /already have a place/.test(err.message)
            ? err.message
            : "We could not save that. Please try again, or message us on WhatsApp and we will reserve your place manually."
        );
      });
  });
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

/* Browser-to-server journeys against the local stack (tests/local-stack/README.md).
 *   node tests/local-stack/journey.js <screenshot-dir>
 * Real Chromium (Playwright), real Pages Functions (wrangler, :8788), real SQL and the
 * webinar business's webhook. Paystack is the local stand-in. Exits non-zero on any failed check. */
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
const SITE = "http://127.0.0.1:8788";
const STATE = "http://127.0.0.1:54352/";
const COHORT_EMAIL = "preview.tester@example.com";
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }
const state = () => fetch(STATE).then((r) => r.json());

async function register(page, slug, email, query) {
  await page.goto(`${SITE}/workshops/${slug}/${query || ""}`);
  await page.fill("#ws-name", "Preview Tester");
  await page.fill("#ws-email", email);
  await page.check('input[name="ack_terms"]');
  await page.click("[data-ws-submit]");
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const before = await state();

  // 1. Paid webinar, same email as a part-paid cohort student, from a Meta ad link.
  await register(page, "sample-webinar", COHORT_EMAIL, "?paystack=test&utm_source=meta&utm_medium=paid_social&utm_campaign=120210000&utm_content=ad-42");
  await page.waitForURL(/127\.0\.0\.1:54351\/checkout\//, { timeout: 15000 });
  await page.screenshot({ path: `${out}/1-paystack-standin.png` });
  check("paid: browser handed to checkout", true, page.url());
  let s = await state();
  check("paid: one registration, pending, attribution stored", s.registrations.length === 1 && s.registrations[0].status === "pending_payment" &&
    s.registrations[0].utm_campaign === "120210000" && s.registrations[0].utm_content === "ad-42", s.registrations[0]);
  check("paid: amount sent to Paystack is the server's, in pesewas", Object.values(s.paystack)[0].amount === 15000, Object.values(s.paystack)[0].amount);
  await page.click("#pay");
  await page.waitForURL(/\/workshops\/registered\//, { timeout: 15000 });
  await page.waitForFunction(() => /You're registered/.test(document.querySelector("[data-done-title]").textContent), null, { timeout: 30000 });
  await page.screenshot({ path: `${out}/2-registered-confirmed.png`, fullPage: true });
  s = await state();
  const reg = s.registrations[0];
  check("paid: registration confirmed and paid", reg.status === "confirmed" && reg.payment_status === "paid" && Number(reg.amount_paid_minor) === 15000, reg);
  const ev = s.payment_events.find((e) => e.event === "charge.success");
  check("paid: nothing written to the training ledger (payment_events)", s.training_ledger.length === 0, s.training_ledger);
  check("paid: webinar ledger row signed, matched and linked to the webinar attempt",
    ev && ev.signature_valid && ev.matched &&
    s.attempts.some((a) => a.registration_id === reg.id && a.payment_event_id === ev.id), ev);
  check("paid: cohort enrollment with the same email unchanged", JSON.stringify(s.cohort) === JSON.stringify(before.cohort), s.cohort);
  check("paid: cohort installment unchanged", JSON.stringify(s.installments) === JSON.stringify(before.installments), s.installments);
  check("paid: confirmation email queued", s.notifications.some((n) => n.registration_id === reg.id && n.kind === "confirmation"), s.notifications);
  check("paid: webhook answered 200", Object.values(s.paystack)[0].webhook && Object.values(s.paystack)[0].webhook.status === 200, Object.values(s.paystack)[0].webhook);

  // 2. Duplicate submission: same email again after paying -> no second seat, no second charge.
  await register(page, "sample-webinar", COHORT_EMAIL, "?paystack=test");
  await page.waitForURL(/\/workshops\/registered\//, { timeout: 15000 });
  s = await state();
  check("duplicate: still one registration and one attempt", s.registrations.length === 1 && s.attempts.length === 1, { regs: s.registrations.length, attempts: s.attempts.length });

  // 3. Abandoned checkout, then a retry that pays: both references kept, paid once.
  const email2 = "second.tester@example.com";
  await register(page, "sample-webinar", email2, "?paystack=test");
  await page.waitForURL(/54351\/checkout\//);
  await page.click("#cancel");
  await page.waitForURL(/\/workshops\/registered\//);
  await page.waitForFunction(() => /Confirming your payment/.test(document.querySelector("[data-done-title]").textContent), null, { timeout: 15000 });
  await page.screenshot({ path: `${out}/3-after-cancel.png` });
  s = await state();
  const r2 = s.registrations.find((r) => r.email_normalized === email2);
  check("cancel: registration stays pending, nothing charged", r2 && r2.status === "pending_payment" && Number(r2.amount_paid_minor) === 0, r2);
  await register(page, "sample-webinar", email2, "?paystack=test");
  await page.waitForURL(/54351\/checkout\//);
  await page.click("#pay");
  await page.waitForURL(/\/workshops\/registered\//);
  await page.waitForFunction(() => /You're registered/.test(document.querySelector("[data-done-title]").textContent), null, { timeout: 30000 });
  s = await state();
  const a2 = s.attempts.filter((a) => a.registration_id === r2.id);
  check("retry: two attempts kept, second succeeded, paid once",
    a2.length === 2 && a2[0].status === "initialized" && a2[1].status === "succeeded" &&
    Number(s.registrations.find((r) => r.id === r2.id).amount_paid_minor) === 15000, a2);

  // 4. Free webinar.
  await register(page, "sample-free", "free.tester@example.com");
  await page.waitForURL(/\/workshops\/registered\//);
  await page.waitForFunction(() => /You're registered/.test(document.querySelector("[data-done-title]").textContent), null, { timeout: 15000 });
  await page.screenshot({ path: `${out}/4-free-confirmed.png` });
  s = await state();
  const rf = s.registrations.find((r) => r.email_normalized === "free.tester@example.com");
  check("free: confirmed without checkout", rf && rf.status === "confirmed" && rf.payment_status === "not_required", rf);

  // 5. Confirmation emails: run the outbox. No mail credentials exist here, so delivery
  //    must FAIL SAFE: rows stay queued for retry, nothing is marked sent.
  const d = await fetch(`${SITE}/api/workshops/dispatch`, { method: "POST", headers: { "content-type": "application/json", "x-workshop-dispatch": "local-dispatch-secret" }, body: "{}" });
  const dj = await d.json();
  s = await state();
  check("email: dispatcher authenticated and ran", d.status === 200 || d.status === 207 || dj.report, dj);
  check("email: without mail credentials nothing is marked sent; rows wait for retry",
    s.notifications.every((n) => n.status === "queued" && /mail_not_configured/.test(n.error || "")), s.notifications);
  const badSecret = await fetch(`${SITE}/api/workshops/dispatch`, { method: "POST", headers: { "x-workshop-dispatch": "wrong" } });
  check("email: dispatcher refuses a wrong secret", badSecret.status === 403, badSecret.status);

  // 5b. Same outbox, on the instance wired to the local mail stand-in (:8789). Checks
  //     what WOULD be sent: recipients, subject, join instructions only when confirmed,
  //     and no unverified phone number. Real delivery through Hostinger is NOT tested here.
  const d2 = await fetch("http://127.0.0.1:8789/api/workshops/dispatch", { method: "POST", headers: { "content-type": "application/json", "x-workshop-dispatch": "local-dispatch-secret" }, body: "{}" });
  const d2j = await d2.json();
  s = await state();
  const confirmations = s.mail.filter((m) => /You're registered/.test(m.subject));
  check("email: one confirmation per confirmed registration, to the registrant", confirmations.length === 3 &&
    confirmations.map((m) => m.to[0]).sort().join(",") === ["free.tester@example.com", "preview.tester@example.com", "second.tester@example.com"].join(","),
    { report: d2j.report, to: s.mail.map((m) => m.to[0] + " | " + m.subject) });
  check("email: join instructions and calendar link present", confirmations.every((m) => /LOCAL TEST: Zoom link/.test(m.text) && /api\/workshops\/calendar\?t=/.test(m.text)), confirmations[0] && confirmations[0].text);
  check("email: no unverified WhatsApp number when none is configured", s.mail.every((m) => !/652 7779|WhatsApp \+/.test(m.text + m.html)), s.mail.map((m) => m.text.slice(-120)));
  check("email: branded sender and independence statement", s.mail.every((m) => m.displayName === "Bulletproof Automations Training" && /not affiliated with or endorsed by n8n GmbH/.test(m.html)), s.mail[0] && s.mail[0].displayName);
  check("email: outbox rows marked sent only after the mail service accepted them", s.notifications.every((n) => n.status === "sent"), s.notifications);
  const again = await fetch("http://127.0.0.1:8789/api/workshops/dispatch", { method: "POST", headers: { "content-type": "application/json", "x-workshop-dispatch": "local-dispatch-secret" }, body: "{}" });
  await again.json();
  check("email: running the outbox again sends nothing twice", (await state()).mail.length === s.mail.length, (await state()).mail.length);
  require("fs").writeFileSync(`${out}/confirmation-email.html`, confirmations[0] ? confirmations[0].html : "");
  // The confirmation page now reports the email as sent, because the server says so.
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("bpa_ws_sample-free")).token);
  const st = await fetch(`${SITE}/api/workshops/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then((r) => r.json());
  check("page: status reports email_sent only after delivery", st.email_sent === true, st);

  // 6. Privacy: a reference alone reveals nothing.
  const ref = s.attempts[0].reference;
  const probe = await fetch(`${SITE}/api/workshops/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: ref, token: "A".repeat(43) }) });
  const pj = await probe.json();
  check("privacy: status with a reference and a wrong token is 'unknown'", pj.state === "unknown" && !JSON.stringify(pj).includes("@"), pj);

  check("no uncaught browser errors", errors.length === 0, errors);
  await browser.close();
  for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "\n     " + JSON.stringify(r.detail)));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* Release 2 in the browser: the five workshop 01 prices, verification codes, test checkout,
 * the confirmation dispatcher, the admin reports and the invitation list, against the
 * local stack started with RELEASE2=1 (tests/local-stack/README.md).
 *   node tests/local-stack/journey-release2.js <screenshot-dir>
 * Real Chromium (Playwright), real Pages Functions (wrangler :8789, wired to the mail
 * stand-in), real SQL with release 2 applied, the webinar business's webhook. Paystack and
 * the mail API are local stand-ins. Every person and certificate here is made up.
 * Exits non-zero on any failed check. */
const { chromium } = require("playwright");
const out = process.argv[2] || ".";
const SITE = "http://127.0.0.1:8789";
const STATE = "http://127.0.0.1:54352/";
const SLUG = "rehearsal-what-to-charge";
const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); }
const state = () => fetch(STATE).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dispatch = () => fetch(SITE + "/api/workshops/dispatch", {
  method: "POST", headers: { "content-type": "application/json", "x-workshop-dispatch": "local-dispatch-secret" }, body: "{}" }).then((r) => r.json());

async function openForm(page, query) {
  await page.goto(`${SITE}/workshops/${SLUG}/${query || "?paystack=test"}`);
  await page.waitForSelector("#ws-name");
  await sleep(400); // the session check settles
}
async function fillBasics(page, name, email, attend) {
  await page.fill("#ws-name", name);
  await page.fill("#ws-email", email);
  await page.dispatchEvent("#ws-email", "change");
  await page.fill("#ws-attend", attend);
}
async function confirmCertificate(page, email, certificate) {
  await page.fill("#ws-cert", certificate);
  await page.dispatchEvent("#ws-cert", "change");
  await page.click("[data-ws-cert-send]");
  await page.waitForSelector("#ws-cert-code", { state: "visible" });
  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    const m = (await state()).mail.filter((x) => x.to[0] === email && /verification code/i.test(x.subject)).pop();
    if (m) code = m.text.match(/code is (\d{6})/)[1];
    else await sleep(250);
  }
  if (!code) return false;
  await page.fill("#ws-cert-code", code);
  await page.click("[data-ws-cert-confirm]");
  await page.waitForFunction(() => /Certificate confirmed/.test(document.querySelector("[data-ws-cert-status]").textContent), null, { timeout: 10000 });
  return true;
}
const quoteText = (page) => page.textContent("[data-ws-quote]");
const buttonText = (page) => page.textContent("[data-ws-submit]");
async function submitAndPay(page, label) {
  await page.check('input[name="ack_terms"]');
  await page.click("[data-ws-submit]");
  await page.waitForURL(/127\.0\.0\.1:54351\/checkout\//, { timeout: 15000 });
  await page.screenshot({ path: `${out}/${label}-checkout.png` });
  const shown = await page.textContent("h1");
  await page.click("#pay");
  await page.waitForURL(/\/workshops\/registered\//, { timeout: 15000 });
  await page.waitForFunction(() => /You're registered/.test(document.querySelector("[data-done-title]").textContent), null, { timeout: 30000 });
  await page.screenshot({ path: `${out}/${label}-registered.png`, fullPage: true });
  return shown;
}
const row = (s, email) => s.registrations.find((r) => r.email_normalized === email) || {};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const errors = [];
  const fresh = async () => { const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; };

  // 1. Standard, GHS 350.
  let page = await fresh();
  await openForm(page);
  await fillBasics(page, "Ama Local", "ama.local@example.com", "ama.meet@example.com");
  check("350: page shows GHS 350 before checkout", /You pay GHS 350\./.test(await quoteText(page)) && /GHS 350/.test(await buttonText(page)), await quoteText(page));
  let shown = await submitAndPay(page, "1-standard");
  let s = await state();
  check("350: Paystack asked for GHS 350 and the registration is confirmed", /350\.00/.test(shown) && row(s, "ama.local@example.com").status === "confirmed" &&
    row(s, "ama.local@example.com").amount_ghs === "350.00" && row(s, "ama.local@example.com").price_tier === "standard", row(s, "ama.local@example.com"));
  await page.close();

  // 2. Referral, GHS 300: from the referrer's link, which fills in the code.
  page = await fresh();
  await openForm(page, "?paystack=test&ref=KWAME50");
  check("300: the link fills in the code", (await page.inputValue("#ws-ref")) === "KWAME50", await page.inputValue("#ws-ref"));
  await fillBasics(page, "Kofi Local", "kofi.local@example.com", "kofi.meet@example.com");
  await page.waitForFunction(() => /You pay GHS 300\./.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("300: page shows advertised 350, less 50 referral, pays 300", /Advertised GHS 350\. Less GHS 50, referral discount\. You pay GHS 300\./.test(await quoteText(page)), await quoteText(page));
  shown = await submitAndPay(page, "2-referral");
  s = await state();
  const kofi = row(s, "kofi.local@example.com");
  check("300: charged GHS 300; referral and GHS 50 commission recorded", /300\.00/.test(shown) && kofi.status === "confirmed" && kofi.amount_ghs === "300.00" &&
    kofi.discount_kind === "referral" && kofi.referral_code === "KWAME50" && kofi.commission_ghs === "50.00", kofi);
  await page.close();

  // 2b. The same code typed by hand, in lower case.
  page = await fresh();
  await openForm(page);
  await fillBasics(page, "Yaw Local", "yaw.local@example.com", "yaw.meet@example.com");
  await page.fill("#ws-ref", "kwame50");
  await page.dispatchEvent("#ws-ref", "change");
  await page.waitForFunction(() => /You pay GHS 300\./.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("300: a typed code prices the same as the link", true);
  await page.fill("#ws-ref", "NOTACODE");
  await page.dispatchEvent("#ws-ref", "change");
  await page.waitForFunction(() => /isn't valid/.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("an unknown code is refused before checkout", true);
  await page.close();

  // 3. Foundations certificate, GHS 280, with the code from the certificate's email.
  page = await fresh();
  await openForm(page);
  await fillBasics(page, "Efua Local", "efua.local@example.com", "efua.meet@example.com");
  check("280: verification code emailed to the certificate's address and accepted", await confirmCertificate(page, "efua.local@example.com", "BPA-FND-2026-LOCAL1"));
  await page.waitForFunction(() => /You pay GHS 280\./.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("280: page shows less 70, Foundations certificate price", /Less GHS 70, Foundations certificate price\. You pay GHS 280\./.test(await quoteText(page)), await quoteText(page));
  shown = await submitAndPay(page, "3-foundations");
  s = await state();
  const efua = row(s, "efua.local@example.com");
  check("280: charged GHS 280, Foundations tier, no commission", /280\.00/.test(shown) && efua.status === "confirmed" && efua.price_tier === "foundations" &&
    efua.commission_ghs === "0.00" && efua.benefit_credential_id === "BPA-FND-2026-LOCAL1", efua);
  await page.close();

  // 4. Foundations plus a referral: still GHS 280, and the referral still earns GHS 50.
  // A second made-up Foundations holder, since each certificate is redeemed once per session.
  page = await fresh();
  await openForm(page, "?paystack=test&ref=KWAME50");
  await fillBasics(page, "Esi Local", "esi.local@example.com", "esi.meet@example.com");
  check("280+ref: second Foundations certificate confirmed by emailed code", await confirmCertificate(page, "esi.local@example.com", "BPA-FND-2026-LOCAL2"));
  await page.waitForFunction(() => /You pay GHS 280\./.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("280+ref: page says discounts don't combine and the referral is still recorded", /Discounts don't combine; your referral is still recorded\./.test(await quoteText(page)), await quoteText(page));
  shown = await submitAndPay(page, "4-foundations-referral");
  s = await state();
  const esi = row(s, "esi.local@example.com");
  check("280+ref: charged GHS 280 (never 230); referral recorded with GHS 50 commission", /280\.00/.test(shown) && esi.amount_ghs === "280.00" &&
    esi.discount_kind === "foundations" && esi.referral_code === "KWAME50" && esi.commission_ghs === "50.00", esi);
  await page.close();

  // 5. Eligible Intermediate graduate: free, reserved place, no checkout.
  page = await fresh();
  await openForm(page);
  await fillBasics(page, "Abena Local", "abena.local@example.com", "abena.meet@example.com");
  check("0: graduate certificate confirmed by emailed code", await confirmCertificate(page, "abena.local@example.com", "BPA-TRN-2026-LOCALA"));
  await page.waitForFunction(() => /Complimentary graduate place\. You pay nothing\./.test(document.querySelector("[data-ws-quote]").textContent), null, { timeout: 10000 });
  check("0: button says register for free", /Register for free/.test(await buttonText(page)), await buttonText(page));
  await page.check('input[name="ack_terms"]');
  await page.click("[data-ws-submit]");
  await page.waitForFunction(() => /You're registered/.test(document.body.textContent), null, { timeout: 15000 });
  await page.screenshot({ path: `${out}/5-graduate-registered.png`, fullPage: true });
  s = await state();
  const abena = row(s, "abena.local@example.com");
  check("0: confirmed, no payment, graduate tier, reserved place, no checkout started", abena.status === "confirmed" && abena.payment_status === "not_required" &&
    abena.price_tier === "graduate" && !s.attempts.some((a) => a.registration_id === abena.id), abena);
  await page.close();

  // Confirmation dispatcher: one email per confirmed registration, no Meet link.
  await dispatch();
  s = await state();
  const confirmations = s.mail.filter((m) => /You're registered/.test(m.subject));
  check("dispatcher: five confirmations, one per registration", confirmations.length === 5, confirmations.map((m) => m.to[0]));
  check("dispatcher: no Meet link and no calendar file in any email; invitation explained", confirmations.every((m) =>
    !/meet\.google\.com|api\/workshops\/calendar/.test(m.text + m.html) && /invitation/i.test(m.text)), confirmations[0] && confirmations[0].text.slice(0, 600));
  check("dispatcher: Ghana and Lagos times shown", confirmations.every((m) => /11:30 AM.2:30 PM \(GMT\)/.test(m.text) && /12:30 PM.3:30 PM \(WAT\)/.test(m.text)), confirmations[0] && confirmations[0].text.slice(0, 400));
  check("dispatcher: discounts named", confirmations.some((m) => /GHS 300, with a GHS 50 referral discount/.test(m.text)) &&
    confirmations.some((m) => /complimentary/i.test(m.text)), confirmations.map((m) => m.text.match(/GHS[^\n]*/)?.[0]));
  await dispatch();
  check("dispatcher: running again sends nothing twice", (await state()).mail.filter((m) => /You're registered/.test(m.subject)).length === 5);

  // Admin: reports and the invitation list, in the real admin page.
  // The production CSP names *.supabase.co; the local database is 127.0.0.1, so this context only bypasses CSP.
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  page = await adminCtx.newPage();
  page.on("pageerror", (e) => errors.push("admin: " + e.message));
  await page.addInitScript(() => sessionStorage.setItem("bpa_admin_session",
    JSON.stringify({ access_token: "local-admin-jwt", refresh_token: "x", email: "johnathan@bulletproofautomations.com", expires_at: Date.now() + 3600000 })));
  await page.goto(`${SITE}/admin/workshops/`);
  await page.waitForFunction(() => document.getElementById("ws-count") && Number(document.getElementById("ws-count").textContent) >= 5, null, { timeout: 20000 });
  await page.screenshot({ path: `${out}/6-admin.png`, fullPage: true });
  const inv = await page.textContent("#ws-invites");
  check("admin: rehearsal session flagged as TEST, with the rehearsal-event warning", /TEST SESSION/.test(inv) && /never to a workshop.s real event/.test(inv), inv.slice(0, 300));
  check("admin: all five, including the graduate, listed to add to the Calendar event", ["ama.meet", "kofi.meet", "efua.meet", "esi.meet", "abena.meet"].every((a) => inv.includes(a + "@example.com")), inv);
  const refs = await page.textContent("#ws-referrals");
  check("admin: the code shows as prepared, rehearsal only", /KWAME50/.test(refs) && /Prepared: rehearsal only/.test(refs), refs.slice(0, 300));
  check("admin: referral link points at a workshop page, not the directory", new RegExp("/workshops/" + SLUG + "/\\?ref=KWAME50").test(refs), refs);
  check("admin: test referral sales are never payable and show no payout button", /Test registration: never payable/.test(refs) && !(await page.$("[data-ws-payout]")), refs);
  check("admin: commissions due is 0 for test sales", (await page.textContent("#ws-ref-due")).trim() === "0");
  const places = await page.textContent("#ws-places");
  check("admin: places for the test session are labelled separate", /TEST SESSION, separate places/.test(places) && /general 4 of 25, reserved graduate 1 of 5/.test(places), places);
  const camp = await page.textContent("#ws-camp-rows");
  check("admin: campaign revenue excludes the test session", /No live registrations yet/.test(camp), camp);
  // Mark one invited, then try paying a commission through the admin API directly.
  const dialogs = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
  await page.click(`[data-ws="mark_invited"][data-id="${kofi.id}"]`);
  await page.waitForFunction((id) => !document.querySelector(`[data-ws="mark_invited"][data-id="${id}"]`), kofi.id, { timeout: 10000 });
  check("admin: asks for confirmation that the guest was added in Calendar first", dialogs.some((m) => /added this Google account as a guest/.test(m)), dialogs);
  s = await state();
  check("admin: invitation status recorded for the rehearsal registration", row(s, "kofi.local@example.com").invited_email === "kofi.meet@example.com", row(s, "kofi.local@example.com"));
  const direct = await page.evaluate((id) => fetch("/api/admin/workshops", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer local-admin-jwt" },
    body: JSON.stringify({ action: "record_payout", registration_id: id, value: "MOMO-TEST" }) }).then((r) => r.json().then((j) => ({ status: r.status, j }))), kofi.id);
  s = await state();
  check("admin: a payout on a test sale is refused, and nothing is recorded", direct.status === 409 && /test registration/.test(direct.j.error) && s.payouts.length === 0, direct);

  check("no uncaught JavaScript errors", errors.length === 0, errors);
  await browser.close();
  process.exit(report() ? 1 : 0);
})().catch((e) => { report(); console.error(e); process.exit(2); });

function report() {
  for (const r of results) console.log((r.ok ? "PASS " : "FAIL ") + r.name + (r.ok ? "" : "  " + JSON.stringify(r.detail).slice(0, 600)));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  return failed;
}

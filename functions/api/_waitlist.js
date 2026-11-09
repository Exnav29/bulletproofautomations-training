/* Waitlist: one pass per dispatcher run (processOutbox, every minute).
 *
 * The database decides everything (workshop_waitlist_advance, under each
 * session's lock): who is offered a place, when an offer expires, when the
 * waitlist closes at the seven-day cutoff. This module only sends the emails
 * those decisions owe (workshop_waitlist_mail_due), with the site's Hostinger
 * sender, and records each one on the waitlist row. An offer email carries a
 * fresh single-use link; only its SHA-256 is stored, and a resend replaces it.
 *
 * Not routed (leading underscore). */

import { rpc } from "./_shared.js";
import { db } from "./_installments.js";
import { sendMail, esc, MAILBOX } from "./_mail.js";

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode.apply(null, Array.from(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}
// A void function answers 204, which the shared rpc() would try to parse.
function rpcVoid(env, name, args) {
  return db(env, "rpc/" + name, { method: "POST", body: JSON.stringify(args) }).then(function (r) { return r.text(); }).catch(function () {});
}

function accra(iso, withDay) {
  const d = new Date(iso);
  const opts = { timeZone: "Africa/Accra", hour: "numeric", minute: "2-digit", hour12: true };
  if (withDay) Object.assign(opts, { weekday: "long", day: "numeric", month: "long" });
  return new Intl.DateTimeFormat("en-GB", opts).format(d).replace(/ am$/, " AM").replace(/ pm$/, " PM") + " in Accra";
}

function message(kind, row, links) {
  const when = accra(row.starts_at, true);
  const parts = {
    joined: ["You're on the waitlist: " + row.title,
      "You're on the waitlist for " + row.title + " (" + when + "). You are number " + row.position + " in the queue" +
      (row.seat_kind === "graduate" ? " for the reserved graduate places" : "") + ". You have not paid anything.",
      "If a place opens, we email you a link that holds it for you for up to 24 hours. Places are offered strictly in the order people joined. Registration closes seven days before the session; after that no places are offered."],
    offer: ["A place is held for you: " + row.title,
      "A place has opened for " + row.title + " (" + when + "), and it is held for you until " + accra(row.offer_expires_at, true) + ".",
      "Use the link below to register. Your details are already filled in, and you pay with the usual Paystack checkout, by mobile money or card. Nothing is charged unless you choose to pay. If you don't want the place, use the second link so it can go to the next person."],
    reminder: ["Your held place expires soon: " + row.title,
      "The place we are holding for you at " + row.title + " is held until " + accra(row.offer_expires_at, true) + ".",
      "After that it goes to the next person on the waitlist."],
    released: ["Your waitlist place has been released: " + row.title,
      row.status_reason === "registration closed"
        ? "Registration for " + row.title + " has now closed, so we can't offer you a place. Thank you for your patience."
        : "The place we held for you at " + row.title + " was not taken up in time, so it has gone to the next person on the waitlist.",
      "You have not been charged. Other sessions are listed at training.bulletproofautomations.com/workshops."]
  }[kind];
  const linkHtml = links ? '<p style="margin:0 0 14px"><a href="' + esc(links.offer) + '" style="display:inline-block;background:#116149;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:700">Register for your place</a></p>' +
    '<p style="margin:0 0 14px;font-size:14px"><a href="' + esc(links.decline) + '" style="color:#116149">I don\'t want this place</a></p>' : "";
  const help = "Questions? Reply to this email, or write to " + MAILBOX + ".";
  return {
    subject: parts[0],
    text: "Hello " + row.full_name + ",\n\n" + parts[1] + "\n\n" + parts[2] +
      (links ? "\n\nRegister: " + links.offer + "\nGive the place back: " + links.decline : "") + "\n\n" + help + "\n\nBulletproof Automations Training",
    html: '<!doctype html><html><body style="margin:0;background:#f3efe5;font-family:Arial,sans-serif;color:#10251d">' +
      '<div style="max-width:620px;margin:0 auto;padding:28px 18px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;font-weight:700">Bulletproof Automations Training</div>' +
      '<div style="background:#fff;margin-top:18px;padding:28px;border:1px solid #d8d2c3;border-radius:16px">' +
      '<p style="margin:0 0 8px;font-size:18px">Hello ' + esc(row.full_name) + ',</p>' +
      '<p style="font-size:15px;line-height:1.55;margin:0 0 14px">' + esc(parts[1]) + '</p>' +
      '<p style="font-size:15px;line-height:1.55;margin:0 0 18px">' + esc(parts[2]) + '</p>' + linkHtml +
      '<p style="font-size:13px;line-height:1.5;color:#52615b;margin:22px 0 0">' + esc(help) + '</p></div>' +
      '<p style="font-size:12px;line-height:1.5;color:#65736d;margin:16px 4px 0">Bulletproof Automations is an independent training provider based in Jacksonville, Florida. ' +
      "Attending a webinar or workshop is not a certification. Bulletproof Automations is not affiliated with or endorsed by n8n GmbH.</p>" +
      "</div></body></html>"
  };
}

/** { advanced, sent, failed } or null. Never throws. */
export async function processWaitlist(env, origin, test) {
  const report = { sent: 0, failed: 0 };
  const advanced = await rpc(env, "workshop_waitlist_advance", { p_test: test });
  if (!advanced.ok) return null;
  report.advanced = advanced.data;
  const due = await rpc(env, "workshop_waitlist_mail_due", { p_test: test, p_limit: 10 });
  for (const row of due.ok && Array.isArray(due.data) ? due.data : []) {
    let links = null;
    if (row.kind === "offer") {
      const t = token();
      const set = await rpc(env, "workshop_waitlist_set_token", { p_id: row.id, p_token_hash: await sha256Hex(t) });
      if (!set.ok || set.data !== true) continue;
      const base = origin + "/workshops/" + encodeURIComponent(row.slug) + "/?offer=" + encodeURIComponent(t);
      links = { offer: base + "#register", decline: base + "&decline=1" };
    }
    const m = message(row.kind, row, links);
    const sent = await sendMail(env, { to: row.email, subject: m.subject, text: m.text, html: m.html });
    await rpcVoid(env, "workshop_waitlist_mail_done", { p_id: row.id, p_kind: row.kind, p_ok: sent.ok, p_error: sent.ok ? null : sent.code });
    if (sent.ok) report.sent += 1; else report.failed += 1;
  }
  return report;
}

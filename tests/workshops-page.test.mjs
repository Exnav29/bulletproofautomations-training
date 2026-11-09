/* assets/js/workshops.js under jsdom, on a generated workshop page: what a sold-out
 * page does for somebody who has already registered from this browser, and that
 * re-registering sends this browser's status token (Codex audit, 9 November 2026).
 * Run after `npm install` of the Studio test deps (jsdom), and after building the
 * fixture pages:
 *   WORKSHOP_CONTENT_DIR=tests/fixtures/workshops npm run build && node tests/workshops-page.test.mjs */
import fs from "node:fs";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const html = fs.readFileSync("dist/workshops/sample-webinar/index.html", "utf8");
const script = fs.readFileSync("assets/js/workshops.js", "utf8");
const TOKEN = "T".repeat(43);

async function soldOutPage(stored) {
  const dom = new JSDOM(html, { url: "https://training.example/workshops/sample-webinar/", runScripts: "outside-only" });
  const w = dom.window;
  if (stored) w.localStorage.setItem("bpa_ws_sample-webinar", JSON.stringify(stored));
  const main = w.document.querySelector("main[data-ws-page]");
  const posts = [];
  const reply = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
  w.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("/api/workshops/session")) {
      return reply({ ok: true, session: { slug: "sample-webinar", price_ghs: Number(main.dataset.price), starts_at: main.dataset.starts },
        open: false, full: true, general_full: true, graduate_places_open: false, waitlist_open: true, status: "full" });
    }
    if (init && init.method === "POST") {
      posts.push({ url: u, body: JSON.parse(init.body) });
      return reply({ ok: false, code: "registered" }, 409);
    }
    return reply({ ok: true });
  };
  w.confirm = () => false;
  w.eval(script);
  await new Promise((r) => setTimeout(r, 50));
  const form = w.document.querySelector("[data-ws-form]");
  const submit = w.document.querySelector("[data-ws-submit]");
  async function send() {
    form.elements.full_name.value = "Ama Mensah";
    form.elements.email.value = "ama@example.com";
    if (form.elements.attend_email) form.elements.attend_email.value = "ama.meet@gmail.com";
    form.elements.ack_terms.checked = true;
    form.dispatchEvent(new w.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 50));
  }
  const error = () => (w.document.querySelector("[data-ws-error]") || {}).textContent || "";
  return { w, form, submit, posts, send, error };
}

// A new visitor on a sold-out session is offered the waitlist, as approved.
{
  const p = await soldOutPage(null);
  assert.equal(p.submit.textContent, "Join the waitlist");
  await p.send();
  assert.equal(p.posts[0].url, "/api/workshops/waitlist");
}

// Somebody who registered from this browser keeps the payment form, so a failed or
// abandoned payment can be retried; the server decides whether the place is theirs.
{
  const p = await soldOutPage({ token: TOKEN, reference: null });
  assert.notEqual(p.submit.textContent, "Join the waitlist", "the form was switched to the waitlist");
  await p.send();
  assert.equal(p.posts[0].url, "/api/workshops/register", "the retry went to the waitlist instead of registration");
  assert.equal(p.posts[0].body.token, TOKEN, "this browser's status token is sent");
  // Refused (another browser's registration): told plainly, nothing else.
  assert.match(p.error(), /already has a registration for this session/);
}

console.log("workshops page: sold-out retry and token resume ok");

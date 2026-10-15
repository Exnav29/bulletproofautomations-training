const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { File } = require("node:buffer");
const { webcrypto } = require("node:crypto");

const code = fs.readFileSync("assets/js/admin-archives.js", "utf8");
const html = fs.readFileSync("admin/index.html", "utf8");
const ID = "BPA-FND-2026-WHXRTT";

function element() {
  return {
    hidden: false, textContent: "", className: "", disabled: false,
    value: "", files: [],
    children: [], listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    appendChild(el) { this.children.push(el); return el; },
    remove() {},
    focus() {},
    setAttribute() {}
  };
}

function harness(options = {}) {
  const elements = {};
  const document = {
    getElementById(id) { return elements[id] || (elements[id] = element()); },
    createElement() { return element(); },
    body: { appendChild() {} }
  };
  const row = { id: "record-1", holder_name: "Carl Lokko", credential_id: ID, pdf_path: null };
  const calls = [];
  const authFetch = async (path, opts = {}) => {
    calls.push({ path, opts });
    if (path.startsWith("/storage/v1/object/") && opts.method === "POST") {
      if (options.failPublic && path.startsWith("/storage/v1/object/credentials/"))
        return new Response('{"message":"storage failed"}', { status: 500 });
      return new Response("{}", { status: 200 });
    }
    if (path.startsWith("/rest/v1/credentials") && opts.method === "PATCH") {
      const update = JSON.parse(opts.body);
      return new Response(JSON.stringify([{ pdf_path: update.pdf_path }]), { status: 200 });
    }
    throw new Error("Unexpected API request " + path);
  };
  const context = {
    document,
    window: { confirm() { return true; } },
    credState: { rows: [row] },
    authFetch, loadCredentials: async () => {},
    crypto: webcrypto,
    Date, Promise, Blob, Uint8Array, Array, String, JSON,
    URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
    setTimeout, clearTimeout, console
  };
  vm.runInNewContext(code, context, { filename: "admin-archives.js" });
  return { elements, row, calls, context };
}

const file = (name = ID + ".pdf", data = "%PDF-1.4\nvalid-body") =>
  new File([data], name, { type: "application/pdf" });

function waitForBatch(h) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + 1200;
    const check = () => {
      const b = h.elements["archive-batch-status"];
      if (b && /Archived \d+ of \d+/.test(b.textContent)) return resolve();
      if (Date.now() > until) return reject(new Error("Batch did not finish: " + (b && b.textContent)));
      setTimeout(check, 10);
    };
    check();
  });
}

test("UI is additive and existing admin script loads before archive script", () => {
  assert.ok(html.includes('id="archive-batch-files"'));
  assert.ok(html.includes('id="credential-archive-dialog"'));
  assert.ok(html.indexOf('src="/assets/js/admin.js"') <
            html.indexOf('src="/assets/js/admin-archives.js"'));
  assert.ok(html.includes('id="cred-rows"'));
  assert.ok(html.includes('id="issue-form"'));
  assert.ok(html.includes('id="enq-rows"'));
});

test("batch archive writes master, public PDF, then pdf_path in that order", async () => {
  const h = harness();
  h.elements["archive-batch-files"].files = [file()];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 3);
  assert.match(h.calls[0].path, /^\/storage\/v1\/object\/credential-masters\/BPA-FND-2026-WHXRTT\//);
  assert.match(h.calls[1].path, /^\/storage\/v1\/object\/credentials\/BPA-FND-2026-WHXRTT\//);
  assert.match(h.calls[2].path, /^\/rest\/v1\/credentials\?id=eq\./);
  const key = JSON.parse(h.calls[2].opts.body).pdf_path;
  assert.ok(key.endsWith(".pdf"));
  assert.equal(h.row.pdf_path, key);
  assert.equal(h.elements["archive-batch-btn"].disabled, false);
});

test("failed public upload leaves credential link unchanged", async () => {
  const h = harness({ failPublic: true });
  h.elements["archive-batch-files"].files = [file()];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 2);
  assert.equal(h.row.pdf_path, null);
  assert.match(h.elements["archive-batch-status"].textContent, /Failures/);
});

test("invalid PDF or filename never reaches storage", async () => {
  const h = harness();
  h.elements["archive-batch-files"].files = [file(ID + ".pdf", "NOT-A-PDF")];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.row.pdf_path, null);
  assert.match(h.elements["archive-batch-status"].textContent, /Failures/);
});

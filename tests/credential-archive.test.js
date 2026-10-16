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
  const row = { id: "record-1", holder_name: "Carl Lokko", credential_id: ID, pdf_path: null, updated_at: "2026-10-16T00:00:00Z" };
  const calls = [];
  var failedStart;
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
    SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "public",
    session: () => ({ access_token: "admin-jwt" }),
    fetch: async (url, opts) => {
      calls.push({ path: url, opts });
      if (url.includes("jobs?credential=")) {
        const jobs = options.existingAfterTimeout ? [{master_path:failedStart.master_path,mode:failedStart.mode,state:"completed",result:{pdf_path:failedStart.master_path,preview_path:failedStart.master_path.replace(/.pdf$/, ".png")}}] : [];
        return new Response(JSON.stringify(jobs));
      }
      const request = JSON.parse(opts.body);
      if (options.timeoutOnce && !failedStart) { failedStart = request; return new Response('{"error":"Signal timed out"}',{status:400}); }
      if (options.failPublic) return new Response('{"error":"conversion failed"}', { status: 422 });
      return new Response(JSON.stringify({state:"completed", stage:"Complete", result:{pdf_path:request.master_path,preview_path:request.master_path.replace(/.pdf$/, ".png")}}));
    },
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
  assert.ok(html.indexOf('src="/assets/js/admin.js') <
            html.indexOf('src="/assets/js/admin-archives.js'));
  assert.ok(html.includes('id="cred-rows"'));
  assert.ok(html.includes('id="issue-form"'));
  assert.ok(html.includes('id="enq-rows"'));
});

test("single browser PDF upload starts backend processing; no public object or DB writes", async () => {
  const h = harness();
  h.elements["archive-batch-files"].files = [file()];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[0].path, /^\/storage\/v1\/object\/credential-masters\/BPA-FND-2026-WHXRTT\//);
  assert.match(h.calls[1].path, /functions\/v1\/certificate-processor\/jobs$/);
  assert.equal(h.calls[1].opts.headers.Authorization, "Bearer admin-jwt");
  const request = JSON.parse(h.calls[1].opts.body);
  assert.equal(request.mode, "publish");
  assert.equal(h.row.pdf_path, request.master_path);
  assert.equal(h.row.preview_path, request.master_path.replace(/.pdf$/, ".png"));
  assert.equal(h.elements["archive-batch-btn"].disabled, false);
});

test("failed public upload leaves credential link unchanged", async () => {
  const h = harness({ failPublic: true });
  h.elements["archive-batch-files"].files = [file()];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 2);
  assert.equal(h.row.pdf_path, null);
  assert.match(h.elements["archive-batch-status"].textContent, /Failed/);
});

test("invalid PDF or filename never reaches storage", async () => {
  const h = harness();
  h.elements["archive-batch-files"].files = [file(ID + ".pdf", "NOT-A-PDF")];
  h.elements["archive-batch-btn"].listeners.click();
  await waitForBatch(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.row.pdf_path, null);
  assert.match(h.elements["archive-batch-status"].textContent, /Failed/);
});


test("certificate issue dates display 29 August across browser timezones", () => {
  const { spawnSync } = require("node:child_process");
  const source = fs.readFileSync("assets/js/admin.js", "utf8");
  const start = source.indexOf("function credentialDate(v)");
  const end = source.indexOf("\n}", start) + 2;
  const script = source.slice(start, end) + ';console.log(credentialDate("2026-08-29"));';
  for (const TZ of ["America/Los_Angeles", "Pacific/Honolulu", "Africa/Accra", "Pacific/Kiritimati"]) {
    const run = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(run.status, 0); assert.equal(run.stdout.trim(), "29 Aug");
  }
});


test("a timed-out start checks durable status then retries the saved PDF once", async () => {
  const h=harness({timeoutOnce:true});h.elements["archive-batch-files"].files=[file()];
  h.elements["archive-batch-btn"].listeners.click();await waitForBatch(h);
  assert.equal(h.calls.length,4);
  assert.match(h.calls[2].path,/jobs\?credential=/);
  assert.equal(h.calls.filter(c=>c.path.startsWith("/storage/")).length,1);
  assert.equal(h.row.preview_path,h.row.pdf_path.replace(/.pdf$/, ".png"));
});
test("a start with uncertain success reconnects its existing job without resending", async () => {
  const h=harness({timeoutOnce:true,existingAfterTimeout:true});h.elements["archive-batch-files"].files=[file()];
  h.elements["archive-batch-btn"].listeners.click();await waitForBatch(h);
  assert.equal(h.calls.length,3);
  assert.equal(h.calls.filter(c=>c.path.endsWith("/jobs")&&c.opts.method==="POST").length,1);
  assert.ok(h.row.preview_path);
});

import test from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../functions/api/verify.js";
import { issuePass } from "../functions/api/_shared.js";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "local-test-key-not-real",
  TURNSTILE_SECRET_KEY: "local-test-turnstile",
  GATE_SECRET: "local-test-gate-secret",
};

const foundationId = "BPA-FND-2026-AB2345";
const intermediateId = "BPA-TRN-2026-CD6789";
const holder = "Test Graduate Person";

const found = [
  {
    credential_id: foundationId,
    holder_name: holder,
    credential: "foundations",
    issued_on: "2026-08-29",
    expires_on: null,
    platform_version: null,
    pdf_path: "foundations.pdf",
    preview_path: "foundations.png",
    result_status: "valid",
  },
  {
    credential_id: intermediateId,
    holder_name: holder,
    credential: "completion",
    issued_on: "2026-10-31",
    expires_on: null,
    platform_version: null,
    pdf_path: "intermediate.pdf",
    preview_path: "intermediate.png",
    result_status: "valid",
  },
];

function installFetchMocks(t) {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
      return Response.json({ success: true });
    }
    const action = target.split("/").pop();
    const args = JSON.parse(options.body || "{}");
    calls.push({ action, args });
    if (action === "verify_credential") {
      if (args.p_name) return Response.json(found);
      return Response.json(found.filter(x => x.credential_id === args.p_id));
    }
    if (action === "verify_credentials_for") return Response.json(found);
    if (action === "studio_public_details") {
      return Response.json([
        { credential_id: foundationId, course_title: "Foundations", completion_statement: "Completed Foundations" },
        { credential_id: intermediateId, course_title: "Automation Studio: Intermediate", completion_statement: "Completed Intermediate" },
      ]);
    }
    throw new Error("Unexpected simulated request " + action);
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  return calls;
}

async function lookup(payload) {
  const request = new Request("https://training.bulletproofautomations.com/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await onRequest({ request, env });
  assert.equal(response.status, 200);
  return response.json();
}

test("a Foundations ID lookup also returns the same holder's Intermediate completion", async t => {
  const calls = installFetchMocks(t);
  const result = await lookup({ id: foundationId });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(x => x.credentialId), [foundationId, intermediateId]);
  assert.equal(result.results[1].courseTitle, "Automation Studio: Intermediate");
  assert.equal(result.results[1].credential, "completion");
  assert.ok(result.results[1].pdfUrl?.endsWith("/intermediate.pdf"));
  assert.ok(calls.some(x => x.action === "verify_credentials_for"));
});

test("exact-name search returns both certificates after the verifier gate", async t => {
  installFetchMocks(t);
  const pass = await issuePass(env);
  const result = await lookup({
    name: holder,
    turnstileToken: "synthetic-test-token",
    pass,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(x => x.credential), ["foundations", "completion"]);
});

test("wrong ID does not return other credentials", async t => {
  installFetchMocks(t);
  const result = await lookup({ id: "BPA-FND-2026-ZZ0000" });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 0);
});

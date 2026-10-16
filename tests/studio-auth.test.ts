import { handle } from "../supabase/functions/certificate-studio/handler.ts";
const original = globalThis.fetch;
function ok(v: unknown) {
  if (!v) throw Error("assertion failed");
}
Deno.test(
  "unauthenticated and nonadministrator requests cannot create certificates",
  async () => {
    let dbRequests = 0;
    globalThis.fetch = async (input) => {
      if (String(input).includes("/auth/v1/user"))
        return Response.json({ id: "attacker", email: "attacker@example.com" });
      dbRequests++;
      return Response.json({});
    };
    try {
      for (const auth of ["", "Bearer attacker"]) {
        const r = await handle(
          new Request("https://example.com", {
            method: "POST",
            headers: auth ? { Authorization: auth } : {},
            body: JSON.stringify({ action: "approve", data: {} }),
          }),
        );
        ok(r.status === 403);
      }
      ok(dbRequests === 0);
    } finally {
      globalThis.fetch = original;
    }
  },
);
Deno.test(
  "internal proof and email claim actions cannot be invoked by browser",
  async () => {
    globalThis.fetch = async () =>
      Response.json({
        id: "admin",
        email: "johnathan@bulletproofautomations.com",
      });
    try {
      for (const action of [
        "proof_generated",
        "claim_email",
        "email_result",
        "issue_context",
        "job",
      ]) {
        const r = await handle(
          new Request("https://example.com", {
            method: "POST",
            headers: { Authorization: "Bearer admin" },
            body: JSON.stringify({ action, data: {} }),
          }),
        );
        ok(r.status === 400);
        const result = await r.json();
        ok(result.error === "Unsupported Studio action");
      }
    } finally {
      globalThis.fetch = original;
    }
  },
);
Deno.test(
  "missing transport configuration cannot claim or send mail",
  async () => {
    globalThis.fetch = async () =>
      Response.json({
        id: "admin",
        email: "johnathan@bulletproofautomations.com",
      });
    try {
      const r = await handle(
        new Request("https://example.com", {
          method: "POST",
          headers: { Authorization: "Bearer admin" },
          body: JSON.stringify({ action: "send_email", data: { id: "test" } }),
        }),
      );
      ok(r.status === 503);
    } finally {
      globalThis.fetch = original;
    }
  },
);
Deno.test(
  "permanent transport sends one recipient and exactly the matching archived PDF",
  async () => {
    const { dispatch } = await import(
      "../supabase/functions/certificate-studio/handler.ts"
    );
    Deno.env.set("HOSTINGER_MAIL_API_TOKEN", "controlled-test-token");
    const pdf = new TextEncoder().encode("%PDF-controlled-test");
    let payload: any;
    let result: any;
    let providerCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/rest/v1/rpc/studio_action")) {
        const p = JSON.parse(String(init?.body));
        if (p.p_action === "claim_email")
          return Response.json({
            id: "delivery",
            master_path: "test/version.pdf",
            message: {
              to: "controlled@example.com",
              subject: "Test",
              body: "Personalized body",
              attachment_name: "BPA-TRN-2026-T3ST01.pdf",
            },
          });
        result = p.p_data;
        return Response.json({});
      }
      if (url.includes("/storage/")) return new Response(pdf);
      providerCalls++;
      payload = JSON.parse(String(init?.body));
      return new Response(null, {
        status: 204,
        headers: { "x-correlation-id": "provider-test-id" },
      });
    };
    try {
      const r = await dispatch("admin", {
        action: "send_email",
        data: { id: "delivery" },
      });
      const response = await r.json();
      ok(response.state === "sent");
      ok(providerCalls === 1);
      ok(payload.to.length === 1 && payload.to[0] === "controlled@example.com");
      ok(!payload.cc && !payload.bcc);
      ok(
        payload.attachments.length === 1 &&
          payload.attachments[0].filename === "BPA-TRN-2026-T3ST01.pdf",
      );
      ok(atob(payload.attachments[0].content) === "%PDF-controlled-test");
      ok(result.provider_id === "provider-test-id");
    } finally {
      globalThis.fetch = original;
      Deno.env.delete("HOSTINGER_MAIL_API_TOKEN");
    }
  },
);
Deno.test(
  "transport timeout persists uncertain outcome and never retries provider",
  async () => {
    const { dispatch } = await import(
      "../supabase/functions/certificate-studio/handler.ts"
    );
    Deno.env.set("HOSTINGER_MAIL_API_TOKEN", "controlled-test-token");
    let sends = 0;
    let outcome: any;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/rest/")) {
        const p = JSON.parse(String(init?.body));
        if (p.p_action === "claim_email")
          return Response.json({
            id: "delivery",
            master_path: "test/version.pdf",
            message: {
              to: "controlled@example.com",
              subject: "Test",
              body: "Body",
              attachment_name: "test.pdf",
            },
          });
        outcome = p.p_data;
        return Response.json({});
      }
      if (url.includes("/storage/")) return new Response("PDF");
      sends++;
      throw Error("timeout");
    };
    try {
      const r = await dispatch("admin", {
        action: "send_email",
        data: { id: "delivery" },
      });
      ok((await r.json()).state === "uncertain");
      ok(sends === 1);
      ok(outcome.state === "uncertain");
    } finally {
      globalThis.fetch = original;
      Deno.env.delete("HOSTINGER_MAIL_API_TOKEN");
    }
  },
);

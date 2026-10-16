import { generate, combine, hash } from "./pdf.mjs";
import { parseRoster, validateGraduate, emailMessage } from "./domain.mjs";
import { render } from "../certificate-processor/render.mjs";
import { zipSync } from "npm:fflate@0.8.2";
const PROJECT = "https://ikkldbhgjleelviwttir.supabase.co",
  ADMIN = "johnathan@bulletproofautomations.com";
const KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY");
const cors = {
  "Access-Control-Allow-Origin": "https://training.bulletproofautomations.com",
  "Access-Control-Allow-Headers": "authorization,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  Vary: "Origin",
};
const headers = {
  apikey: KEY!,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
};
const MAIL_TOKEN = () =>
  Deno.env.get("HOSTINGER_MAIL_API_TOKEN") ||
  Deno.env.get("HOSTINGER_API_TOKEN");
const MAILBOX = "AC8b0ed57303e85973a5b8cfedfe66";
async function db(name: string, body: unknown) {
  const r = await fetch(PROJECT + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.message || "Database request failed");
  return d;
}
async function get(bucket: string, key: string) {
  const r = await fetch(PROJECT + "/storage/v1/object/" + bucket + "/" + key, {
    headers,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw Error("Private document unavailable (" + r.status + ")");
  return new Uint8Array(await r.arrayBuffer());
}
async function put(
  bucket: string,
  key: string,
  data: Uint8Array,
  mime: string,
) {
  const r = await fetch(PROJECT + "/storage/v1/object/" + bucket + "/" + key, {
    method: "POST",
    headers: { ...headers, "Content-Type": mime, "x-upsert": "false" },
    body: new Uint8Array(data).buffer,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok && ![400, 409].includes(r.status))
    throw Error("Archive upload failed");
  if ((await hash(await get(bucket, key))) !== (await hash(data)))
    throw Error("Immutable archive differs");
}
async function assets() {
  const [template, body, serif, signature] = await Promise.all(
    ["template-001-v1.pdf", "body.ttf", "serif.ttf", "signature.png"].map((f) =>
      get("certificate-studio", "studio/001/v1/" + f),
    ),
  );
  return { template, body, serif, signature };
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
function binary(bytes: Uint8Array, name: string, mime = "application/pdf") {
  return new Response(new Uint8Array(bytes).buffer, {
    headers: {
      ...cors,
      "Content-Type": mime,
      "Content-Disposition": 'attachment; filename="' + name + '"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function handle(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer "))
      return json({ error: "Administrator required" }, 403);
    const userResponse = await fetch(PROJECT + "/auth/v1/user", {
      headers: { apikey: KEY!, Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    if (!userResponse.ok) return json({ error: "Administrator required" }, 403);
    const user = await userResponse.json();
    if (!user.id || String(user.email).toLowerCase() !== ADMIN)
      return json({ error: "Administrator required" }, 403);
    const raw = await req.text();
    if (raw.length > 300000) return json({ error: "Request too large" }, 413);
    return await dispatch(user.id, JSON.parse(raw));
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 300) }, 400);
  }
}

export async function dispatch(actorId: string, input: any) {
  const action = String(input.action),
    data = input.data || {};
  const rpc = (a: string, d: any = {}) =>
    db("studio_action", { p_actor: actorId, p_action: a, p_data: d });
  if (action === "update_cohort")
    return json(
      await db("studio_update_cohort", {
        p_actor: actorId,
        p_id: data.id,
        p_data: data,
      }),
    );
  if (action === "health")
    return json({ ok: true, email_configured: !!MAIL_TOKEN(), mailbox: ADMIN });
  if (action === "import_csv")
    return json(
      await rpc("graduates", {
        batch_id: data.batch_id,
        graduates: parseRoster(data.csv),
      }),
    );
  if (action === "graduates")
    data.graduates = data.graduates.map(validateGraduate);
  if (["graduate", "correct"].includes(action))
    data.graduate = validateGraduate(data.graduate);
  if (action === "proof") {
    const ctx = await rpc("proof_context", { id: data.id });
    if (ctx.batch.state !== "draft") throw Error("Batch no longer draft");
    const bytes = await generate(
      { ...ctx.batch.snapshot, ...ctx.graduate.data },
      await assets(),
      { draft: true, format: data.format || "letter" },
    );
    await rpc("proof_generated", {
      id: ctx.graduate.id,
      revision: ctx.batch.revision,
    });
    if (data.preview) {
      const image = await render(bytes);
      return binary(image.png, "proof.png", "image/png");
    }
    return binary(bytes, "DRAFT-" + ctx.graduate.id + ".pdf");
  }
  if (action === "issue") {
    const ctx = await rpc("issue_context", data),
      g = ctx.graduate,
      c = ctx.credential;
    if (g.state === "issued")
      return json({ state: "issued", credential_id: g.credential_id });
    // If an archive job already exists, recover it rather than regenerating/uploading.
    const jobs = await db("certificate_job_status", {
      p_credential: g.credential_id,
    });
    let job = jobs.find((j: any) => j.master_path === g.master_path);
    if (job) {
      if (job.state === "failed")
        job = await db("certificate_job_retry", { p_id: job.id });
      return json(job);
    }
    const bytes = await generate(
      { ...ctx.batch.snapshot, ...g.data, credential_id: g.credential_id },
      await assets(),
      { draft: false },
    );
    await put("credential-masters", g.master_path, bytes, "application/pdf");
    job = await db("certificate_job_start", {
      p_request: {
        credential_id: g.credential_id,
        master_path: g.master_path,
        mode: "publish",
        expected_pdf_path: c.pdf_path,
        expected_updated_at: c.updated_at,
      },
    });
    await rpc("job", { id: g.id, job_id: job.id });
    return json(job, 202);
  }
  if (action === "print_pack" || action === "download") {
    if (!Array.isArray(data.ids) || !data.ids.length || data.ids.length > 100)
      throw Error("Select 1–100 issued certificates");
    const format = data.format || "letter";
    if (!["letter", "a4"].includes(format)) throw Error("Invalid paper format");
    const files: Record<string, Uint8Array> = {},
      all = [];
    const art = format === "a4" ? await assets() : null;
    for (const id of data.ids) {
      const ctx = await rpc("proof_context", { id });
      const g = ctx.graduate;
      if (g.state !== "issued")
        throw Error("Only issued certificates can be printed");
      // Retrieve CURRENT official master, including a later corrected version.
      const current = await db("studio_current_document", {
        p_credential: g.credential_id,
      });
      if (!current || current.status !== "valid")
        throw Error("Credential revoked or unavailable");
      const bytes =
        format === "letter"
          ? await get("credential-masters", current.pdf_path)
          : await generate(
              {
                ...current.snapshot,
                ...current.graduate_data,
                credential_id: g.credential_id,
              },
              art,
              { draft: false, format },
            );
      files[g.credential_id + ".pdf"] = bytes;
      all.push(bytes);
    }
    const bytes = data.zip
      ? zipSync(files)
      : all.length === 1
        ? all[0]
        : await combine(all);
    if (data.purpose !== "inspect")
      await db("studio_record_print_pack", {
        p_actor: actorId,
        p_ids: data.ids,
        p_format: format,
        p_sha: await hash(bytes),
      });
    return binary(
      bytes,
      data.zip
        ? "certificates.zip"
        : (data.ids.length === 1 ? "certificate" : "class-certificates") +
            "-" +
            format +
            ".pdf",
      data.zip ? "application/zip" : "application/pdf",
    );
  }
  if (action === "prepare_email") {
    const ctx = await rpc("proof_context", { id: data.id });
    const g = ctx.graduate;
    if (g.state !== "issued") throw Error("Issue certificate first");
    const current = await db("studio_current_document", {
      p_credential: g.credential_id,
    });
    if (current.status !== "valid") throw Error("Credential revoked");
    const msg = emailMessage(
      { ...current.graduate_data, credential_id: g.credential_id },
      current.snapshot,
      {
        subject: data.subject || current.snapshot.email_subject,
        body: data.body || current.snapshot.email_body,
      },
    );
    if (
      !msg.subject ||
      !msg.body ||
      msg.body.length > 30000 ||
      /[\r\n]/.test(msg.subject)
    )
      throw Error("Valid email subject and body required");
    return json({
      ...(await rpc("prepare_email", { ...data, message: msg })),
      message: msg,
    });
  }
  if (action === "send_email") {
    if (!MAIL_TOKEN())
      return json(
        {
          error:
            "Hostinger server API token is not configured. Prepared messages are retained; nothing was sent.",
        },
        503,
      );
    // Persist claimed/unknown outcome BEFORE crossing the provider boundary.
    const d = await rpc("claim_email", { id: data.id });
    let state = "uncertain",
      provider_id = null,
      error = null;
    try {
      const pdf = await get("credential-masters", d.master_path);
      let encoded = "";
      for (let i = 0; i < pdf.length; i += 16384)
        encoded += String.fromCharCode(...pdf.subarray(i, i + 16384));
      const r = await fetch(
        "https://api.mail.hostinger.com/api/v1/mailboxes/" + MAILBOX + "/send",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + MAIL_TOKEN(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            to: [d.message.to],
            displayName: "Johnathan Lightfoot | Bulletproof Automations",
            subject: d.message.subject,
            text: d.message.body,
            attachments: [
              {
                filename: d.message.attachment_name,
                content: btoa(encoded),
                contentType: "application/pdf",
                encoding: "base64",
              },
            ],
          }),
          signal: AbortSignal.timeout(25000),
        },
      );
      provider_id = r.headers.get("x-correlation-id");
      if (r.status === 204) state = "sent";
      else if ([400, 401, 403, 422, 429].includes(r.status)) {
        state = "failed";
        error = "Provider explicitly rejected request (" + r.status + ")";
      } else
        error =
          "Provider outcome uncertain (" +
          r.status +
          "); check Sent before reconciliation";
    } catch (e) {
      error =
        "Delivery outcome uncertain; check provider Sent before reconciliation";
    }
    await rpc("email_result", { id: d.id, state, provider_id, error });
    return json({ state, provider_id, error });
  }
  const allowed = [
    "list",
    "course",
    "cohort",
    "batch",
    "remove_graduate",
    "graduate",
    "graduates",
    "eligibility",
    "review",
    "approve",
    "print",
    "correct",
    "revoke",
    "exclude_email",
    "reconcile_email",
  ];
  if (!allowed.includes(action)) throw Error("Unsupported Studio action");
  return json(await rpc(action, data));
}

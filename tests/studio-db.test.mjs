// Runs the actual Postgres/PLpgSQL state machine in an isolated PGlite instance.
// Minimal Auth/Storage/net fixtures replace Supabase integrations, never production.
import { PGlite } from "npm:@electric-sql/pglite@0.3.14";
import fs from "node:fs";
import assert from "node:assert/strict";
const pg = new PGlite();
await pg.exec(`create schema auth;create schema storage;create schema extensions;create schema net;
create role anon;create role authenticated;create role service_role;
create table auth.users(id uuid primary key,email text,deleted_at timestamptz);
insert into auth.users values('00000000-0000-0000-0000-000000000001','johnathan@bulletproofautomations.com',null);
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(bucket_id text,name text,metadata jsonb);
create function extensions.gen_random_bytes(n int) returns bytea language sql as $$select decode(string_agg(lpad(to_hex(floor(random()*256)::int),2,'0'),''),'hex') from generate_series(1,n)$$;
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$select 1::bigint$$;
create table public.enrollments(id uuid primary key,full_name text,email text,cohort text);
create table public.credentials(id uuid primary key default gen_random_uuid(),credential_id text unique,created_at timestamptz default now(),updated_at timestamptz default now(),holder_name text,holder_name_normalised text,holder_email text,credential text constraint credentials_credential_check check(credential in ('foundations','bcab')),issued_on date,expires_on date,platform_version text,cohort text,status text default 'valid',revoked_on date,revoked_reason text,publish_consent boolean,allow_name_lookup boolean,pdf_path text,preview_path text,enrollment_id uuid,notes text);
create function public.verify_credential(p_id text default null,p_name text default null) returns setof public.credentials language sql as $$select * from public.credentials c where c.publish_consent and (c.credential_id=p_id or c.holder_name=p_name)$$;
create function public.verify_credentials_for(p_normalised text) returns setof public.credentials language sql as $$select * from public.credentials c where c.publish_consent and c.holder_name_normalised=p_normalised$$;`);
await pg.exec(fs.readFileSync("supabase/certificate-processing.sql", "utf8"));
for (const file of fs
  .readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort())
  await pg.exec(fs.readFileSync("supabase/migrations/" + file, "utf8"));
const actor = "00000000-0000-0000-0000-000000000001";
async function rpc(action, data = {}) {
  return (
    await pg.query("select public.studio_action($1,$2,$3) as result", [
      actor,
      action,
      data,
    ])
  ).rows[0].result;
}
async function reject(action, data, pattern) {
  await assert.rejects(rpc(action, data), pattern);
}
const course = await rpc("course", {
  course: {
    name: "Controlled Test",
    code: "TEST",
    level: "Beginner",
    statement: "for completing training",
    certificate_title: "Certificate of Completion",
    status: "active",
    template: "001",
  },
});
await reject(
  "course",
  {
    course: {
      name: "Competency",
      code: "BCAB",
      level: "Intermediate",
      statement: "completed",
      certificate_title: "Professional Certification",
      status: "active",
      template: "001",
    },
  },
  /Professional/,
);
await reject("course", { course: {} }, /Invalid/);
const cohort = await rpc("cohort", {
  course_id: course.id,
  cohort: {
    name: "Test cohort",
    start_date: "2026-10-01",
    end_date: "2026-10-10",
    instructor: "Test Instructor",
  },
});
await pg.query("select studio_update_cohort($1,$2,$3)", [
  actor,
  cohort.id,
  {
    reason: "Controlled correction",
    cohort: {
      name: "Test cohort updated",
      start_date: "2026-10-01",
      end_date: "2026-10-10",
      instructor: "Updated Instructor",
    },
  },
]);
await reject(
  "batch",
  { cohort_id: cohort.id, issue_date: "2026-10-11" },
  /reason/,
);
const b = await rpc("batch", { cohort_id: cohort.id });
await rpc("graduates", {
  batch_id: b.id,
  graduates: [
    {
      full_name: "Test Graduate",
      email: "controlled@example.com",
      publish_consent: true,
      allow_name_lookup: true,
    },
  ],
});
await reject(
  "graduates",
  {
    batch_id: b.id,
    graduates: [
      { full_name: "Test Graduate", email: "controlled@example.com" },
    ],
  },
  /already exists/,
);
let m = await rpc("list"),
  g = m.graduates[0];
await reject("approve", { batch_id: b.id }, /eligibility/);
await rpc("eligibility", { batch_id: b.id, id: g.id, eligible: true });
m = await rpc("list");
let rev = m.batches[0].revision;
await reject(
  "review",
  { batch_id: b.id, id: g.id, revision: rev },
  /Eligibility/,
);
await rpc("proof_generated", { id: g.id, revision: rev });
await rpc("review", { batch_id: b.id, id: g.id, revision: rev });
await rpc("approve", { batch_id: b.id });
m = await rpc("list");
g = m.graduates[0];
assert.match(g.credential_id, /^BPA-TRN-2026-[0-9A-Z]{6}$/);
assert.equal(
  (await pg.query("select * from verify_credential($1)", [g.credential_id]))
    .rows.length,
  0,
  "Approved but unarchived credential must not verify",
);
await reject(
  "graduate",
  { batch_id: b.id, id: g.id, graduate: g.data },
  /immutable/,
);
await reject("claim_email", { id: crypto.randomUUID() }, /no rows/);
await pg.query(
  "insert into storage.objects values('credential-masters',$1,'{\"mimetype\":\"application/pdf\"}')",
  [g.master_path],
);
const c = (await pg.query("select * from credentials")).rows[0];
let job = (
  await pg.query("select certificate_job_start($1) as j", [
    {
      credential_id: g.credential_id,
      master_path: g.master_path,
      mode: "publish",
      expected_pdf_path: null,
      expected_updated_at: c.updated_at,
    },
  ])
).rows[0].j;
const privateJob = (await pg.query("select * from private.certificate_jobs"))
  .rows[0];
let claimed = (
  await pg.query("select certificate_job_claim($1,$2) as j", [
    job.id,
    privateJob.run_token,
  ])
).rows[0].j;
const preview = g.master_path.replace(".pdf", ".png");
await pg.query(
  "insert into storage.objects values('credentials',$1,'{\"mimetype\":\"application/pdf\"}'),('credentials',$2,'{\"mimetype\":\"image/png\"}')",
  [g.master_path, preview],
);
await pg.query("select certificate_job_complete($1,$2,$3)", [
  job.id,
  claimed.lease,
  { pdf_path: g.master_path, preview_path: preview },
]);
m = await rpc("list");
g = m.graduates[0];
assert.equal(g.state, "issued");
assert.equal(m.batches[0].state, "issued");
assert.equal(
  (await pg.query("select * from verify_credential($1)", [g.credential_id]))
    .rows.length,
  1,
);
await rpc("print", { ids: [g.id], status: "pack_generated" });
m = await rpc("list");
assert.equal(m.graduates[0].handed_at, null);
await rpc("print", { ids: [g.id], status: "handed_out" });
m = await rpc("list");
assert.equal(m.graduates[0].handed_by, actor);
await pg.query("select studio_record_print_pack($1,$2,$3,$4)", [
  actor,
  [g.id],
  "letter",
  "a".repeat(64),
]);
m = await rpc("list");
assert.equal(
  m.graduates.find((x) => x.id === g.id).print_status,
  "handed_out",
  "Reprinting must preserve handout status",
);
const email = await rpc("prepare_email", {
  id: g.id,
  message: {
    to: g.data.email,
    attachment_name: g.credential_id + ".pdf",
    subject: "Test",
    body: "Test",
  },
});
await rpc("claim_email", { id: email.id });
await reject("claim_email", { id: email.id }, /not prepared/);
await rpc("email_result", { id: email.id, state: "uncertain" });
await reject(
  "prepare_email",
  { id: g.id, resend: true, reason: "test", message: {} },
  /uncertain/,
);
await rpc("reconcile_email", {
  id: email.id,
  state: "failed",
  reason: "Provider confirmed not sent",
});
const correction = await rpc("correct", {
  id: g.id,
  reason: "Spelling",
  graduate: { ...g.data, full_name: "Corrected Test Graduate" },
});
assert.ok(correction.id);
await reject(
  "correct",
  { id: g.id, reason: "Duplicate", graduate: g.data },
  /unfinished/,
);
assert.equal(
  (await pg.query("select count(*)::int as n from credentials")).rows[0].n,
  1,
);
await rpc("revoke", {
  credential_id: g.credential_id,
  reason: "Controlled test",
});
assert.equal(
  (await pg.query("select status from credentials")).rows[0].status,
  "revoked",
);
await assert.rejects(
  pg.query("select studio_action($1,$2,$3)", [crypto.randomUUID(), "list", {}]),
  /Administrator/,
);
console.log(
  "PASS: real Postgres migrations, course/cohort/roster, eligibility/proof/approval, draft privacy, TRN IDs, queue integration, physical handout, email idempotency, correction, revocation and administrator checks.",
);
await pg.close();

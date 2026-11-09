-- Webinars and workshops: sessions, registrations, immutable payment attempts,
-- notification and Meta outboxes, and the RPCs that are the ONLY write path.
--
-- STATUS: APPLIED to production and recorded in supabase_migrations.schema_migrations
-- as 20261103120000 (checked read-only on 9 November 2026). Never apply it again.
-- Release 2 is 20261109120000_workshop_admission_benefits.sql; see
-- docs/workshops-runbook.md, "Release 2 deployment checklist".
-- Rollback: supabase/migrations/rollback/20261103120000_workshops_down.sql
--
-- Design rules (docs/PRD-WEBINARS-WORKSHOPS.md and the 3 November review):
--   * Additive only: new objects only. enrollments, payment_plan_installments,
--     payment_events and their triggers are not altered in any way.
--   * No anon privilege on any object here. Public writes go through Cloudflare
--     Pages Functions holding the service key, which call the RPCs below.
--   * The authenticated admin (same email allowlist as enrollments) may READ
--     everything except token hashes and private join instructions are
--     readable by admin only. Admin mutations go through
--     workshop_admin_action(), called by an authenticated Pages Function.
--   * Every Paystack checkout attempt keeps its own reference for ever. The
--     reference, amount, currency, mode and owning registration of an attempt
--     cannot be updated (trigger), and attempts cannot be deleted.
--   * A verified payment is never silently kept. It confirms, or it puts the
--     registration into payment_received_review, or (second success) it is
--     flagged duplicate_payment for refund review. Access is never removed by
--     a duplicate.

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_sessions (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  kind text not null check (kind in ('webinar', 'workshop')),
  title text not null check (length(title) between 3 and 160),
  starts_at timestamptz not null,
  duration_minutes integer not null check (duration_minutes between 15 and 600),
  time_zone text not null default 'Africa/Accra',
  format text not null check (length(format) between 2 and 120),
  -- 0 = free. Whole pesewas only, so minor units are exact.
  price_ghs numeric(10,2) not null default 0 check (price_ghs >= 0 and price_ghs = round(price_ghs, 2)),
  capacity integer check (capacity is null or capacity > 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'closed', 'completed', 'cancelled')),
  -- Private. Sent only to confirmed registrants; never in public HTML.
  join_instructions text,
  terms_version text not null default '2026-11-03',
  -- How long a started checkout holds a seat against capacity.
  hold_minutes integer not null default 30 check (hold_minutes between 5 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Registrations
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_registrations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.workshop_sessions(id) on delete restrict,
  email_normalized text not null check (email_normalized = lower(btrim(email_normalized)) and email_normalized like '%@%'),
  full_name text not null check (length(full_name) between 2 and 120),
  whatsapp text check (whatsapp is null or length(whatsapp) between 7 and 40),
  whatsapp_consent boolean not null default false,
  terms_ack boolean not null check (terms_ack),
  terms_version text not null,
  -- pending_payment          paid session, no verified payment yet
  -- confirmed                free, or paid and admitted
  -- payment_received_review  verified money that could not be auto-confirmed
  --                          (capacity reached after the hold expired, session
  --                          cancelled/started/completed, registration cancelled)
  -- refund_pending           admin chose to refund; awaiting refund.processed
  -- cancelled                no money held
  -- refunded                 money returned in full
  status text not null default 'pending_payment' check (status in (
    'pending_payment', 'confirmed', 'payment_received_review', 'refund_pending', 'cancelled', 'refunded')),
  payment_status text not null default 'pending' check (payment_status in (
    'not_required', 'pending', 'paid', 'needs_review', 'partially_refunded', 'refunded')),
  review_reason text check (review_reason is null or review_reason in (
    'capacity', 'session_unavailable', 'registration_cancelled', 'duplicate_payment', 'payment_mismatch', 'partial_refund')),
  attendance text not null default 'unknown' check (attendance in ('unknown', 'attended', 'no_show')),
  amount_ghs numeric(10,2) not null default 0,
  currency text not null default 'GHS' check (currency = 'GHS'),
  amount_paid_minor bigint not null default 0 check (amount_paid_minor >= 0),
  paid_at timestamptz,
  -- Attribution. UTMs are first-party campaign parameters and are always kept
  -- (disclosed in the privacy policy). Meta identifiers and the request
  -- context used by the Conversions API are kept ONLY when ad_consent is true;
  -- client_ip / client_user_agent are cleared once the Purchase is sent.
  utm_source text, utm_medium text, utm_campaign text, utm_content text, utm_term text,
  landing_path text, referrer_host text,
  ad_consent boolean not null default false,
  fbclid text, fbc text, fbp text, client_ip text, client_user_agent text,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, email_normalized),
  check (ad_consent or (fbclid is null and fbc is null and fbp is null and client_ip is null and client_user_agent is null))
);
create index if not exists workshop_registrations_session_idx on public.workshop_registrations (session_id, status);

-- Bearer tokens that let ONE browser read the state of ONE registration. Only
-- the SHA-256 is stored. Several per registration (each device that registers
-- or resumes gets its own), so a resume never revokes another device.
create table if not exists public.workshop_status_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  registration_id uuid not null references public.workshop_registrations(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists workshop_status_tokens_reg_idx on public.workshop_status_tokens (registration_id);

-- ---------------------------------------------------------------------------
-- Payment attempts: one row per Paystack checkout, immutable identity
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.workshop_registrations(id) on delete restrict,
  reference text not null unique check (reference ~ '^BPA-W(EB|TEST)-[0-9]{4}-[0-9A-Z]{10}$'),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'GHS' check (currency = 'GHS'),
  mode text not null check (mode in ('live', 'test')),
  status text not null default 'initialized' check (status in (
    'initialized', 'init_failed', 'succeeded', 'duplicate_payment', 'mismatch')),
  status_note text,
  received_minor bigint,
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  paid_at timestamptz,
  verified_at timestamptz,
  verified_via text check (verified_via is null or verified_via in ('webhook', 'verify')),
  payment_event_id uuid,
  last_verify_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((mode = 'live') = (reference like 'BPA-WEB-%'))
);
create index if not exists workshop_payment_attempts_reg_idx on public.workshop_payment_attempts (registration_id, created_at);

create or replace function public.workshop_attempt_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'workshop payment attempts are never deleted';
  end if;
  if new.reference is distinct from old.reference
     or new.amount_minor is distinct from old.amount_minor
     or new.currency is distinct from old.currency
     or new.mode is distinct from old.mode
     or new.registration_id is distinct from old.registration_id
     or new.created_at is distinct from old.created_at then
    raise exception 'workshop payment attempt identity is immutable';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists workshop_payment_attempts_immutable on public.workshop_payment_attempts;
create trigger workshop_payment_attempts_immutable before update or delete on public.workshop_payment_attempts
  for each row execute function public.workshop_attempt_immutable();

create or replace function public.workshop_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists workshop_sessions_touch on public.workshop_sessions;
create trigger workshop_sessions_touch before update on public.workshop_sessions
  for each row execute function public.workshop_touch_updated_at();
drop trigger if exists workshop_registrations_touch on public.workshop_registrations;
create trigger workshop_registrations_touch before update on public.workshop_registrations
  for each row execute function public.workshop_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Webinar payment ledger. Every event the webinar Paystack business sends to
-- supabase/functions/workshop-paystack-webhook is recorded here, including
-- ones that fail verification. It is separate from public.payment_events, the
-- training business's ledger, which this feature never writes to.
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_payment_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event text,
  reference text,
  email text,
  amount_minor bigint,
  currency text,
  status text,
  domain text,
  paid_at timestamptz,
  signature_valid boolean not null default false,
  matched boolean not null default false,
  match_note text,
  raw jsonb not null,
  unique (event, reference)
);
create index if not exists workshop_payment_events_received_idx on public.workshop_payment_events (received_at desc);

-- ---------------------------------------------------------------------------
-- Outboxes: email and Meta Conversions API. Rows are enqueued in the same
-- transaction as the state change that warrants them; the dispatcher claims
-- with SKIP LOCKED, so two dispatchers never send the same row.
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_notifications (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.workshop_registrations(id) on delete cascade,
  kind text not null check (kind in ('confirmation', 'payment_review', 'admitted', 'duplicate_payment')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (registration_id, kind)
);

create table if not exists public.workshop_meta_events (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.workshop_registrations(id) on delete cascade,
  event_name text not null check (event_name in ('InitiateCheckout', 'CompleteRegistration', 'Purchase')),
  -- The same id the browser Pixel uses, so Meta deduplicates the pair.
  event_id text not null unique,
  event_time timestamptz not null default now(),
  value_ghs numeric(10,2),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Seats in use: confirmed, money-held review, refund_pending (money still held),
-- and pending registrations with a checkout started inside the hold window.
create or replace function public.workshop_seats_in_use(p_session_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int
  from public.workshop_registrations r
  join public.workshop_sessions s on s.id = r.session_id
  where r.session_id = p_session_id
    and r.id is distinct from p_except
    and (
      r.status in ('confirmed', 'payment_received_review', 'refund_pending')
      or (r.status = 'pending_payment' and exists (
        select 1 from public.workshop_payment_attempts a
        where a.registration_id = r.id and a.status = 'initialized'
          and a.created_at > now() - make_interval(mins => s.hold_minutes)))
    )
$$;

create or replace function public.workshop_session_open(s public.workshop_sessions)
returns boolean language sql stable set search_path = '' as $$
  select s.status = 'published' and s.starts_at > now()
$$;

create or replace function public.workshop_enqueue_meta(p_reg public.workshop_registrations, p_name text, p_event_id text, p_value numeric)
returns void language plpgsql set search_path = '' as $$
begin
  if p_reg.ad_consent then
    insert into public.workshop_meta_events (registration_id, event_name, event_id, value_ghs)
    values (p_reg.id, p_name, p_event_id, p_value)
    on conflict (event_id) do nothing;
  end if;
end $$;

-- Notes the outcome on the webinar ledger row (workshop_payment_events). The
-- training ledger (payment_events) is never read or written by this feature.
-- p_reg is kept for readability at call sites.
create or replace function public.workshop_note_event(p_event_id uuid, p_reg uuid, p_matched boolean, p_note text)
returns void language sql set search_path = '' as $$
  update public.workshop_payment_events
     set matched = p_matched,
         match_note = p_note
   where id = p_event_id
$$;

-- ---------------------------------------------------------------------------
-- workshop_register: create or resume one registration for one session.
-- Outcomes: created | existing | full | closed | not_found
-- ---------------------------------------------------------------------------
create or replace function public.workshop_register(
  p_slug text, p_email text, p_full_name text, p_whatsapp text, p_whatsapp_consent boolean,
  p_terms_version text, p_token_hash text, p_attribution jsonb default '{}'::jsonb,
  p_ad_consent boolean default false, p_displayed_price numeric default null,
  p_displayed_starts_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  r public.workshop_registrations;
  email text := lower(btrim(p_email));
  a jsonb := coalesce(p_attribution, '{}'::jsonb);
  free boolean;
begin
  select * into s from public.workshop_sessions where slug = p_slug for update;
  if not found or s.status = 'draft' then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into r from public.workshop_registrations where session_id = s.id and email_normalized = email;
  if found then
    if p_token_hash is not null then
      insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id)
      on conflict do nothing;
    end if;
    return jsonb_build_object('outcome', 'existing', 'registration_id', r.id, 'status', r.status,
      'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', s.price_ghs);
  end if;

  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- The page states a price and a time. If the database disagrees, nobody is
  -- registered against a number they did not see.
  if p_displayed_price is not null and p_displayed_price <> s.price_ghs then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if p_displayed_starts_at is not null and p_displayed_starts_at <> s.starts_at then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if s.capacity is not null and public.workshop_seats_in_use(s.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  free := s.price_ghs = 0;
  insert into public.workshop_registrations (
    session_id, email_normalized, full_name, whatsapp, whatsapp_consent, terms_ack, terms_version,
    status, payment_status, amount_ghs,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_path, referrer_host,
    ad_consent, fbclid, fbc, fbp, client_ip, client_user_agent)
  values (
    s.id, email, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    true, p_terms_version,
    case when free then 'confirmed' else 'pending_payment' end,
    case when free then 'not_required' else 'pending' end,
    s.price_ghs,
    left(a->>'utm_source', 120), left(a->>'utm_medium', 120), left(a->>'utm_campaign', 200),
    left(a->>'utm_content', 200), left(a->>'utm_term', 200), left(a->>'landing_path', 200), left(a->>'referrer_host', 200),
    coalesce(p_ad_consent, false),
    case when p_ad_consent then left(a->>'fbclid', 500) end,
    case when p_ad_consent then left(a->>'fbc', 600) end,
    case when p_ad_consent then left(a->>'fbp', 200) end,
    case when p_ad_consent then left(a->>'client_ip', 64) end,
    case when p_ad_consent then left(a->>'client_user_agent', 400) end)
  returning * into r;

  if p_token_hash is not null then
    insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id);
  end if;

  if free then
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'confirmation');
    perform public.workshop_enqueue_meta(r, 'CompleteRegistration', 'cr_' || r.id, 0);
  end if;

  return jsonb_build_object('outcome', 'created', 'registration_id', r.id, 'status', r.status,
    'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', s.price_ghs);
end $$;

-- ---------------------------------------------------------------------------
-- workshop_start_attempt: record a new checkout attempt BEFORE Paystack is
-- called. The amount comes from the session, never from the caller.
-- Outcomes: started | already_paid | full | closed | not_payable | not_found
-- ---------------------------------------------------------------------------
create or replace function public.workshop_start_attempt(p_registration_id uuid, p_reference text, p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  s public.workshop_sessions;
  att public.workshop_payment_attempts;
begin
  select * into r from public.workshop_registrations where id = p_registration_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  select * into s from public.workshop_sessions where id = r.session_id for update;
  select * into r from public.workshop_registrations where id = p_registration_id for update;

  if r.status in ('confirmed', 'payment_received_review', 'refund_pending') or r.payment_status = 'paid' then
    return jsonb_build_object('outcome', 'already_paid', 'status', r.status);
  end if;
  if r.status <> 'pending_payment' or s.price_ghs = 0 or r.payment_status = 'needs_review' then
    return jsonb_build_object('outcome', 'not_payable', 'status', r.status);
  end if;
  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  if s.capacity is not null and public.workshop_seats_in_use(s.id, r.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
  values (r.id, p_reference, round(s.price_ghs * 100)::bigint, 'GHS', p_mode)
  returning * into att;

  perform public.workshop_enqueue_meta(r, 'InitiateCheckout', 'ic_' || r.id, s.price_ghs);

  return jsonb_build_object('outcome', 'started', 'attempt_id', att.id, 'reference', att.reference,
    'amount_minor', att.amount_minor, 'currency', att.currency, 'session_id', s.id);
end $$;

-- Paystack refused or timed out at initialize. Identity stays; status moves.
create or replace function public.workshop_attempt_init_failed(p_reference text, p_note text)
returns void language sql security definer set search_path = '' as $$
  update public.workshop_payment_attempts
     set status = 'init_failed', status_note = left(p_note, 300)
   where reference = p_reference and status = 'initialized'
$$;

-- ---------------------------------------------------------------------------
-- workshop_recompute_payment: derive a registration's money state from ALL of
-- its attempts. The single source of truth for payment_status, so a later
-- payment or refund can never erase a duplicate or mismatch that still holds
-- somebody's money.
--   primary  = the 'succeeded' attempt (at most one)
--   extra    = money still held on duplicate_payment / mismatch attempts
-- ---------------------------------------------------------------------------
create or replace function public.workshop_recompute_payment(p_registration_id uuid)
returns public.workshop_registrations language plpgsql set search_path = '' as $$
declare
  r public.workshop_registrations;
  primary_received bigint;
  primary_remaining bigint;
  dup_remaining bigint;
  mis_remaining bigint;
  held bigint;
  ps text;
  reason text;
  st text;
begin
  select * into r from public.workshop_registrations where id = p_registration_id;
  select received_minor, received_minor - refunded_minor into primary_received, primary_remaining
    from public.workshop_payment_attempts where registration_id = r.id and status = 'succeeded' limit 1;
  select coalesce(sum(received_minor - refunded_minor) filter (where status = 'duplicate_payment'), 0),
         coalesce(sum(received_minor - refunded_minor) filter (where status = 'mismatch'), 0),
         coalesce(sum(received_minor - refunded_minor) filter (where status in ('succeeded', 'duplicate_payment', 'mismatch')), 0)
    into dup_remaining, mis_remaining, held
    from public.workshop_payment_attempts where registration_id = r.id;

  st := r.status;
  reason := r.review_reason;
  -- Registration-level review reasons belong to payment_received_review and
  -- survive; money-level reasons are recomputed here.
  if reason in ('duplicate_payment', 'payment_mismatch', 'partial_refund') then reason := null; end if;

  if primary_received is not null then
    if primary_remaining <= 0 and dup_remaining <= 0 and mis_remaining <= 0 then
      ps := 'refunded'; st := 'refunded'; reason := null;
    elsif dup_remaining > 0 or mis_remaining > 0 then
      ps := 'needs_review';
      if st <> 'payment_received_review' then
        reason := case when dup_remaining > 0 then 'duplicate_payment' else 'payment_mismatch' end;
      end if;
    elsif primary_remaining < primary_received then
      ps := 'partially_refunded';
      if st <> 'payment_received_review' then reason := 'partial_refund'; end if;
    else
      ps := 'paid';
    end if;
  else
    if mis_remaining > 0 then
      ps := 'needs_review'; reason := 'payment_mismatch';
    elsif r.payment_status = 'not_required' then
      ps := 'not_required';
    else
      ps := 'pending';
    end if;
  end if;

  update public.workshop_registrations
     set payment_status = ps, status = st, review_reason = reason, amount_paid_minor = held
   where id = r.id returning * into r;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- workshop_apply_charge: the single place a workshop payment takes effect.
-- Called by the webhook and by the server-side verify path; idempotent per
-- attempt. Writes the payment_events note in the same transaction, so a
-- failure anywhere rolls the whole thing back and a retry starts clean.
-- Outcomes: confirmed | review | duplicate_payment | mismatch | already_applied | unknown_reference
-- ---------------------------------------------------------------------------
create or replace function public.workshop_apply_charge(
  p_reference text, p_amount_minor bigint, p_currency text, p_domain text,
  p_paid_at timestamptz, p_via text, p_payment_event_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  att public.workshop_payment_attempts;
  r public.workshop_registrations;
  s public.workshop_sessions;
  reason text;
  hold_valid boolean;
  outcome text;
  note text;
  detail text;
begin
  select * into att from public.workshop_payment_attempts where reference = p_reference;
  if not found then
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, null, false,
        'Workshop transaction with no matching payment attempt; not applied to any enrollment');
    end if;
    return jsonb_build_object('outcome', 'unknown_reference');
  end if;

  -- Lock order everywhere: session, registration, attempt.
  select * into s from public.workshop_sessions where id = (
    select session_id from public.workshop_registrations where id = att.registration_id) for update;
  select * into r from public.workshop_registrations where id = att.registration_id for update;
  select * into att from public.workshop_payment_attempts where id = att.id for update;

  if att.status in ('succeeded', 'duplicate_payment', 'mismatch') then
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, r.id, true,
        'Workshop attempt already ' || att.status || '; nothing applied again');
    end if;
    return jsonb_build_object('outcome', 'already_applied', 'registration_id', r.id, 'attempt_status', att.status);
  end if;

  -- Money arrived, but not the money this attempt expected. Never confirm on
  -- it, never ignore it: hold for a person.
  if p_amount_minor is distinct from att.amount_minor
     or upper(coalesce(p_currency, '')) <> att.currency
     or p_domain is distinct from att.mode then
    detail := format('expected %s %s %s; received %s %s %s',
      att.amount_minor, att.currency, att.mode, p_amount_minor, p_currency, p_domain);
    update public.workshop_payment_attempts
       set status = 'mismatch', received_minor = greatest(coalesce(p_amount_minor, 0), 0), paid_at = p_paid_at,
           verified_at = now(), verified_via = p_via,
           payment_event_id = coalesce(p_payment_event_id, payment_event_id), status_note = detail
     where id = att.id;
    r := public.workshop_recompute_payment(r.id);
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, r.id, true,
        'WORKSHOP PAYMENT MISMATCH, held for review: ' || detail);
    end if;
    return jsonb_build_object('outcome', 'mismatch', 'registration_id', r.id);
  end if;

  -- A second successful payment for a registration that already has one.
  -- The registration and its access are kept exactly as they are; the extra
  -- money is flagged for refund review.
  if exists (select 1 from public.workshop_payment_attempts x
              where x.registration_id = r.id and x.id <> att.id and x.status = 'succeeded') then
    update public.workshop_payment_attempts
       set status = 'duplicate_payment', received_minor = p_amount_minor, paid_at = p_paid_at,
           verified_at = now(), verified_via = p_via, payment_event_id = coalesce(p_payment_event_id, payment_event_id)
     where id = att.id;
    r := public.workshop_recompute_payment(r.id);
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'duplicate_payment')
    on conflict do nothing;
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, r.id, true,
        'DUPLICATE workshop payment; registration kept, flagged for refund review');
    end if;
    return jsonb_build_object('outcome', 'duplicate_payment', 'registration_id', r.id, 'status', r.status);
  end if;

  -- First successful payment. Decide whether it can be honoured automatically.
  hold_valid := att.created_at > now() - make_interval(mins => s.hold_minutes);
  reason := null;
  if r.status in ('cancelled', 'refunded') then
    reason := 'registration_cancelled';
  elsif s.status not in ('published', 'closed') or s.starts_at <= now() then
    reason := 'session_unavailable';
  elsif not hold_valid and s.capacity is not null
        and public.workshop_seats_in_use(s.id, r.id) >= s.capacity then
    reason := 'capacity';
  end if;

  update public.workshop_payment_attempts
     set status = 'succeeded', received_minor = p_amount_minor, paid_at = p_paid_at,
         verified_at = now(), verified_via = p_via, payment_event_id = coalesce(p_payment_event_id, payment_event_id)
   where id = att.id;

  if reason is null then
    update public.workshop_registrations
       set status = 'confirmed', review_reason = null, paid_at = coalesce(p_paid_at, now())
     where id = r.id;
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'confirmation')
    on conflict do nothing;
    outcome := 'confirmed';
    note := 'Workshop payment applied; registration confirmed';
  else
    update public.workshop_registrations
       set status = 'payment_received_review', review_reason = reason, paid_at = coalesce(p_paid_at, now())
     where id = r.id;
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'payment_review')
    on conflict do nothing;
    outcome := 'review';
    note := 'Workshop payment received; held for review (' || reason || ')';
  end if;
  r := public.workshop_recompute_payment(r.id);

  /* PURCHASE = A CONFIRMED PAID ENROLLMENT, and nothing else. Money held for
     review is not yet an enrollment: it may be refunded. It becomes a Purchase
     only if an admin admits it (workshop_admin_action 'admit'), with the same
     event id. The browser Pixel (status endpoint) and the admin campaign report
     use this same definition. */
  if outcome = 'confirmed' then
    perform public.workshop_enqueue_meta(r, 'Purchase', 'pu_' || r.id, p_amount_minor / 100.0);
  end if;
  if p_payment_event_id is not null then
    perform public.workshop_note_event(p_payment_event_id, r.id, true, note);
  end if;

  return jsonb_build_object('outcome', outcome, 'registration_id', r.id, 'status', r.status,
    'payment_status', r.payment_status, 'review_reason', reason);
end $$;

-- ---------------------------------------------------------------------------
-- workshop_apply_refund: a processed refund against one attempt. Clamped to
-- what that attempt received; never touches enrollments.
-- Outcomes: applied | already_refunded | mode_mismatch | unknown_reference
-- ---------------------------------------------------------------------------
create or replace function public.workshop_apply_refund(
  p_reference text, p_amount_minor bigint, p_domain text, p_payment_event_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  att public.workshop_payment_attempts;
  r public.workshop_registrations;
  remaining bigint;
  reversal bigint;
  clamped boolean;
begin
  select * into att from public.workshop_payment_attempts where reference = p_reference;
  if not found then
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, null, false,
        'Workshop refund with no matching payment attempt; not applied to any enrollment');
    end if;
    return jsonb_build_object('outcome', 'unknown_reference');
  end if;
  select * into r from public.workshop_registrations where id = att.registration_id for update;
  select * into att from public.workshop_payment_attempts where id = att.id for update;

  if p_domain is distinct from att.mode then
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, r.id, false,
        format('Refused: %s refund on a %s workshop attempt', p_domain, att.mode));
    end if;
    return jsonb_build_object('outcome', 'mode_mismatch', 'registration_id', r.id);
  end if;

  remaining := coalesce(att.received_minor, 0) - att.refunded_minor;
  if remaining <= 0 then
    if p_payment_event_id is not null then
      perform public.workshop_note_event(p_payment_event_id, r.id, true,
        'Workshop refund: nothing left to reverse on this attempt');
    end if;
    return jsonb_build_object('outcome', 'already_refunded', 'registration_id', r.id);
  end if;
  reversal := least(greatest(coalesce(p_amount_minor, 0), 0), remaining);
  clamped := coalesce(p_amount_minor, 0) > remaining;

  update public.workshop_payment_attempts set refunded_minor = refunded_minor + reversal where id = att.id;
  r := public.workshop_recompute_payment(r.id);

  if p_payment_event_id is not null then
    perform public.workshop_note_event(p_payment_event_id, r.id, true,
      format('Workshop refund reversed %s of %s minor units on %s; registration now %s / %s',
        reversal, att.received_minor, att.reference, r.status, r.payment_status) ||
      case when clamped then ' — REFUND EXCEEDED AMOUNT RECEIVED AND WAS CLAMPED; check the units' else '' end);
  end if;
  return jsonb_build_object('outcome', 'applied', 'registration_id', r.id,
    'status', r.status, 'payment_status', r.payment_status, 'reversed_minor', reversal);
end $$;

-- ---------------------------------------------------------------------------
-- workshop_status_for_token: what one browser may know about its registration.
-- No name, email or WhatsApp. A wrong token and a missing reference are
-- indistinguishable.
-- ---------------------------------------------------------------------------
create or replace function public.workshop_status_for_token(p_token_hash text, p_reference text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  s public.workshop_sessions;
  att public.workshop_payment_attempts;
begin
  select reg.* into r from public.workshop_status_tokens t
    join public.workshop_registrations reg on reg.id = t.registration_id
   where t.token_hash = p_token_hash;
  if not found then return jsonb_build_object('state', 'unknown'); end if;
  if p_reference is not null then
    select * into att from public.workshop_payment_attempts where reference = p_reference and registration_id = r.id;
    if not found then return jsonb_build_object('state', 'unknown'); end if;
  end if;
  select * into s from public.workshop_sessions where id = r.session_id;
  return jsonb_build_object(
    'state', 'known',
    'registration_id', r.id,
    'status', r.status,
    'payment_status', r.payment_status,
    'review_reason', case when r.review_reason in ('capacity', 'session_unavailable', 'registration_cancelled') then r.review_reason end,
    'attempt_status', att.status,
    -- Whether a confirmation (or admitted) email has actually been delivered to
    -- the mail service, so the page never claims an email it has not sent.
    'email_sent', exists (select 1 from public.workshop_notifications n
                           where n.registration_id = r.id and n.kind in ('confirmation', 'admitted') and n.status = 'sent'),
    'attempt_mode', att.mode,
    'last_verify_at', att.last_verify_at,
    'amount_ghs', r.amount_ghs,
    'session', jsonb_build_object('slug', s.slug, 'title', s.title, 'kind', s.kind, 'starts_at', s.starts_at,
      'duration_minutes', s.duration_minutes, 'time_zone', s.time_zone, 'format', s.format));
end $$;

-- Throttle for the server-side verify call: at most one per reference per 10 s.
create or replace function public.workshop_claim_verify(p_reference text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  update public.workshop_payment_attempts
     set last_verify_at = now()
   where reference = p_reference and status in ('initialized', 'init_failed')
     and (last_verify_at is null or last_verify_at < now() - interval '10 seconds')
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- ---------------------------------------------------------------------------
-- Outbox claiming (dispatcher only).
-- ---------------------------------------------------------------------------
create or replace function public.workshop_claim_notifications(p_limit integer default 10)
returns setof public.workshop_notifications language sql security definer set search_path = '' as $$
  update public.workshop_notifications n
     set status = 'sending', claimed_at = now(), attempts = n.attempts + 1
   where n.id in (
     select id from public.workshop_notifications
      where (status = 'queued' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
        and attempts < 5
      order by created_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked)
  returning n.*
$$;

create or replace function public.workshop_finish_notification(p_id uuid, p_ok boolean, p_error text default null)
returns void language sql security definer set search_path = '' as $$
  update public.workshop_notifications
     set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
         sent_at = case when p_ok then now() end,
         error = case when p_ok then null else left(p_error, 300) end
   where id = p_id and status = 'sending'
$$;

create or replace function public.workshop_claim_meta_events(p_limit integer default 20)
returns setof public.workshop_meta_events language sql security definer set search_path = '' as $$
  update public.workshop_meta_events m
     set status = 'sending', claimed_at = now(), attempts = m.attempts + 1
   where m.id in (
     select id from public.workshop_meta_events
      where (status = 'queued' or (status = 'sending' and claimed_at < now() - interval '10 minutes'))
        and attempts < 5
      order by created_at
      limit greatest(1, least(p_limit, 50))
      for update skip locked)
  returning m.*
$$;

create or replace function public.workshop_finish_meta_event(p_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare ev public.workshop_meta_events;
begin
  update public.workshop_meta_events
     set status = case when p_ok then 'sent' when attempts >= 5 then 'failed' else 'queued' end,
         sent_at = case when p_ok then now() end,
         error = case when p_ok then null else left(p_error, 300) end
   where id = p_id and status = 'sending'
  returning * into ev;
  -- Request context is only needed until the Purchase has been sent.
  if p_ok and ev.event_name = 'Purchase' then
    update public.workshop_registrations set client_ip = null, client_user_agent = null where id = ev.registration_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- workshop_admin_action: every admin mutation, audited in admin_notes.
-- Actions: admit | request_refund | resolve_duplicate | cancel | attendance
-- ---------------------------------------------------------------------------
create or replace function public.workshop_admin_action(
  p_actor_email text, p_registration_id uuid, p_action text, p_value text default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  stamp text;
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  select * into r from public.workshop_registrations where id = p_registration_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  stamp := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC ' || p_action ||
    coalesce(' (' || p_value || ')', '') || coalesce(': ' || left(p_note, 300), '');

  if p_action = 'admit' then
    if r.status <> 'payment_received_review' then return jsonb_build_object('ok', false, 'error', 'not_in_review'); end if;
    update public.workshop_registrations set status = 'confirmed', review_reason = null,
      admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = r.id returning * into r;
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'admitted') on conflict do nothing;
    -- Admitted money is now a confirmed paid enrollment: report it once, valued
    -- at the verified payment (never a duplicate's).
    perform public.workshop_enqueue_meta(r, 'Purchase', 'pu_' || r.id,
      (select received_minor / 100.0 from public.workshop_payment_attempts
        where registration_id = r.id and status = 'succeeded' limit 1));
  elsif p_action = 'request_refund' then
    if r.status not in ('payment_received_review', 'confirmed') or r.payment_status not in ('paid', 'needs_review', 'partially_refunded') then
      return jsonb_build_object('ok', false, 'error', 'nothing_to_refund');
    end if;
    -- State only. The refund itself is issued in Paystack, and the seat is
    -- released when refund.processed arrives, never on this click.
    update public.workshop_registrations set status = 'refund_pending',
      admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = r.id;
  elsif p_action = 'resolve_duplicate' then
    -- Records the decision to refund the duplicate (in Paystack). Status stays
    -- needs_review until the refund webhook reverses it.
    if r.review_reason <> 'duplicate_payment' then return jsonb_build_object('ok', false, 'error', 'no_duplicate'); end if;
    update public.workshop_registrations set admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = r.id;
  elsif p_action = 'cancel' then
    if r.payment_status in ('paid', 'needs_review', 'partially_refunded') then
      return jsonb_build_object('ok', false, 'error', 'money_held_use_refund');
    end if;
    update public.workshop_registrations set status = 'cancelled',
      admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = r.id;
  elsif p_action = 'attendance' then
    if p_value not in ('unknown', 'attended', 'no_show') then return jsonb_build_object('ok', false, 'error', 'bad_value'); end if;
    update public.workshop_registrations set attendance = p_value where id = r.id;
  elsif p_action = 'note' then
    update public.workshop_registrations set admin_notes = concat_ws(E'\n', admin_notes, stamp) where id = r.id;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Dispatcher secret (hash only), same pattern as installment_scheduler_config.
-- ---------------------------------------------------------------------------
create table if not exists public.workshop_dispatch_config (
  id boolean primary key default true check (id),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.workshop_sessions enable row level security;
alter table public.workshop_registrations enable row level security;
alter table public.workshop_status_tokens enable row level security;
alter table public.workshop_payment_attempts enable row level security;
alter table public.workshop_notifications enable row level security;
alter table public.workshop_meta_events enable row level security;
alter table public.workshop_dispatch_config enable row level security;
alter table public.workshop_payment_events enable row level security;

revoke all on public.workshop_sessions, public.workshop_registrations, public.workshop_status_tokens,
  public.workshop_payment_attempts, public.workshop_notifications, public.workshop_meta_events,
  public.workshop_dispatch_config, public.workshop_payment_events from public, anon, authenticated;
grant all on public.workshop_sessions, public.workshop_registrations, public.workshop_status_tokens,
  public.workshop_payment_attempts, public.workshop_notifications, public.workshop_meta_events,
  public.workshop_dispatch_config, public.workshop_payment_events to service_role;

-- The signed-in admin reads (never writes) the operational tables. Token
-- hashes and the dispatcher secret are not readable even by the admin.
grant select on public.workshop_sessions, public.workshop_registrations, public.workshop_payment_attempts,
  public.workshop_notifications, public.workshop_meta_events, public.workshop_payment_events to authenticated;

drop policy if exists "Admin reads workshop sessions" on public.workshop_sessions;
create policy "Admin reads workshop sessions" on public.workshop_sessions for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop registrations" on public.workshop_registrations;
create policy "Admin reads workshop registrations" on public.workshop_registrations for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop attempts" on public.workshop_payment_attempts;
create policy "Admin reads workshop attempts" on public.workshop_payment_attempts for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop notifications" on public.workshop_notifications;
create policy "Admin reads workshop notifications" on public.workshop_notifications for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop payment events" on public.workshop_payment_events;
create policy "Admin reads workshop payment events" on public.workshop_payment_events for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');
drop policy if exists "Admin reads workshop meta events" on public.workshop_meta_events;
create policy "Admin reads workshop meta events" on public.workshop_meta_events for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

do $$
declare fn text;
begin
  foreach fn in array array[
    'workshop_seats_in_use(uuid,uuid)', 'workshop_session_open(public.workshop_sessions)',
    'workshop_enqueue_meta(public.workshop_registrations,text,text,numeric)',
    'workshop_note_event(uuid,uuid,boolean,text)',
    'workshop_register(text,text,text,text,boolean,text,text,jsonb,boolean,numeric,timestamptz)',
    'workshop_start_attempt(uuid,text,text)', 'workshop_attempt_init_failed(text,text)',
    'workshop_apply_charge(text,bigint,text,text,timestamptz,text,uuid)',
    'workshop_apply_refund(text,bigint,text,uuid)', 'workshop_status_for_token(text,text)',
    'workshop_recompute_payment(uuid)',
    'workshop_claim_verify(text)', 'workshop_claim_notifications(integer)',
    'workshop_finish_notification(uuid,boolean,text)', 'workshop_claim_meta_events(integer)',
    'workshop_finish_meta_event(uuid,boolean,text)', 'workshop_admin_action(text,uuid,text,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Dispatcher schedule: NOT created by this migration. After the Pages
-- Function is deployed and the secret is set, run once (check cron.job first):
--
--   select cron.schedule('workshop-dispatch', '*/5 * * * *', $cron$
--     select net.http_post(
--       url := 'https://training.bulletproofautomations.com/api/workshops/dispatch',
--       headers := jsonb_build_object('Content-Type', 'application/json',
--                                     'x-workshop-dispatch', '<secret>'),
--       body := '{}'::jsonb)
--   $cron$);
-- ---------------------------------------------------------------------------

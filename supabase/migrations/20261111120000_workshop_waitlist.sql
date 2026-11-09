-- ---------------------------------------------------------------------------
-- Workshop release 4: first-in, first-out waitlist.
--
-- STATUS: NOT APPLIED. Apply only with the owner's explicit approval, after
-- release 3 (20261110120000). Rollback:
-- supabase/migrations/rollback/20261111120000_workshop_waitlist_down.sql
--
-- Extends what exists rather than adding a service:
--   * Places: the two capacity functions count places held by active offers,
--     so offers, holds and registrations share one count, under the same
--     session lock registration already takes. Nothing can oversell.
--   * Registration: workshop_register accepts an offer (it holds the place)
--     and refuses everyone else a place while people are waiting for that
--     kind of place. Prices, discounts, certificates and checkout are the
--     existing ones, unchanged.
--   * Timing: the existing per-minute dispatcher calls workshop_waitlist_advance
--     and sends the emails; no new job.
--   * Email: the existing outbox (workshop_notifications) belongs to a
--     registration, which a waiting person does not have yet, so each waitlist
--     row records its own email timestamps and the dispatcher sends them with
--     the same Hostinger sender.
--   * The seven-day cutoff (workshop_session_open) governs joining and offers.
--     An offer lasts until the earlier of 24 hours and the cutoff, and none is
--     made in the last 2 hours before the cutoff. Waiting entries close at it.
--
-- Replaces workshop_seats_in_use, workshop_graduate_seats_in_use and
-- workshop_register; the rollback restores release 2's bodies verbatim.
-- ---------------------------------------------------------------------------

create table if not exists public.workshop_waitlist (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.workshop_sessions(id) on delete restrict,
  -- general: the 25 open places; graduate: the reserved places, for a verified
  -- eligible Intermediate graduate only. Never offered across kinds.
  seat_kind text not null default 'general' check (seat_kind in ('general', 'graduate')),
  email_normalized text not null check (email_normalized = lower(btrim(email_normalized)) and email_normalized like '%@%'),
  full_name text not null check (length(full_name) between 2 and 120),
  whatsapp text check (whatsapp is null or length(whatsapp) between 7 and 40),
  whatsapp_consent boolean not null default false,
  attend_email text check (attend_email is null or attend_email = lower(btrim(attend_email))),
  referral_code text check (referral_code is null or referral_code ~ '^[A-Z0-9]{4,16}$'),
  benefit_credential_id text,
  --   waiting    in the queue
  --   offered    a place is held for them until offer_expires_at
  --   converted  they registered from the offer and it is confirmed
  --   expired    the offer ran out (or the cutoff came first)
  --   declined   they gave the place back
  --   skipped    not eligible when their turn came; status_reason says why
  --   closed     registration closed while they were still waiting
  --   removed    taken off by the admin; status_reason says why
  status text not null default 'waiting' check (status in (
    'waiting', 'offered', 'converted', 'expired', 'declined', 'skipped', 'closed', 'removed')),
  status_reason text,
  offer_token_hash text unique check (offer_token_hash is null or offer_token_hash ~ '^[0-9a-f]{64}$'),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  registration_id uuid references public.workshop_registrations(id) on delete restrict,
  joined_email_at timestamptz,
  offer_email_at timestamptz,
  reminder_email_at timestamptz,
  release_email_at timestamptz,
  email_failures integer not null default 0,
  email_error text,
  audit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One live entry per person per session.
create unique index if not exists workshop_waitlist_once
  on public.workshop_waitlist (session_id, email_normalized) where status in ('waiting', 'offered');
-- First in, first out: by the time of joining, then the id, per kind of place.
create index if not exists workshop_waitlist_fifo
  on public.workshop_waitlist (session_id, seat_kind, status, created_at, id);

alter table public.workshop_waitlist enable row level security;
revoke all on public.workshop_waitlist from anon, authenticated;
grant all on public.workshop_waitlist to service_role;
grant select on public.workshop_waitlist to authenticated;
drop policy if exists "Admin reads the workshop waitlist" on public.workshop_waitlist;
create policy "Admin reads the workshop waitlist" on public.workshop_waitlist for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

-- Does this registration's place come from an active offer?
create or replace function public.workshop_offer_holds(p_registration_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.workshop_waitlist w
                  where w.registration_id = p_registration_id and w.status = 'offered' and w.offer_expires_at > now())
$$;

-- Places held by active offers: an offer not yet used, or used by a
-- registration that is still waiting for payment. Once that registration is
-- confirmed it is counted as a registration instead.
create or replace function public.workshop_offers_holding(p_session_id uuid, p_kind text, p_except uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.workshop_waitlist w
   where w.session_id = p_session_id and w.seat_kind = p_kind
     and w.status = 'offered' and w.offer_expires_at > now()
     and w.registration_id is distinct from p_except
     and (w.registration_id is null or exists (select 1 from public.workshop_registrations r
                                                where r.id = w.registration_id and r.status = 'pending_payment'))
$$;

create or replace function public.workshop_waiting(p_session_id uuid, p_kind text)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.workshop_waitlist
   where session_id = p_session_id and seat_kind = p_kind and status = 'waiting'
$$;

create or replace function public.workshop_seats_in_use(p_session_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select (select count(*)::int
  from public.workshop_registrations r
  join public.workshop_sessions s on s.id = r.session_id
  where r.session_id = p_session_id
    and r.id is distinct from p_except
    and r.price_tier <> 'graduate'
    and (
      r.status in ('confirmed', 'payment_received_review', 'refund_pending')
      -- A pending registration made from a waitlist offer is counted through its offer below.
      or (r.status = 'pending_payment' and not public.workshop_offer_holds(r.id) and exists (
        select 1 from public.workshop_payment_attempts a
        where a.registration_id = r.id and a.status = 'initialized'
          and a.created_at > now() - make_interval(mins => s.hold_minutes)))
    ))
  -- Places held by active waitlist offers (release 4).
  + public.workshop_offers_holding(p_session_id, 'general', p_except)
$$;

create or replace function public.workshop_graduate_seats_in_use(p_session_id uuid)
returns integer language sql stable set search_path = '' as $$
  select (select count(*)::int from public.workshop_registrations
   where session_id = p_session_id and price_tier = 'graduate'
     and status in ('confirmed', 'payment_received_review', 'refund_pending'))
  -- Reserved places held by active graduate waitlist offers (release 4).
  + public.workshop_offers_holding(p_session_id, 'graduate', null)
$$;

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
  q jsonb;
  shown numeric;
  free boolean;
  offer public.workshop_waitlist;
  offer_hash text := nullif(coalesce(p_attribution, '{}'::jsonb)->>'offer_token_hash', '');
begin
  select * into s from public.workshop_sessions where slug = p_slug for update;
  if not found or s.status = 'draft' then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  -- Test and live never cross (Part 3). deployment_mode is set by the Pages
  -- Function from its own key, never by the browser; absent reads as 'off'.
  if s.is_test is distinct from (coalesce(a->>'deployment_mode', 'off') = 'test') then
    return jsonb_build_object('outcome', 'closed');
  end if;

  select * into r from public.workshop_registrations where session_id = s.id and email_normalized = email;
  if found then
    if p_token_hash is not null then
      insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id)
      on conflict do nothing;
    end if;
    -- An existing registration resumes at the price it was created with.
    return jsonb_build_object('outcome', 'existing', 'registration_id', r.id, 'status', r.status,
      'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier);
  end if;

  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- The page states the advertised price and a time. If the database
  -- disagrees, nobody is registered against a number they did not see.
  if p_displayed_price is not null and p_displayed_price <> s.price_ghs then
    return jsonb_build_object('outcome', 'stale_page');
  end if;
  if p_displayed_starts_at is not null and p_displayed_starts_at <> s.starts_at then
    return jsonb_build_object('outcome', 'stale_page');
  end if;

  q := public.workshop_price(s.id, email, a->>'referral_code', a->>'benefit_token_hash');
  if not (q->>'ok')::boolean then return jsonb_build_object('outcome', q->>'error'); end if;
  -- The final price the page showed. If it differs, the customer re-quotes.
  shown := nullif(a->>'expected_price', '')::numeric;
  if shown is not null and shown <> (q->>'price_ghs')::numeric then
    return jsonb_build_object('outcome', 'price_changed', 'price_ghs', (q->>'price_ghs')::numeric);
  end if;

  -- A waitlist offer (release 4) holds its place: only the person it was made
  -- to, for its kind of place, before it expires. Without one, nobody may take
  -- a place while people are waiting for that kind of place (first in, first out).
  if offer_hash is not null then
    select * into offer from public.workshop_waitlist
     where offer_token_hash = offer_hash and session_id = s.id and status = 'offered'
       and offer_expires_at > now() and email_normalized = email
     for update;
    if not found or (offer.seat_kind = 'graduate') is distinct from (q->>'tier' = 'graduate') then
      return jsonb_build_object('outcome', 'offer_not_valid');
    end if;
  elsif q->>'tier' = 'graduate' then
    if public.workshop_graduate_seats_in_use(s.id) >= s.reserved_graduate_seats
       or public.workshop_waiting(s.id, 'graduate') > 0 then
      return jsonb_build_object('outcome', 'full');
    end if;
  elsif s.capacity is not null and (public.workshop_seats_in_use(s.id) >= s.capacity
       or public.workshop_waiting(s.id, 'general') > 0) then
    return jsonb_build_object('outcome', 'full');
  end if;

  free := (q->>'price_ghs')::numeric = 0;
  insert into public.workshop_registrations (
    session_id, email_normalized, full_name, whatsapp, whatsapp_consent, terms_ack, terms_version,
    status, payment_status, amount_ghs,
    price_tier, benefit_credential_id, list_price_ghs, discount_kind, discount_ghs,
    referral_code, referrer_id, commission_ghs,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_path, referrer_host,
    ad_consent, fbclid, fbc, fbp, client_ip, client_user_agent)
  values (
    s.id, email, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    true, p_terms_version,
    case when free then 'confirmed' else 'pending_payment' end,
    case when free then 'not_required' else 'pending' end,
    (q->>'price_ghs')::numeric,
    q->>'tier', q->>'credential_id', (q->>'list_price_ghs')::numeric, q->>'discount_kind', (q->>'discount_ghs')::numeric,
    q->>'referral_code', (q->>'referrer_id')::uuid, (q->>'commission_ghs')::numeric,
    left(a->>'utm_source', 120), left(a->>'utm_medium', 120), left(a->>'utm_campaign', 200),
    left(a->>'utm_content', 200), left(a->>'utm_term', 200), left(a->>'landing_path', 200), left(a->>'referrer_host', 200),
    coalesce(p_ad_consent, false),
    case when p_ad_consent then left(a->>'fbclid', 500) end,
    case when p_ad_consent then left(a->>'fbc', 600) end,
    case when p_ad_consent then left(a->>'fbp', 200) end,
    case when p_ad_consent then left(a->>'client_ip', 64) end,
    case when p_ad_consent then left(a->>'client_user_agent', 400) end)
  returning * into r;

  if offer.id is not null then
    update public.workshop_waitlist set registration_id = r.id, updated_at = now(),
      audit = concat_ws(E'\n', audit, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC offer used to register')
     where id = offer.id;
  end if;

  -- The certificate token is spent with the registration, in the same transaction.
  if q->>'verification_id' is not null then
    update public.workshop_benefit_verifications set consumed_at = now(), registration_id = r.id
     where id = (q->>'verification_id')::uuid;
  end if;

  if p_token_hash is not null then
    insert into public.workshop_status_tokens (token_hash, registration_id) values (p_token_hash, r.id);
  end if;

  if free then
    insert into public.workshop_notifications (registration_id, kind) values (r.id, 'confirmation');
    perform public.workshop_enqueue_meta(r, 'CompleteRegistration', 'cr_' || r.id, 0);
  end if;

  return jsonb_build_object('outcome', 'created', 'registration_id', r.id, 'status', r.status,
    'payment_status', r.payment_status, 'session_id', s.id, 'price_ghs', r.amount_ghs, 'price_tier', r.price_tier,
    'list_price_ghs', r.list_price_ghs, 'discount_kind', r.discount_kind, 'discount_ghs', r.discount_ghs);
end $$;

-- Join the waitlist. Outcomes: joined | already (position), not_full (register
-- instead), registered (already has a place), closed, not_found.
create or replace function public.workshop_waitlist_join(
  p_slug text, p_email text, p_full_name text, p_whatsapp text, p_whatsapp_consent boolean,
  p_attend_email text, p_referral_code text, p_benefit_token_hash text, p_deployment_mode text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  w public.workshop_waitlist;
  addr text := lower(btrim(coalesce(p_email, '')));
  kind text := 'general';
  cred text;
  v public.workshop_benefit_verifications;
begin
  select * into s from public.workshop_sessions where slug = p_slug for update;
  if not found or s.status = 'draft' or s.is_test is distinct from (coalesce(p_deployment_mode, 'off') = 'test') then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if not public.workshop_session_open(s) then return jsonb_build_object('outcome', 'closed'); end if;
  if addr !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(btrim(coalesce(p_full_name, ''))) < 2 then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  if exists (select 1 from public.workshop_registrations r where r.session_id = s.id and r.email_normalized = addr) then
    return jsonb_build_object('outcome', 'registered');
  end if;

  -- A reserved graduate place needs a certificate already confirmed by the
  -- emailed code; it is checked again when the place is offered and used.
  if coalesce(p_benefit_token_hash, '') <> '' then
    select * into v from public.workshop_benefit_verifications
     where token_hash = p_benefit_token_hash and session_id = s.id and email = addr
       and verified_at is not null and consumed_at is null and token_expires_at > now() and tier = 'graduate';
    if found and s.graduate_free and s.reserved_graduate_seats > 0 then kind := 'graduate'; cred := v.credential_id; end if;
  end if;

  select * into w from public.workshop_waitlist
   where session_id = s.id and email_normalized = addr and status in ('waiting', 'offered');
  if found then
    return jsonb_build_object('outcome', 'already', 'position', public.workshop_waitlist_position(w.id), 'status', w.status);
  end if;

  -- Only when that kind of place is genuinely taken.
  if kind = 'graduate' then
    if public.workshop_graduate_seats_in_use(s.id) < s.reserved_graduate_seats and public.workshop_waiting(s.id, 'graduate') = 0 then
      return jsonb_build_object('outcome', 'not_full');
    end if;
  elsif s.capacity is null or (public.workshop_seats_in_use(s.id) < s.capacity and public.workshop_waiting(s.id, 'general') = 0) then
    return jsonb_build_object('outcome', 'not_full');
  end if;

  insert into public.workshop_waitlist (session_id, seat_kind, email_normalized, full_name, whatsapp, whatsapp_consent,
    attend_email, referral_code, benefit_credential_id, audit)
  values (s.id, kind, addr, btrim(p_full_name), nullif(btrim(coalesce(p_whatsapp, '')), ''), coalesce(p_whatsapp_consent, false),
    nullif(lower(btrim(coalesce(p_attend_email, ''))), ''), nullif(upper(btrim(coalesce(p_referral_code, ''))), ''), cred,
    to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC joined (' || kind || ')')
  returning * into w;
  return jsonb_build_object('outcome', 'joined', 'position', public.workshop_waitlist_position(w.id), 'kind', kind);
end $$;

-- Place in the queue for that kind of place, counting only people still waiting
-- or holding an offer ahead of this entry. Nothing about anyone else.
create or replace function public.workshop_waitlist_position(p_id uuid)
returns integer language sql stable set search_path = '' as $$
  select 1 + count(*)::int from public.workshop_waitlist o, public.workshop_waitlist w
   where w.id = p_id and o.session_id = w.session_id and o.seat_kind = w.seat_kind
     and o.status in ('waiting', 'offered') and (o.created_at, o.id) < (w.created_at, w.id)
$$;

-- One pass of the waitlist for test or live sessions, under each session's
-- lock. Called by the dispatcher every minute. Returns nothing: the emails it
-- leads to are read from the rows (workshop_waitlist_mail_due).
create or replace function public.workshop_waitlist_advance(p_test boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.workshop_sessions;
  sid uuid;
  w public.workshop_waitlist;
  free_places integer;
  k text;
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC ';
  out jsonb := jsonb_build_object('offered', 0, 'expired', 0, 'converted', 0, 'skipped', 0, 'closed', 0);
begin
  for sid in select ws.id from public.workshop_sessions ws
            where ws.is_test = p_test and ws.status <> 'draft'
              and exists (select 1 from public.workshop_waitlist x where x.session_id = ws.id and x.status in ('waiting', 'offered'))
            order by ws.starts_at
  loop
    select * into s from public.workshop_sessions where id = sid for update;

    -- Confirmed from an offer: converted (the registration now counts itself).
    with c as (
      update public.workshop_waitlist w set status = 'converted', updated_at = now(),
        audit = concat_ws(E'\n', w.audit, stamp || 'converted: registration confirmed')
       where w.session_id = s.id and w.status = 'offered' and w.registration_id is not null
         and exists (select 1 from public.workshop_registrations r where r.id = w.registration_id and r.status = 'confirmed')
      returning 1)
    select jsonb_set(out, '{converted}', to_jsonb((out->>'converted')::int + count(*)::int)) into out from c;

    -- Offers that ran out. A checkout already under way keeps its own 30-minute
    -- hold on the place, so a payment arriving now is still confirmed.
    with e as (
      update public.workshop_waitlist w set status = 'expired', updated_at = now(),
        status_reason = case when w.offer_expires_at >= s.starts_at - interval '168 hours' then 'registration closed' else 'offer not taken up within 24 hours' end,
        audit = concat_ws(E'\n', w.audit, stamp || 'offer expired')
       where w.session_id = s.id and w.status = 'offered' and w.offer_expires_at <= now()
         and not exists (select 1 from public.workshop_registrations r where r.id = w.registration_id and r.status = 'confirmed')
      returning 1)
    select jsonb_set(out, '{expired}', to_jsonb((out->>'expired')::int + count(*)::int)) into out from e;

    -- Registration closed: nobody still waiting can be offered a place.
    if not public.workshop_session_open(s) then
      with c as (
        update public.workshop_waitlist w set status = 'closed', updated_at = now(),
          status_reason = 'registration closed', audit = concat_ws(E'\n', w.audit, stamp || 'closed: registration closed')
         where w.session_id = s.id and w.status = 'waiting'
        returning 1)
      select jsonb_set(out, '{closed}', to_jsonb((out->>'closed')::int + count(*)::int)) into out from c;
      continue;
    end if;
    -- Too close to the cutoff to complete registration: offer nothing new.
    if now() > s.starts_at - interval '168 hours' - interval '2 hours' then continue; end if;

    foreach k in array array['general', 'graduate'] loop
      free_places := case when k = 'general' then coalesce(s.capacity, 0) - public.workshop_seats_in_use(s.id)
                          else case when s.graduate_free then s.reserved_graduate_seats - public.workshop_graduate_seats_in_use(s.id) else 0 end end;
      while free_places > 0 loop
        select * into w from public.workshop_waitlist
         where session_id = s.id and seat_kind = k and status = 'waiting'
         order by created_at, id limit 1 for update skip locked;
        exit when not found;
        -- Not eligible any more: skipped, with the reason kept. Order is never changed.
        if exists (select 1 from public.workshop_registrations r where r.session_id = s.id and r.email_normalized = w.email_normalized) then
          update public.workshop_waitlist set status = 'skipped', status_reason = 'already has a registration for this session', updated_at = now(),
            audit = concat_ws(E'\n', audit, stamp || 'skipped: already registered') where id = w.id;
          out := jsonb_set(out, '{skipped}', to_jsonb((out->>'skipped')::int + 1));
          continue;
        end if;
        if k = 'graduate' and public.workshop_credential_tier(w.benefit_credential_id) is distinct from 'graduate' then
          update public.workshop_waitlist set status = 'skipped', status_reason = 'graduate entitlement no longer active', updated_at = now(),
            audit = concat_ws(E'\n', audit, stamp || 'skipped: graduate entitlement no longer active') where id = w.id;
          out := jsonb_set(out, '{skipped}', to_jsonb((out->>'skipped')::int + 1));
          continue;
        end if;
        update public.workshop_waitlist set status = 'offered', offered_at = now(), updated_at = now(),
          offer_expires_at = least(now() + interval '24 hours', s.starts_at - interval '168 hours'),
          offer_token_hash = null, offer_email_at = null,
          audit = concat_ws(E'\n', audit, stamp || 'offered a ' || k || ' place')
         where id = w.id;
        out := jsonb_set(out, '{offered}', to_jsonb((out->>'offered')::int + 1));
        free_places := free_places - 1;
      end loop;
    end loop;
  end loop;
  return out;
end $$;

-- Emails the dispatcher owes, oldest first: joined, offer, reminder (6 hours
-- left, for an offer of more than 12 hours), released (expired or closed).
create or replace function public.workshop_waitlist_mail_due(p_test boolean, p_limit integer default 10)
returns table (id uuid, kind text, email text, full_name text, slug text, title text, starts_at timestamptz,
  time_zone text, offer_expires_at timestamptz, seat_kind text, status_reason text, position integer)
language sql stable security definer set search_path = '' as $$
  select w.id,
    case when w.joined_email_at is null and w.status in ('waiting', 'offered') then 'joined'
         when w.status = 'offered' and w.offer_email_at is null then 'offer'
         when w.status = 'offered' and w.reminder_email_at is null and w.offer_expires_at - now() < interval '6 hours'
              and w.offer_expires_at - w.offered_at > interval '12 hours' and w.registration_id is null then 'reminder'
         when w.status in ('expired', 'closed') and w.release_email_at is null then 'released' end,
    w.email_normalized, w.full_name, s.slug, s.title, s.starts_at, s.time_zone, w.offer_expires_at, w.seat_kind, w.status_reason,
    public.workshop_waitlist_position(w.id)
  from public.workshop_waitlist w join public.workshop_sessions s on s.id = w.session_id
  where s.is_test = p_test and w.email_failures < 5
    and ((w.joined_email_at is null and w.status in ('waiting', 'offered'))
      or (w.status = 'offered' and w.offer_email_at is null)
      or (w.status = 'offered' and w.reminder_email_at is null and w.offer_expires_at - now() < interval '6 hours'
          and w.offer_expires_at - w.offered_at > interval '12 hours' and w.registration_id is null)
      or (w.status in ('expired', 'closed') and w.release_email_at is null))
  order by w.created_at, w.id
  limit greatest(1, least(p_limit, 50))
$$;

-- A new offer link for an offered entry: only the hash is kept. Each email
-- attempt mints a new one, so a link that never arrived is never valid.
create or replace function public.workshop_waitlist_set_token(p_id uuid, p_token_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.workshop_waitlist set offer_token_hash = p_token_hash, updated_at = now()
   where id = p_id and status = 'offered';
  return found;
end $$;

create or replace function public.workshop_waitlist_mail_done(p_id uuid, p_kind text, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then
    update public.workshop_waitlist set updated_at = now(), email_failures = 0, email_error = null,
      joined_email_at = case when p_kind = 'joined' then now() else joined_email_at end,
      offer_email_at = case when p_kind = 'offer' then now() else offer_email_at end,
      reminder_email_at = case when p_kind = 'reminder' then now() else reminder_email_at end,
      release_email_at = case when p_kind = 'released' then now() else release_email_at end,
      audit = concat_ws(E'\n', audit, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC email sent: ' || p_kind)
     where id = p_id;
  else
    update public.workshop_waitlist set updated_at = now(), email_failures = email_failures + 1,
      email_error = left(coalesce(p_error, 'send failed'), 200) where id = p_id;
  end if;
end $$;

-- What an offer link may see: the person's own details, to fill in the form.
create or replace function public.workshop_waitlist_offer(p_token_hash text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', s.slug, 'full_name', w.full_name, 'email', w.email_normalized, 'whatsapp', w.whatsapp,
    'attend_email', w.attend_email, 'referral_code', w.referral_code, 'seat_kind', w.seat_kind,
    'expires_at', w.offer_expires_at)
  from public.workshop_waitlist w join public.workshop_sessions s on s.id = w.session_id
  where w.offer_token_hash = p_token_hash and w.status = 'offered' and w.offer_expires_at > now()
$$;

-- "No thanks": the place goes back at once. An offer already used to register
-- is not declined here (the registration is cancelled through the admin).
create or replace function public.workshop_waitlist_decline(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare w public.workshop_waitlist;
begin
  update public.workshop_waitlist set status = 'declined', status_reason = 'declined by the participant', updated_at = now(),
    audit = concat_ws(E'\n', audit, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC declined')
   where offer_token_hash = p_token_hash and status = 'offered' and offer_expires_at > now() and registration_id is null
  returning * into w;
  return jsonb_build_object('ok', found);
end $$;

-- Admin exceptions only: take someone off (with a reason), or clear an email
-- error so it is tried again. Normal progression needs no admin action.
create or replace function public.workshop_admin_waitlist(p_actor_email text, p_id uuid, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC admin ';
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then raise exception 'Administrator required'; end if;
  if p_action = 'remove' then
    if length(btrim(coalesce(p_reason, ''))) < 5 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;
    update public.workshop_waitlist set status = 'removed', status_reason = left(p_reason, 300), updated_at = now(),
      audit = concat_ws(E'\n', audit, stamp || 'removed: ' || left(p_reason, 300))
     where id = p_id and status in ('waiting', 'offered') and registration_id is null;
  elsif p_action = 'retry_email' then
    update public.workshop_waitlist set email_failures = 0, email_error = null, updated_at = now(),
      audit = concat_ws(E'\n', audit, stamp || 'email retry') where id = p_id;
  else
    return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end if;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'workshop_offer_holds(uuid)', 'workshop_offers_holding(uuid,text,uuid)', 'workshop_waiting(uuid,text)',
    'workshop_waitlist_join(text,text,text,text,boolean,text,text,text,text)', 'workshop_waitlist_position(uuid)',
    'workshop_waitlist_advance(boolean)', 'workshop_waitlist_mail_due(boolean,integer)',
    'workshop_waitlist_set_token(uuid,text)', 'workshop_waitlist_mail_done(uuid,text,boolean,text)',
    'workshop_waitlist_offer(text)', 'workshop_waitlist_decline(text)', 'workshop_admin_waitlist(text,uuid,text,text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;

-- Rollback of release 5 (20261112120000_workshop_audit_corrections.sql).
-- Restores every function it replaced, verbatim from the release that last
-- defined it (1, 3 or 4), drops the three functions it added, then the three
-- columns it added. Run as one transaction. Reintroduces the audit findings.

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

create or replace function public.workshop_payment_in_flight(p_registration_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.workshop_payment_attempts a
                  join public.workshop_registrations r on r.id = a.registration_id
                  join public.workshop_sessions s on s.id = r.session_id
                  where a.registration_id = p_registration_id and a.status = 'initialized'
                    and a.created_at > now() - make_interval(mins => s.hold_minutes))
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
  if r.status <> 'pending_payment' or r.amount_ghs = 0 or r.payment_status = 'needs_review' then
    return jsonb_build_object('outcome', 'not_payable', 'status', r.status);
  end if;
  -- Test money only on a test session, live money only on a live one (Part 3).
  if (p_mode = 'test') is distinct from s.is_test then
    return jsonb_build_object('outcome', 'mode_not_allowed');
  end if;
  if not public.workshop_session_open(s) then
    return jsonb_build_object('outcome', 'closed');
  end if;
  -- Release 4: checked atomically, under the session lock, before Paystack is
  -- called. A registration made from a live offer, or one whose own checkout
  -- hold is still running (payment in flight), already has its place. Any other
  -- may start a checkout only if a place is free AND nobody is waiting for one,
  -- so an expired offer or an old unpaid registration can never jump the queue.
  if not public.workshop_offer_holds(r.id) and not public.workshop_payment_in_flight(r.id)
     and s.capacity is not null
     and (public.workshop_seats_in_use(s.id, r.id) >= s.capacity or public.workshop_waiting(s.id, 'general') > 0) then
    return jsonb_build_object('outcome', 'full');
  end if;

  insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
  values (r.id, p_reference, round(r.amount_ghs * 100)::bigint, 'GHS', p_mode)
  returning * into att;

  perform public.workshop_enqueue_meta(r, 'InitiateCheckout', 'ic_' || r.id, r.amount_ghs);

  return jsonb_build_object('outcome', 'started', 'attempt_id', att.id, 'reference', att.reference,
    'amount_minor', att.amount_minor, 'currency', att.currency, 'session_id', s.id);
end $$;

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
  -- Release 4: a payment whose checkout hold has lapsed, and whose place no live
  -- waitlist offer reserves, is confirmed only if a place is free AND nobody is
  -- waiting for one. Otherwise it is held for review (capacity) and refunded,
  -- so a late payment can neither oversell nor jump the waitlist, even before
  -- the dispatcher has offered the freed place. Payments inside their hold, or
  -- covered by a live offer, confirm exactly as before.
  elsif not hold_valid and not public.workshop_offer_holds(r.id) and s.capacity is not null
        and (public.workshop_seats_in_use(s.id, r.id) >= s.capacity
             or public.workshop_waiting(s.id, 'general') > 0) then
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

-- Restored stable and unclaiming. Same signature and return type, so no drop.
create or replace function public.workshop_waitlist_mail_due(p_test boolean, p_limit integer default 10)
returns table (id uuid, kind text, email text, full_name text, slug text, title text, starts_at timestamptz,
  time_zone text, offer_expires_at timestamptz, seat_kind text, status_reason text, queue_position integer)
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

create or replace function public.workshop_calendar_plan(p_test boolean, p_limit integer default 10)
returns table (registration_id uuid, session_id uuid, calendar_event_id text, add_email text, remove_email text, blocked text)
language sql stable security definer set search_path = '' as $$
  with candidates as (
    select r.id, r.session_id, s.calendar_event_id, r.created_at,
      (r.status = 'confirmed' and r.payment_status in ('paid', 'partially_refunded', 'not_required')) as entitled,
      -- coalesce: a lapsed certificate's tier is null, which must read as "not eligible", never as unknown.
      coalesce(r.price_tier <> 'graduate' or public.workshop_credential_tier(r.benefit_credential_id) = 'graduate', false) as eligible,
      r.attend_email, r.invited_email
    from public.workshop_registrations r
    join public.workshop_sessions s on s.id = r.session_id
    where s.admission = 'invite' and s.calendar_event_id is not null and s.is_test = p_test
      and s.status <> 'draft' and s.starts_at > now() - interval '1 day'
      and r.calendar_sync_failures < 5
  ), wanted as (
    select c.*,
      case when c.entitled and c.eligible and c.attend_email is not null
                and c.attend_email is distinct from c.invited_email
                -- One invitation per account per session, to the earliest registration.
                and not exists (select 1 from public.workshop_registrations o
                                 where o.session_id = c.session_id and o.id <> c.id and o.invited_email = c.attend_email)
                and c.id = (select o.id from public.workshop_registrations o
                             where o.session_id = c.session_id and o.attend_email = c.attend_email
                               and o.status = 'confirmed' order by o.created_at, o.id limit 1)
           then c.attend_email end as add_email,
      case when c.invited_email is not null
                and (not c.entitled or c.attend_email is distinct from c.invited_email)
           then c.invited_email end as remove_email,
      case when c.entitled and not c.eligible and c.invited_email is null and c.attend_email is not null
           then 'graduate_not_eligible' end as blocked
    from candidates c
  )
  select w.id, w.session_id, w.calendar_event_id, w.add_email, w.remove_email, w.blocked
    from wanted w
   where w.add_email is not null or w.remove_email is not null or w.blocked is not null
   order by w.created_at
   limit greatest(1, least(p_limit, 50))
$$;

create or replace function public.workshop_calendar_record(
  p_registration_id uuid, p_ok boolean, p_added text default null, p_removed text default null,
  p_error text default null, p_permanent boolean default false
) returns void language plpgsql security definer set search_path = '' as $$
declare
  r public.workshop_registrations;
  stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC calendar-sync ';
begin
  select * into r from public.workshop_registrations where id = p_registration_id for update;
  if not found then return; end if;
  if p_ok then
    update public.workshop_registrations set
      invited_email = case when p_added is not null then p_added
                           when p_removed is not null and invited_email = p_removed then null
                           else invited_email end,
      invited_at = case when p_added is not null then now() else invited_at end,
      invite_removed_at = case when p_removed is not null then now() else invite_removed_at end,
      calendar_sync_failures = 0, calendar_sync_error = null, calendar_sync_at = now(),
      admin_notes = concat_ws(E'\n', admin_notes,
        case when p_removed is not null then stamp || 'removed (' || p_removed || ')' end,
        case when p_added is not null then stamp || 'added (' || p_added || ')' end)
    where id = r.id;
  else
    update public.workshop_registrations set
      calendar_sync_failures = case when p_permanent then 5 else least(calendar_sync_failures + 1, 5) end,
      calendar_sync_error = left(coalesce(p_error, 'unknown error'), 300), calendar_sync_at = now()
    where id = r.id;
  end if;
end $$;

create or replace function public.workshop_calendar_retry(p_actor_email text, p_registration_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if lower(coalesce(p_actor_email, '')) <> 'johnathan@bulletproofautomations.com' then
    raise exception 'Administrator required';
  end if;
  update public.workshop_registrations set calendar_sync_failures = 0, calendar_sync_error = null,
    admin_notes = concat_ws(E'\n', admin_notes, to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC calendar-sync retry requested')
   where id = p_registration_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

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

drop function if exists public.workshop_admin_notification_retry(text, uuid);
drop function if exists public.workshop_apply_pending_refunds(text);
drop function if exists public.workshop_refund_awaiting_note();

-- Last, once nothing refers to them.
alter table public.workshop_registrations drop column if exists calendar_claimed_at;
alter table public.workshop_waitlist drop column if exists mail_claimed_at;
alter table public.workshop_payment_attempts drop column if exists hold_until;

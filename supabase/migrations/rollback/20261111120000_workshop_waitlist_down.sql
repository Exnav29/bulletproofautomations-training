-- Rollback of 20261111120000_workshop_waitlist.sql. Restores release 2's
-- capacity, registration and checkout functions verbatim, then drops the waitlist.
-- Export workshop_waitlist first: it is the record of every offer made.
create or replace function public.workshop_seats_in_use(p_session_id uuid, p_except uuid default null)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int
  from public.workshop_registrations r
  join public.workshop_sessions s on s.id = r.session_id
  where r.session_id = p_session_id
    and r.id is distinct from p_except
    and r.price_tier <> 'graduate'
    and (
      r.status in ('confirmed', 'payment_received_review', 'refund_pending')
      or (r.status = 'pending_payment' and exists (
        select 1 from public.workshop_payment_attempts a
        where a.registration_id = r.id and a.status = 'initialized'
          and a.created_at > now() - make_interval(mins => s.hold_minutes)))
    )
$$;

create or replace function public.workshop_graduate_seats_in_use(p_session_id uuid)
returns integer language sql stable set search_path = '' as $$
  select count(*)::int from public.workshop_registrations
   where session_id = p_session_id and price_tier = 'graduate'
     and status in ('confirmed', 'payment_received_review', 'refund_pending')
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

  if q->>'tier' = 'graduate' then
    if public.workshop_graduate_seats_in_use(s.id) >= s.reserved_graduate_seats then
      return jsonb_build_object('outcome', 'full');
    end if;
  elsif s.capacity is not null and public.workshop_seats_in_use(s.id) >= s.capacity then
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
  if s.capacity is not null and public.workshop_seats_in_use(s.id, r.id) >= s.capacity then
    return jsonb_build_object('outcome', 'full');
  end if;

  insert into public.workshop_payment_attempts (registration_id, reference, amount_minor, currency, mode)
  values (r.id, p_reference, round(r.amount_ghs * 100)::bigint, 'GHS', p_mode)
  returning * into att;

  perform public.workshop_enqueue_meta(r, 'InitiateCheckout', 'ic_' || r.id, r.amount_ghs);

  return jsonb_build_object('outcome', 'started', 'attempt_id', att.id, 'reference', att.reference,
    'amount_minor', att.amount_minor, 'currency', att.currency, 'session_id', s.id);
end $$;

-- Release 1's payment confirmation, verbatim.
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

drop function if exists public.workshop_admin_waitlist(text, uuid, text, text);
drop function if exists public.workshop_waitlist_decline(text);
drop function if exists public.workshop_waitlist_offer(text);
drop function if exists public.workshop_waitlist_mail_done(uuid, text, boolean, text);
drop function if exists public.workshop_waitlist_set_token(uuid, text);
drop function if exists public.workshop_waitlist_mail_due(boolean, integer);
drop function if exists public.workshop_waitlist_advance(boolean);
drop function if exists public.workshop_waitlist_position(uuid);
drop function if exists public.workshop_waitlist_join(text, text, text, text, boolean, text, text, text, text);
drop function if exists public.workshop_waiting(uuid, text);
drop function if exists public.workshop_payment_in_flight(uuid);
drop function if exists public.workshop_offers_holding(uuid, text, uuid);
drop function if exists public.workshop_offer_holds(uuid);
drop table if exists public.workshop_waitlist;

-- Payment ledger schema, copied from the PRODUCTION training database (project
-- ikkldbhgjleelviwttir) on 2026-11-02 with read-only catalog queries:
--   information_schema.columns, pg_get_constraintdef, pg_get_indexdef,
--   pg_get_functiondef and pg_get_triggerdef for the three tables below.
-- Function and trigger bodies are verbatim. Do not edit by hand: re-export from the live
-- database if it changes. The repo's supabase-*.sql files are documentation, and the live
-- database is the source of truth (see their headers).
--
-- Used by tests/paystack-webhook.test.ts, which runs it in PGlite (real PostgreSQL) so the
-- webhook is tested against production's constraints and triggers, including
-- payment_events_mark_installment_paid.


CREATE TABLE public.enrollments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  full_name text NOT NULL,
  email text NOT NULL,
  whatsapp text NOT NULL,
  city text NOT NULL,
  experience_level text NOT NULL,
  chosen_option text NOT NULL,
  amount_ghs numeric NOT NULL,
  payment_plan boolean DEFAULT false NOT NULL,
  first_instalment_ghs numeric,
  payment_status text DEFAULT 'reserved'::text NOT NULL,
  paystack_reference text,
  paystack_payment_date timestamp with time zone,
  amount_paid_ghs numeric DEFAULT 0,
  slack_invited boolean DEFAULT false NOT NULL,
  whatsapp_contacted boolean DEFAULT false NOT NULL,
  contact_date timestamp with time zone,
  seat_number integer,
  cohort text DEFAULT 'intermediate_2026_09'::text NOT NULL,
  notes text,
  consent_given boolean DEFAULT false NOT NULL,
  source text,
  ack_refund boolean DEFAULT false NOT NULL,
  ack_certification boolean DEFAULT false NOT NULL,
  acks_policy_version text,
  region_tier text,
  detected_country text,
  declared_country text,
  foundations_cohort_1 boolean DEFAULT false NOT NULL
);

CREATE TABLE public.payment_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  provider text DEFAULT 'paystack'::text NOT NULL,
  event text,
  reference text,
  email text,
  amount_ghs numeric,
  status text,
  paid_at timestamp with time zone,
  signature_valid boolean DEFAULT false NOT NULL,
  enrollment_id uuid,
  matched boolean DEFAULT false NOT NULL,
  match_note text,
  raw jsonb NOT NULL
);

CREATE TABLE public.payment_plan_installments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  enrollment_id uuid NOT NULL,
  installment_number integer NOT NULL,
  amount_ghs numeric NOT NULL,
  due_rule text,
  due_date date,
  send_on date,
  status text DEFAULT 'scheduled'::text NOT NULL,
  payment_token uuid DEFAULT gen_random_uuid() NOT NULL,
  paystack_reference text,
  authorization_url text,
  sent_at timestamp with time zone,
  paid_at timestamp with time zone,
  last_notified_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);

ALTER TABLE public.payment_events ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_pkey PRIMARY KEY (id);

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_chosen_option_check CHECK ((chosen_option = ANY (ARRAY['cohort_only'::text, 'cohort_and_assessment'::text, 'path_b_readiness'::text])));

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_experience_level_check CHECK ((experience_level = ANY (ARRAY['foundations_graduate'::text, 'experienced_builder'::text, 'beginner'::text])));

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_payment_status_check CHECK ((payment_status = ANY (ARRAY['reserved'::text, 'payment_pending'::text, 'partially_paid'::text, 'paid'::text, 'cancelled'::text])));

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_region_tier_check CHECK (((region_tier IS NULL) OR (region_tier = ANY (ARRAY['ghana'::text, 'africa'::text, 'emerging'::text, 'international'::text]))));

ALTER TABLE public.enrollments ADD CONSTRAINT enrollments_source_check CHECK ((source = ANY (ARRAY['website'::text, 'showcase'::text, 'whatsapp'::text, 'referral'::text])));

ALTER TABLE public.payment_events ADD CONSTRAINT payment_events_provider_event_ref_key UNIQUE (provider, event, reference);

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_amount_ghs_check CHECK ((amount_ghs > (0)::numeric));

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_enrollment_id_installment_number_key UNIQUE (enrollment_id, installment_number);

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_installment_number_check CHECK ((installment_number > 0));

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_payment_token_key UNIQUE (payment_token);

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_paystack_reference_key UNIQUE (paystack_reference);

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'sent'::text, 'paid'::text, 'cancelled'::text])));

ALTER TABLE public.payment_events ADD CONSTRAINT payment_events_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL;

ALTER TABLE public.payment_plan_installments ADD CONSTRAINT payment_plan_installments_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE;

CREATE INDEX payment_events_email_idx ON public.payment_events USING btree (lower(email));

CREATE INDEX payment_events_received_idx ON public.payment_events USING btree (received_at DESC);

CREATE INDEX payment_events_reference_idx ON public.payment_events USING btree (reference);

CREATE INDEX payment_plan_installments_due_idx ON public.payment_plan_installments USING btree (status, send_on);

CREATE INDEX payment_plan_installments_enrollment_idx ON public.payment_plan_installments USING btree (enrollment_id, installment_number);

CREATE OR REPLACE FUNCTION public.mark_installment_paid_from_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.provider = 'paystack'
     and new.event = 'charge.success'
     and new.signature_valid is true
     and new.matched is true
     and coalesce(old.matched, false) is false then
    update public.payment_plan_installments
       set status = 'paid',
           paid_at = coalesce(new.paid_at, now()),
           updated_at = now()
     where paystack_reference = new.reference
       and status <> 'paid';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.seed_intermediate_payment_plan_from_enrollment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  paid_on timestamptz := coalesce(new.paystack_payment_date, now());
  initial_due date := coalesce(new.paystack_payment_date::date, current_date);
begin
  -- Only seed a plan after the first real payment has been applied.
  -- Fully-paid enrollments do not need installment rows.
  if new.payment_plan is not true
     or new.payment_status <> 'partially_paid'
     or coalesce(new.amount_paid_ghs, 0) <= 0
     or new.cohort <> 'intermediate_2026_09' then
    return new;
  end if;

  if new.chosen_option = 'cohort_only'
     and new.amount_ghs = 750
     and new.first_instalment_ghs = 400 then

    insert into public.payment_plan_installments
      (enrollment_id, installment_number, amount_ghs, due_rule, due_date, send_on,
       status, paystack_reference, paid_at)
    values
      (new.id, 1, 400, 'Initial deposit', initial_due, null,
       'paid', new.paystack_reference, paid_on),
      (new.id, 2, 350, 'Before Week 3', date '2026-10-16', date '2026-10-12',
       'scheduled', null, null)
    on conflict (enrollment_id, installment_number) do nothing;

  elsif new.chosen_option = 'cohort_and_assessment'
        and new.amount_ghs = 1050
        and new.first_instalment_ghs = 400 then

    insert into public.payment_plan_installments
      (enrollment_id, installment_number, amount_ghs, due_rule, due_date, send_on,
       status, paystack_reference, paid_at)
    values
      (new.id, 1, 400, 'Initial deposit', initial_due, null,
       'paid', new.paystack_reference, paid_on),
      (new.id, 2, 325, 'Before Week 3', date '2026-10-16', date '2026-10-12',
       'scheduled', null, null),
      (new.id, 3, 325, 'Before Week 5', date '2026-10-30', date '2026-10-26',
       'scheduled', null, null)
    on conflict (enrollment_id, installment_number) do nothing;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE TRIGGER enrollments_seed_intermediate_payment_plan AFTER INSERT OR UPDATE OF amount_paid_ghs, payment_status, paystack_reference, paystack_payment_date, payment_plan ON public.enrollments FOR EACH ROW EXECUTE FUNCTION seed_intermediate_payment_plan_from_enrollment();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.enrollments FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER payment_events_mark_installment_paid AFTER UPDATE OF matched ON public.payment_events FOR EACH ROW WHEN ((new.matched IS TRUE)) EXECUTE FUNCTION mark_installment_paid_from_event();

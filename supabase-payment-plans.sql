-- Bulletproof Automations Training — installment plans
-- Live schema for post-enrollment installment billing.

create table if not exists public.payment_plan_installments (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  installment_number integer not null check (installment_number > 0),
  amount_ghs numeric(10,2) not null check (amount_ghs > 0),
  due_rule text,
  due_date date,
  send_on date,
  status text not null default 'scheduled'
    check (status in ('scheduled','sent','paid','cancelled')),
  payment_token uuid not null default gen_random_uuid(),
  paystack_reference text,
  authorization_url text,
  sent_at timestamptz,
  paid_at timestamptz,
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (enrollment_id, installment_number),
  unique (payment_token),
  unique (paystack_reference)
);

create index if not exists payment_plan_installments_enrollment_idx
  on public.payment_plan_installments (enrollment_id, installment_number);
create index if not exists payment_plan_installments_due_idx
  on public.payment_plan_installments (status, send_on);
alter table public.payment_plan_installments enable row level security;

drop policy if exists "Admins can read payment plan installments" on public.payment_plan_installments;
create policy "Admins can read payment plan installments"
  on public.payment_plan_installments for select to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

drop policy if exists "Admins can insert payment plan installments" on public.payment_plan_installments;
create policy "Admins can insert payment plan installments"
  on public.payment_plan_installments for insert to authenticated
  with check ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

drop policy if exists "Admins can update payment plan installments" on public.payment_plan_installments;
create policy "Admins can update payment plan installments"
  on public.payment_plan_installments for update to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com')
  with check ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

drop policy if exists "Admins can delete payment plan installments" on public.payment_plan_installments;
create policy "Admins can delete payment plan installments"
  on public.payment_plan_installments for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'johnathan@bulletproofautomations.com');

drop policy if exists "Allow service role full access" on public.payment_plan_installments;
create policy "Allow service role full access"
  on public.payment_plan_installments for all to service_role using (true) with check (true);

grant select, insert, update, delete on public.payment_plan_installments to authenticated;
grant all on public.payment_plan_installments to service_role;
-- Scheduler authentication stores only a SHA-256 hash. The raw token is kept
-- inside the database cron command, where only database administrators can read it.
create table if not exists public.installment_scheduler_config (
  id boolean primary key default true check (id),
  secret_hash text not null,
  updated_at timestamptz not null default now()
);

alter table public.installment_scheduler_config enable row level security;
revoke all on public.installment_scheduler_config from anon, authenticated;
grant all on public.installment_scheduler_config to service_role;
-- Keep the installment ledger in sync with verified Paystack evidence. The
-- existing webhook marks payment_events.matched only after the enrollment
-- balance has been updated successfully; this trigger then advances the exact
-- installment whose Paystack reference produced that event.
create or replace function public.mark_installment_paid_from_event()
returns trigger
language plpgsql
set search_path = ''
as $$
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
$$;

drop trigger if exists payment_events_mark_installment_paid on public.payment_events;
create trigger payment_events_mark_installment_paid
after update of matched on public.payment_events
for each row
when (new.matched is true)
execute function public.mark_installment_paid_from_event();


-- Automatically create the current Intermediate cohort's default installment
-- ledger after Paystack applies the first real payment. Existing/custom plans
-- are preserved because conflicts are never overwritten.
create or replace function public.seed_intermediate_payment_plan_from_enrollment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  paid_on timestamptz := coalesce(new.paystack_payment_date, now());
  initial_due date := coalesce(new.paystack_payment_date::date, current_date);
begin
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
$$;

drop trigger if exists enrollments_seed_intermediate_payment_plan on public.enrollments;
create trigger enrollments_seed_intermediate_payment_plan
after insert or update of amount_paid_ghs, payment_status, paystack_reference,
  paystack_payment_date, payment_plan
on public.enrollments
for each row
execute function public.seed_intermediate_payment_plan_from_enrollment();

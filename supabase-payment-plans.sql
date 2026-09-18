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
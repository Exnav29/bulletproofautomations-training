-- Bulletproof Automations Training
-- Supabase setup for the standalone training subdomain.
-- Run this in the Supabase SQL editor for the training project only.

create extension if not exists "uuid-ossp";

create table if not exists public.waitlist_signups (
    id uuid primary key default uuid_generate_v4(),
    full_name text not null,
    email text not null,
    whatsapp_number text not null,
    city text not null,
    experience_level text not null,
    current_build_type text not null,
    interested_class text,
    preferred_setup text,
    biggest_pricing_challenge text,
    vip_pricing_review_interest text not null default 'No',
    price_range_interest text,
    source text not null default 'direct',
    workshop_slug text not null default 'price-by-value',
    signup_date_time timestamptz not null default now(),
    status text not null default 'New',
    ticket_type text not null default 'Waitlist',
    payment_status text not null default 'Unpaid',
    amount_paid numeric(10,2),
    payment_reference text,
    payment_method text,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint waitlist_experience_check check (experience_level in ('New to n8n', 'Beginner', 'Some experience', 'Intermediate', 'Advanced')),
    constraint waitlist_vip_check check (vip_pricing_review_interest in ('Yes', 'Maybe', 'No')),
    constraint waitlist_status_check check (status in ('New', 'Contacted', 'Registered', 'Paid', 'Not Interested')),
    constraint waitlist_ticket_type_check check (ticket_type in ('Waitlist', 'Early Bird', 'Regular', 'VIP')),
    constraint waitlist_payment_status_check check (payment_status in ('Unpaid', 'Paid', 'Refunded', 'Cancelled')),
    constraint waitlist_payment_method_check check (
        payment_method is null
        or payment_method in ('Mobile Money', 'Card', 'Bank Transfer', 'Cash', 'Other')
    )
);

alter table public.waitlist_signups
    add column if not exists interested_class text;

alter table public.waitlist_signups
    add column if not exists preferred_setup text;

alter table public.waitlist_signups
    drop constraint if exists waitlist_experience_check;

alter table public.waitlist_signups
    add constraint waitlist_experience_check
    check (experience_level in ('New to n8n', 'Beginner', 'Some experience', 'Intermediate', 'Advanced'));

create index if not exists idx_waitlist_workshop on public.waitlist_signups(workshop_slug);
create index if not exists idx_waitlist_status on public.waitlist_signups(status);
create index if not exists idx_waitlist_payment on public.waitlist_signups(payment_status);
create index if not exists idx_waitlist_source on public.waitlist_signups(source);
create index if not exists idx_waitlist_date on public.waitlist_signups(signup_date_time desc);
create index if not exists idx_waitlist_vip on public.waitlist_signups(vip_pricing_review_interest);
create index if not exists idx_waitlist_interested_class on public.waitlist_signups(interested_class);
create index if not exists idx_waitlist_preferred_setup on public.waitlist_signups(preferred_setup);

create unique index if not exists idx_waitlist_unique_workshop_email
    on public.waitlist_signups(workshop_slug, lower(email));

create unique index if not exists idx_waitlist_unique_workshop_whatsapp
    on public.waitlist_signups(workshop_slug, whatsapp_number);

create or replace function public.update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists update_waitlist_updated_at on public.waitlist_signups;
create trigger update_waitlist_updated_at
    before update on public.waitlist_signups
    for each row
    execute function public.update_updated_at_column();

alter table public.waitlist_signups enable row level security;

drop policy if exists "Public waitlist insert" on public.waitlist_signups;
create policy "Public waitlist insert"
    on public.waitlist_signups
    for insert
    to anon, authenticated
    with check (
        workshop_slug is not null
        and email is not null
        and whatsapp_number is not null
    );

drop policy if exists "Authenticated admin read" on public.waitlist_signups;
create policy "Authenticated admin read"
    on public.waitlist_signups
    for select
    to authenticated
    using (true);

drop policy if exists "Authenticated admin update" on public.waitlist_signups;
create policy "Authenticated admin update"
    on public.waitlist_signups
    for update
    to authenticated
    using (true)
    with check (true);

-- Recommended hardening after you create the admin user:
-- 1. Create a Supabase Auth user for the workshop owner/admin.
-- 2. Replace the two authenticated policies above with policies restricted to that auth.uid().
-- 3. Keep anonymous users limited to insert only.

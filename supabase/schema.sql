-- Kinfolk family chat schema. Run this in Supabase SQL Editor as project owner.
-- This application stores messages in Postgres. No client delete policy is created.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  role text not null default 'member' check (role in ('owner','member')),
  status text not null default 'invited' check (status in ('invited','active')),
  created_at timestamptz not null default now()
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  contact_member_id uuid not null references public.family_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(owner_id, contact_member_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete restrict,
  recipient_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);
create index if not exists messages_pair_created_idx on public.messages(sender_id, recipient_id, created_at);
create index if not exists messages_recipient_created_idx on public.messages(recipient_id, created_at);

create or replace function private.current_family_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select fm.family_id from public.family_members fm
  where fm.auth_user_id = (select auth.uid()) and fm.status = 'active' limit 1;
$$;

create or replace function private.can_read_message(p_sender uuid, p_recipient uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.family_members sender
    join public.family_members recipient on recipient.family_id = sender.family_id
    join public.contacts c on c.owner_id = p_sender and c.contact_member_id = recipient.id
    where sender.auth_user_id = p_sender and sender.status = 'active'
      and recipient.auth_user_id = p_recipient and recipient.status = 'active'
      and (p_sender = (select auth.uid()) or p_recipient = (select auth.uid()))
  );
$$;

revoke all on function private.current_family_id() from public, anon;
revoke all on function private.can_read_message(uuid,uuid) from public, anon;
grant execute on function private.current_family_id() to authenticated;
grant execute on function private.can_read_message(uuid,uuid) to authenticated;

create or replace function public.claim_family_invite(p_display_name text default '')
returns public.family_members language plpgsql security definer set search_path = '' as $$
declare v_phone text := (select auth.jwt() ->> 'phone'); v_uid uuid := (select auth.uid()); v_member public.family_members; v_family uuid;
begin
  if v_uid is null or v_phone is null then raise exception 'Verify your phone number first.'; end if;
  if v_phone !~ '^\+91[6-9][0-9]{9}$' then raise exception 'Use a valid Indian mobile number with +91.'; end if;
  select * into v_member from public.family_members where auth_user_id = v_uid and status = 'active' limit 1;
  if found then return v_member; end if;
  update public.family_members
    set auth_user_id = v_uid, status = 'active',
        display_name = coalesce(nullif(trim(p_display_name), ''), display_name)
    where phone_e164 = v_phone and status = 'invited' and auth_user_id is null
    returning * into v_member;
  if not found then
    -- The first verified member creates an unowned family space. This lock
    -- prevents two first-time sign-ins from creating two spaces concurrently.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kinfolk:first-family'));
    select * into v_member from public.family_members where auth_user_id = v_uid and status = 'active' limit 1;
    if found then return v_member; end if;
    if exists (select 1 from public.families) then
      raise exception 'This number has not been added to the family yet. Ask a family member to add it.';
    end if;
    insert into public.families(name) values ('Our Family') returning id into v_family;
    insert into public.family_members(family_id, auth_user_id, phone_e164, display_name, role, status)
    values (v_family, v_uid, v_phone,
      coalesce(nullif(trim(p_display_name), ''), 'Family member'), 'member', 'active')
    returning * into v_member;
  end if;
  -- Anyone who invited this number gets a reciprocal contact after verification,
  -- so either person can see and reply to the conversation.
  insert into public.contacts(owner_id, contact_member_id)
    select v_uid, invited_by.id
    from public.contacts c
    join public.family_members invited_by on invited_by.auth_user_id = c.owner_id
    where c.contact_member_id = v_member.id and c.owner_id <> v_uid
  on conflict do nothing;
  return v_member;
end;
$$;

create or replace function public.add_family_contact(p_phone_e164 text, p_display_name text)
returns public.family_members language plpgsql security definer set search_path = '' as $$
declare v_family uuid := private.current_family_id(); v_uid uuid := (select auth.uid()); v_member public.family_members;
begin
  if v_uid is null or v_family is null then raise exception 'Only a family member can add contacts.'; end if;
  if p_phone_e164 !~ '^\+91[6-9][0-9]{9}$' then raise exception 'Enter a valid Indian mobile number with +91.'; end if;
  if length(trim(coalesce(p_display_name,''))) not between 1 and 80 then raise exception 'Enter their name.'; end if;
  select * into v_member from public.family_members where family_id = v_family and phone_e164 = p_phone_e164 limit 1;
  if not found then
    insert into public.family_members(family_id, phone_e164, display_name, role, status)
    values(v_family, p_phone_e164, trim(p_display_name), 'member', 'invited') returning * into v_member;
  end if;
  if v_member.auth_user_id = v_uid then raise exception 'You cannot add yourself.'; end if;
  insert into public.contacts(owner_id, contact_member_id) values(v_uid, v_member.id) on conflict do nothing;
  if v_member.auth_user_id is not null then
    insert into public.contacts(owner_id, contact_member_id)
      select v_member.auth_user_id, me.id from public.family_members me where me.auth_user_id = v_uid
    on conflict do nothing;
  end if;
  return v_member;
end;
$$;

revoke all on function public.claim_family_invite(text) from public, anon;
revoke all on function public.add_family_contact(text,text) from public, anon;
grant execute on function public.claim_family_invite(text) to authenticated;
grant execute on function public.add_family_contact(text,text) to authenticated;

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;

drop policy if exists family_read on public.families;
create policy family_read on public.families for select to authenticated
  using (id = private.current_family_id());

drop policy if exists members_read on public.family_members;
create policy members_read on public.family_members for select to authenticated
  using (family_id = private.current_family_id());

drop policy if exists contacts_read_own on public.contacts;
create policy contacts_read_own on public.contacts for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists messages_read_contact on public.messages;
create policy messages_read_contact on public.messages for select to authenticated
  using (private.can_read_message(sender_id, recipient_id));

drop policy if exists messages_send_to_contact on public.messages;
create policy messages_send_to_contact on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.can_read_message(sender_id, recipient_id));

grant select on public.families, public.family_members, public.contacts, public.messages to authenticated;
revoke insert, update, delete on public.families, public.family_members, public.contacts, public.messages from authenticated;
grant insert on public.messages to authenticated;
revoke all on public.families, public.family_members, public.contacts, public.messages from anon;
revoke update, delete on public.families, public.family_members, public.contacts, public.messages from authenticated;

-- Make saved message inserts available to Supabase Realtime.
do $$ begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;

-- The first verified Indian mobile number creates the unowned family space.

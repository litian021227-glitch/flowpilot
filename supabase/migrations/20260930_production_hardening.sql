-- FlowPilot production hardening migration.
-- Review and run this migration in Supabase SQL Editor after a backup.

alter table if exists public.tasks add column if not exists idempotency_key text;
alter table if exists public.tasks drop constraint if exists tasks_status_check;
alter table if exists public.tasks add constraint tasks_status_check
  check (status in ('pending', 'running', 'approval', 'completed', 'failed', 'cancelled'));
create unique index if not exists tasks_workspace_idempotency_key_uidx
  on public.tasks(workspace_id, idempotency_key)
  where idempotency_key is not null;

alter table if exists public.workspace_invitations add column if not exists token_hash text;
alter table if exists public.workspace_invitations add column if not exists accepted_at timestamptz;
alter table if exists public.workspace_invitations add column if not exists revoked_at timestamptz;
create unique index if not exists workspace_invitations_token_hash_uidx
  on public.workspace_invitations(token_hash)
  where token_hash is not null;

alter table if exists public.knowledge_documents add column if not exists owner_id uuid references auth.users(id) on delete set null;
alter table if exists public.knowledge_documents add column if not exists file_name text;
alter table if exists public.knowledge_documents add column if not exists storage_path text;
alter table if exists public.knowledge_documents add column if not exists mime_type text;
alter table if exists public.knowledge_documents add column if not exists file_size_bytes bigint;
alter table if exists public.knowledge_documents add column if not exists sha256 text;
alter table if exists public.knowledge_documents add column if not exists status text not null default 'indexed';
alter table if exists public.knowledge_documents add column if not exists error_message text;
alter table if exists public.knowledge_documents add column if not exists indexed_at timestamptz;
alter table if exists public.integrations drop constraint if exists integrations_status_check;
alter table if exists public.integrations add constraint integrations_status_check
  check (status in ('disabled', 'pending', 'connected', 'error'));
alter table if exists public.knowledge_documents drop constraint if exists knowledge_documents_status_check;
alter table if exists public.knowledge_documents add constraint knowledge_documents_status_check
  check (status in ('uploaded', 'processing', 'indexed', 'failed', 'deleted'));
create index if not exists knowledge_documents_workspace_status_idx
  on public.knowledge_documents(workspace_id, status, created_at desc);
create unique index if not exists knowledge_documents_workspace_sha256_uidx
  on public.knowledge_documents(workspace_id, sha256)
  where sha256 is not null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
for each row execute function public.set_updated_at();
drop trigger if exists integrations_set_updated_at on public.integrations;
create trigger integrations_set_updated_at before update on public.integrations
for each row execute function public.set_updated_at();
drop trigger if exists workspace_settings_set_updated_at on public.workspace_settings;
create trigger workspace_settings_set_updated_at before update on public.workspace_settings
for each row execute function public.set_updated_at();

create or replace function public.is_workspace_member(target_workspace uuid, target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace and user_id = target_user
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[], target_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = target_user
      and role = any(allowed_roles)
  );
$$;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.tasks enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.agent_runs enable row level security;
alter table public.approval_requests enable row level security;
alter table public.audit_events enable row level security;
alter table public.integrations enable row level security;
alter table public.workspace_settings enable row level security;

drop policy if exists "authenticated users can read workspaces" on public.workspaces;
create policy "members can read workspaces" on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

drop policy if exists "members can read workspace membership" on public.workspace_members;
create policy "members can read workspace membership" on public.workspace_members for select to authenticated
using (user_id = auth.uid() or public.has_workspace_role(workspace_id, array['owner', 'admin']));
drop policy if exists "admins can manage workspace membership" on public.workspace_members;
create policy "admins can manage workspace membership" on public.workspace_members for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "admins can manage invitations" on public.workspace_invitations;
create policy "admins can manage invitations" on public.workspace_invitations for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "authenticated users can read tasks" on public.tasks;
create policy "members can read tasks" on public.tasks for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "authenticated users can write tasks" on public.tasks;
create policy "members can write tasks" on public.tasks for insert to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'member']));
drop policy if exists "authenticated users can update tasks" on public.tasks;
create policy "members can update tasks" on public.tasks for update to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin', 'member']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'member']));

drop policy if exists "authenticated users can read knowledge documents" on public.knowledge_documents;
create policy "members can read knowledge documents" on public.knowledge_documents for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "members can write knowledge documents" on public.knowledge_documents;
create policy "members can write knowledge documents" on public.knowledge_documents for insert to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin', 'member']));
drop policy if exists "admins can delete knowledge documents" on public.knowledge_documents;
create policy "admins can delete knowledge documents" on public.knowledge_documents for delete to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "authenticated users can read knowledge chunks" on public.knowledge_chunks;
create policy "members can read knowledge chunks" on public.knowledge_chunks for select to authenticated
using (exists (
  select 1 from public.knowledge_documents document
  where document.id = knowledge_chunks.document_id and public.is_workspace_member(document.workspace_id)
));

drop policy if exists "authenticated users can read agent runs" on public.agent_runs;
create policy "members can read agent runs" on public.agent_runs for select to authenticated
using (exists (
  select 1 from public.tasks task
  where task.id = agent_runs.task_id and public.is_workspace_member(task.workspace_id)
));

drop policy if exists "authenticated users can read approvals" on public.approval_requests;
create policy "members can read approvals" on public.approval_requests for select to authenticated
using (exists (
  select 1 from public.tasks task
  where task.id = approval_requests.task_id and public.is_workspace_member(task.workspace_id)
));
drop policy if exists "authenticated users can update approvals" on public.approval_requests;
create policy "members can update approvals" on public.approval_requests for update to authenticated
using (exists (
  select 1 from public.tasks task
  where task.id = approval_requests.task_id and public.has_workspace_role(task.workspace_id, array['owner', 'admin', 'member'])
))
with check (status in ('pending', 'approved', 'rejected'));

drop policy if exists "authenticated users can read audit events" on public.audit_events;
create policy "members can read audit events" on public.audit_events for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "members can read integrations" on public.integrations;
create policy "members can read integrations" on public.integrations for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "admins can manage integrations" on public.integrations;
create policy "admins can manage integrations" on public.integrations for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "members can read settings" on public.workspace_settings;
create policy "members can read settings" on public.workspace_settings for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "admins can manage settings" on public.workspace_settings;
create policy "admins can manage settings" on public.workspace_settings for all to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

-- Storage setup is intentionally manual because bucket policies depend on the deployment owner.
-- Create a private bucket named flowpilot-knowledge before enabling file upload in production.

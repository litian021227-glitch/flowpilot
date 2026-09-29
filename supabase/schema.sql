create extension if not exists vector with schema extensions;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'expired', 'revoked')),
  token_hash text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'approval', 'completed', 'failed', 'cancelled')),
  idempotency_key text,
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  source_type text not null default 'upload',
  owner_id uuid references auth.users(id) on delete set null,
  file_name text,
  storage_path text,
  mime_type text,
  file_size_bytes bigint,
  sha256 text,
  status text not null default 'indexed' check (status in ('uploaded', 'processing', 'indexed', 'failed', 'deleted')),
  error_message text,
  indexed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  status text not null default 'running',
  model text,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  name text not null,
  status text not null default 'disabled' check (status in ('disabled', 'connected', 'error')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists public.workspace_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  ai_model text not null default 'gpt-4.1-mini',
  approval_required boolean not null default true,
  max_concurrent_runs integer not null default 3 check (max_concurrent_runs between 1 and 20),
  updated_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_document_id_idx on public.knowledge_chunks(document_id);
create index if not exists tasks_workspace_status_idx on public.tasks(workspace_id, status, updated_at desc);
create index if not exists agent_runs_task_id_idx on public.agent_runs(task_id, started_at desc);
create index if not exists approval_requests_status_idx on public.approval_requests(status, created_at desc);
create index if not exists audit_events_workspace_created_idx on public.audit_events(workspace_id, created_at desc);
create index if not exists workspace_members_user_workspace_idx on public.workspace_members(user_id, workspace_id);
create index if not exists workspace_invitations_workspace_status_idx on public.workspace_invitations(workspace_id, status, created_at desc);
create unique index if not exists tasks_workspace_idempotency_key_uidx on public.tasks(workspace_id, idempotency_key) where idempotency_key is not null;
create unique index if not exists workspace_invitations_token_hash_uidx on public.workspace_invitations(token_hash) where token_hash is not null;
create index if not exists knowledge_documents_workspace_status_idx on public.knowledge_documents(workspace_id, status, created_at desc);
create unique index if not exists knowledge_documents_workspace_sha256_uidx on public.knowledge_documents(workspace_id, sha256) where sha256 is not null;
create index if not exists integrations_workspace_status_idx on public.integrations(workspace_id, status);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.tasks enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.agent_runs enable row level security;
alter table public.approval_requests enable row level security;
alter table public.audit_events enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.integrations enable row level security;
alter table public.workspace_settings enable row level security;

-- Replace these demo policies with membership-based policies before production use.
drop policy if exists "authenticated users can read workspaces" on public.workspaces;
create policy "authenticated users can read workspaces" on public.workspaces for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = workspaces.id and member.user_id = auth.uid()));
drop policy if exists "members can read workspace membership" on public.workspace_members;
create policy "members can read workspace membership" on public.workspace_members for select to authenticated using (user_id = auth.uid() or exists (select 1 from public.workspace_members member where member.workspace_id = workspace_members.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin')));
drop policy if exists "admins can manage invitations" on public.workspace_invitations;
create policy "admins can manage invitations" on public.workspace_invitations for all to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = workspace_invitations.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin'))) with check (exists (select 1 from public.workspace_members member where member.workspace_id = workspace_invitations.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin')));
drop policy if exists "members can read integrations" on public.integrations;
create policy "members can read integrations" on public.integrations for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = integrations.workspace_id and member.user_id = auth.uid()));
drop policy if exists "admins can manage integrations" on public.integrations;
create policy "admins can manage integrations" on public.integrations for all to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = integrations.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin'))) with check (exists (select 1 from public.workspace_members member where member.workspace_id = integrations.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin')));
drop policy if exists "members can read settings" on public.workspace_settings;
create policy "members can read settings" on public.workspace_settings for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = workspace_settings.workspace_id and member.user_id = auth.uid()));
drop policy if exists "admins can manage settings" on public.workspace_settings;
create policy "admins can manage settings" on public.workspace_settings for all to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = workspace_settings.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin'))) with check (exists (select 1 from public.workspace_members member where member.workspace_id = workspace_settings.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin')));
drop policy if exists "authenticated users can read tasks" on public.tasks;
create policy "authenticated users can read tasks" on public.tasks for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = tasks.workspace_id and member.user_id = auth.uid()));
drop policy if exists "authenticated users can write tasks" on public.tasks;
create policy "authenticated users can write tasks" on public.tasks for insert to authenticated with check (exists (select 1 from public.workspace_members member where member.workspace_id = tasks.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin', 'member')));
drop policy if exists "authenticated users can update tasks" on public.tasks;
create policy "authenticated users can update tasks" on public.tasks for update to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = tasks.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin', 'member'))) with check (exists (select 1 from public.workspace_members member where member.workspace_id = tasks.workspace_id and member.user_id = auth.uid() and member.role in ('owner', 'admin', 'member')));
drop policy if exists "authenticated users can read knowledge documents" on public.knowledge_documents;
create policy "authenticated users can read knowledge documents" on public.knowledge_documents for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = knowledge_documents.workspace_id and member.user_id = auth.uid()));
drop policy if exists "authenticated users can read knowledge chunks" on public.knowledge_chunks;
create policy "authenticated users can read knowledge chunks" on public.knowledge_chunks for select to authenticated using (exists (select 1 from public.knowledge_documents document join public.workspace_members member on member.workspace_id = document.workspace_id where document.id = knowledge_chunks.document_id and member.user_id = auth.uid()));
drop policy if exists "authenticated users can read agent runs" on public.agent_runs;
create policy "authenticated users can read agent runs" on public.agent_runs for select to authenticated using (exists (select 1 from public.tasks task join public.workspace_members member on member.workspace_id = task.workspace_id where task.id = agent_runs.task_id and member.user_id = auth.uid()));
drop policy if exists "authenticated users can read approvals" on public.approval_requests;
create policy "authenticated users can read approvals" on public.approval_requests for select to authenticated using (exists (select 1 from public.tasks task join public.workspace_members member on member.workspace_id = task.workspace_id where task.id = approval_requests.task_id and member.user_id = auth.uid()));
drop policy if exists "authenticated users can update approvals" on public.approval_requests;
create policy "authenticated users can update approvals" on public.approval_requests for update to authenticated using (exists (select 1 from public.tasks task join public.workspace_members member on member.workspace_id = task.workspace_id where task.id = approval_requests.task_id and member.user_id = auth.uid() and member.role in ('owner', 'admin', 'member'))) with check (exists (select 1 from public.tasks task join public.workspace_members member on member.workspace_id = task.workspace_id where task.id = approval_requests.task_id and member.user_id = auth.uid() and member.role in ('owner', 'admin', 'member')));
drop policy if exists "authenticated users can read audit events" on public.audit_events;
create policy "authenticated users can read audit events" on public.audit_events for select to authenticated using (exists (select 1 from public.workspace_members member where member.workspace_id = audit_events.workspace_id and member.user_id = auth.uid()));

-- Demo seed. Run once after applying the schema, then tighten policies with workspace membership.
insert into public.workspaces (name)
select '华东销售团队'
where not exists (select 1 from public.workspaces where name = '华东销售团队');

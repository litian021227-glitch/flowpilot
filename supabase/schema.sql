create extension if not exists vector with schema extensions;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'approval', 'completed', 'failed')),
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

create index if not exists knowledge_chunks_document_id_idx on public.knowledge_chunks(document_id);
create index if not exists tasks_workspace_status_idx on public.tasks(workspace_id, status, updated_at desc);
create index if not exists agent_runs_task_id_idx on public.agent_runs(task_id, started_at desc);

alter table public.workspaces enable row level security;
alter table public.tasks enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.agent_runs enable row level security;
alter table public.approval_requests enable row level security;

-- Replace these demo policies with membership-based policies before production use.
create policy "authenticated users can read workspaces" on public.workspaces for select to authenticated using (true);
create policy "authenticated users can read tasks" on public.tasks for select to authenticated using (true);
create policy "authenticated users can write tasks" on public.tasks for insert to authenticated with check (true);
create policy "authenticated users can update tasks" on public.tasks for update to authenticated using (true) with check (true);

-- Demo seed. Run once after applying the schema, then tighten policies with workspace membership.
insert into public.workspaces (name)
select '华东销售团队'
where not exists (select 1 from public.workspaces where name = '华东销售团队');

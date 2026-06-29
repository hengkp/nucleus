create extension if not exists pgcrypto;

create table if not exists apphub_templates (
    id text primary key,
    enabled boolean not null default true,
    data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists apphub_apps (
    id uuid primary key default gen_random_uuid(),
    owner text not null,
    status text not null,
    port integer,
    route_host text,
    slurm_job_id text,
    data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists apphub_routes (
    host text primary key,
    app_id uuid references apphub_apps(id) on delete cascade,
    target_host text not null,
    target_port integer not null,
    status text not null,
    data jsonb not null,
    updated_at timestamptz not null default now()
);

create table if not exists apphub_support_threads (
    id uuid primary key default gen_random_uuid(),
    status text not null,
    data jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists apphub_audit_events (
    id uuid primary key default gen_random_uuid(),
    actor text not null,
    action text not null,
    target_type text,
    target_id text,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists apphub_apps_owner_idx on apphub_apps(owner);
create index if not exists apphub_apps_status_idx on apphub_apps(status);
create index if not exists apphub_apps_slurm_job_idx on apphub_apps(slurm_job_id);
create index if not exists apphub_routes_status_idx on apphub_routes(status);
create index if not exists apphub_support_status_idx on apphub_support_threads(status);
create index if not exists apphub_audit_created_idx on apphub_audit_events(created_at desc);

-- Cache V2 foundation. This migration is versioned but must not be applied
-- remotely as part of Stage 8A.

create extension if not exists pgcrypto;

create table if not exists public.analysis_replay (
  id uuid primary key default gen_random_uuid(),
  -- Empty string represents a request without proposalId and avoids NULL
  -- uniqueness ambiguity. It is not a person/cache identity.
  proposal_id text not null default '',
  input_hash text not null,
  rule_version text not null,
  cache_schema_version text not null,
  result_json jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint analysis_replay_identity_unique
    unique (proposal_id, input_hash, rule_version, cache_schema_version)
);

create index if not exists analysis_replay_expires_at_idx
  on public.analysis_replay (expires_at);
create index if not exists analysis_replay_proposal_id_idx
  on public.analysis_replay (proposal_id) where proposal_id <> '';

create table if not exists public.techtrail_evidence_cache (
  id uuid primary key default gen_random_uuid(),
  lookup_token text not null,
  provider text not null,
  normalized_evidence jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  provider_contract_version text not null,
  normalizer_version text not null,
  cache_schema_version text not null,
  completeness text not null check (completeness in ('COMPLETE', 'PARTIAL')),
  raw_reference text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint techtrail_evidence_identity_unique unique (
    lookup_token,
    provider,
    provider_contract_version,
    normalizer_version,
    cache_schema_version
  )
);

create index if not exists techtrail_evidence_lookup_idx
  on public.techtrail_evidence_cache (lookup_token, provider, fetched_at desc);
create index if not exists techtrail_evidence_expires_at_idx
  on public.techtrail_evidence_cache (expires_at);

create table if not exists public.imei_evidence_cache (
  id uuid primary key default gen_random_uuid(),
  lookup_token text not null,
  provider text not null,
  service text not null,
  normalized_evidence jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  provider_contract_version text not null,
  normalizer_version text not null,
  cache_schema_version text not null,
  completeness text not null check (completeness in ('COMPLETE', 'PARTIAL')),
  raw_reference text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imei_evidence_identity_unique unique (
    lookup_token,
    provider,
    service,
    provider_contract_version,
    normalizer_version,
    cache_schema_version
  )
);

create index if not exists imei_evidence_lookup_idx
  on public.imei_evidence_cache (lookup_token, provider, service, fetched_at desc);
create index if not exists imei_evidence_expires_at_idx
  on public.imei_evidence_cache (expires_at);

-- Service-role access is expected. Client roles receive no direct access.
alter table public.analysis_replay enable row level security;
alter table public.techtrail_evidence_cache enable row level security;
alter table public.imei_evidence_cache enable row level security;

revoke all on public.analysis_replay from anon, authenticated;
revoke all on public.techtrail_evidence_cache from anon, authenticated;
revoke all on public.imei_evidence_cache from anon, authenticated;

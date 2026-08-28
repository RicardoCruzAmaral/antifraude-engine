-- Cache V2 service_role CRUD validation for a CONTROLLED environment only.
-- NOT READ-ONLY. DO NOT RUN before reviewing cache_v2_postcheck.sql output.
-- Contains no credentials or personal/provider data. The transaction rolls back.

begin;
set local role service_role;

select
  '01_role' as check_group,
  current_user as effective_role,
  session_user as session_role;

-- SELECT must be permitted before synthetic writes.
select '02_select' as check_group, 'analysis_replay' as table_name, count(*) as row_count
from public.analysis_replay
union all
select '02_select', 'techtrail_evidence_cache', count(*)
from public.techtrail_evidence_cache
union all
select '02_select', 'imei_evidence_cache', count(*)
from public.imei_evidence_cache
order by table_name;

-- INSERT completely synthetic artifacts.
insert into public.analysis_replay (
  proposal_id, input_hash, rule_version, cache_schema_version, result_json,
  created_at, expires_at
) values (
  'synthetic-cache-v2-preflight-proposal',
  'synthetic-cache-v2-preflight-input-hash',
  'synthetic-cache-v2-preflight-policy',
  'cache-v2-schema-v1',
  '{"statusCode":200,"body":{"synthetic":true}}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz
) returning '03_insert' as check_group, id, proposal_id;

insert into public.techtrail_evidence_cache (
  lookup_token, provider, normalized_evidence, fetched_at, expires_at,
  provider_contract_version, normalizer_version, cache_schema_version,
  completeness, raw_reference
) values (
  'synthetic-cache-v2-preflight-techtrail-token',
  'synthetic-provider',
  '{"synthetic":true,"revision":1}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz,
  'synthetic-provider-contract-v1',
  'synthetic-normalizer-v1',
  'cache-v2-schema-v1',
  'COMPLETE',
  null
) returning '03_insert' as check_group, id, lookup_token;

insert into public.imei_evidence_cache (
  lookup_token, provider, service, normalized_evidence, fetched_at, expires_at,
  provider_contract_version, normalizer_version, cache_schema_version,
  completeness, raw_reference
) values (
  'synthetic-cache-v2-preflight-imei-token',
  'synthetic-provider',
  'synthetic-service',
  '{"synthetic":true,"revision":1}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz,
  'synthetic-provider-contract-v1',
  'synthetic-normalizer-v1',
  'cache-v2-schema-v1',
  'COMPLETE',
  null
) returning '03_insert' as check_group, id, lookup_token, service;

-- UPSERT through the same conflict identities used by the application adapters.
insert into public.analysis_replay (
  proposal_id, input_hash, rule_version, cache_schema_version, result_json,
  created_at, expires_at, updated_at
) values (
  'synthetic-cache-v2-preflight-proposal',
  'synthetic-cache-v2-preflight-input-hash',
  'synthetic-cache-v2-preflight-policy',
  'cache-v2-schema-v1',
  '{"statusCode":200,"body":{"synthetic":true,"revision":2}}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz,
  now()
)
on conflict (proposal_id, input_hash, rule_version, cache_schema_version)
do update set result_json = excluded.result_json, updated_at = excluded.updated_at
returning '04_upsert' as check_group, id, result_json;

insert into public.techtrail_evidence_cache (
  lookup_token, provider, normalized_evidence, fetched_at, expires_at,
  provider_contract_version, normalizer_version, cache_schema_version,
  completeness, raw_reference, updated_at
) values (
  'synthetic-cache-v2-preflight-techtrail-token',
  'synthetic-provider',
  '{"synthetic":true,"revision":2}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz,
  'synthetic-provider-contract-v1',
  'synthetic-normalizer-v1',
  'cache-v2-schema-v1',
  'COMPLETE',
  null,
  now()
)
on conflict (
  lookup_token, provider, provider_contract_version, normalizer_version,
  cache_schema_version
)
do update set normalized_evidence = excluded.normalized_evidence,
  updated_at = excluded.updated_at
returning '04_upsert' as check_group, id, normalized_evidence;

insert into public.imei_evidence_cache (
  lookup_token, provider, service, normalized_evidence, fetched_at, expires_at,
  provider_contract_version, normalizer_version, cache_schema_version,
  completeness, raw_reference, updated_at
) values (
  'synthetic-cache-v2-preflight-imei-token',
  'synthetic-provider',
  'synthetic-service',
  '{"synthetic":true,"revision":2}'::jsonb,
  '2099-01-01T00:00:00Z'::timestamptz,
  '2099-01-02T00:00:00Z'::timestamptz,
  'synthetic-provider-contract-v1',
  'synthetic-normalizer-v1',
  'cache-v2-schema-v1',
  'COMPLETE',
  null,
  now()
)
on conflict (
  lookup_token, provider, service, provider_contract_version,
  normalizer_version, cache_schema_version
)
do update set normalized_evidence = excluded.normalized_evidence,
  updated_at = excluded.updated_at
returning '04_upsert' as check_group, id, normalized_evidence;

-- Verify SELECT can observe the UPSERT revision.
select '05_verify_upsert' as check_group, 'analysis_replay' as table_name,
  result_json as payload
from public.analysis_replay
where proposal_id = 'synthetic-cache-v2-preflight-proposal'
union all
select '05_verify_upsert', 'techtrail_evidence_cache', normalized_evidence
from public.techtrail_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-techtrail-token'
union all
select '05_verify_upsert', 'imei_evidence_cache', normalized_evidence
from public.imei_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-imei-token'
order by table_name;

-- DELETE only the exact synthetic identities.
delete from public.analysis_replay
where proposal_id = 'synthetic-cache-v2-preflight-proposal'
  and input_hash = 'synthetic-cache-v2-preflight-input-hash'
  and rule_version = 'synthetic-cache-v2-preflight-policy'
  and cache_schema_version = 'cache-v2-schema-v1'
returning '06_delete' as check_group, id;

delete from public.techtrail_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-techtrail-token'
  and provider = 'synthetic-provider'
  and provider_contract_version = 'synthetic-provider-contract-v1'
  and normalizer_version = 'synthetic-normalizer-v1'
  and cache_schema_version = 'cache-v2-schema-v1'
returning '06_delete' as check_group, id;

delete from public.imei_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-imei-token'
  and provider = 'synthetic-provider'
  and service = 'synthetic-service'
  and provider_contract_version = 'synthetic-provider-contract-v1'
  and normalizer_version = 'synthetic-normalizer-v1'
  and cache_schema_version = 'cache-v2-schema-v1'
returning '06_delete' as check_group, id;

-- All values must be zero before the final rollback.
select '07_cleanup' as check_group, 'analysis_replay' as table_name, count(*) as remaining
from public.analysis_replay
where proposal_id = 'synthetic-cache-v2-preflight-proposal'
union all
select '07_cleanup', 'techtrail_evidence_cache', count(*)
from public.techtrail_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-techtrail-token'
union all
select '07_cleanup', 'imei_evidence_cache', count(*)
from public.imei_evidence_cache
where lookup_token = 'synthetic-cache-v2-preflight-imei-token'
order by table_name;

rollback;

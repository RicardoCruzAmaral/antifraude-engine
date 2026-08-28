-- Cache V2 controlled-environment postcheck.
-- READ-ONLY: this file intentionally contains only SELECT statements.
-- Run after 202608270001_cache_v2_foundation.sql and copy every result set.

-- 1. Extension and UUID function. Both status values must be PASS.
select
  '01_extension_and_uuid' as check_group,
  e.extversion as pgcrypto_version,
  n.nspname as extension_schema,
  pg_catalog.to_regprocedure('gen_random_uuid()')::text as function_signature,
  case when e.oid is not null then 'PASS' else 'FAIL' end as pgcrypto_status,
  case when pg_catalog.to_regprocedure('gen_random_uuid()') is not null
    then 'PASS' else 'FAIL'
  end as uuid_function_status
from (values ('pgcrypto')) as expected(extname)
left join pg_catalog.pg_extension e on e.extname = expected.extname
left join pg_catalog.pg_namespace n on n.oid = e.extnamespace;

-- 2. Target tables and RLS. Every row must be TABLE/PASS.
with targets(table_name) as (
  values
    ('analysis_replay'),
    ('techtrail_evidence_cache'),
    ('imei_evidence_cache')
)
select
  '02_tables_and_rls' as check_group,
  t.table_name,
  case when c.relkind is null then 'ABSENT' when c.relkind = 'r' then 'TABLE' else c.relkind::text end as object_kind,
  pg_catalog.pg_get_userbyid(c.relowner) as owner,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  case when c.relkind = 'r' and c.relrowsecurity then 'PASS' else 'FAIL' end as status
from targets t
left join pg_catalog.pg_namespace n on n.nspname = 'public'
left join pg_catalog.pg_class c
  on c.relnamespace = n.oid
 and c.relname = t.table_name
order by t.table_name;

-- 3. Exact expected columns, types, order and nullability.
with expected(table_name, ordinal_position, column_name, udt_name, is_nullable) as (
  values
    ('analysis_replay', 1, 'id', 'uuid', 'NO'),
    ('analysis_replay', 2, 'proposal_id', 'text', 'NO'),
    ('analysis_replay', 3, 'input_hash', 'text', 'NO'),
    ('analysis_replay', 4, 'rule_version', 'text', 'NO'),
    ('analysis_replay', 5, 'cache_schema_version', 'text', 'NO'),
    ('analysis_replay', 6, 'result_json', 'jsonb', 'NO'),
    ('analysis_replay', 7, 'created_at', 'timestamptz', 'NO'),
    ('analysis_replay', 8, 'expires_at', 'timestamptz', 'NO'),
    ('analysis_replay', 9, 'updated_at', 'timestamptz', 'NO'),
    ('techtrail_evidence_cache', 1, 'id', 'uuid', 'NO'),
    ('techtrail_evidence_cache', 2, 'lookup_token', 'text', 'NO'),
    ('techtrail_evidence_cache', 3, 'provider', 'text', 'NO'),
    ('techtrail_evidence_cache', 4, 'normalized_evidence', 'jsonb', 'NO'),
    ('techtrail_evidence_cache', 5, 'fetched_at', 'timestamptz', 'NO'),
    ('techtrail_evidence_cache', 6, 'expires_at', 'timestamptz', 'NO'),
    ('techtrail_evidence_cache', 7, 'provider_contract_version', 'text', 'NO'),
    ('techtrail_evidence_cache', 8, 'normalizer_version', 'text', 'NO'),
    ('techtrail_evidence_cache', 9, 'cache_schema_version', 'text', 'NO'),
    ('techtrail_evidence_cache', 10, 'completeness', 'text', 'NO'),
    ('techtrail_evidence_cache', 11, 'raw_reference', 'text', 'YES'),
    ('techtrail_evidence_cache', 12, 'created_at', 'timestamptz', 'NO'),
    ('techtrail_evidence_cache', 13, 'updated_at', 'timestamptz', 'NO'),
    ('imei_evidence_cache', 1, 'id', 'uuid', 'NO'),
    ('imei_evidence_cache', 2, 'lookup_token', 'text', 'NO'),
    ('imei_evidence_cache', 3, 'provider', 'text', 'NO'),
    ('imei_evidence_cache', 4, 'service', 'text', 'NO'),
    ('imei_evidence_cache', 5, 'normalized_evidence', 'jsonb', 'NO'),
    ('imei_evidence_cache', 6, 'fetched_at', 'timestamptz', 'NO'),
    ('imei_evidence_cache', 7, 'expires_at', 'timestamptz', 'NO'),
    ('imei_evidence_cache', 8, 'provider_contract_version', 'text', 'NO'),
    ('imei_evidence_cache', 9, 'normalizer_version', 'text', 'NO'),
    ('imei_evidence_cache', 10, 'cache_schema_version', 'text', 'NO'),
    ('imei_evidence_cache', 11, 'completeness', 'text', 'NO'),
    ('imei_evidence_cache', 12, 'raw_reference', 'text', 'YES'),
    ('imei_evidence_cache', 13, 'created_at', 'timestamptz', 'NO'),
    ('imei_evidence_cache', 14, 'updated_at', 'timestamptz', 'NO')
), actual as (
  select
    c.table_name,
    c.ordinal_position,
    c.column_name,
    c.udt_name,
    c.is_nullable,
    c.column_default
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name in (
      'analysis_replay',
      'techtrail_evidence_cache',
      'imei_evidence_cache'
    )
)
select
  '03_columns' as check_group,
  coalesce(e.table_name, a.table_name) as table_name,
  coalesce(e.ordinal_position, a.ordinal_position) as ordinal_position,
  coalesce(e.column_name, a.column_name) as column_name,
  e.udt_name as expected_type,
  a.udt_name as actual_type,
  e.is_nullable as expected_nullable,
  a.is_nullable as actual_nullable,
  a.column_default,
  case
    when e.table_name is null then 'UNEXPECTED_COLUMN'
    when a.table_name is null then 'MISSING_COLUMN'
    when e.ordinal_position = a.ordinal_position
     and e.udt_name = a.udt_name
     and e.is_nullable = a.is_nullable then 'PASS'
    else 'FAIL'
  end as status
from expected e
full join actual a
  on a.table_name = e.table_name
 and a.column_name = e.column_name
order by table_name, ordinal_position;

-- 4. Primary, unique and check constraints with definitions.
select
  '04_constraints' as check_group,
  rel.relname as table_name,
  con.conname as constraint_name,
  case con.contype
    when 'p' then 'PRIMARY KEY'
    when 'u' then 'UNIQUE'
    when 'c' then 'CHECK'
    when 'f' then 'FOREIGN KEY'
    else con.contype::text
  end as constraint_type,
  pg_catalog.pg_get_constraintdef(con.oid, true) as definition
from pg_catalog.pg_constraint con
join pg_catalog.pg_class rel on rel.oid = con.conrelid
join pg_catalog.pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and rel.relname in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
order by rel.relname, constraint_type, con.conname;

-- Expected constraint counts: replay 1 PK/1 UNIQUE/0 CHECK;
-- each evidence table 1 PK/1 UNIQUE/1 CHECK.
with expected(table_name, primary_keys, unique_constraints, check_constraints) as (
  values
    ('analysis_replay', 1, 1, 0),
    ('techtrail_evidence_cache', 1, 1, 1),
    ('imei_evidence_cache', 1, 1, 1)
), actual as (
  select
    rel.relname as table_name,
    count(*) filter (where con.contype = 'p')::integer as primary_keys,
    count(*) filter (where con.contype = 'u')::integer as unique_constraints,
    count(*) filter (where con.contype = 'c')::integer as check_constraints
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class rel on rel.oid = con.conrelid
  join pg_catalog.pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
    and rel.relname in (
      'analysis_replay',
      'techtrail_evidence_cache',
      'imei_evidence_cache'
    )
  group by rel.relname
)
select
  '05_constraint_summary' as check_group,
  e.table_name,
  e.primary_keys as expected_primary_keys,
  coalesce(a.primary_keys, 0) as actual_primary_keys,
  e.unique_constraints as expected_unique_constraints,
  coalesce(a.unique_constraints, 0) as actual_unique_constraints,
  e.check_constraints as expected_check_constraints,
  coalesce(a.check_constraints, 0) as actual_check_constraints,
  case
    when e.primary_keys = coalesce(a.primary_keys, 0)
     and e.unique_constraints = coalesce(a.unique_constraints, 0)
     and e.check_constraints = coalesce(a.check_constraints, 0)
      then 'PASS' else 'FAIL'
  end as status
from expected e
left join actual a using (table_name)
order by e.table_name;

-- 5. Every expected index, including indexes backing PK/UNIQUE constraints.
with expected(index_name, table_name) as (
  values
    ('analysis_replay_pkey', 'analysis_replay'),
    ('analysis_replay_identity_unique', 'analysis_replay'),
    ('analysis_replay_expires_at_idx', 'analysis_replay'),
    ('analysis_replay_proposal_id_idx', 'analysis_replay'),
    ('techtrail_evidence_cache_pkey', 'techtrail_evidence_cache'),
    ('techtrail_evidence_identity_unique', 'techtrail_evidence_cache'),
    ('techtrail_evidence_lookup_idx', 'techtrail_evidence_cache'),
    ('techtrail_evidence_expires_at_idx', 'techtrail_evidence_cache'),
    ('imei_evidence_cache_pkey', 'imei_evidence_cache'),
    ('imei_evidence_identity_unique', 'imei_evidence_cache'),
    ('imei_evidence_lookup_idx', 'imei_evidence_cache'),
    ('imei_evidence_expires_at_idx', 'imei_evidence_cache')
)
select
  '06_indexes' as check_group,
  e.table_name,
  e.index_name,
  i.indexdef,
  case when i.indexname is not null and i.tablename = e.table_name
    then 'PASS' else 'FAIL'
  end as status
from expected e
left join pg_catalog.pg_indexes i
  on i.schemaname = 'public'
 and i.indexname = e.index_name
order by e.table_name, e.index_name;

-- 6. Effective table ACL. This includes default ACL when relacl is null.
select
  '07_grants' as check_group,
  c.relname as table_name,
  case when acl.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(acl.grantee) end as grantee,
  acl.privilege_type,
  acl.is_grantable
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
cross join lateral pg_catalog.aclexplode(
  coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
) acl
where n.nspname = 'public'
  and c.relname in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
order by c.relname, grantee, acl.privilege_type;

-- 7. Security-role matrix. anon/authenticated must have no CRUD privileges.
-- service_role must have all four CRUD privileges before enabling Cache V2.
select
  '08_role_access' as check_group,
  c.relname as table_name,
  case when pg_catalog.to_regrole('anon') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('anon'), c.oid, 'SELECT') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('anon'), c.oid, 'INSERT') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('anon'), c.oid, 'UPDATE') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('anon'), c.oid, 'DELETE')
  end as anon_has_any_crud,
  case when pg_catalog.to_regrole('authenticated') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('authenticated'), c.oid, 'SELECT') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('authenticated'), c.oid, 'INSERT') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('authenticated'), c.oid, 'UPDATE') or
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('authenticated'), c.oid, 'DELETE')
  end as authenticated_has_any_crud,
  case when pg_catalog.to_regrole('service_role') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('service_role'), c.oid, 'SELECT')
  end as service_role_can_select,
  case when pg_catalog.to_regrole('service_role') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('service_role'), c.oid, 'INSERT')
  end as service_role_can_insert,
  case when pg_catalog.to_regrole('service_role') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('service_role'), c.oid, 'UPDATE')
  end as service_role_can_update,
  case when pg_catalog.to_regrole('service_role') is null then null else
    pg_catalog.has_table_privilege(pg_catalog.to_regrole('service_role'), c.oid, 'DELETE')
  end as service_role_can_delete
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
order by c.relname;

-- 8. Policies are not required for service_role because it bypasses RLS.
-- No permissive client policy is expected at this stage.
with targets(table_name) as (
  values
    ('analysis_replay'),
    ('techtrail_evidence_cache'),
    ('imei_evidence_cache')
)
select
  '09_rls_policy_summary' as check_group,
  t.table_name,
  count(p.policyname) as policy_count,
  case when count(p.policyname) = 0 then 'PASS' else 'REVIEW' end as status
from targets t
left join pg_catalog.pg_policies p
  on p.schemaname = 'public'
 and p.tablename = t.table_name
group by t.table_name
order by t.table_name;

select
  '10_rls_policy_details' as check_group,
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
order by tablename, policyname;

-- 9. Execute the UUID function last so all structural result sets remain
-- available even if this final callable check fails unexpectedly.
select
  '11_uuid_execution' as check_group,
  gen_random_uuid() is not null as callable,
  'PASS' as expected_status;

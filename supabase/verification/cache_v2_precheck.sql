-- Cache V2 controlled-environment precheck.
-- READ-ONLY: this file intentionally contains only SELECT statements.
-- Run before 202608270001_cache_v2_foundation.sql and copy every result set.

-- 1. Server/session identity and privileges useful for extension/schema work.
select
  '01_environment' as check_group,
  current_setting('server_version') as postgres_version,
  current_database() as database_name,
  current_user as current_role,
  session_user as session_role,
  current_schema() as current_schema_name,
  current_setting('search_path') as search_path,
  r.rolsuper as role_is_superuser,
  r.rolbypassrls as role_bypasses_rls,
  has_database_privilege(current_user, current_database(), 'CREATE') as can_create_in_database,
  has_schema_privilege(current_user, 'public', 'USAGE') as can_use_public_schema,
  has_schema_privilege(current_user, 'public', 'CREATE') as can_create_in_public_schema
from pg_catalog.pg_roles r
where r.rolname = current_user;

-- 2. pgcrypto and UUID function availability before migration.
select
  '02_pgcrypto' as check_group,
  e.extname,
  e.extversion,
  n.nspname as extension_schema,
  pg_catalog.to_regprocedure('gen_random_uuid()')::text as gen_random_uuid_function
from (values ('pgcrypto')) as expected(extname)
left join pg_catalog.pg_extension e on e.extname = expected.extname
left join pg_catalog.pg_namespace n on n.oid = e.extnamespace;

-- 3. Target names in public. SAFE_TO_CREATE means no object currently owns the name.
with targets(object_name) as (
  values
    ('analysis_replay'),
    ('techtrail_evidence_cache'),
    ('imei_evidence_cache')
)
select
  '03_target_relations' as check_group,
  t.object_name,
  case
    when c.relkind is null then 'ABSENT'
    when c.relkind = 'r' then 'TABLE'
    when c.relkind = 'p' then 'PARTITIONED TABLE'
    when c.relkind = 'v' then 'VIEW'
    when c.relkind = 'm' then 'MATERIALIZED VIEW'
    when c.relkind = 'S' then 'SEQUENCE'
    when c.relkind = 'i' then 'INDEX'
    else c.relkind::text
  end as actual_object_kind,
  pg_catalog.pg_get_userbyid(c.relowner) as owner,
  case when c.oid is null then 'SAFE_TO_CREATE' else 'REVIEW_EXISTING_OBJECT' end as precheck_status
from targets t
left join pg_catalog.pg_namespace n on n.nspname = 'public'
left join pg_catalog.pg_class c
  on c.relnamespace = n.oid
 and c.relname = t.object_name
order by t.object_name;

-- 4. Existing columns, if a target table already exists.
select
  '04_existing_columns' as check_group,
  c.table_schema,
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
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
order by c.table_name, c.ordinal_position;

-- 5. Existing constraints, if a target table already exists.
select
  '05_existing_constraints' as check_group,
  n.nspname as table_schema,
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

-- 6. Existing indexes on target tables.
select
  '06_existing_target_indexes' as check_group,
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_catalog.pg_indexes
where schemaname = 'public'
  and tablename in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
order by tablename, indexname;

-- 7. Index-name conflicts that could make CREATE INDEX IF NOT EXISTS skip
-- the intended index on a different relation.
with expected_indexes(index_name, expected_table) as (
  values
    ('analysis_replay_expires_at_idx', 'analysis_replay'),
    ('analysis_replay_proposal_id_idx', 'analysis_replay'),
    ('techtrail_evidence_lookup_idx', 'techtrail_evidence_cache'),
    ('techtrail_evidence_expires_at_idx', 'techtrail_evidence_cache'),
    ('imei_evidence_lookup_idx', 'imei_evidence_cache'),
    ('imei_evidence_expires_at_idx', 'imei_evidence_cache')
)
select
  '07_index_name_conflicts' as check_group,
  e.index_name,
  e.expected_table,
  actual_table.relname as actual_table,
  case
    when index_rel.oid is null then 'SAFE_TO_CREATE'
    when actual_table.relname = e.expected_table then 'REVIEW_EXISTING_INDEX'
    else 'NAME_CONFLICT'
  end as precheck_status
from expected_indexes e
left join pg_catalog.pg_namespace n on n.nspname = 'public'
left join pg_catalog.pg_class index_rel
  on index_rel.relnamespace = n.oid
 and index_rel.relname = e.index_name
 and index_rel.relkind = 'i'
left join pg_catalog.pg_index i on i.indexrelid = index_rel.oid
left join pg_catalog.pg_class actual_table on actual_table.oid = i.indrelid
order by e.index_name;

-- 8. Existing RLS state and policies, if target tables already exist.
select
  '08_existing_rls' as check_group,
  n.nspname as table_schema,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  count(p.policyname) as policy_count
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_policies p
  on p.schemaname = n.nspname
 and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname in (
    'analysis_replay',
    'techtrail_evidence_cache',
    'imei_evidence_cache'
  )
group by n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
order by c.relname;

-- Narrow SECURITY DEFINER boundary for Community runtime-only DDL.
-- Every public callable accepts domain identifiers, never raw SQL or raw names.

GRANT USAGE ON SCHEMA tabtin_capability
  TO tabtin_native_ddl_owner, tabtin_record_index_owner,
     tabtin_readonly_role_admin, tabtin_runtime;
GRANT USAGE ON SCHEMA public
  TO tabtin_native_ddl_owner, tabtin_record_index_owner,
     tabtin_readonly_role_admin;
GRANT CREATE ON SCHEMA public TO tabtin_record_index_owner;

GRANT SELECT (id, organization_id, space_id)
  ON public.tabdata_table
  TO tabtin_native_ddl_owner, tabtin_record_index_owner,
     tabtin_readonly_role_admin;
GRANT SELECT (id, table_id, is_deleted)
  ON public.tabdata_field
  TO tabtin_native_ddl_owner, tabtin_record_index_owner;
GRANT SELECT (space_id, pg_role, pg_schema)
  ON public.tabdata_db_readonly_connection
  TO tabtin_readonly_role_admin;

CREATE OR REPLACE FUNCTION tabtin_capability._assert_native_target(
  p_partition_id UUID,
  p_table_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tabdata_table AS target
    WHERE target.id = p_table_id
      AND (
        target.space_id = p_partition_id
        OR (target.space_id IS NULL AND target.organization_id = p_partition_id)
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'TABTIN_COMMUNITY_NATIVE_TARGET_DENIED';
  END IF;
END
$function$;
ALTER FUNCTION tabtin_capability._assert_native_target(UUID, UUID)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability._assert_native_field_target(
  p_table_id UUID,
  p_field_id UUID,
  p_allow_deleted BOOLEAN
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tabdata_field AS target
    WHERE target.id = p_field_id
      AND target.table_id = p_table_id
      AND (p_allow_deleted OR target.is_deleted = false)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'TABTIN_COMMUNITY_NATIVE_FIELD_DENIED';
  END IF;
END
$function$;
ALTER FUNCTION tabtin_capability._assert_native_field_target(UUID, UUID, BOOLEAN)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.native_ensure_schema(
  p_partition_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tabdata_table AS target
    WHERE target.space_id = p_partition_id
      OR (target.space_id IS NULL AND target.organization_id = p_partition_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'TABTIN_COMMUNITY_NATIVE_PARTITION_DENIED';
  END IF;
  EXECUTE pg_catalog.format(
    'CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION tabtin_native_ddl_owner',
    schema_name
  );
  EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', schema_name);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO tabtin_runtime', schema_name);
  EXECUTE pg_catalog.format(
    'GRANT USAGE ON SCHEMA %I TO tabtin_readonly_role_admin WITH GRANT OPTION',
    schema_name
  );
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_ensure_schema(UUID)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability._native_column_definition(
  p_pg_type TEXT,
  p_default_kind TEXT
) RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  column_definition TEXT;
BEGIN
  column_definition := CASE pg_catalog.upper(p_pg_type)
    WHEN 'TEXT' THEN 'TEXT'
    WHEN 'DOUBLE PRECISION' THEN 'DOUBLE PRECISION'
    WHEN 'INTEGER' THEN 'INTEGER'
    WHEN 'BOOLEAN' THEN 'BOOLEAN'
    WHEN 'DATE' THEN 'DATE'
    WHEN 'TIMESTAMPTZ' THEN 'TIMESTAMPTZ'
    WHEN 'JSONB' THEN 'JSONB'
    ELSE NULL
  END;
  IF column_definition IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_FIELD_TYPE_DENIED';
  END IF;
  column_definition := column_definition || CASE p_default_kind
    WHEN 'none' THEN ''
    WHEN 'false' THEN ' DEFAULT false'
    WHEN 'empty_json_array' THEN ' DEFAULT ''[]''::pg_catalog.jsonb'
    ELSE NULL
  END;
  IF column_definition IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_FIELD_DEFAULT_DENIED';
  END IF;
  RETURN column_definition;
END
$function$;
ALTER FUNCTION tabtin_capability._native_column_definition(TEXT, TEXT)
  OWNER TO tabtin_native_ddl_owner;

DROP FUNCTION IF EXISTS tabtin_capability.native_create_table(UUID, UUID);

CREATE OR REPLACE FUNCTION tabtin_capability.native_create_table(
  p_partition_id UUID,
  p_table_id UUID,
  p_field_specs JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
  table_name TEXT := 'tbl_' || pg_catalog.replace(p_table_id::text, '-', '');
  readonly_role TEXT := 'ro_as_' || pg_catalog.substr(
    pg_catalog.replace(p_partition_id::text, '-', ''), 1, 16
  );
  field_spec JSONB;
  field_id UUID;
  pg_type TEXT;
  default_kind TEXT;
  column_definition TEXT;
  column_name TEXT;
BEGIN
  PERFORM tabtin_capability._assert_native_target(p_partition_id, p_table_id);
  IF pg_catalog.jsonb_typeof(p_field_specs) <> 'array'
    OR pg_catalog.jsonb_array_length(p_field_specs) > 500
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'TABTIN_COMMUNITY_FIELD_SPECS_DENIED';
  END IF;
  PERFORM tabtin_capability.native_ensure_schema(p_partition_id);
  EXECUTE pg_catalog.format(
    'CREATE TABLE IF NOT EXISTS %I.%I ('
    '__id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),'
    '__auto_number SERIAL,'
    '__order DOUBLE PRECISION DEFAULT 0,'
    '__version INTEGER NOT NULL DEFAULT 1,'
    '__created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),'
    '__updated_at TIMESTAMPTZ,'
    '__created_by UUID,'
    '__updated_by UUID) ',
    schema_name,
    table_name
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I OWNER TO tabtin_native_ddl_owner',
    schema_name,
    table_name
  );
  EXECUTE pg_catalog.format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO tabtin_runtime',
    schema_name,
    table_name
  );
  EXECUTE pg_catalog.format(
    'GRANT SELECT ON TABLE %I.%I TO tabtin_readonly_role_admin WITH GRANT OPTION',
    schema_name,
    table_name
  );
  EXECUTE pg_catalog.format(
    'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO tabtin_runtime',
    schema_name
  );
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = readonly_role) THEN
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, readonly_role);
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE %I.%I TO %I',
      schema_name,
      table_name,
      readonly_role
    );
  END IF;
  FOR field_spec IN SELECT value FROM pg_catalog.jsonb_array_elements(p_field_specs)
  LOOP
    IF pg_catalog.jsonb_typeof(field_spec) <> 'object'
      OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(field_spec)) <> 3
      OR NOT (field_spec ?& ARRAY['field_id', 'pg_type', 'default_kind'])
      OR pg_catalog.jsonb_typeof(field_spec->'field_id') <> 'string'
      OR pg_catalog.jsonb_typeof(field_spec->'pg_type') <> 'string'
      OR pg_catalog.jsonb_typeof(field_spec->'default_kind') <> 'string'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'TABTIN_COMMUNITY_FIELD_SPEC_DENIED';
    END IF;
    BEGIN
      field_id := (field_spec->>'field_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'TABTIN_COMMUNITY_FIELD_SPEC_DENIED';
    END;
    PERFORM tabtin_capability._assert_native_field_target(
      p_table_id,
      field_id,
      false
    );
    pg_type := field_spec->>'pg_type';
    default_kind := field_spec->>'default_kind';
    column_name := pg_catalog.replace(field_id::text, '-', '');
    column_definition := tabtin_capability._native_column_definition(
      pg_type,
      default_kind
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS %I %s',
      schema_name,
      table_name,
      column_name,
      column_definition
    );
  END LOOP;
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_create_table(UUID, UUID, JSONB)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.native_drop_table(
  p_partition_id UUID,
  p_table_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
  table_name TEXT := 'tbl_' || pg_catalog.replace(p_table_id::text, '-', '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tabdata_table AS target
    WHERE target.id = p_table_id
      AND (
        target.space_id = p_partition_id
        OR (target.space_id IS NULL AND target.organization_id = p_partition_id)
      )
  ) THEN
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', schema_name, table_name)) IS NULL THEN
      RETURN FALSE;
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'TABTIN_COMMUNITY_NATIVE_DROP_DENIED';
  END IF;
  EXECUTE pg_catalog.format('DROP TABLE IF EXISTS %I.%I CASCADE', schema_name, table_name);
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_drop_table(UUID, UUID)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.native_add_column(
  p_partition_id UUID,
  p_table_id UUID,
  p_field_id UUID,
  p_pg_type TEXT,
  p_default_kind TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
  table_name TEXT := 'tbl_' || pg_catalog.replace(p_table_id::text, '-', '');
  column_name TEXT := pg_catalog.replace(p_field_id::text, '-', '');
  column_definition TEXT;
BEGIN
  PERFORM tabtin_capability._assert_native_target(p_partition_id, p_table_id);
  PERFORM tabtin_capability._assert_native_field_target(
    p_table_id,
    p_field_id,
    false
  );
  column_definition := tabtin_capability._native_column_definition(
    p_pg_type,
    p_default_kind
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS %I %s',
    schema_name,
    table_name,
    column_name,
    column_definition
  );
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_add_column(UUID, UUID, UUID, TEXT, TEXT)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.native_drop_column(
  p_partition_id UUID,
  p_table_id UUID,
  p_field_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
  table_name TEXT := 'tbl_' || pg_catalog.replace(p_table_id::text, '-', '');
  column_name TEXT := pg_catalog.replace(p_field_id::text, '-', '');
BEGIN
  PERFORM tabtin_capability._assert_native_target(p_partition_id, p_table_id);
  -- Field metadata is commonly soft-deleted before physical column cleanup.
  PERFORM tabtin_capability._assert_native_field_target(
    p_table_id,
    p_field_id,
    true
  );
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I DROP COLUMN IF EXISTS %I CASCADE',
    schema_name,
    table_name,
    column_name
  );
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_drop_column(UUID, UUID, UUID)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.native_alter_column_type(
  p_partition_id UUID,
  p_table_id UUID,
  p_field_id UUID,
  p_target_type TEXT,
  p_timezone TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_schema_name TEXT := 'as_' || pg_catalog.replace(p_partition_id::text, '-', '');
  v_table_name TEXT := 'tbl_' || pg_catalog.replace(p_table_id::text, '-', '');
  v_column_name TEXT := pg_catalog.replace(p_field_id::text, '-', '');
  source_type TEXT;
  target_type TEXT;
  using_expression TEXT;
BEGIN
  PERFORM tabtin_capability._assert_native_target(p_partition_id, p_table_id);
  PERFORM tabtin_capability._assert_native_field_target(
    p_table_id,
    p_field_id,
    false
  );
  target_type := CASE pg_catalog.upper(p_target_type)
    WHEN 'TEXT' THEN 'TEXT'
    WHEN 'DOUBLE PRECISION' THEN 'DOUBLE PRECISION'
    WHEN 'INTEGER' THEN 'INTEGER'
    WHEN 'BOOLEAN' THEN 'BOOLEAN'
    WHEN 'DATE' THEN 'DATE'
    WHEN 'TIMESTAMPTZ' THEN 'TIMESTAMPTZ'
    WHEN 'JSONB' THEN 'JSONB'
    ELSE NULL
  END;
  IF target_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_FIELD_TYPE_DENIED';
  END IF;
  IF p_timezone IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_timezone
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_TIMEZONE_DENIED';
  END IF;
  SELECT CASE pg_catalog.lower(data_type)
    WHEN 'text' THEN 'TEXT'
    WHEN 'double precision' THEN 'DOUBLE PRECISION'
    WHEN 'integer' THEN 'INTEGER'
    WHEN 'boolean' THEN 'BOOLEAN'
    WHEN 'date' THEN 'DATE'
    WHEN 'timestamp with time zone' THEN 'TIMESTAMPTZ'
    WHEN 'jsonb' THEN 'JSONB'
    ELSE pg_catalog.upper(data_type)
  END
  INTO source_type
  FROM information_schema.columns AS physical_column
  WHERE physical_column.table_schema = v_schema_name
    AND physical_column.table_name = v_table_name
    AND physical_column.column_name = v_column_name;
  IF source_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = 'TABTIN_COMMUNITY_FIELD_COLUMN_MISSING';
  END IF;
  IF source_type = target_type THEN
    RETURN FALSE;
  END IF;
  using_expression := CASE
    WHEN source_type = 'TEXT' AND target_type = 'DOUBLE PRECISION'
      THEN pg_catalog.format('NULLIF(pg_catalog.btrim(%I), '''')::DOUBLE PRECISION', v_column_name)
    WHEN source_type = 'TEXT' AND target_type = 'INTEGER'
      THEN pg_catalog.format('NULLIF(pg_catalog.btrim(%I), '''')::INTEGER', v_column_name)
    WHEN source_type = 'TEXT' AND target_type = 'BOOLEAN'
      THEN pg_catalog.format(
        'CASE pg_catalog.lower(pg_catalog.btrim(%I)) WHEN ''true'' THEN true WHEN ''1'' THEN true WHEN ''yes'' THEN true ELSE false END',
        v_column_name
      )
    WHEN source_type = 'TEXT' AND target_type = 'JSONB'
      THEN pg_catalog.format('pg_catalog.to_jsonb(%I)', v_column_name)
    WHEN source_type = 'DATE' AND target_type = 'TIMESTAMPTZ' AND p_timezone IS NOT NULL
      THEN pg_catalog.format('%I::TIMESTAMP AT TIME ZONE %L', v_column_name, p_timezone)
    WHEN source_type = 'TIMESTAMPTZ' AND target_type = 'DATE' AND p_timezone IS NOT NULL
      THEN pg_catalog.format('(%I AT TIME ZONE %L)::DATE', v_column_name, p_timezone)
    WHEN source_type = 'BOOLEAN' AND target_type = 'TEXT'
      THEN pg_catalog.format('CASE WHEN %I THEN ''true'' ELSE ''false'' END', v_column_name)
    ELSE pg_catalog.format('%I::%s', v_column_name, target_type)
  END;
  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I ALTER COLUMN %I TYPE %s USING %s',
    v_schema_name,
    v_table_name,
    v_column_name,
    target_type,
    using_expression
  );
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.native_alter_column_type(UUID, UUID, UUID, TEXT, TEXT)
  OWNER TO tabtin_native_ddl_owner;

CREATE OR REPLACE FUNCTION tabtin_capability._assert_record_index_target(
  p_table_id UUID,
  p_field_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tabdata_table WHERE id = p_table_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.tabdata_field
      WHERE id = p_field_id AND table_id = p_table_id AND is_deleted = false
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_INDEX_TARGET_DENIED';
  END IF;
END
$function$;
ALTER FUNCTION tabtin_capability._assert_record_index_target(UUID, UUID)
  OWNER TO tabtin_record_index_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.record_create_search_index(
  p_table_id UUID,
  p_field_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  index_name TEXT := 'idx_tt_s_'
    || pg_catalog.substr(pg_catalog.replace(p_table_id::text, '-', ''), 1, 16)
    || '_'
    || pg_catalog.substr(pg_catalog.replace(p_field_id::text, '-', ''), 1, 16);
BEGIN
  PERFORM tabtin_capability._assert_record_index_target(p_table_id, p_field_id);
  PERFORM pg_catalog.set_config('lock_timeout', '1500ms', true);
  PERFORM pg_catalog.set_config('statement_timeout', '5000ms', true);
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS %I ON public.tabdata_record USING gin '
    '((COALESCE(data->>%L, '''')) public.gin_trgm_ops) '
    'WHERE table_id = %L::uuid AND is_deleted = false',
    index_name,
    p_field_id::text,
    p_table_id::text
  );
  RETURN TRUE;
EXCEPTION
  WHEN lock_not_available OR query_canceled THEN
    RETURN FALSE;
END
$function$;
ALTER FUNCTION tabtin_capability.record_create_search_index(UUID, UUID)
  OWNER TO tabtin_record_index_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.record_drop_search_index(
  p_table_id UUID,
  p_field_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  index_name TEXT := 'idx_tt_s_'
    || pg_catalog.substr(pg_catalog.replace(p_table_id::text, '-', ''), 1, 16)
    || '_'
    || pg_catalog.substr(pg_catalog.replace(p_field_id::text, '-', ''), 1, 16);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tabdata_table WHERE id = p_table_id) THEN
    IF pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(index_name)) IS NULL THEN
      RETURN FALSE;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_INDEX_DROP_DENIED';
  END IF;
  EXECUTE pg_catalog.format('DROP INDEX IF EXISTS public.%I', index_name);
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.record_drop_search_index(UUID, UUID)
  OWNER TO tabtin_record_index_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.record_drop_search_indexes(
  p_table_id UUID
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  index_row RECORD;
  index_prefix TEXT := 'idx_tt_s_'
    || pg_catalog.substr(pg_catalog.replace(p_table_id::text, '-', ''), 1, 16)
    || '_';
  dropped_count INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tabdata_table WHERE id = p_table_id) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname LIKE index_prefix || '%'
    ) THEN
      RETURN 0;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_INDEX_DROP_DENIED';
  END IF;
  FOR index_row IN
    SELECT c.relname
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'i'
      AND c.relname LIKE index_prefix || '%'
  LOOP
    EXECUTE pg_catalog.format('DROP INDEX public.%I', index_row.relname);
    dropped_count := dropped_count + 1;
  END LOOP;
  RETURN dropped_count;
END
$function$;
ALTER FUNCTION tabtin_capability.record_drop_search_indexes(UUID)
  OWNER TO tabtin_record_index_owner;

CREATE OR REPLACE FUNCTION tabtin_capability.record_create_sort_index(
  p_table_id UUID,
  p_field_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  index_name TEXT := 'tabdata_sort_idx_'
    || pg_catalog.substr(pg_catalog.md5(p_table_id::text || ':' || p_field_id::text), 1, 16);
BEGIN
  PERFORM tabtin_capability._assert_record_index_target(p_table_id, p_field_id);
  PERFORM pg_catalog.set_config('lock_timeout', '1500ms', true);
  PERFORM pg_catalog.set_config('statement_timeout', '5000ms', true);
  EXECUTE pg_catalog.format(
    'CREATE INDEX IF NOT EXISTS %I ON public.tabdata_record '
    '(table_id, is_deleted, ((data->>%L))) '
    'WHERE table_id = %L::uuid AND is_deleted = false',
    index_name,
    p_field_id::text,
    p_table_id::text
  );
  RETURN TRUE;
EXCEPTION
  WHEN lock_not_available OR query_canceled THEN
    RETURN FALSE;
END
$function$;
ALTER FUNCTION tabtin_capability.record_create_sort_index(UUID, UUID)
  OWNER TO tabtin_record_index_owner;

CREATE OR REPLACE FUNCTION tabtin_capability._assert_readonly_scope(
  p_space_id UUID,
  p_organization_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_space_id::text, '-', '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tabdata_table AS target
    WHERE target.organization_id = p_organization_id
      AND (
        target.space_id = p_space_id
        OR (target.space_id IS NULL AND target.organization_id = p_space_id)
      )
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = schema_name
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_READONLY_SCOPE_DENIED';
  END IF;
  RETURN schema_name;
END
$function$;
ALTER FUNCTION tabtin_capability._assert_readonly_scope(UUID, UUID)
  OWNER TO tabtin_readonly_role_admin;

CREATE OR REPLACE FUNCTION tabtin_capability._assert_readonly_connection(
  p_space_id UUID,
  p_organization_id UUID
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT := 'as_' || pg_catalog.replace(p_space_id::text, '-', '');
  role_name TEXT := 'ro_as_' || pg_catalog.substr(
    pg_catalog.replace(p_space_id::text, '-', ''), 1, 16
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tabdata_db_readonly_connection AS connection_record
    WHERE connection_record.space_id = p_space_id
      AND connection_record.pg_role = role_name
      AND connection_record.pg_schema = schema_name
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_READONLY_CONNECTION_DENIED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tabdata_table AS target
    WHERE target.space_id = p_space_id
      OR (target.space_id IS NULL AND target.organization_id = p_space_id)
  ) AND NOT EXISTS (
    SELECT 1 FROM public.tabdata_table AS target
    WHERE target.organization_id = p_organization_id
      AND (
        target.space_id = p_space_id
        OR (target.space_id IS NULL AND target.organization_id = p_space_id)
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_READONLY_ORGANIZATION_DENIED';
  END IF;
  RETURN schema_name;
END
$function$;
ALTER FUNCTION tabtin_capability._assert_readonly_connection(UUID, UUID)
  OWNER TO tabtin_readonly_role_admin;

CREATE OR REPLACE FUNCTION tabtin_capability.readonly_role_create(
  p_space_id UUID,
  p_organization_id UUID,
  p_password TEXT
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT;
  role_name TEXT := 'ro_as_' || pg_catalog.substr(
    pg_catalog.replace(p_space_id::text, '-', ''), 1, 16
  );
BEGIN
  schema_name := tabtin_capability._assert_readonly_scope(p_space_id, p_organization_id);
  IF p_password !~ '^[A-Za-z0-9_=-]{20,128}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_READONLY_PASSWORD_DENIED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = role_name
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolinherit)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'TABTIN_COMMUNITY_READONLY_ROLE_COLLISION';
    END IF;
    EXECUTE pg_catalog.format(
      'ALTER ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD %L',
      role_name,
      p_password
    );
  ELSE
    EXECUTE pg_catalog.format(
      'CREATE ROLE %I WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD %L',
      role_name,
      p_password
    );
  END IF;
  EXECUTE pg_catalog.format(
    'ALTER ROLE %I SET default_transaction_read_only = on', role_name
  );
  EXECUTE pg_catalog.format('ALTER ROLE %I SET search_path = %I', role_name, schema_name);
  EXECUTE pg_catalog.format('GRANT CONNECT ON DATABASE %I TO %I', pg_catalog.current_database(), role_name);
  EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM %I', pg_catalog.current_database(), role_name);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, role_name);
  EXECUTE pg_catalog.format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', schema_name, role_name);
  RETURN role_name;
END
$function$;
ALTER FUNCTION tabtin_capability.readonly_role_create(UUID, UUID, TEXT)
  OWNER TO tabtin_readonly_role_admin;

CREATE OR REPLACE FUNCTION tabtin_capability.readonly_role_rotate(
  p_space_id UUID,
  p_organization_id UUID,
  p_password TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  role_name TEXT := 'ro_as_' || pg_catalog.substr(
    pg_catalog.replace(p_space_id::text, '-', ''), 1, 16
  );
BEGIN
  PERFORM tabtin_capability._assert_readonly_connection(p_space_id, p_organization_id);
  IF p_password !~ '^[A-Za-z0-9_=-]{20,128}$'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'TABTIN_COMMUNITY_READONLY_ROTATE_DENIED';
  END IF;
  EXECUTE pg_catalog.format('ALTER ROLE %I PASSWORD %L', role_name, p_password);
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.readonly_role_rotate(UUID, UUID, TEXT)
  OWNER TO tabtin_readonly_role_admin;

CREATE OR REPLACE FUNCTION tabtin_capability.readonly_role_drop(
  p_space_id UUID,
  p_organization_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  schema_name TEXT;
  role_name TEXT := 'ro_as_' || pg_catalog.substr(
    pg_catalog.replace(p_space_id::text, '-', ''), 1, 16
  );
BEGIN
  -- A completed cleanup is safely retryable even after the metadata row has
  -- been deleted.  When the derived role still exists, metadata remains the
  -- authorization fact and the strict assertion below must pass.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
    RETURN FALSE;
  END IF;
  schema_name := tabtin_capability._assert_readonly_connection(p_space_id, p_organization_id);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = schema_name) THEN
    EXECUTE pg_catalog.format('REVOKE SELECT ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, role_name);
    EXECUTE pg_catalog.format('REVOKE USAGE ON SCHEMA %I FROM %I', schema_name, role_name);
  END IF;
  EXECUTE pg_catalog.format('REVOKE CONNECT ON DATABASE %I FROM %I', pg_catalog.current_database(), role_name);
  EXECUTE pg_catalog.format('DROP ROLE %I', role_name);
  RETURN TRUE;
END
$function$;
ALTER FUNCTION tabtin_capability.readonly_role_drop(UUID, UUID)
  OWNER TO tabtin_readonly_role_admin;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA tabtin_capability FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_ensure_schema(UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_create_table(UUID, UUID, JSONB) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_drop_table(UUID, UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_add_column(UUID, UUID, UUID, TEXT, TEXT) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_drop_column(UUID, UUID, UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.native_alter_column_type(UUID, UUID, UUID, TEXT, TEXT) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.record_create_search_index(UUID, UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.record_drop_search_index(UUID, UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.record_drop_search_indexes(UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.record_create_sort_index(UUID, UUID) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.readonly_role_create(UUID, UUID, TEXT) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.readonly_role_rotate(UUID, UUID, TEXT) TO tabtin_runtime;
GRANT EXECUTE ON FUNCTION tabtin_capability.readonly_role_drop(UUID, UUID) TO tabtin_runtime;

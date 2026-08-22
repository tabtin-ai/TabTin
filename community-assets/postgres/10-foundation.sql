-- Community-only post-migration grants.
-- Extensions are created by the init control path before Django migrations;
-- Web and Celery never execute this file.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tabtin_migrator, tabtin_runtime;

CREATE SCHEMA IF NOT EXISTS tabtin_capability AUTHORIZATION tabtin_init;
REVOKE ALL ON SCHEMA tabtin_capability FROM PUBLIC;

DO $record_owner$
BEGIN
  IF pg_catalog.to_regclass('public.tabdata_record') IS NOT NULL THEN
    ALTER TABLE public.tabdata_record OWNER TO tabtin_record_index_owner;
  END IF;
END
$record_owner$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tabtin_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tabtin_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tabtin_migrator;
REVOKE CREATE ON SCHEMA public FROM tabtin_runtime;

-- PostgreSQL grants EXECUTE to PUBLIC for new functions.  Community revokes
-- that implicit surface, then restores only extension and application
-- signatures required by current upstream flows.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $extension_functions$
DECLARE
  function_identity TEXT;
BEGIN
  FOR function_identity IN
    SELECT procedure.oid::pg_catalog.regprocedure::text
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     AND dependency.objid = procedure.oid
     AND dependency.deptype = 'e'
    JOIN pg_catalog.pg_extension AS extension
      ON extension.oid = dependency.refobjid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND extension.extname IN ('vector', 'pg_trgm')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO tabtin_runtime',
      function_identity
    );
  END LOOP;
END
$extension_functions$;

DO $application_functions$
DECLARE
  function_identity TEXT;
BEGIN
  FOREACH function_identity IN ARRAY ARRAY[
    'public.jsonb_merge(jsonb,jsonb)',
    'public.jsonb_merge_uniq(jsonb,jsonb)',
    'public.tabdoc_sync_legacy_comment_thread()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(function_identity) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %s TO tabtin_runtime',
        function_identity
      );
    END IF;
  END LOOP;
END
$application_functions$;

ALTER DEFAULT PRIVILEGES FOR ROLE tabtin_migrator IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE tabtin_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tabtin_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE tabtin_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tabtin_runtime;

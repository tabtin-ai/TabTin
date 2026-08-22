from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[4]
SQL_ROOT = ROOT / "community-assets" / "postgres"


def _sql() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(SQL_ROOT.glob("*.sql")))


def test_capability_sql_is_closed_and_owned_by_non_login_roles() -> None:
    sql = _sql()
    expected_public_functions = {
        "native_ensure_schema",
        "native_create_table",
        "native_drop_table",
        "native_add_column",
        "native_drop_column",
        "native_alter_column_type",
        "record_create_search_index",
        "record_drop_search_index",
        "record_drop_search_indexes",
        "record_create_sort_index",
        "readonly_role_create",
        "readonly_role_rotate",
        "readonly_role_drop",
    }
    declared = set(re.findall(r"CREATE OR REPLACE FUNCTION tabtin_capability\.([a-z0-9_]+)\(", sql))

    assert expected_public_functions <= declared
    assert "p_sql" not in sql.lower()
    assert not re.search(r"EXECUTE\s+p_[a-z0-9_]+", sql, re.IGNORECASE)
    assert sql.count("SECURITY DEFINER") >= len(expected_public_functions)
    assert sql.count("SET search_path = pg_catalog") >= len(expected_public_functions)
    assert "REVOKE ALL ON SCHEMA tabtin_capability FROM PUBLIC" in sql
    assert "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA tabtin_capability FROM PUBLIC" in sql
    assert "native_create_table(UUID, UUID, JSONB)" in sql
    assert "jsonb_array_length(p_field_specs) > 500" in sql
    assert "_assert_native_field_target(UUID, UUID, BOOLEAN)" in sql
    assert "TABTIN_COMMUNITY_NATIVE_FIELD_DENIED" in sql
    assert "GRANT CREATE ON SCHEMA public TO tabtin_runtime" not in sql


def test_sql_classifies_current_upstream_tabdata_tables() -> None:
    sql = _sql()
    assert "public.tabdata_table" in sql
    assert "public.tabdata_field" in sql
    assert "public.tabdata_record" in sql
    assert "public.tabdata_db_readonly_connection" in sql
    assert "CREATE EXTENSION IF NOT EXISTS vector" not in sql
    assert "CREATE EXTENSION IF NOT EXISTS pg_trgm" not in sql

from __future__ import annotations

from pathlib import Path

import pytest

from tabtin.community_database import (
    CAPABILITY_ROLE_NAMES,
    LOGIN_ROLE_NAMES,
    ROLE_SPECS,
    finalize_database,
    synchronize_roles,
)


def test_role_policy_separates_login_and_capability_owners() -> None:
    assert LOGIN_ROLE_NAMES == {
        "tabtin_init",
        "tabtin_migrator",
        "tabtin_runtime",
    }
    assert CAPABILITY_ROLE_NAMES == {
        "tabtin_native_ddl_owner",
        "tabtin_record_index_owner",
        "tabtin_readonly_role_admin",
    }
    assert set(ROLE_SPECS) == LOGIN_ROLE_NAMES | CAPABILITY_ROLE_NAMES

    init = ROLE_SPECS["tabtin_init"]
    assert init.login is True
    assert init.superuser is True
    assert init.inherit is False

    for name in ("tabtin_migrator", "tabtin_runtime"):
        role = ROLE_SPECS[name]
        assert role.login is True
        assert role.superuser is False
        assert role.create_db is False
        assert role.create_role is False
        assert role.bypass_rls is False
        assert role.inherit is False

    for name in CAPABILITY_ROLE_NAMES:
        role = ROLE_SPECS[name]
        assert role.login is False
        assert role.superuser is False
        assert role.create_db is False
        assert role.bypass_rls is False
        assert role.inherit is False

    assert ROLE_SPECS["tabtin_native_ddl_owner"].create_role is False
    assert ROLE_SPECS["tabtin_record_index_owner"].create_role is False
    assert ROLE_SPECS["tabtin_readonly_role_admin"].create_role is True


class _RecordingCursor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list | tuple | None]] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None

    def execute(self, statement, parameters=None) -> None:
        self.calls.append((str(statement), parameters))

    def fetchone(self):
        return None


class _RecordingConnection:
    def __init__(self) -> None:
        self.recorder = _RecordingCursor()

    def cursor(self) -> _RecordingCursor:
        return self.recorder


def test_role_sync_binds_passwords_and_revokes_runtime_ddl() -> None:
    connection = _RecordingConnection()
    passwords = {
        "tabtin_init": "init-secret-sentinel",
        "tabtin_migrator": "migrator-secret-sentinel",
        "tabtin_runtime": "runtime-secret-sentinel",
    }

    synchronize_roles(connection, database_name="tabtin", passwords=passwords)

    statements = "\n".join(statement for statement, _ in connection.recorder.calls)
    for password in passwords.values():
        assert password not in statements
        assert any(parameters and password in parameters for _, parameters in connection.recorder.calls)
    assert 'REVOKE TEMPORARY ON DATABASE "tabtin" FROM "tabtin_runtime"' in statements
    assert 'GRANT CONNECT ON DATABASE "tabtin" TO "tabtin_runtime"' in statements
    assert 'GRANT CREATE ON DATABASE "tabtin" TO "tabtin_native_ddl_owner"' in statements
    assert 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "tabtin_migrator"' in statements
    assert 'GRANT CREATE ON SCHEMA public TO "tabtin_runtime"' not in statements
    assert "NOINHERIT" in statements


def test_finalize_runs_only_ordered_sql_files(tmp_path: Path) -> None:
    (tmp_path / "20-capabilities.sql").write_text("SELECT 2", encoding="utf-8")
    (tmp_path / "10-foundation.sql").write_text("SELECT 1", encoding="utf-8")
    (tmp_path / "README.md").write_text("not sql", encoding="utf-8")
    connection = _RecordingConnection()

    executed = finalize_database(connection, sql_root=tmp_path)

    assert executed == ("10-foundation.sql", "20-capabilities.sql")
    assert [statement for statement, _ in connection.recorder.calls] == ["SELECT 1", "SELECT 2"]


def test_finalize_requires_a_classified_sql_set(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="finalization SQL is missing"):
        finalize_database(_RecordingConnection(), sql_root=tmp_path)

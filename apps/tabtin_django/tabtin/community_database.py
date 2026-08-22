"""Community PostgreSQL role and capability installation boundary.

Only one-shot installation commands should import the environment entrypoints
in this module.  Web and Celery use ``tabtin_runtime`` and never receive init
or migrator credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys

from tabtin.community_secrets import read_secret_file


@dataclass(frozen=True, slots=True)
class RoleSpec:
    login: bool
    inherit: bool = False
    superuser: bool = False
    create_db: bool = False
    create_role: bool = False
    bypass_rls: bool = False
    connection_limit: int = -1


ROLE_SPECS = {
    "tabtin_init": RoleSpec(login=True, superuser=True, connection_limit=2),
    "tabtin_migrator": RoleSpec(login=True, connection_limit=4),
    "tabtin_runtime": RoleSpec(login=True, connection_limit=100),
    "tabtin_native_ddl_owner": RoleSpec(login=False),
    "tabtin_record_index_owner": RoleSpec(login=False),
    "tabtin_readonly_role_admin": RoleSpec(login=False, create_role=True),
}

LOGIN_ROLE_NAMES = {
    "tabtin_init",
    "tabtin_migrator",
    "tabtin_runtime",
}

CAPABILITY_ROLE_NAMES = {
    "tabtin_native_ddl_owner",
    "tabtin_record_index_owner",
    "tabtin_readonly_role_admin",
}


def _role_options(spec: RoleSpec) -> str:
    return " ".join(
        (
            "LOGIN" if spec.login else "NOLOGIN",
            "INHERIT" if spec.inherit else "NOINHERIT",
            "SUPERUSER" if spec.superuser else "NOSUPERUSER",
            "CREATEDB" if spec.create_db else "NOCREATEDB",
            "CREATEROLE" if spec.create_role else "NOCREATEROLE",
            "BYPASSRLS" if spec.bypass_rls else "NOBYPASSRLS",
            f"CONNECTION LIMIT {spec.connection_limit}",
        )
    )


def _quoted_identifier(value: str, *, label: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", value):
        raise ValueError(f"invalid {label}")
    return f'"{value}"'


def synchronize_roles(connection, *, database_name: str, passwords: dict[str, str]) -> None:
    """Idempotently converge roles and pre-migration grants."""
    if set(passwords) != LOGIN_ROLE_NAMES:
        raise ValueError("passwords must cover the three Community login roles")
    database = _quoted_identifier(database_name, label="database name")

    with connection.cursor() as cursor:
        for role_name, spec in ROLE_SPECS.items():
            role = _quoted_identifier(role_name, label="role name")
            cursor.execute("SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = %s", [role_name])
            verb = "ALTER ROLE" if cursor.fetchone() is not None else "CREATE ROLE"
            statement = f"{verb} {role} WITH {_role_options(spec)}"
            parameters = None
            if spec.login:
                statement += " PASSWORD %s"
                parameters = [passwords[role_name]]
            cursor.execute(statement, parameters)

        for granted_role in ROLE_SPECS:
            for member_role in ROLE_SPECS:
                if granted_role != member_role:
                    cursor.execute(f'REVOKE "{granted_role}" FROM "{member_role}"')

        cursor.execute(f'ALTER DATABASE {database} OWNER TO "tabtin_init"')
        cursor.execute(f"REVOKE ALL ON DATABASE {database} FROM PUBLIC")
        cursor.execute(
            f'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE {database} TO "tabtin_migrator"'
        )
        cursor.execute(f'GRANT CONNECT ON DATABASE {database} TO "tabtin_runtime"')
        cursor.execute(f'REVOKE TEMPORARY ON DATABASE {database} FROM "tabtin_runtime"')
        cursor.execute(
            f'GRANT CREATE ON DATABASE {database} TO "tabtin_native_ddl_owner"'
        )
        cursor.execute(
            f'GRANT CONNECT ON DATABASE {database} TO "tabtin_readonly_role_admin" WITH GRANT OPTION'
        )
        cursor.execute(
            f'REVOKE TEMPORARY ON DATABASE {database} FROM "tabtin_readonly_role_admin"'
        )

        cursor.execute("CREATE EXTENSION IF NOT EXISTS vector")
        cursor.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        cursor.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
        cursor.execute('GRANT USAGE, CREATE ON SCHEMA public TO "tabtin_migrator"')
        # ``safe_migrate`` performs a read-only schema integrity check after
        # applying migrations.  Finalization hands selected objects to narrow
        # capability owners, so an idempotent restart must restore this
        # explicit inspection grant before running that check again.
        cursor.execute(
            'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "tabtin_migrator"'
        )
        cursor.execute('GRANT USAGE ON SCHEMA public TO "tabtin_runtime"')
        cursor.execute(
            "CREATE SCHEMA IF NOT EXISTS tabtin_capability AUTHORIZATION tabtin_init"
        )
        cursor.execute("REVOKE ALL ON SCHEMA tabtin_capability FROM PUBLIC")
        for role_name in (*sorted(CAPABILITY_ROLE_NAMES), "tabtin_runtime"):
            cursor.execute(f'GRANT USAGE ON SCHEMA tabtin_capability TO "{role_name}"')

        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            "REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC"
        )
        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "tabtin_runtime"'
        )
        cursor.execute(
            'ALTER DEFAULT PRIVILEGES FOR ROLE "tabtin_migrator" IN SCHEMA public '
            'GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "tabtin_runtime"'
        )


def finalize_database(connection, *, sql_root: Path) -> tuple[str, ...]:
    sql_files = tuple(sorted(sql_root.glob("*.sql")))
    if not sql_files:
        raise ValueError("Community database finalization SQL is missing")
    with connection.cursor() as cursor:
        for sql_file in sql_files:
            cursor.execute(sql_file.read_text(encoding="utf-8"))
    return tuple(sql_file.name for sql_file in sql_files)


def _required_path(name: str) -> Path:
    value = os.environ.get(name, "")
    if not value:
        raise ValueError(f"missing required file setting: {name}")
    return Path(value)


def _passwords_from_files() -> dict[str, str]:
    return {
        "tabtin_init": read_secret_file(_required_path("PG_INIT_PASSWORD_FILE"), label="init"),
        "tabtin_migrator": read_secret_file(
            _required_path("PG_MIGRATOR_PASSWORD_FILE"), label="migrator"
        ),
        "tabtin_runtime": read_secret_file(
            _required_path("PG_RUNTIME_PASSWORD_FILE"), label="runtime"
        ),
    }


def _connect_as_init():
    import psycopg2

    return psycopg2.connect(
        dbname=os.environ.get("PG_DB_NAME", "tabtin"),
        user="tabtin_init",
        password=_passwords_from_files()["tabtin_init"],
        host=os.environ.get("PG_DB_HOST", "/var/run/postgresql"),
        port=int(os.environ.get("PG_DB_PORT", "5432")),
        connect_timeout=10,
    )


def synchronize_from_environment() -> None:
    passwords = _passwords_from_files()
    with _connect_as_init() as connection:
        synchronize_roles(
            connection,
            database_name=os.environ.get("PG_DB_NAME", "tabtin"),
            passwords=passwords,
        )
    print("[community-database] roles synchronized")


def finalize_from_environment() -> None:
    sql_root = Path(
        os.environ.get(
            "TABTIN_COMMUNITY_DATABASE_SQL_ROOT",
            "/opt/tabtin/postgres-community",
        )
    )
    with _connect_as_init() as connection:
        executed = finalize_database(connection, sql_root=sql_root)
    print(f"[community-database] finalized scripts={len(executed)}")


def main() -> None:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "sync":
        synchronize_from_environment()
        return
    if action == "finalize":
        finalize_from_environment()
        return
    raise SystemExit("usage: python -m tabtin.community_database {sync|finalize}")


if __name__ == "__main__":
    main()

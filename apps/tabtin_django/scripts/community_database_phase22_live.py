"""Disposable PostgreSQL probe for Community database isolation.

The probe is intentionally unavailable unless explicitly enabled and must run
against a disposable local database as ``tabtin_runtime``.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
from types import SimpleNamespace
from uuid import uuid4


if os.environ.get("TABTIN_COMMUNITY_PHASE22_LIVE_PROBE") != "1":
    raise SystemExit("TABTIN_COMMUNITY_PHASE22_LIVE_PROBE=1 is required")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django

django.setup()

from django.contrib.auth import get_user_model
from django.db import DatabaseError, connection, transaction

from apps.tabdata.models import Table, TableField
from apps.tabdata.native.community_capabilities import CommunityRecordIndexOperations
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import FIELD_TYPE_TO_PG_TYPE
from apps.tabdata.services.db_connection_service import DbConnectionService
from apps.tabtinspace.models import Organization, OrganizationMember


def fetchone(statement: str, parameters=None):
    with connection.cursor() as cursor:
        cursor.execute(statement, parameters or [])
        return cursor.fetchone()


def expect_denied(label: str, statement: str) -> str:
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(statement)
    except DatabaseError:
        return label
    raise AssertionError(f"runtime unexpectedly allowed {label}")


def main() -> None:
    identity = fetchone("SELECT current_user, session_user")
    assert identity == ("tabtin_runtime", "tabtin_runtime")
    role_flags = fetchone(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls "
        "FROM pg_catalog.pg_roles WHERE rolname = current_user"
    )
    assert role_flags == (False, False, False, False, False)

    denied = [
        expect_denied("create_role", "CREATE ROLE phase22_denied"),
        expect_denied("create_database", "CREATE DATABASE phase22_denied"),
        expect_denied("create_public_table", "CREATE TABLE public.phase22_denied(id integer)"),
        expect_denied("create_schema", "CREATE SCHEMA phase22_denied"),
        expect_denied("set_role", "SET ROLE tabtin_migrator"),
    ]

    User = get_user_model()
    user = User.objects.create_user(email=f"phase22-{uuid4().hex}@example.invalid")
    organization = Organization.objects.create(name="Phase 2.2 disposable", owner=user)
    OrganizationMember.objects.create(organization=organization, user=user, role="owner")
    table = Table.objects.create(
        organization_id=organization.id,
        name="Phase 2.2 capability",
        owner=user,
    )
    initial_fields = [
        TableField.objects.create(
            table=table,
            name=f"Field {field_type}",
            field_type=field_type,
            order=order,
        )
        for order, field_type in enumerate(FIELD_TYPE_TO_PG_TYPE)
    ]
    initial_fields.append(
        TableField.objects.create(
            table=table,
            name="Field date with time",
            field_type="date",
            config={"formatting": {"time": "HH:mm"}},
            order=len(initial_fields),
        )
    )
    text_field = next(field for field in initial_fields if field.field_type == "text")
    checkbox_field = next(
        field for field in initial_fields if field.field_type == "checkbox"
    )

    manager = DDLManager()
    manager.ensure_schema(organization.id)
    manager.create_native_table(
        organization.id,
        table.id,
        extra_fields=initial_fields,
    )
    qualified = manager.qualified_table_name(organization.id, table.id)
    assert fetchone("SELECT pg_catalog.to_regclass(%s) IS NOT NULL", [qualified])[0]

    json_field = TableField.objects.create(
        table=table,
        name="Tags",
        field_type="multi_select",
        order=2,
    )
    assert manager.add_column(
        organization.id,
        table.id,
        json_field.id,
        json_field.field_type,
        json_field.config,
    )
    assert manager.alter_column_type(
        organization.id,
        table.id,
        text_field.id,
        "long_text",
        "text",
    ) is False

    indexes = CommunityRecordIndexOperations(connection)
    assert indexes.create_search_index(table.id, text_field.id) is True
    assert indexes.create_sort_index(table.id, text_field.id) is True

    try:
        manager.add_column(
            organization.id,
            table.id,
            uuid4(),
            "text",
            {},
        )
    except DatabaseError:
        unauthorized_field_capability = "denied"
    else:
        raise AssertionError("unknown field identifier was accepted for a known table")

    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f'INSERT INTO {qualified} ("__id", "{text_field.id.hex}", "{checkbox_field.id.hex}") '
                "VALUES (%s, %s, %s)",
                [uuid4(), "runtime-write", True],
            )
            cursor.execute(f"SELECT count(*) FROM {qualified}")
            assert cursor.fetchone()[0] == 1

    readonly_service = DbConnectionService(user)
    readonly = readonly_service.create_connection(organization.id)
    encrypted_before = readonly.pg_password_encrypted
    assert encrypted_before and "phase22" not in encrypted_before
    rotated = readonly_service.reset_password(organization.id)
    assert rotated is not None
    assert rotated.pg_password_encrypted != encrypted_before
    assert readonly_service.delete_connection(organization.id) is True

    try:
        CommunityRecordIndexOperations(connection).create_search_index(uuid4(), uuid4())
    except DatabaseError:
        unauthorized_capability = "denied"
    else:
        raise AssertionError("unknown TabData identifiers were accepted")

    manager.drop_native_table(organization.id, table.id)
    table.delete()

    assert fetchone("SELECT pg_catalog.to_regclass(%s) IS NULL", [qualified])[0]
    print(
        "PHASE22_DATABASE_RESULT="
        f"identity={identity[0]} denied={','.join(sorted(denied))} "
        f"unauthorized_capability={unauthorized_capability} "
        f"unauthorized_field_capability={unauthorized_field_capability} "
        f"native_field_specs={len(initial_fields)} tabdata=ok readonly_role=ok"
    )


if __name__ == "__main__":
    main()

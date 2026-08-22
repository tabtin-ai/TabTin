from django.db import migrations, models


WALLET_TABLE = "users_wallet_workspace_wallet"
TRANSACTION_TABLE = "users_wallet_transaction"


def _table_exists(schema_editor, table_name: str) -> bool:
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        return table_name in connection.introspection.table_names(cursor)


def _get_columns(schema_editor, table_name: str) -> set[str]:
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        return {
            column.name
            for column in connection.introspection.get_table_description(cursor, table_name)
        }


def _get_constraints(schema_editor, table_name: str) -> dict:
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        return connection.introspection.get_constraints(cursor, table_name)


def _rename_column_if_needed(schema_editor, table_name: str, old_name: str, new_name: str) -> None:
    if not _table_exists(schema_editor, table_name):
        return

    columns = _get_columns(schema_editor, table_name)
    if old_name not in columns or new_name in columns:
        return

    qn = schema_editor.quote_name
    schema_editor.execute(
        f"ALTER TABLE {qn(table_name)} RENAME COLUMN {qn(old_name)} TO {qn(new_name)}"
    )


def _get_owner_wallet_column(schema_editor) -> str | None:
    if not _table_exists(schema_editor, TRANSACTION_TABLE):
        return None

    columns = _get_columns(schema_editor, TRANSACTION_TABLE)
    if "workteam_wallet_id" in columns:
        return "workteam_wallet_id"
    if "workspace_wallet_id" in columns:
        return "workspace_wallet_id"
    return None


def _validate_wallet_owner_rows(schema_editor) -> None:
    owner_wallet_column = _get_owner_wallet_column(schema_editor)
    if not owner_wallet_column:
        return

    columns = _get_columns(schema_editor, TRANSACTION_TABLE)
    if "wallet_id" not in columns:
        return

    connection = schema_editor.connection
    qn = schema_editor.quote_name
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT COUNT(*) FROM {qn(TRANSACTION_TABLE)} "
            f"WHERE (({qn('wallet_id')} IS NULL AND {qn(owner_wallet_column)} IS NULL) "
            f"OR ({qn('wallet_id')} IS NOT NULL AND {qn(owner_wallet_column)} IS NOT NULL))"
        )
        invalid_count = cursor.fetchone()[0]

    if invalid_count:
        raise RuntimeError(
            "wallet transaction owner columns contain invalid rows; "
            f"please clean {invalid_count} rows before running repair migration"
        )


def _drop_constraint_if_exists(schema_editor, model, table_name: str, constraint) -> None:
    if not _table_exists(schema_editor, table_name):
        return

    constraints = _get_constraints(schema_editor, table_name)
    if constraint.name not in constraints:
        return

    schema_editor.remove_constraint(model, constraint)


def _add_constraint_if_missing(schema_editor, model, table_name: str, constraint) -> None:
    if not _table_exists(schema_editor, table_name):
        return

    constraints = _get_constraints(schema_editor, table_name)
    if constraint.name in constraints:
        return

    schema_editor.add_constraint(model, constraint)


def repair_wallet_workspace_to_workteam_schema(apps, schema_editor):
    wallet_transaction = apps.get_model("wallet", "WalletTransaction")
    must_have_owner = models.CheckConstraint(
        check=~models.Q(wallet__isnull=True, workteam_wallet__isnull=True),
        name="tx_must_have_owner",
    )
    owner_mutually_exclusive = models.CheckConstraint(
        check=models.Q(wallet__isnull=True) | models.Q(workteam_wallet__isnull=True),
        name="tx_owner_mutually_exclusive",
    )

    _validate_wallet_owner_rows(schema_editor)

    _drop_constraint_if_exists(
        schema_editor,
        wallet_transaction,
        TRANSACTION_TABLE,
        must_have_owner,
    )
    _drop_constraint_if_exists(
        schema_editor,
        wallet_transaction,
        TRANSACTION_TABLE,
        owner_mutually_exclusive,
    )

    _rename_column_if_needed(schema_editor, WALLET_TABLE, "workspace_id", "workteam_id")
    _rename_column_if_needed(schema_editor, TRANSACTION_TABLE, "workspace_id", "workteam_id")
    _rename_column_if_needed(
        schema_editor,
        TRANSACTION_TABLE,
        "workspace_wallet_id",
        "workteam_wallet_id",
    )

    if not _table_exists(schema_editor, TRANSACTION_TABLE):
        return

    columns = _get_columns(schema_editor, TRANSACTION_TABLE)
    if "wallet_id" not in columns or "workteam_wallet_id" not in columns:
        return

    _add_constraint_if_missing(
        schema_editor,
        wallet_transaction,
        TRANSACTION_TABLE,
        must_have_owner,
    )
    _add_constraint_if_missing(
        schema_editor,
        wallet_transaction,
        TRANSACTION_TABLE,
        owner_mutually_exclusive,
    )


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("wallet", "0007_wallettransaction_reference_key_and_more"),
    ]

    operations = [
        migrations.RunPython(
            repair_wallet_workspace_to_workteam_schema,
            migrations.RunPython.noop,
        ),
    ]

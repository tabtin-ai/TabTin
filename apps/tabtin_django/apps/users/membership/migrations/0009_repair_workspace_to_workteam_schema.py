from django.db import migrations


MEMBERSHIP_TABLE = "users_membership_workspace_membership"


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


def repair_membership_workspace_to_workteam_schema(apps, schema_editor):
    if not _table_exists(schema_editor, MEMBERSHIP_TABLE):
        return

    columns = _get_columns(schema_editor, MEMBERSHIP_TABLE)
    if "workspace_id" not in columns or "workteam_id" in columns:
        return

    qn = schema_editor.quote_name
    schema_editor.execute(
        f"ALTER TABLE {qn(MEMBERSHIP_TABLE)} "
        f"RENAME COLUMN {qn('workspace_id')} TO {qn('workteam_id')}"
    )


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("membership", "0008_alter_workteammembership_options_and_more"),
    ]

    operations = [
        migrations.RunPython(
            repair_membership_workspace_to_workteam_schema,
            migrations.RunPython.noop,
        ),
    ]

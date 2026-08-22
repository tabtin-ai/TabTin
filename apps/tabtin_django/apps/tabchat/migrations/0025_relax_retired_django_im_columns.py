"""Make abandoned Django IM columns harmless to the current ORM models."""

from django.db import migrations


RETIRED_COLUMNS = {
    "tabchat_agent_mention_job": (
        "source_sender_id",
        "source_content",
        "context_messages",
        "conversation_ref",
        "conversation_name",
        "project_ref",
        "final_content",
        "final_message_type",
        "final_metadata",
    ),
    "tabchat_handoff_package": ("conversation_ref",),
}


def relax_retired_columns(_apps, schema_editor):
    connection = schema_editor.connection
    quote = connection.ops.quote_name
    with connection.cursor() as cursor:
        tables = set(connection.introspection.table_names(cursor))
        for table, columns in RETIRED_COLUMNS.items():
            if table not in tables:
                continue
            existing = {
                field.name
                for field in connection.introspection.get_table_description(cursor, table)
            }
            for column in columns:
                if column in existing:
                    schema_editor.execute(
                        f"ALTER TABLE {quote(table)} "
                        f"ALTER COLUMN {quote(column)} DROP NOT NULL"
                    )


class Migration(migrations.Migration):
    dependencies = [("tabchat", "0024_handoff_message_refs")]

    operations = [migrations.RunPython(relax_retired_columns, migrations.RunPython.noop)]

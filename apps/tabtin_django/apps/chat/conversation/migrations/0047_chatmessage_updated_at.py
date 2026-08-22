from django.db import migrations, models


def ensure_chatmessage_updated_at(apps, schema_editor):
    table_name = "chat_message"
    column_name = "updated_at"
    with schema_editor.connection.cursor() as cursor:
        existing_columns = {
            column.name
            for column in schema_editor.connection.introspection.get_table_description(
                cursor, table_name,
            )
        }
    if column_name in existing_columns:
        return

    ChatMessage = apps.get_model("conversation", "ChatMessage")
    field = models.DateTimeField(auto_now=True, null=True, verbose_name="更新时间")
    field.set_attributes_from_name(column_name)
    schema_editor.add_field(ChatMessage, field)


def backfill_updated_at(apps, schema_editor):
    ChatMessage = apps.get_model("conversation", "ChatMessage")
    ChatMessage.objects.filter(updated_at__isnull=True).update(
        updated_at=models.F("created_at"),
    )


def ensure_chatmessage_updated_index(apps, schema_editor):
    table_name = "chat_message"
    index_name = "chat_msg_sess_updated_idx"
    with schema_editor.connection.cursor() as cursor:
        constraints = schema_editor.connection.introspection.get_constraints(
            cursor, table_name,
        )
    if index_name in constraints:
        return

    ChatMessage = apps.get_model("conversation", "ChatMessage")
    index = models.Index(
        fields=["session", "updated_at", "id"],
        name=index_name,
    )
    schema_editor.add_index(ChatMessage, index)


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0046_remove_chatsession_chat_sess_space_updated_idx_and_more'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    ensure_chatmessage_updated_at,
                    migrations.RunPython.noop,
                ),
            ],
            state_operations=[
                migrations.AddField(
                    model_name='chatmessage',
                    name='updated_at',
                    field=models.DateTimeField(
                        auto_now=True,
                        null=True,
                        verbose_name='更新时间',
                    ),
                ),
            ],
        ),
        migrations.RunPython(backfill_updated_at, migrations.RunPython.noop),
        migrations.AlterField(
            model_name='chatmessage',
            name='updated_at',
            field=models.DateTimeField(auto_now=True, verbose_name='更新时间'),
        ),
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(
                    ensure_chatmessage_updated_index,
                    migrations.RunPython.noop,
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name='chatmessage',
                    index=models.Index(
                        fields=['session', 'updated_at', 'id'],
                        name='chat_msg_sess_updated_idx',
                    ),
                ),
            ],
        ),
    ]

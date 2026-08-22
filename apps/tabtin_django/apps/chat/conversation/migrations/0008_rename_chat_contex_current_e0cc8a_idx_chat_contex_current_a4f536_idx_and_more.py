# Remove db_column overrides: rename columns to match field names
from django.db import migrations, models
import django.db.models.deletion


def ensure_index_exists(apps, schema_editor):
    """Create or rename the index depending on DB state."""
    conn = schema_editor.connection
    if conn.vendor == 'mysql':
        with conn.cursor() as cursor:
            cursor.execute("SHOW INDEX FROM chat_context WHERE Key_name = 'chat_contex_current_e0cc8a_idx'")
            if cursor.fetchone():
                cursor.execute(
                    "ALTER TABLE `chat_context` RENAME INDEX "
                    "`chat_contex_current_e0cc8a_idx` TO `chat_contex_current_a4f536_idx`"
                )
            else:
                cursor.execute("SHOW INDEX FROM chat_context WHERE Key_name = 'chat_contex_current_a4f536_idx'")
                if not cursor.fetchone():
                    cursor.execute(
                        "CREATE INDEX `chat_contex_current_a4f536_idx` "
                        "ON `chat_context` (`current_space_id`)"
                    )


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0008_alter_contextitem_space_and_more'),
        ('conversation', '0007_alter_chatcontext_current_space_id_and_more'),
    ]

    operations = [
        # First: rename columns via AlterField
        migrations.AlterField(
            model_name='chatcontext',
            name='current_space_id',
            field=models.CharField(blank=True, max_length=100, verbose_name='当前 Space ID'),
        ),
        migrations.AlterField(
            model_name='chatcontext',
            name='recent_spaces',
            field=models.JSONField(default=list, verbose_name='最近 Space 列表'),
        ),
        migrations.AlterField(
            model_name='chatsession',
            name='space',
            field=models.ForeignKey(blank=True, db_constraint=False, null=True, on_delete=django.db.models.deletion.CASCADE, related_name='chat_sessions', to='tabtinspace.space', verbose_name='所属智能体空间'),
        ),
        # Then: handle index rename/creation
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RenameIndex(
                    model_name='chatcontext',
                    new_name='chat_contex_current_a4f536_idx',
                    old_name='chat_contex_current_e0cc8a_idx',
                ),
            ],
            database_operations=[
                migrations.RunPython(ensure_index_exists, migrations.RunPython.noop),
            ],
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('agent_engine', '0018_alter_cliauditevent_organization_id_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='permissionaudit',
            name='workspace_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='决议关联的 Workspace；历史记录可为空。',
                null=True,
            ),
        ),
        migrations.AddIndex(
            model_name='permissionaudit',
            index=models.Index(
                fields=['workspace_id', '-created_at'],
                name='idx_permaudit_workspace_time',
            ),
        ),
    ]

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users_auth', '0020_backfill_batch_a2_resource_governance_permissions'),
        ('users_auth', '0016_user_session_revocation_metadata'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "CREATE INDEX IF NOT EXISTS users_auth_user_session_device_id_idx "
                        "ON users_auth_user_session (device_id);"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name='usersession',
                    name='device_id',
                    field=models.CharField(
                        blank=True,
                        db_index=True,
                        default='',
                        help_text='可存 Device.id 或 fingerprint；为空表示历史会话未绑定设备',
                        max_length=255,
                        verbose_name='客户端设备标识',
                    ),
                ),
            ],
        ),
    ]

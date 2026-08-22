from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users_auth', '0014_intent_user'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ADD COLUMN IF NOT EXISTS device_id varchar(255) NOT NULL DEFAULT '';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ADD COLUMN IF NOT EXISTS client_type varchar(32) NOT NULL DEFAULT 'web';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "CREATE INDEX IF NOT EXISTS users_auth_user_session_client_type_7ac7e2a9 "
                        "ON users_auth_user_session (client_type);"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "CREATE INDEX IF NOT EXISTS users_auth__user_id_580a52_idx "
                        "ON users_auth_user_session (user_id, client_type);"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AddField(
                    model_name='usersession',
                    name='device_id',
                    field=models.CharField(
                        blank=True,
                        default='',
                        help_text='可存 Device.id 或 fingerprint；为空表示历史会话未绑定设备',
                        max_length=255,
                        verbose_name='客户端设备标识',
                    ),
                ),
                migrations.AddField(
                    model_name='usersession',
                    name='client_type',
                    field=models.CharField(
                        blank=True,
                        db_index=True,
                        default='web',
                        max_length=32,
                        verbose_name='客户端类型',
                    ),
                ),
                migrations.AddIndex(
                    model_name='usersession',
                    index=models.Index(
                        fields=['user', 'client_type'],
                        name='users_auth__user_id_580a52_idx',
                    ),
                ),
            ],
        ),
    ]

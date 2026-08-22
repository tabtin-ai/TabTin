from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('users_auth', '0015_user_session_client_metadata'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ALTER COLUMN revoked_at DROP NOT NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ADD COLUMN IF NOT EXISTS revoked_by_admin_account_id varchar(36) NOT NULL DEFAULT '';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "UPDATE users_auth_user_session "
                        "SET revoked_by_admin_account_id = '' "
                        "WHERE revoked_by_admin_account_id IS NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ALTER COLUMN revoked_by_admin_account_id SET DEFAULT '';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ALTER COLUMN revoked_by_admin_account_id SET NOT NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ADD COLUMN IF NOT EXISTS revoked_reason text NOT NULL DEFAULT '';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "UPDATE users_auth_user_session "
                        "SET revoked_reason = '' "
                        "WHERE revoked_reason IS NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ALTER COLUMN revoked_reason SET DEFAULT '';"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "ALTER TABLE users_auth_user_session "
                        "ALTER COLUMN revoked_reason SET NOT NULL;"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    sql=(
                        "CREATE INDEX IF NOT EXISTS users_auth__revoked_d4f238_idx "
                        "ON users_auth_user_session (revoked_at);"
                    ),
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AddField(
                    model_name='usersession',
                    name='revoked_at',
                    field=models.DateTimeField(blank=True, null=True, verbose_name='吊销时间'),
                ),
                migrations.AddField(
                    model_name='usersession',
                    name='revoked_by_admin_account_id',
                    field=models.CharField(
                        blank=True,
                        default='',
                        max_length=36,
                        verbose_name='吊销后台账号 ID',
                    ),
                ),
                migrations.AddField(
                    model_name='usersession',
                    name='revoked_reason',
                    field=models.TextField(blank=True, default='', verbose_name='吊销原因'),
                ),
                migrations.AddIndex(
                    model_name='usersession',
                    index=models.Index(
                        fields=['revoked_at'],
                        name='users_auth__revoked_d4f238_idx',
                    ),
                ),
            ],
        ),
    ]

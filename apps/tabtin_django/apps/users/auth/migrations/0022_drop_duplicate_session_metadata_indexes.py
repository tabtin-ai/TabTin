from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('users_auth', '0021_device_session_admin_governance'),
    ]

    operations = [
        migrations.RunSQL(
            sql=(
                "DROP INDEX IF EXISTS users_auth_session_user_client;\n"
                "DROP INDEX IF EXISTS users_auth_session_revoked_at;"
            ),
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]

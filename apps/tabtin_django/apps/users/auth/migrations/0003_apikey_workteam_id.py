"""
Add workteam_id to UserApiKey.

For existing API Keys without a workteam_id, a data migration backfills
the user's personal Workteam (type='personal').
"""

from django.db import migrations, models


def backfill_workteam_id(apps, schema_editor):
    """Backfill workteam_id for existing API Keys using the user's personal Workteam."""
    UserApiKey = apps.get_model('users_auth', 'UserApiKey')
    keys_without_workteam = UserApiKey.objects.using('default').filter(
        models.Q(workteam_id='') | models.Q(workteam_id__isnull=True)
    )

    if not keys_without_workteam.exists():
        return

    from django.db import connections
    pg_conn = connections['postgresql']
    with pg_conn.cursor() as cursor:
        user_ids = list(keys_without_workteam.values_list('user_id', flat=True).distinct())
        if not user_ids:
            return

        placeholders = ', '.join(['%s'] * len(user_ids))
        cursor.execute(
            f"SELECT id, owner_id FROM tabtinspace_workteam "
            f"WHERE owner_id IN ({placeholders}) AND type = 'personal' ",
            user_ids,
        )
        owner_to_workteam = {}
        for row in cursor.fetchall():
            wt_id, owner_id = row
            if owner_id not in owner_to_workteam:
                owner_to_workteam[owner_id] = wt_id

    for key in keys_without_workteam:
        wt_id = owner_to_workteam.get(str(key.user_id), '')
        if wt_id:
            UserApiKey.objects.using('default').filter(pk=key.pk).update(workteam_id=str(wt_id))


class Migration(migrations.Migration):

    dependencies = [
        ('users_auth', '0002_user_api_key'),
    ]

    operations = [
        migrations.AddField(
            model_name='userapikey',
            name='workteam_id',
            field=models.CharField(
                db_index=True,
                default='',
                help_text='API Key 归属的 Workteam，计费和权限归属于此',
                max_length=36,
                verbose_name='工作团队',
            ),
            preserve_default=False,
        ),
        migrations.RunPython(backfill_workteam_id, migrations.RunPython.noop),
        migrations.AddIndex(
            model_name='userapikey',
            index=models.Index(fields=['workteam_id', 'is_active'], name='users_auth__workteam_4d6e8a_idx'),
        ),
    ]

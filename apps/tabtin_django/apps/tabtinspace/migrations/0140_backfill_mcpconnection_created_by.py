from django.db import migrations


def backfill_created_by_from_credential(apps, schema_editor):
    connection_model = apps.get_model('tabtinspace', 'MCPConnection')
    rows = connection_model.objects.filter(
        created_by__isnull=True,
        credential__user_id__isnull=False,
    ).values_list('id', 'credential__user_id')
    for connection_id, user_id in rows.iterator():
        connection_model.objects.filter(id=connection_id).update(created_by_id=user_id)


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0139_mcpconnection_created_by'),
    ]

    operations = [
        migrations.RunPython(
            backfill_created_by_from_credential,
            migrations.RunPython.noop,
        ),
    ]

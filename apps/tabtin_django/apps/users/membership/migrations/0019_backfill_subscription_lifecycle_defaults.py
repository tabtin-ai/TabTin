from django.db import migrations


def backfill_lifecycle_defaults(apps, schema_editor):
    OrganizationMembership = apps.get_model('membership', 'OrganizationMembership')
    db_alias = schema_editor.connection.alias
    OrganizationMembership.objects.using(db_alias).filter(
        billing_cycle__isnull=True,
    ).update(billing_cycle='monthly')
    OrganizationMembership.objects.using(db_alias).filter(
        lifecycle_version__isnull=True,
    ).update(lifecycle_version=1)


def reverse_lifecycle_defaults(apps, schema_editor):
    OrganizationMembership = apps.get_model('membership', 'OrganizationMembership')
    db_alias = schema_editor.connection.alias
    OrganizationMembership.objects.using(db_alias).update(
        billing_cycle=None,
        lifecycle_version=None,
    )


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0018_subscription_lifecycle_schema'),
    ]

    operations = [
        migrations.RunPython(
            backfill_lifecycle_defaults,
            reverse_code=reverse_lifecycle_defaults,
        ),
    ]

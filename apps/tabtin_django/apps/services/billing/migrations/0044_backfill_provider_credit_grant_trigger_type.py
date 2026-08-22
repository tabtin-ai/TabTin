from django.db import migrations


def backfill_trigger_type(apps, schema_editor):
    table = "services_billing_provider_credit_grant"
    schema_editor.execute(
        f"""
        UPDATE {table}
        SET trigger_type = 'membership'
        WHERE metadata ->> 'source' = 'membership'
        """
    )
    schema_editor.execute(
        f"""
        UPDATE {table}
        SET trigger_type = 'new_org'
        WHERE metadata ->> 'source' = 'new_org'
        """
    )


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0043_provider_credit_grant_trigger_type"),
    ]

    operations = [
        migrations.RunPython(backfill_trigger_type, migrations.RunPython.noop),
    ]

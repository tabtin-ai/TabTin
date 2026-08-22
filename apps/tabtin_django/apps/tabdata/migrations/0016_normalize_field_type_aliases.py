"""
Data migration: normalize historical field_type aliases.

Renames:
  - single_select → select
  - multiple_select → multi_select

Safe to re-run (WHERE clause is idempotent).
"""
from django.db import migrations


def normalize_field_type_aliases(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    TableField = apps.get_model('tabdata', 'TableField')

    updated_select = TableField.objects.using(db_alias).filter(
        field_type='single_select',
    ).update(field_type='select')

    updated_multi = TableField.objects.using(db_alias).filter(
        field_type='multiple_select',
    ).update(field_type='multi_select')

    if updated_select or updated_multi:
        print(
            f"\n  [0016] Normalized field_type aliases: "
            f"single_select→select ({updated_select}), "
            f"multiple_select→multi_select ({updated_multi})"
        )


def reverse_normalize(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    TableField = apps.get_model('tabdata', 'TableField')

    TableField.objects.using(db_alias).filter(
        field_type='select',
    ).update(field_type='single_select')

    TableField.objects.using(db_alias).filter(
        field_type='multi_select',
    ).update(field_type='multiple_select')


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0015_remove_webhook_created_by_fk_constraint'),
    ]

    operations = [
        migrations.RunPython(
            normalize_field_type_aliases,
            reverse_code=reverse_normalize,
        ),
    ]

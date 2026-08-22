from django.db import migrations
from django.db.migrations.exceptions import IrreversibleError


LEGACY_GRANT_TABLES = (
    "tabtinspace_delegation_grant",
    "tabtinspace_space_share",
)


def drop_legacy_space_grants(apps, schema_editor):
    """Delete retired Space-level grant rows, then drop their tables.

    Rollback boundary: SF-1 retires the product surface before launch, so old
    SpaceShare/DelegationGrant rows are intentionally not preserved. Reverting
    requires a database backup if those rows must be inspected.
    """
    connection = schema_editor.connection
    db_alias = connection.alias

    with connection.cursor() as cursor:
        existing_tables = set(connection.introspection.table_names(cursor))
        for table_name in LEGACY_GRANT_TABLES:
            if table_name not in existing_tables:
                continue
            model_label = "DelegationGrant" if "delegation" in table_name else "SpaceShare"
            model = apps.get_model("tabtinspace", model_label)
            model.objects.using(db_alias).all().delete()
            quoted_table = connection.ops.quote_name(table_name)
            if connection.vendor == "postgresql":
                cursor.execute(f"DROP TABLE IF EXISTS {quoted_table} CASCADE")
            else:
                cursor.execute(f"DROP TABLE IF EXISTS {quoted_table}")


def reverse_drop_legacy_space_grants(apps, schema_editor):
    raise IrreversibleError(
        "SF-1 removed SpaceShare/DelegationGrant rows and tables. "
        "Restore from database backup if old rows are needed."
    )


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0065_space_type_bot_only_choices"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(drop_legacy_space_grants, reverse_drop_legacy_space_grants),
            ],
            state_operations=[
                migrations.DeleteModel(name="DelegationGrant"),
                migrations.DeleteModel(name="SpaceShare"),
            ],
        ),
    ]

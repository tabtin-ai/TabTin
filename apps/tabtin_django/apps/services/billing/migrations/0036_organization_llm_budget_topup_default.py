from decimal import Decimal

import django.core.validators
from django.db import migrations, models


TABLE_NAME = "services_billing_organization_llm_monthly_budget"
COLUMN_NAME = "topup_credits"


def ensure_topup_credits_column(apps, schema_editor):
    """Bring DB schema in line even if ACK already has the column without a default."""
    OrganizationLlmMonthlyBudget = apps.get_model("billing", "OrganizationLlmMonthlyBudget")
    connection = schema_editor.connection
    with connection.cursor() as cursor:
        existing_columns = {
            column.name
            for column in connection.introspection.get_table_description(cursor, TABLE_NAME)
        }

    field = models.DecimalField(
        max_digits=20,
        decimal_places=8,
        default=Decimal("0"),
        validators=[django.core.validators.MinValueValidator(Decimal("0"))],
        verbose_name="本月自动补充累计量（credits）",
    )
    field.set_attributes_from_name(COLUMN_NAME)

    if COLUMN_NAME not in existing_columns:
        schema_editor.add_field(OrganizationLlmMonthlyBudget, field)

    if connection.vendor == "postgresql":
        quoted_table = schema_editor.quote_name(TABLE_NAME)
        quoted_column = schema_editor.quote_name(COLUMN_NAME)
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {quoted_table} SET {quoted_column} = %s WHERE {quoted_column} IS NULL",
                [Decimal("0")],
            )
            cursor.execute(
                f"ALTER TABLE {quoted_table} ALTER COLUMN {quoted_column} SET DEFAULT %s",
                [Decimal("0")],
            )
            cursor.execute(
                f"ALTER TABLE {quoted_table} ALTER COLUMN {quoted_column} SET NOT NULL"
            )


def noop_reverse(apps, schema_editor):
    """Do not drop the live compatibility column on rollback."""


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0035_alter_billingbudgetpolicy_options_and_more"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(ensure_topup_credits_column, noop_reverse),
            ],
            state_operations=[
                migrations.AddField(
                    model_name="organizationllmmonthlybudget",
                    name="topup_credits",
                    field=models.DecimalField(
                        decimal_places=8,
                        default=Decimal("0"),
                        max_digits=20,
                        validators=[django.core.validators.MinValueValidator(Decimal("0"))],
                        verbose_name="本月自动补充累计量（credits）",
                    ),
                ),
            ],
        ),
    ]

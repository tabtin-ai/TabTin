import importlib
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock


migration = importlib.import_module(
    "apps.services.billing.migrations.0037_llm_quota_only_auto_topup"
)


class EnsureAutoTopupColumnsTests(TestCase):
    def test_adds_only_missing_columns(self):
        schema_editor, added_fields = self._schema_editor(
            existing_columns={"auto_topup_enabled"}
        )

        migration.ensure_auto_topup_columns(self._apps(), schema_editor)

        self.assertEqual(
            added_fields,
            [
                "auto_topup_credits",
                "auto_topup_threshold_credits",
                "auto_topup_monthly_cap_credits",
            ],
        )

    def test_does_not_add_columns_when_all_already_exist(self):
        schema_editor, added_fields = self._schema_editor(
            existing_columns={
                "auto_topup_enabled",
                "auto_topup_credits",
                "auto_topup_threshold_credits",
                "auto_topup_monthly_cap_credits",
            }
        )

        migration.ensure_auto_topup_columns(self._apps(), schema_editor)

        self.assertEqual(added_fields, [])

    def test_adds_all_columns_to_clean_schema(self):
        schema_editor, added_fields = self._schema_editor(existing_columns=set())

        migration.ensure_auto_topup_columns(self._apps(), schema_editor)

        self.assertEqual(
            added_fields,
            [
                "auto_topup_enabled",
                "auto_topup_credits",
                "auto_topup_threshold_credits",
                "auto_topup_monthly_cap_credits",
            ],
        )

    @staticmethod
    def _apps():
        model = type(
            "HistoricalOrganizationBillingPolicy",
            (),
            {"_meta": SimpleNamespace(db_table="services_billing_organization_policy")},
        )
        apps = MagicMock()
        apps.get_model.return_value = model
        return apps

    @staticmethod
    def _schema_editor(existing_columns):
        connection = MagicMock()
        connection.introspection.get_table_description.return_value = [
            SimpleNamespace(name=column_name) for column_name in existing_columns
        ]
        added_fields = []
        schema_editor = MagicMock(connection=connection)
        schema_editor.add_field.side_effect = (
            lambda _model, field: added_fields.append(field.name)
        )
        return schema_editor, added_fields

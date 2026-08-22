from importlib import import_module
from types import SimpleNamespace
from unittest.mock import MagicMock

from django.test import SimpleTestCase


migration = import_module(
    "apps.services.llm.migrations.0061_custom_chat_json_mode_capability"
)


class CustomModelCapabilityMigrationTests(SimpleTestCase):
    def test_backfill_targets_only_personal_and_organization_chat_models(self):
        model = SimpleNamespace(
            capabilities_config={"supports_streaming": True},
            save=MagicMock(),
        )
        queryset = MagicMock()
        queryset.iterator.return_value = [model]
        manager = MagicMock()
        manager.filter.return_value = queryset
        historical_model = SimpleNamespace(objects=manager)
        apps = MagicMock()
        apps.get_model.return_value = historical_model

        migration.backfill_custom_chat_json_mode(apps, schema_editor=None)

        manager.filter.assert_called_once_with(
            provider__scope__in=["user", "organization"],
            capability_domain="chat",
        )
        self.assertTrue(model.capabilities_config["supports_json_mode"])
        self.assertEqual(
            model.capabilities_config["json_mode"]["modes"],
            ["json_object"],
        )
        model.save.assert_called_once_with(
            update_fields=["capabilities_config", "updated_at"]
        )

    def test_backfill_replaces_legacy_false_with_the_product_default(self):
        original = {"supports_json_mode": False, "supports_streaming": True}

        result = migration.merge_custom_chat_json_mode(original)

        self.assertTrue(result["supports_json_mode"])
        self.assertEqual(result["json_mode"]["modes"], ["json_object"])

from importlib import import_module
from types import SimpleNamespace
from unittest.mock import MagicMock

from django.test import SimpleTestCase


migration = import_module(
    "apps.services.llm.migrations.0060_glm47_json_mode_capability"
)


class Glm47CapabilityMigrationTests(SimpleTestCase):
    def test_merge_preserves_unrelated_capability_metadata(self):
        original = {
            "wire": {"stream_supported": True},
            "json_mode": {"modes": ["vendor_json"], "keep": True},
            "custom": {"keep": True},
        }

        result = migration.merge_glm47_json_mode(original)

        self.assertTrue(result["supports_json_mode"])
        self.assertEqual(
            result["json_mode"]["modes"],
            ["vendor_json", "json_object"],
        )
        self.assertTrue(result["json_mode"]["keep"])
        self.assertEqual(result["custom"], {"keep": True})
        self.assertNotIn("supports_json_mode", original)

    def test_backfill_filters_by_official_provider_type_and_model_code(self):
        model = SimpleNamespace(
            capabilities_config={"custom": {"keep": True}},
            save=MagicMock(),
        )
        queryset = MagicMock()
        queryset.iterator.return_value = [model]
        manager = MagicMock()
        manager.filter.return_value = queryset
        historical_model = SimpleNamespace(objects=manager)
        apps = MagicMock()
        apps.get_model.return_value = historical_model

        migration.backfill_glm47_json_mode(apps, schema_editor=None)

        manager.filter.assert_called_once_with(
            provider__scope="global",
            provider__name="zhipu",
            model_name="glm-4.7",
        )
        self.assertTrue(model.capabilities_config["supports_json_mode"])
        self.assertEqual(
            model.capabilities_config["json_mode"]["modes"],
            ["json_object"],
        )
        self.assertEqual(model.capabilities_config["custom"], {"keep": True})
        model.save.assert_called_once_with(
            update_fields=["capabilities_config", "updated_at"]
        )

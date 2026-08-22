from django.test import SimpleTestCase

from apps.services.llm.utils.custom_model_capabilities import (
    ensure_custom_chat_json_capability,
    ensure_known_provider_chat_capabilities,
    resolve_known_provider_chat_max_output_tokens,
)


class CustomModelCapabilityDefaultsTests(SimpleTestCase):
    def test_registers_json_object_and_preserves_unrelated_metadata(self):
        original = {
            "supports_streaming": True,
            "json_mode": {"modes": ["vendor_json"], "keep": True},
        }

        result = ensure_custom_chat_json_capability(original)

        self.assertTrue(result["supports_json_mode"])
        self.assertEqual(
            result["json_mode"]["modes"],
            ["vendor_json", "json_object"],
        )
        self.assertTrue(result["json_mode"]["keep"])
        self.assertNotIn("supports_json_mode", original)

    def test_replaces_legacy_false_with_the_product_default(self):
        result = ensure_custom_chat_json_capability({
            "supports_json_mode": False,
            "supports_streaming": True,
        })

        self.assertTrue(result["supports_json_mode"])
        self.assertEqual(result["json_mode"]["modes"], ["json_object"])

    def test_known_provider_profile_fills_only_missing_capabilities(self):
        original = {
            "tool": {"enabled": False},
        }

        result = ensure_known_provider_chat_capabilities(
            provider_name="openai",
            config=original,
        )

        self.assertNotIn("supports_function_calling", result)
        self.assertEqual(result["tool"], {"enabled": False})
        self.assertTrue(result["supports_streaming"])
        self.assertNotIn("supports_streaming", original)

    def test_unknown_provider_is_not_inferred(self):
        original = {"supports_streaming": True}

        result = ensure_known_provider_chat_capabilities(
            provider_name="private-gateway",
            config=original,
        )

        self.assertEqual(result, original)
        self.assertIsNone(
            resolve_known_provider_chat_max_output_tokens(
                provider_name="private-gateway",
                context_window_tokens=200_000,
                explicit_max_output_tokens=None,
            )
        )

    def test_known_provider_output_default_preserves_explicit_value(self):
        self.assertEqual(
            resolve_known_provider_chat_max_output_tokens(
                provider_name="openai",
                context_window_tokens=200_000,
                explicit_max_output_tokens=None,
            ),
            16_384,
        )
        self.assertEqual(
            resolve_known_provider_chat_max_output_tokens(
                provider_name="openai",
                context_window_tokens=200_000,
                explicit_max_output_tokens=8_192,
            ),
            8_192,
        )

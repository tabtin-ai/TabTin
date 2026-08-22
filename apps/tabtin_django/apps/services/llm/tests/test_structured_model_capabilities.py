from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.utils.capabilities import get_model_limit, resolve_model_capabilities


class StructuredModelCapabilitiesTest(SimpleTestCase):
    def test_structured_image_capability_drives_catalog_compatibility_flag(self):
        model = SimpleNamespace(
            capabilities_config={
                "image": {"enabled": True},
                "supports_vision": False,
            },
        )

        resolved = resolve_model_capabilities(model)

        self.assertTrue(resolved["supports_vision"])

    def test_structured_tool_and_stream_capabilities_drive_compatibility_flags(self):
        model = SimpleNamespace(
            capabilities_config={
                "wire": {"stream_supported": True},
                "tool": {"enabled": True},
            },
        )

        resolved = resolve_model_capabilities(model)

        self.assertTrue(resolved["supports_streaming"])
        self.assertTrue(resolved["supports_function_calling"])

    def test_structured_limits_are_runtime_limits(self):
        model = SimpleNamespace(
            multimodal_limits={},
            capabilities_config={
                "limits": {
                    "max_documents_per_request": 3,
                    "request_payload_max_mb": 20,
                },
            },
        )

        self.assertEqual(get_model_limit(model, "max_documents_per_request"), 3)
        self.assertEqual(get_model_limit(model, "request_payload_max_mb"), 20)

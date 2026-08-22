"""Phase 2 W2e —— Catalog Runtime Profile capability exposure."""

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.catalog import (
    serialize_runtime_profile_for_client,
)
from apps.services.llm.services.factory import (
    _build_global_runtime_profile_peers,
    _serialize_runtime_controls_for_client,
    _serialize_runtime_profile_for_client,
)


class CatalogRuntimeProfileExposureTests(SimpleTestCase):

    def test_model_with_runtime_profile_declaration(self):
        payload = serialize_runtime_profile_for_client({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["low", "medium", "high"],
                    "default_effort": "medium",
                    "off_supported": True,
                },
            },
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "reasoning_effort",
                },
            },
        })
        thinking = payload["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["off", "standard", "deep"])
        self.assertEqual(thinking["default_mode"], "standard")
        self.assertNotIn("param_path", thinking)
        self.assertNotIn("effort_levels", thinking)

    def test_model_without_capability_hidden(self):
        payload = serialize_runtime_profile_for_client({
            "wire_adapter": {
                "reasoning": {"enabled": False},
            },
        })
        thinking = payload["thinking"]
        self.assertFalse(thinking["supported"])
        self.assertEqual(thinking["modes"], [])
        self.assertEqual(thinking["default_mode"], "standard")

    def test_forced_thinking_hides_off_mode(self):
        payload = serialize_runtime_profile_for_client({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": False,
                    "effort_levels": ["low", "high", "max"],
                    "default_effort": "high",
                },
            },
        })
        thinking = payload["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["standard", "deep"])
        self.assertNotIn("off", thinking["modes"])
        self.assertEqual(thinking["default_mode"], "deep")

    def test_max_only_when_declared_still_exposes_product_modes(self):
        """max 是高级 effort，不是 thinking_mode；Catalog 只暴露三档产品语言。"""
        payload = serialize_runtime_profile_for_client({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["max"],
                    "default_effort": "max",
                    "off_supported": True,
                },
            },
        })
        thinking = payload["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["off", "standard", "deep"])
        self.assertEqual(thinking["default_mode"], "deep")
        self.assertNotIn("max", thinking["modes"])

    def test_inferred_fallback_without_declaration(self):
        payload = serialize_runtime_profile_for_client({
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "reasoning_effort",
                },
            },
        })
        thinking = payload["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["off", "standard", "deep"])
        self.assertEqual(thinking["default_mode"], "standard")

    def test_byok_hidden_without_peer(self):
        payload = serialize_runtime_profile_for_client(
            {"wire_adapter": {"reasoning": {"enabled": False}}},
            global_peer_capabilities_config=None,
        )
        self.assertFalse(payload["thinking"]["supported"])
        self.assertEqual(payload["thinking"]["modes"], [])

    def test_byok_inherits_global_same_name(self):
        byok = {"wire_adapter": {"reasoning": {"enabled": False}}}
        peer = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["low", "medium", "high", "max"],
                    "default_effort": "medium",
                    "off_supported": True,
                },
            },
        }
        payload = serialize_runtime_profile_for_client(
            byok,
            global_peer_capabilities_config=peer,
        )
        thinking = payload["thinking"]
        self.assertTrue(thinking["supported"])
        self.assertEqual(thinking["modes"], ["off", "standard", "deep"])
        self.assertEqual(thinking["default_mode"], "standard")

    def test_does_not_expose_provider_or_wire_params(self):
        payload = serialize_runtime_profile_for_client({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["medium", "high"],
                },
            },
            "runtime_controls": [
                {
                    "key": "reasoning_effort",
                    "label": "思考强度",
                    "kind": "select",
                    "param_path": "reasoning_effort",
                },
            ],
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "param_path": "thinking.budget_tokens",
                    "budget_map": {"high": 8000},
                },
            },
        })
        dumped = str(payload)
        self.assertNotIn("param_path", dumped)
        self.assertNotIn("budget_map", dumped)
        self.assertNotIn("wire_adapter", dumped)
        self.assertNotIn("runtime_controls", dumped)


class FactoryCatalogWiringTests(SimpleTestCase):

    def test_factory_wrapper_matches_package_serializer(self):
        cfg = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["medium", "high"],
                    "default_effort": "high",
                },
            },
        }
        self.assertEqual(
            _serialize_runtime_profile_for_client(cfg),
            serialize_runtime_profile_for_client(cfg),
        )

    def test_runtime_controls_still_serialized_alongside(self):
        """旧 runtime_controls 不得被 W2e 删除。"""
        cfg = {
            "runtime_controls": [
                {
                    "key": "reasoning_effort",
                    "label": "思考强度",
                    "kind": "select",
                    "options": [
                        {"value": "medium", "label": "标准"},
                        {"value": "high", "label": "深度"},
                    ],
                },
            ],
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["medium", "high"],
                },
            },
        }
        controls = _serialize_runtime_controls_for_client(cfg, {})
        profile = _serialize_runtime_profile_for_client(cfg)
        self.assertEqual(controls[0]["key"], "reasoning_effort")
        self.assertTrue(profile["thinking"]["supported"])

    def test_build_global_peers_indexes_ready_declared_only(self):
        class _P:
            def __init__(self, pk, scope):
                self.pk = pk
                self.scope = scope

        class _M:
            def __init__(self, model_name, wave_status, capabilities_config):
                self.model_name = model_name
                self.wave_status = wave_status
                self.capabilities_config = capabilities_config

        global_p = _P("g1", "global")
        user_p = _P("u1", "user")
        models_by_provider = {
            "g1": [
                _M(
                    "claude-opus",
                    "ready",
                    {
                        "runtime_profile": {
                            "thinking": {
                                "supported": True,
                                "effort_levels": ["high", "max"],
                            },
                        },
                    },
                ),
                _M("no-declare", "ready", {"wire_adapter": {}}),
                _M(
                    "pending-model",
                    "w2_pending",
                    {
                        "runtime_profile": {
                            "thinking": {
                                "supported": True,
                                "effort_levels": ["medium"],
                            },
                        },
                    },
                ),
            ],
            "u1": [
                _M(
                    "claude-opus",
                    "ready",
                    {
                        "runtime_profile": {
                            "thinking": {
                                "supported": True,
                                "effort_levels": ["low"],
                            },
                        },
                    },
                ),
            ],
        }
        peers = _build_global_runtime_profile_peers(
            models_by_provider,
            [global_p, user_p],
        )
        self.assertIn("claude-opus", peers)
        self.assertNotIn("no-declare", peers)
        self.assertNotIn("pending-model", peers)
        # 只收录 global，不收录 user 声明
        self.assertIn("max", str(peers["claude-opus"]))

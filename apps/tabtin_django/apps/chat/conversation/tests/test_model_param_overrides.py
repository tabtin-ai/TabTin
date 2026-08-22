"""W2b: Session model_param_overrides v2 持久化契约。"""

from django.test import SimpleTestCase

from apps.chat.conversation.api.session import _normalize_model_param_overrides
from apps.services.llm.runtime_profile.persistence import (
    maybe_upgrade_stored_overrides,
    normalize_model_param_overrides_for_storage,
    serialize_model_param_overrides_for_client,
)


class NormalizeModelParamOverridesTests(SimpleTestCase):
    """写路径:v1→v2 / v2 直写 / 非法拒绝 / 禁止双事实源。"""

    def test_v1_write_stores_v2_thinking_mode(self):
        stored = _normalize_model_param_overrides({"reasoning_effort": "high"})
        self.assertEqual(stored["v"], 2)
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertIsNone(stored["reasoning_effort"])

    def test_v1_max_keeps_advanced_override_only(self):
        stored = _normalize_model_param_overrides({"reasoning_effort": "max"})
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertEqual(stored["reasoning_effort"], "max")

    def test_v2_write_round_trip(self):
        stored = _normalize_model_param_overrides({
            "v": 2,
            "thinking_mode": "off",
        })
        self.assertEqual(
            stored,
            {"v": 2, "thinking_mode": "off", "reasoning_effort": None},
        )

    def test_rejects_dual_fact_deep_plus_high(self):
        """deep 已推导 high → 禁止同时落库。"""
        stored = _normalize_model_param_overrides({
            "v": 2,
            "thinking_mode": "deep",
            "reasoning_effort": "high",
        })
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertIsNone(stored["reasoning_effort"])

    def test_null_resets_to_empty(self):
        self.assertEqual(
            _normalize_model_param_overrides({"reasoning_effort": None}),
            {},
        )

    def test_empty_dict_clears(self):
        self.assertEqual(_normalize_model_param_overrides({}), {})

    def test_ignores_other_runtime_params(self):
        stored = _normalize_model_param_overrides({
            "reasoning_effort": "medium",
            "thinking.type": "enabled",
            "service_tier": "priority",
        })
        self.assertEqual(stored["thinking_mode"], "standard")
        self.assertNotIn("service_tier", stored)
        self.assertNotIn("thinking.type", stored)

    def test_strips_context_tier_id_from_storage(self):
        stored = _normalize_model_param_overrides({
            "v": 2,
            "thinking_mode": "deep",
            "context_tier_id": "long_1m",
        })
        self.assertNotIn("context_tier_id", stored)

    def test_rejects_invalid_reasoning_effort_value(self):
        for value in (
            {"provider_specific": True},
            "xhigh",
            "anything",
            12,
        ):
            self.assertIsNone(
                _normalize_model_param_overrides({"reasoning_effort": value}),
                f"value={value!r} 应被拒绝",
            )

    def test_rejects_invalid_thinking_mode(self):
        self.assertIsNone(
            _normalize_model_param_overrides({
                "v": 2,
                "thinking_mode": "ultra",
            }),
        )

    def test_rejects_non_dict(self):
        self.assertIsNone(_normalize_model_param_overrides("high"))


class ClientCompatibilityProjectionTests(SimpleTestCase):
    """读路径:旧客户端仍能看到 reasoning_effort。"""

    def test_old_client_sees_projected_effort_for_deep(self):
        stored = normalize_model_param_overrides_for_storage({
            "v": 2,
            "thinking_mode": "deep",
        })
        projected = serialize_model_param_overrides_for_client(stored)
        self.assertEqual(projected["v"], 2)
        self.assertEqual(projected["thinking_mode"], "deep")
        self.assertEqual(projected["reasoning_effort"], "high")

    def test_empty_storage_projects_none(self):
        self.assertIsNone(serialize_model_param_overrides_for_client({}))
        self.assertIsNone(serialize_model_param_overrides_for_client(None))

    def test_v1_legacy_row_projects_without_mutating_meaning(self):
        projected = serialize_model_param_overrides_for_client(
            {"reasoning_effort": "high"},
        )
        self.assertEqual(projected["thinking_mode"], "deep")
        self.assertEqual(projected["reasoning_effort"], "high")


class SwitchModelPreserveIntentTests(SimpleTestCase):
    """切模型:保留意图;可懒升级;不落 resolved。"""

    def test_maybe_upgrade_v1_to_v2_without_resolver_fields(self):
        upgraded = maybe_upgrade_stored_overrides({"reasoning_effort": "high"})
        self.assertEqual(upgraded["v"], 2)
        self.assertEqual(upgraded["thinking_mode"], "deep")
        self.assertNotIn("resolved", upgraded or {})
        self.assertNotIn("notice", upgraded or {})

    def test_already_v2_needs_no_upgrade(self):
        stored = {
            "v": 2,
            "thinking_mode": "deep",
            "reasoning_effort": None,
        }
        self.assertIsNone(maybe_upgrade_stored_overrides(stored))

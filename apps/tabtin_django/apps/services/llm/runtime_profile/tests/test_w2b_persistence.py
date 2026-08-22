"""Phase 2 W2b —— Backend Persistence Layer 纯函数验收。"""

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.persistence import (
    InvalidModelParamOverrides,
    normalize_model_param_overrides_for_storage,
    serialize_model_param_overrides_for_client,
)


class W2bPersistenceFoundationTests(SimpleTestCase):

    def test_v1_write_to_v2_storage(self):
        stored = normalize_model_param_overrides_for_storage(
            {"reasoning_effort": "low"},
        )
        self.assertEqual(stored["v"], 2)
        self.assertEqual(stored["thinking_mode"], "standard")
        # low 无法由 standard 推导 → 保留高级覆盖(不静默变贵)
        self.assertEqual(stored["reasoning_effort"], "low")

    def test_v2_write_read_projection(self):
        stored = normalize_model_param_overrides_for_storage({
            "v": 2,
            "thinking_mode": "standard",
        })
        self.assertIsNone(stored["reasoning_effort"])
        projected = serialize_model_param_overrides_for_client(stored)
        self.assertEqual(projected["reasoning_effort"], "medium")

    def test_no_dual_source_in_storage(self):
        stored = normalize_model_param_overrides_for_storage({
            "v": 2,
            "thinking_mode": "deep",
            "reasoning_effort": "high",
        })
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertIsNone(stored["reasoning_effort"])

    def test_invalid_raises(self):
        with self.assertRaises(InvalidModelParamOverrides):
            normalize_model_param_overrides_for_storage(
                {"reasoning_effort": "xhigh"},
            )

    def test_performance_profile_preserved_with_thinking(self):
        """Electron PUT: thinking + performance 一并落库，不剥离。"""
        stored = normalize_model_param_overrides_for_storage({
            "v": 2,
            "thinking_mode": "deep",
            "performance_profile": "fast",
        })
        self.assertEqual(stored["v"], 2)
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertEqual(stored["performance_profile"], "fast")
        projected = serialize_model_param_overrides_for_client(stored)
        self.assertEqual(projected["performance_profile"], "fast")
        self.assertEqual(projected["thinking_mode"], "deep")

    def test_performance_profile_only_omits_thinking_mode(self):
        stored = normalize_model_param_overrides_for_storage({
            "performance_profile": "quality",
        })
        self.assertEqual(stored, {
            "v": 2,
            "performance_profile": "quality",
        })
        self.assertNotIn("thinking_mode", stored)
        projected = serialize_model_param_overrides_for_client(stored)
        self.assertEqual(projected, {
            "v": 2,
            "performance_profile": "quality",
        })
        self.assertNotIn("thinking_mode", projected)

    def test_thinking_plus_performance_both_persisted(self):
        stored = normalize_model_param_overrides_for_storage({
            "thinking_mode": "deep",
            "performance_profile": "fast",
        })
        self.assertEqual(stored["v"], 2)
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertEqual(stored["performance_profile"], "fast")

    def test_empty_override_does_not_invent_defaults(self):
        self.assertEqual(normalize_model_param_overrides_for_storage({}), {})
        self.assertEqual(
            normalize_model_param_overrides_for_storage({"v": 2}),
            {},
        )
        self.assertIsNone(serialize_model_param_overrides_for_client({}))

    def test_v1_effort_upgrade_maps_mode_without_redundant_effort(self):
        """v1 high → thinking_mode=deep（意图升级）；不回写可推导的 reasoning_effort。"""
        stored = normalize_model_param_overrides_for_storage(
            {"reasoning_effort": "high"},
        )
        self.assertEqual(stored["v"], 2)
        self.assertEqual(stored["thinking_mode"], "deep")
        self.assertIsNone(stored["reasoning_effort"])

    def test_invalid_performance_profile_raises(self):
        with self.assertRaises(InvalidModelParamOverrides):
            normalize_model_param_overrides_for_storage({
                "v": 2,
                "thinking_mode": "deep",
                "performance_profile": "turbo",
            })

    def test_unknown_keys_still_stripped_but_performance_kept(self):
        stored = normalize_model_param_overrides_for_storage({
            "v": 2,
            "thinking_mode": "deep",
            "performance_profile": "quality",
            "context_tier_id": "tier-1m",
            "foo": "bar",
        })
        self.assertEqual(stored["performance_profile"], "quality")
        self.assertNotIn("context_tier_id", stored)
        self.assertNotIn("foo", stored)

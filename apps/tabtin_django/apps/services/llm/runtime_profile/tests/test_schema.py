"""RuntimeProfile schema:枚举校验、脏数据容错、v1 存量兼容、v2 升级。"""

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.schema import (
    EFFORT_LADDER,
    EFFORT_LEVELS,
    PROFILE_VERSION_V2,
    InvalidRuntimeProfile,
    RuntimeProfile,
    THINKING_MODE_DEEP,
    THINKING_MODE_OFF,
    THINKING_MODE_STANDARD,
    THINKING_MODE_TO_EFFORT,
    parse_profile,
    upgrade_v1_to_v2,
)


class CanonicalValueDomainTests(SimpleTestCase):

    def test_effort_ladder_is_ascending_and_excludes_off(self):
        """resolver 的"就近向下取"依赖阶梯顺序,顺序错了降级方向就反了。"""
        self.assertEqual(EFFORT_LADDER, ("low", "medium", "high", "max"))
        self.assertNotIn("off", EFFORT_LADDER)
        self.assertEqual(EFFORT_LEVELS[0], "off")
        self.assertEqual(EFFORT_LEVELS[1:], EFFORT_LADDER)

    def test_thinking_mode_derivation_table(self):
        """§3.3:三档意图 → canonical effort。"""
        self.assertEqual(THINKING_MODE_TO_EFFORT[THINKING_MODE_OFF], "off")
        self.assertEqual(THINKING_MODE_TO_EFFORT[THINKING_MODE_STANDARD], "medium")
        self.assertEqual(THINKING_MODE_TO_EFFORT[THINKING_MODE_DEEP], "high")


class ParseProfileLenientTests(SimpleTestCase):
    """读路径:脏数据不能让会话打不开。"""

    def test_none_and_empty_give_defaults(self):
        for raw in (None, {}):
            profile = parse_profile(raw)
            self.assertEqual(profile.thinking_mode, THINKING_MODE_STANDARD)
            self.assertIsNone(profile.reasoning_effort)
            self.assertIsNone(profile.context_tier_id)
            self.assertIsNone(profile.max_output_tokens)

    def test_non_dict_falls_back_to_defaults(self):
        for raw in ("high", 42, [1, 2]):
            self.assertEqual(parse_profile(raw), RuntimeProfile())

    def test_full_profile_round_trip(self):
        raw = {
            "v": PROFILE_VERSION_V2,
            "thinking_mode": "deep",
            "reasoning_effort": "max",
            "context_tier_id": "long_1m",
            "max_output_tokens": 32768,
        }
        profile = parse_profile(raw)
        self.assertEqual(profile.thinking_mode, "deep")
        self.assertEqual(profile.reasoning_effort, "max")
        self.assertEqual(profile.context_tier_id, "long_1m")
        self.assertEqual(profile.max_output_tokens, 32768)
        self.assertEqual(profile.version, PROFILE_VERSION_V2)
        self.assertEqual(profile.to_json(), raw)

    def test_to_json_always_writes_v2(self):
        self.assertEqual(
            RuntimeProfile(thinking_mode="off").to_json()["v"],
            PROFILE_VERSION_V2,
        )

    def test_case_and_whitespace_normalized(self):
        profile = parse_profile({
            "thinking_mode": " DEEP ",
            "reasoning_effort": "High",
            "context_tier_id": "  standard  ",
        })
        self.assertEqual(profile.thinking_mode, "deep")
        self.assertEqual(profile.reasoning_effort, "high")
        self.assertEqual(profile.context_tier_id, "standard")

    def test_unknown_thinking_mode_falls_back_to_standard(self):
        self.assertEqual(
            parse_profile({"thinking_mode": "ultra"}).thinking_mode,
            THINKING_MODE_STANDARD,
        )

    def test_vendor_private_effort_is_rejected(self):
        """厂商私有值(xhigh)不属于 canonical 值域,丢弃后回落到意图推导。"""
        profile = parse_profile({"thinking_mode": "deep", "reasoning_effort": "xhigh"})
        self.assertEqual(profile.thinking_mode, "deep")
        self.assertIsNone(profile.reasoning_effort)

    def test_bad_output_budget_values_dropped(self):
        for value in ("abc", 0, -1, True, {"a": 1}):
            self.assertIsNone(
                parse_profile({"max_output_tokens": value}).max_output_tokens,
                f"value={value!r} 应被丢弃",
            )

    def test_numeric_string_output_budget_accepted(self):
        self.assertEqual(
            parse_profile({"max_output_tokens": "8192"}).max_output_tokens,
            8192,
        )

    def test_blank_tier_becomes_none(self):
        self.assertIsNone(parse_profile({"context_tier_id": "   "}).context_tier_id)


class ParseProfileStrictTests(SimpleTestCase):
    """写路径:脏数据不能进库。"""

    def test_strict_rejects_unknown_thinking_mode(self):
        with self.assertRaises(InvalidRuntimeProfile):
            parse_profile({"thinking_mode": "ultra"}, strict=True)

    def test_strict_rejects_vendor_effort(self):
        with self.assertRaises(InvalidRuntimeProfile):
            parse_profile({"reasoning_effort": "xhigh"}, strict=True)

    def test_strict_rejects_bad_output_budget(self):
        for value in ("abc", 0, -1, True):
            with self.assertRaises(InvalidRuntimeProfile, msg=f"value={value!r}"):
                parse_profile({"max_output_tokens": value}, strict=True)

    def test_strict_rejects_non_dict(self):
        with self.assertRaises(InvalidRuntimeProfile):
            parse_profile("high", strict=True)

    def test_strict_accepts_canonical_payload(self):
        profile = parse_profile(
            {"thinking_mode": "off", "reasoning_effort": "off"}, strict=True,
        )
        self.assertEqual(profile.thinking_mode, "off")
        self.assertEqual(profile.reasoning_effort, "off")


class V1LegacyCompatTests(SimpleTestCase):
    """v1 存量:model_param_overrides 里只有 vendor 风格的 reasoning_effort。"""

    def test_v1_high_maps_to_deep_without_override(self):
        profile = parse_profile({"reasoning_effort": "high"})
        self.assertEqual(profile.thinking_mode, THINKING_MODE_DEEP)
        self.assertIsNone(profile.reasoning_effort)

    def test_v1_max_keeps_advanced_override(self):
        profile = parse_profile({"reasoning_effort": "max"})
        self.assertEqual(profile.thinking_mode, THINKING_MODE_DEEP)
        self.assertEqual(profile.reasoning_effort, "max")

    def test_v1_low_keeps_override_to_avoid_silent_cost_up(self):
        profile = parse_profile({"reasoning_effort": "low"})
        self.assertEqual(profile.thinking_mode, THINKING_MODE_STANDARD)
        self.assertEqual(profile.reasoning_effort, "low")

    def test_v1_null_effort_means_model_default(self):
        profile = parse_profile({"reasoning_effort": None})
        self.assertIsNone(profile.reasoning_effort)

    def test_v1_extra_keys_ignored(self):
        """v1 里可能混着别的 override key(verbosity 等),不应影响解析。"""
        profile = parse_profile({
            "reasoning_effort": "low",
            "verbosity": "concise",
            "service_tier": "priority",
        })
        self.assertEqual(profile.reasoning_effort, "low")
        self.assertEqual(profile.thinking_mode, THINKING_MODE_STANDARD)

    def test_v1_xhigh_does_not_enter_canonical(self):
        profile = parse_profile({"reasoning_effort": "xhigh"})
        self.assertEqual(profile.thinking_mode, THINKING_MODE_DEEP)
        self.assertIsNone(profile.reasoning_effort)


class UpgradeV1ToV2Tests(SimpleTestCase):

    def test_upgrade_high(self):
        out = upgrade_v1_to_v2({"reasoning_effort": "high"})
        self.assertEqual(out["v"], PROFILE_VERSION_V2)
        self.assertEqual(out["thinking_mode"], "deep")
        self.assertIsNone(out["reasoning_effort"])

    def test_upgrade_max_preserves_override(self):
        out = upgrade_v1_to_v2({"reasoning_effort": "max"})
        self.assertEqual(out["thinking_mode"], "deep")
        self.assertEqual(out["reasoning_effort"], "max")

    def test_upgrade_already_v2_normalizes(self):
        out = upgrade_v1_to_v2({
            "v": 2,
            "thinking_mode": " DEEP ",
            "reasoning_effort": None,
        })
        self.assertEqual(out["v"], 2)
        self.assertEqual(out["thinking_mode"], "deep")

    def test_upgrade_none_gives_default_v2(self):
        out = upgrade_v1_to_v2(None)
        self.assertEqual(out["v"], 2)
        self.assertEqual(out["thinking_mode"], THINKING_MODE_STANDARD)

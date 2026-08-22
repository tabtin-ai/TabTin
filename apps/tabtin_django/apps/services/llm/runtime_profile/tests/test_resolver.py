"""Resolver 降级矩阵 + 能力读取。

核心不变量:``resolved_effort`` 要么 None(未开启思考),要么 ∈ 该模型
``effort_levels``;任何降级都必须产出可送达 UI 的 downgrade 事件。
"""

from django.test import SimpleTestCase

from apps.services.llm.runtime_profile.capability import (
    ModelRuntimeCapability,
    ThinkingCapability,
    read_model_capability,
)
from apps.services.llm.runtime_profile.resolver import resolve_runtime_profile
from apps.services.llm.runtime_profile.schema import (
    EFFORT_LADDER,
    RuntimeProfile,
    THINKING_MODES,
    parse_profile,
)


def _cap(
    *,
    supported=True,
    off_supported=True,
    levels=("low", "medium", "high"),
    default_effort="medium",
    max_output_tokens=None,
) -> ModelRuntimeCapability:
    return ModelRuntimeCapability(
        thinking=ThinkingCapability(
            supported=supported,
            off_supported=off_supported,
            effort_levels=tuple(levels),
            default_effort=default_effort,
            user_selectable=THINKING_MODES,
        ),
        max_output_tokens=max_output_tokens,
        declared=True,
    )


class IntentDerivationTests(SimpleTestCase):

    def test_thinking_mode_maps_to_effort(self):
        cases = {"off": None, "standard": "medium", "deep": "high"}
        for mode, expected in cases.items():
            resolved = resolve_runtime_profile(
                RuntimeProfile(thinking_mode=mode), _cap(),
            )
            self.assertEqual(resolved.resolved_effort, expected, f"mode={mode}")
            self.assertEqual(resolved.thinking_enabled, expected is not None)
            self.assertEqual(resolved.downgrades, ())

    def test_explicit_effort_overrides_mode(self):
        """高级覆盖优先于 thinking_mode 推导(§3.2)。"""
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="off", reasoning_effort="high"), _cap(),
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_effort, "high")

    def test_context_tier_passes_through_untouched(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(context_tier_id="long_1m"), _cap(),
        )
        self.assertEqual(resolved.context_tier_id, "long_1m")


class ThinkingUnsupportedTests(SimpleTestCase):

    def test_unsupported_model_with_off_intent_is_silent(self):
        """用户本来就没想开 → 不该弹降级提示。"""
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="off"), _cap(supported=False, levels=()),
        )
        self.assertFalse(resolved.thinking_enabled)
        self.assertIsNone(resolved.resolved_effort)
        self.assertEqual(resolved.downgrades, ())

    def test_unsupported_model_with_deep_intent_reports_downgrade(self):
        """用户想开却开不了 → 必须告知,否则就是"点了没反应"。"""
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="deep"),
            _cap(supported=False, levels=()),
            model_label="MiniMax M2",
        )
        self.assertFalse(resolved.thinking_enabled)
        self.assertIsNone(resolved.resolved_effort)
        self.assertEqual(len(resolved.downgrades), 1)
        event = resolved.downgrades[0]
        self.assertEqual(event.reason, "thinking_not_controllable")
        self.assertEqual(event.requested, "high")
        self.assertIn("MiniMax M2", event.message)

    def test_supported_with_empty_levels_is_binary_on(self):
        """空 effort_levels = 无强度梯子，不是「不支持思考」。"""
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="deep"), _cap(levels=()),
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertIsNone(resolved.resolved_effort)
        self.assertEqual(resolved.downgrades, ())
        self.assertEqual(resolved.resolved_thinking_mode, "standard")


class AlwaysThinkingModelTests(SimpleTestCase):
    """K3 类模型:关不掉。"""

    def test_off_intent_falls_back_to_lowest_with_downgrade(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="off"),
            _cap(off_supported=False, levels=("low", "high", "max")),
            model_label="Kimi K3",
        )
        self.assertTrue(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_effort, "low")
        self.assertEqual(resolved.downgrades[0].reason, "thinking_off_unsupported")
        self.assertEqual(resolved.downgrades[0].fallback_to, "low")
        self.assertIn("始终思考", resolved.downgrades[0].message)
        self.assertTrue(resolved.downgraded)
        self.assertEqual(resolved.notice, resolved.downgrades[0].message)
        self.assertEqual(resolved.resolved_thinking_mode, "standard")

    def test_off_intent_on_off_capable_model_is_clean(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(thinking_mode="off"), _cap(off_supported=True),
        )
        self.assertFalse(resolved.thinking_enabled)
        self.assertEqual(resolved.downgrades, ())


class NearestAvailableTests(SimpleTestCase):
    """就近向下取:宁可少花钱,不要静默升到更贵的档。"""

    def test_missing_level_goes_down_not_up(self):
        # 模型只有 low / max;请求 high → 应降到 low,而不是升到 max。
        resolved = resolve_runtime_profile(
            RuntimeProfile(reasoning_effort="high"),
            _cap(levels=("low", "max")),
        )
        self.assertEqual(resolved.resolved_effort, "low")
        self.assertEqual(resolved.downgrades[0].reason, "effort_level_unavailable")
        self.assertEqual(resolved.downgrades[0].requested, "high")

    def test_goes_up_only_when_nothing_below(self):
        # 模型只有 high / max;请求 low → 下方无可用,只能向上。
        resolved = resolve_runtime_profile(
            RuntimeProfile(reasoning_effort="low"),
            _cap(levels=("high", "max")),
        )
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertEqual(resolved.downgrades[0].fallback_to, "high")

    def test_max_request_on_three_level_model_falls_to_high(self):
        """#8791 的 canonical 版本:选 max 落到 high,而不是塌回 medium。"""
        resolved = resolve_runtime_profile(
            RuntimeProfile(reasoning_effort="max"),
            _cap(levels=("low", "medium", "high")),
        )
        self.assertEqual(resolved.resolved_effort, "high")

    def test_deepseek_style_two_level_model_collapses_standard_and_off(self):
        """UI 档数恒定,差异由 resolver 吸收(§5.4 最后一行)。"""
        cap = _cap(off_supported=False, levels=("high", "max"))
        off = resolve_runtime_profile(RuntimeProfile(thinking_mode="off"), cap)
        standard = resolve_runtime_profile(RuntimeProfile(thinking_mode="standard"), cap)
        deep = resolve_runtime_profile(RuntimeProfile(thinking_mode="deep"), cap)
        self.assertEqual(off.resolved_effort, "high")
        self.assertEqual(standard.resolved_effort, "high")
        self.assertEqual(deep.resolved_effort, "high")
        # 三档都能执行,但前两档都带降级说明
        self.assertTrue(off.downgrades)
        self.assertTrue(standard.downgrades)
        self.assertEqual(deep.downgrades, ())

    def test_resolved_effort_always_within_model_levels(self):
        """核心不变量的穷举检查。"""
        level_sets = [
            ("low",), ("max",), ("low", "max"), ("medium", "high"),
            ("low", "medium", "high"), EFFORT_LADDER,
        ]
        for levels in level_sets:
            for requested in EFFORT_LADDER:
                resolved = resolve_runtime_profile(
                    RuntimeProfile(reasoning_effort=requested),
                    _cap(levels=levels),
                )
                self.assertIn(
                    resolved.resolved_effort, levels,
                    f"levels={levels} requested={requested} "
                    f"→ {resolved.resolved_effort!r} 越界",
                )


class OutputBudgetTests(SimpleTestCase):

    def test_none_stays_none(self):
        resolved = resolve_runtime_profile(RuntimeProfile(), _cap(max_output_tokens=8192))
        self.assertIsNone(resolved.max_output_tokens)

    def test_within_ceiling_kept(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(max_output_tokens=4096), _cap(max_output_tokens=8192),
        )
        self.assertEqual(resolved.max_output_tokens, 4096)

    def test_above_ceiling_clamped_with_downgrade(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(max_output_tokens=65536),
            _cap(max_output_tokens=8192),
            model_label="claude-x",
        )
        self.assertEqual(resolved.max_output_tokens, 8192)
        event = next(d for d in resolved.downgrades if d.feature == "output_budget")
        self.assertEqual(event.reason, "output_budget_exceeds_model_max")
        self.assertIn("上限", event.message)
        self.assertTrue(resolved.downgraded)
        self.assertIsNotNone(resolved.notice)

    def test_unknown_ceiling_keeps_user_value(self):
        resolved = resolve_runtime_profile(
            RuntimeProfile(max_output_tokens=65536), _cap(max_output_tokens=None),
        )
        self.assertEqual(resolved.max_output_tokens, 65536)


class ReadModelCapabilityTests(SimpleTestCase):

    def test_declared_runtime_profile_wins(self):
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": False,
                    "effort_levels": ["max", "low", "high"],
                    "default_effort": "high",
                    "user_selectable": ["standard", "deep"],
                },
                "output_budget": {"supported": True, "max": 32768},
            },
            "wire_adapter": {"reasoning": {"enabled": False}},
        })
        self.assertTrue(cap.declared)
        self.assertTrue(cap.thinking.supported)
        self.assertFalse(cap.thinking.off_supported)
        # 声明顺序被规整成 canonical 升序
        self.assertEqual(cap.thinking.effort_levels, ("low", "high", "max"))
        self.assertEqual(cap.thinking.default_effort, "high")
        self.assertEqual(cap.thinking.user_selectable, ("standard", "deep"))
        self.assertEqual(cap.max_output_tokens, 32768)

    def test_declared_levels_drop_off_and_garbage(self):
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["off", "low", "xhigh", 42, None],
                },
            },
        })
        self.assertEqual(cap.thinking.effort_levels, ("low",))
        self.assertEqual(cap.thinking.default_effort, "low")

    def test_declared_supported_without_levels_is_binary_thinking(self):
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": [],
                    "user_selectable": ["off", "standard"],
                },
            },
        })
        self.assertTrue(cap.thinking.supported)
        self.assertFalse(cap.thinking.effort_supported)
        self.assertEqual(cap.thinking.effort_levels, ())
        self.assertEqual(cap.thinking.user_selectable, ("off", "standard"))

    def test_declared_default_effort_outside_levels_takes_lowest(self):
        """不擅自升档:声明了不可用的默认档 → 取最低,不取最高。"""
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "effort_levels": ["medium", "high"],
                    "default_effort": "max",
                },
            },
        })
        self.assertEqual(cap.thinking.default_effort, "medium")

    def test_forced_thinking_hides_off_in_user_selectable_by_default(self):
        """D3: off_supported=false 且未声明 user_selectable → 隐藏关闭。"""
        cap = read_model_capability({
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": False,
                    "effort_levels": ["low", "high", "max"],
                },
            },
        })
        self.assertEqual(cap.thinking.user_selectable, ("standard", "deep"))
        self.assertNotIn("off", cap.thinking.user_selectable)

    def test_byok_inherits_global_peer_declaration(self):
        byok = {
            "wire_adapter": {"reasoning": {"enabled": False}},
        }
        peer = {
            "runtime_profile": {
                "thinking": {
                    "supported": True,
                    "off_supported": False,
                    "effort_levels": ["low", "high", "max"],
                    "default_effort": "high",
                },
            },
        }
        cap = read_model_capability(
            byok, global_peer_capabilities_config=peer,
        )
        self.assertFalse(cap.declared)
        self.assertTrue(cap.inherited)
        self.assertEqual(cap.thinking.effort_levels, ("low", "high", "max"))
        self.assertFalse(cap.thinking.off_supported)

    def test_byok_without_peer_or_wire_is_hidden(self):
        cap = read_model_capability({
            "wire_adapter": {"reasoning": {"enabled": False}},
        })
        self.assertFalse(cap.thinking.supported)
        self.assertFalse(cap.inherited)

    def test_inferred_from_wire_adapter_when_undeclared(self):
        """Phase 1 所有模型的状态:只有 wire_adapter,没有 runtime_profile。"""
        cap = read_model_capability({
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "format": "thinking_block",
                    "param_path": "thinking",
                },
            },
        })
        self.assertFalse(cap.declared)
        self.assertTrue(cap.thinking.supported)
        self.assertEqual(cap.thinking.effort_levels, ("low", "medium", "high"))
        self.assertNotIn(
            "max", cap.thinking.effort_levels,
            "缺省推导不能给出 max —— 会让用户误选一个模型不支持的高价档",
        )

    def test_inferred_unsupported_when_reasoning_disabled(self):
        cap = read_model_capability({
            "wire_adapter": {"reasoning": {"enabled": False, "param_path": "thinking"}},
        })
        self.assertFalse(cap.thinking.supported)

    def test_inferred_unsupported_when_no_request_side_switch(self):
        """响应侧有 reasoning 内容但请求侧无开关 → 不可控。"""
        for param_path in (None, "", "   "):
            cap = read_model_capability({
                "wire_adapter": {
                    "reasoning": {
                        "enabled": True,
                        "format": "reasoning_content_field",
                        "param_path": param_path,
                    },
                },
            })
            self.assertFalse(
                cap.thinking.supported, f"param_path={param_path!r}",
            )

    def test_missing_or_malformed_config_is_safe(self):
        for raw in (None, {}, {"wire_adapter": None}, {"wire_adapter": {"reasoning": []}}, "junk"):
            cap = read_model_capability(raw)
            self.assertFalse(cap.thinking.supported, f"raw={raw!r}")


class EndToEndPureFunctionTests(SimpleTestCase):
    """parse → read capability → resolve 全链路(仍然全是纯函数)。"""

    def test_v1_legacy_payload_on_kimi_like_model(self):
        profile = parse_profile({"reasoning_effort": "high"})
        capability = read_model_capability({
            "wire_adapter": {
                "reasoning": {
                    "enabled": True,
                    "format": "reasoning_content_field",
                    "param_path": "thinking",
                },
            },
        })
        resolved = resolve_runtime_profile(profile, capability, model_label="kimi-k2.6")
        self.assertTrue(resolved.thinking_enabled)
        self.assertEqual(resolved.resolved_effort, "high")
        self.assertEqual(resolved.downgrades, ())

    def test_dirty_payload_does_not_raise(self):
        profile = parse_profile({"thinking_mode": "ultra", "reasoning_effort": "xhigh"})
        resolved = resolve_runtime_profile(profile, _cap())
        # ultra → standard → medium
        self.assertEqual(resolved.resolved_effort, "medium")

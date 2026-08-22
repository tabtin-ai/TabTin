"""W1b-fix · 建议 Md1:9 model 健全测(回归 gate)。

枚举 ``LLMModel.objects.filter(is_active=True, mode='chat')`` 全部 active
chat-capable model,对每个 model:

1. 读 ``utils.capabilities.resolve_for_wire(model, provider=...)`` → ResolvedCapabilities(should not raise)
2. 用 minimal fixture body 跑 ``adapt_request(body, caps, mock_ctx)``
   → 不抛异常 + ``adjusted_body`` 关键字段满足 spec(根据 model 不同期望)

这是 W1c 启动前的回归 gate:任何一个 active model 跑不通 wire_adapter,
本 test fail。

W1b-fix 触发的 4 Block 都是字符串/路径不对齐导致 model 失效但 380 测试假绿,
此测试用 0016/0017/0018 migration patch 数据 + 真 helper 执行,堵住
fixture-only 假绿陷阱。

设计:
- 不连真 DB(SQLite test DB 重建有 INDEX 语法兼容问题,且 prod-db pytest mark
  默认 CI 跳过 → 不能保证回归);
- 改用 0016 PROVIDER_V2_PATCH_MAP + ZENMUX_*_FULL profile 数据构造 9 个
  ResolvedCapabilities 模拟 9 个 active model;
- 关键约束:0018 已 applied 后 MiniMax sms 应是 ``"top_level_system_field"``,
  这是同步 0016 / 0018 后的"权威值",直接断言 patch 字符串就能堵住
  字符串不一致问题。

harness 验收命令 #2 / #3 / #5 还会用真 DB 跑 manage.py shell 一次(读取
真 DB 数据),双向 cross-check。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter import adapt_request
from apps.services.llm.wire_adapter.resolved_capabilities import (
    ResolvedCapabilities,
)


def _load_migration_module(filename: str):
    """从 migration 文件路径直接 importlib 加载(数字开头不能 import)。"""
    django_root = Path(__file__).resolve().parents[5]
    migration_path = (
        django_root / "apps" / "services" / "llm" / "migrations" / filename
    )
    spec = importlib.util.spec_from_file_location(
        f"_llm_w1b_fix_{filename}_module", str(migration_path)
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _ctx(model_name: str):
    obj = MagicMock()
    obj.model_name = model_name
    obj.request_id = "req-sanity-1"
    obj.model_instance = None
    return obj


def _build_caps_from_patch(provider_patch: dict, extras: dict | None = None):
    """从 0016 provider patch + extras 合并构造 ResolvedCapabilities。

    模拟"0015 + 0016 + 0017 + 0018 全部 applied 后"的字段视图。
    extras 含 ZenMux profile 缺失字段或 admin 手工配字段。
    """
    merged = {}
    for key in ("image", "tool", "wire", "caching", "json_mode",
                "reasoning", "usage", "limits"):
        nested = dict(provider_patch.get(key) or {})
        if extras and key in extras:
            nested.update(extras[key])
        merged[key] = nested
    return ResolvedCapabilities.from_json(merged)


# 9 个 active chat-capable model 的 (provider_name, model_name, patch_source) 三元组
# patch_source 标识来自 0016 哪个 patch / 哪个 ZenMux profile。
EXPECTED_ACTIVE_MODELS = [
    # provider, model_name, patch_source
    ("minimax", "MiniMax-M2.5", "MINIMAX_V2_PATCH"),
    ("minimax", "MiniMax-M2.5-highspeed", "MINIMAX_V2_PATCH"),
    ("moonshot", "kimi-k2.6", "MOONSHOT_V2_PATCH"),
    ("moonshot", "kimi-k2.5", "MOONSHOT_V2_PATCH"),
    ("qwen", "qwen3.5-plus", "QWEN_V2_PATCH"),
    ("zenmux", "anthropic/claude-opus-4.6", "ZENMUX_CLAUDE_FULL"),
    ("zenmux", "anthropic/claude-sonnet-4.6", "ZENMUX_CLAUDE_FULL"),
    ("zenmux", "google/gemini-3.1-flash-lite-preview", "ZENMUX_GEMINI_FULL"),
    ("zenmux", "google/gemini-3.1-pro-preview", "ZENMUX_GEMINI_FULL"),
    ("zenmux", "openai/gpt-5.3-chat", "ZENMUX_OPENAI_FULL"),
]


class AllChatCapableModelsSanityTests(SimpleTestCase):
    """枚举 9 个 active chat-capable model 模拟数据,跑 adapt_request 健全测。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.m0016 = _load_migration_module(
            "0016_llm_wire_adapter_capability_fill_v2.py"
        )

    def _get_patch(self, source_name: str) -> dict:
        return getattr(self.m0016, source_name)

    def test_all_chat_capable_models_pass_adapt_request(self):
        """每个 active chat-capable model patch 跑 adapt_request 不抛异常。"""
        failures: list[str] = []
        for provider_name, model_name, patch_source in EXPECTED_ACTIVE_MODELS:
            patch_data = self._get_patch(patch_source)
            try:
                caps = _build_caps_from_patch(patch_data)
            except Exception as exc:  # noqa: BLE001
                failures.append(
                    f"{provider_name}/{model_name} build caps 抛异常: {exc}"
                )
                continue

            ctx = _ctx(model_name)
            body = {
                "messages": [
                    {"role": "system", "content": "You are helpful"},
                    {"role": "user", "content": "hi"},
                ],
            }
            try:
                out, downgrade_events = adapt_request(body, caps, ctx)
            except Exception as exc:  # noqa: BLE001
                failures.append(
                    f"{provider_name}/{model_name} "
                    f"adapt_request 抛异常: {type(exc).__name__}: {exc}"
                )
                continue

            if not isinstance(out, dict):
                failures.append(
                    f"{provider_name}/{model_name} "
                    f"adapt_request 返回 body 非 dict: {type(out)}"
                )
                continue
            if not isinstance(downgrade_events, list):
                failures.append(
                    f"{provider_name}/{model_name} "
                    f"adapt_request 返回 events 非 list"
                )
                continue

            sms = caps.wire.system_message_style
            if sms == "top_level_system_field":
                if "system" not in out:
                    failures.append(
                        f"{provider_name}/{model_name} "
                        f"sms=top_level_system_field 但 body 无 top-level system"
                    )
                    continue
                roles = [m.get("role") for m in out.get("messages", [])]
                if "system" in roles:
                    failures.append(
                        f"{provider_name}/{model_name} "
                        f"sms=top_level_system_field 但 messages 仍含 role=system"
                    )

        self.assertEqual(
            failures,
            [],
            "active chat-capable model 健全测失败:\n" + "\n".join(failures),
        )

    def test_minimax_v2_patch_uses_canonical_system_message_style(self):
        """W1b-fix Block C1 专项:0016 MINIMAX_V2_PATCH 已用权威字符串
        ``top_level_system_field``(0018 同步 DB 真值)。"""
        patch_data = self._get_patch("MINIMAX_V2_PATCH")
        sms = patch_data["wire"]["system_message_style"]
        self.assertEqual(
            sms,
            "top_level_system_field",
            f"0016 MINIMAX_V2_PATCH system_message_style 仍是 {sms!r},"
            "应为权威值 top_level_system_field(W1b-fix Block C1 已修)",
        )

    def test_minimax_caps_truly_hoist_system(self):
        """W1b-fix Block C1 专项:MiniMax caps 跑 adapt_request 真 hoist system。"""
        patch_data = self._get_patch("MINIMAX_V2_PATCH")
        caps = _build_caps_from_patch(patch_data)
        ctx = _ctx("MiniMax-M2.5")
        body = {
            "messages": [
                {"role": "system", "content": "you are helpful"},
                {"role": "user", "content": "hi"},
            ],
        }
        out, _ = adapt_request(body, caps, ctx)
        self.assertEqual(
            out.get("system"),
            "you are helpful",
            "MiniMax system 未被 hoist 到 top-level system 字段",
        )
        roles = [m.get("role") for m in out["messages"]]
        self.assertNotIn(
            "system",
            roles,
            "MiniMax messages 仍含 role=system,hoist 不彻底",
        )

    def test_gemini_caps_thinking_config_extra_body_path(self):
        """W1b-fix Block C2 专项:Gemini reasoning_effort → extra_body 真写入。"""
        patch_data = self._get_patch("ZENMUX_GEMINI_FULL")
        caps = _build_caps_from_patch(patch_data)
        # ZENMUX_GEMINI_FULL.reasoning.enabled=True,param_path=extra_body.google.thinking_config
        self.assertTrue(caps.reasoning.enabled)
        self.assertEqual(
            caps.reasoning.param_path,
            "extra_body.google.thinking_config",
        )
        ctx = _ctx("google/gemini-3.1-pro-preview")
        body = {
            "messages": [{"role": "user", "content": "hi"}],
            "reasoning_effort": "high",
        }
        out, _ = adapt_request(body, caps, ctx)
        self.assertNotIn(
            "reasoning_effort",
            out,
            "Gemini 顶层 reasoning_effort 未被 wire_adapter 删除",
        )
        tc = out.get("extra_body", {}).get("google", {}).get("thinking_config", {})
        self.assertEqual(
            tc.get("thinking_level"),
            "high",
            f"Gemini extra_body.google.thinking_config.thinking_level 错误: {tc!r}",
        )
        self.assertTrue(
            tc.get("include_thoughts"),
            "Gemini include_thoughts 未注入",
        )

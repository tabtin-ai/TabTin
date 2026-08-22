"""legacy_env.py 单元测试。

覆盖 W11 命名迁移的三个核心能力：
1. 新名优先；新名缺失时 fallback 到 legacy 名
2. 每个 legacy key 进程内只告警一次（日志 + DeprecationWarning）
3. settings 别名赋值：settings.py 里的显式 legacy 值仍具有更高优先级
"""

from __future__ import annotations

import pytest
from django.test import override_settings

from apps.services.agent_engine import legacy_env as legacy_env_module
from apps.services.agent_engine.legacy_env import (
    LEGACY_PREFIX,
    MISSING,
    NEW_PREFIX,
    agent_engine_env,
    agent_engine_setting,
    alias_legacy_setting_names,
    list_reported_legacy_keys,
)

# testing-only API 使用私有入口
_reset_deprecation_cache = legacy_env_module._reset_deprecation_cache


@pytest.fixture(autouse=True)
def _clear_deprecation_cache():
    """每个 case 前清空告警去重缓存，确保每个 case 独立。"""
    _reset_deprecation_cache()
    yield
    _reset_deprecation_cache()


@pytest.fixture
def warning_recorder(monkeypatch):
    """拦截 legacy_env.logger.warning，返回调用参数列表。

    pytest caplog 默认绑定 root logger 且依赖 handler；不同项目 logging 配置
    下可能捕获不到 module-level logger。直接 mock logger.warning 更可靠地
    验证 "每 key 仅告警一次" 这一核心契约。
    """
    calls: list[str] = []

    def _capture(msg, *args, **kwargs):
        calls.append(msg % args if args else msg)

    monkeypatch.setattr(legacy_env_module.logger, "warning", _capture)
    return calls


class TestAgentEngineEnv:
    """agent_engine_env: 环境变量双名读取。"""

    def test_prefix_constants(self):
        assert NEW_PREFIX == "AGENT_ENGINE_"
        assert LEGACY_PREFIX == "ORCHESTRATION_"

    def test_new_name_wins(self, monkeypatch):
        monkeypatch.setenv("AGENT_ENGINE_TEST_X", "new")
        monkeypatch.setenv("ORCHESTRATION_TEST_X", "legacy")
        assert agent_engine_env("AGENT_ENGINE_TEST_X") == "new"

    def test_legacy_fallback(self, monkeypatch):
        monkeypatch.delenv("AGENT_ENGINE_TEST_Y", raising=False)
        monkeypatch.setenv("ORCHESTRATION_TEST_Y", "legacy")
        assert agent_engine_env("AGENT_ENGINE_TEST_Y") == "legacy"

    def test_default_when_both_missing(self, monkeypatch):
        monkeypatch.delenv("AGENT_ENGINE_TEST_Z", raising=False)
        monkeypatch.delenv("ORCHESTRATION_TEST_Z", raising=False)
        assert agent_engine_env("AGENT_ENGINE_TEST_Z", "fallback") == "fallback"

    def test_deprecation_emitted_once_per_process(
        self, monkeypatch, warning_recorder,
    ):
        monkeypatch.delenv("AGENT_ENGINE_TEST_DEP", raising=False)
        monkeypatch.setenv("ORCHESTRATION_TEST_DEP", "1")

        with pytest.warns(DeprecationWarning) as record:
            assert agent_engine_env("AGENT_ENGINE_TEST_DEP") == "1"
            assert agent_engine_env("AGENT_ENGINE_TEST_DEP") == "1"

        env_warns = [w for w in record if "ORCHESTRATION_TEST_DEP" in str(w.message)]
        assert len(env_warns) == 1, \
            "每进程每 legacy key 只应发一次 DeprecationWarning"

        env_logs = [msg for msg in warning_recorder if "ORCHESTRATION_TEST_DEP" in msg]
        assert len(env_logs) == 1, "每进程每 legacy key 只应 WARN 一次"

    def test_explicit_legacy_name(self, monkeypatch):
        """`legacy_name=` 参数可覆盖默认 ORCHESTRATION_ 前缀推导。"""
        monkeypatch.delenv("AGENT_ENGINE_FOO", raising=False)
        monkeypatch.setenv("OLD_CUSTOM_FOO", "custom")
        with pytest.warns(DeprecationWarning):
            assert (
                agent_engine_env("AGENT_ENGINE_FOO", legacy_name="OLD_CUSTOM_FOO")
                == "custom"
            )


class TestAgentEngineSetting:
    """agent_engine_setting: Django settings 双名读取。"""

    @override_settings(AGENT_ENGINE_TEST_A="new")
    def test_new_name_wins(self):
        assert agent_engine_setting("AGENT_ENGINE_TEST_A") == "new"

    @override_settings(ORCHESTRATION_TEST_B="legacy")
    def test_legacy_fallback_when_new_missing(self, warning_recorder):
        with pytest.warns(DeprecationWarning) as record:
            assert agent_engine_setting("AGENT_ENGINE_TEST_B") == "legacy"
        assert any("ORCHESTRATION_TEST_B" in str(w.message) for w in record)
        assert any("ORCHESTRATION_TEST_B" in msg for msg in warning_recorder)

    def test_default_when_both_missing(self):
        sentinel = object()
        result = agent_engine_setting("AGENT_ENGINE_DOES_NOT_EXIST_AT_ALL", sentinel)
        assert result is sentinel

    @override_settings(
        AGENT_ENGINE_TEST_BOTH="new",
        ORCHESTRATION_TEST_BOTH="legacy",
    )
    def test_new_takes_precedence_over_legacy(self, warning_recorder):
        assert agent_engine_setting("AGENT_ENGINE_TEST_BOTH") == "new"
        assert not [m for m in warning_recorder if "ORCHESTRATION_TEST_BOTH" in m], \
            "新名存在时不应打出 legacy 告警"


class TestAliasLegacySettingNames:
    """alias_legacy_setting_names: settings.py 反向别名。"""

    def test_assigns_legacy_from_new(self):
        module_globals = {"AGENT_ENGINE_FOO": 42}
        alias_legacy_setting_names(
            module_globals,
            pairs=[("AGENT_ENGINE_FOO", "ORCHESTRATION_FOO")],
        )
        assert module_globals["ORCHESTRATION_FOO"] == 42

    def test_does_not_overwrite_existing_legacy(self):
        module_globals = {
            "AGENT_ENGINE_FOO": 42,
            "ORCHESTRATION_FOO": 99,  # 运维显式设置的 legacy override
        }
        alias_legacy_setting_names(
            module_globals,
            pairs=[("AGENT_ENGINE_FOO", "ORCHESTRATION_FOO")],
        )
        assert module_globals["ORCHESTRATION_FOO"] == 99, \
            "已显式设置的 legacy 值必须保留，便于过渡期临时回退"

    def test_skips_missing_new_attr(self, warning_recorder):
        module_globals: dict = {}
        alias_legacy_setting_names(
            module_globals,
            pairs=[("AGENT_ENGINE_NOT_SET", "ORCHESTRATION_NOT_SET")],
        )
        assert "ORCHESTRATION_NOT_SET" not in module_globals
        assert any("alias_legacy_setting_names skipped" in m for m in warning_recorder)


class TestIntegrationSettingsPy:
    """验证 settings.py 的 AGENT_ENGINE_* / ORCHESTRATION_* 双向别名真实生效。"""

    def test_litellm_provider_aliases_both_names(self):
        from django.conf import settings

        assert hasattr(settings, "AGENT_ENGINE_LITELLM_PROVIDER_ALIASES"), \
            "settings 必须暴露新名 AGENT_ENGINE_LITELLM_PROVIDER_ALIASES"
        assert hasattr(settings, "ORCHESTRATION_LITELLM_PROVIDER_ALIASES"), \
            "settings 必须同时保留 legacy ORCHESTRATION_LITELLM_PROVIDER_ALIASES"
        assert (
            settings.AGENT_ENGINE_LITELLM_PROVIDER_ALIASES
            == settings.ORCHESTRATION_LITELLM_PROVIDER_ALIASES
        )

    def test_compressor_chars_both_names(self):
        from django.conf import settings
        assert (
            settings.AGENT_ENGINE_COMPRESSOR_MAX_CHARS
            == settings.ORCHESTRATION_COMPRESSOR_MAX_CHARS
        )
        assert (
            settings.AGENT_ENGINE_COMPRESSOR_MAX_INPUT_CHARS
            == settings.ORCHESTRATION_COMPRESSOR_MAX_INPUT_CHARS
        )

    def test_prompt_cache_both_names(self):
        from django.conf import settings
        assert (
            settings.AGENT_ENGINE_PROMPT_CACHE_ENABLED
            == settings.ORCHESTRATION_PROMPT_CACHE_ENABLED
        )
        assert (
            settings.AGENT_ENGINE_PROMPT_CACHE_KEY_SCOPE
            == settings.ORCHESTRATION_PROMPT_CACHE_KEY_SCOPE
        )
        assert (
            settings.AGENT_ENGINE_PROMPT_CACHE_RETENTION
            == settings.ORCHESTRATION_PROMPT_CACHE_RETENTION
        )


class TestEdgeCases:
    """P2 补丁：falsy 值穿透、caller 信息、list_reported、pair 重复。"""

    @override_settings(ORCHESTRATION_FALSY_INT=0)
    def test_legacy_falsy_int_not_swallowed(self, warning_recorder):
        assert agent_engine_setting("AGENT_ENGINE_FALSY_INT", 999) == 0, \
            "legacy=0 必须正确透传，不应被 sentinel 逻辑误判为 '未设置'"

    @override_settings(ORCHESTRATION_EMPTY_STR="")
    def test_legacy_empty_string_not_swallowed(self, warning_recorder):
        assert agent_engine_setting("AGENT_ENGINE_EMPTY_STR", "fallback") == ""

    @override_settings(ORCHESTRATION_FALSE_FLAG=False)
    def test_legacy_false_not_swallowed(self, warning_recorder):
        assert agent_engine_setting("AGENT_ENGINE_FALSE_FLAG", True) is False

    @override_settings(ORCHESTRATION_NONE_EXPLICIT=None)
    def test_legacy_none_is_not_considered_missing(self, warning_recorder):
        """MISSING sentinel 与 None 不同：显式 None 仍应返回 None 而非 default。"""
        sentinel = object()
        assert agent_engine_setting("AGENT_ENGINE_NONE_EXPLICIT", sentinel) is None

    def test_missing_sentinel_is_public(self):
        """MISSING 是公开 API，identity 可用于 is 判断。"""
        assert MISSING is not None
        assert bool(MISSING) is False
        assert repr(MISSING) == "<MISSING>"

    @override_settings(ORCHESTRATION_CALLER_DEMO="value")
    def test_warning_message_includes_caller(self, warning_recorder):
        assert agent_engine_setting("AGENT_ENGINE_CALLER_DEMO") == "value"
        matched = [msg for msg in warning_recorder if "caller=" in msg]
        assert matched, "告警消息必须包含 caller=filename:lineno#function"
        assert "test_legacy_env.py" in matched[0], \
            f"caller 应指向调用测试文件，实际={matched[0]}"

    def test_list_reported_legacy_keys_snapshot(self, monkeypatch, warning_recorder):
        monkeypatch.delenv("AGENT_ENGINE_TRACKED", raising=False)
        monkeypatch.setenv("ORCHESTRATION_TRACKED", "1")
        agent_engine_env("AGENT_ENGINE_TRACKED")
        snapshot = list_reported_legacy_keys()
        assert "env:ORCHESTRATION_TRACKED" in snapshot
        assert isinstance(snapshot, frozenset), \
            "应返回不可变快照，避免外部修改内部状态"

    def test_duplicate_pairs_in_alias(self, warning_recorder):
        module_globals = {"AGENT_ENGINE_DUP": 1}
        alias_legacy_setting_names(
            module_globals,
            pairs=[
                ("AGENT_ENGINE_DUP", "ORCHESTRATION_DUP"),
                ("AGENT_ENGINE_DUP", "ORCHESTRATION_DUP"),
            ],
        )
        dup_warns = [m for m in warning_recorder if "duplicate pair" in m]
        assert dup_warns, "重复 pair 必须发 WARNING"

    def test_alias_conflict_warn_level_upgraded(self, warning_recorder):
        """运维显式设置 legacy 与新名不同值时，应发 WARNING 不是 INFO。"""
        module_globals = {
            "AGENT_ENGINE_CONFLICT": "new",
            "ORCHESTRATION_CONFLICT": "legacy",  # 运维故意 override
        }
        alias_legacy_setting_names(
            module_globals,
            pairs=[("AGENT_ENGINE_CONFLICT", "ORCHESTRATION_CONFLICT")],
        )
        conflict_warns = [
            m for m in warning_recorder
            if "BOTH values observed" in m and "ORCHESTRATION_CONFLICT" in m
        ]
        assert conflict_warns, \
            "legacy 显式 override 新名时应打 WARNING 而非静默，便于运维清理"

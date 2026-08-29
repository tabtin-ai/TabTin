"""
litellm_config.compose_litellm_model_name 单测。

聚焦 dogfood 8f3a3f40 第四轮根因：当 user 配的是 OpenAI 兼容代理网关（zenmux /
openrouter 等多 vendor 路由）时，model_name 的 `<vendor>/<model>` 前缀**不能**
被 LiteLLM 当作内部 provider segment 剥掉——那是上游网关自己的路由 alias。
剥了就撞 upstream 404。
"""
from types import SimpleNamespace

from apps.services.llm.litellm_config import (
    collect_channel_search_hints,
    compose_litellm_model_name,
    get_litellm_provider_set,
    resolve_litellm_provider,
)


# 与 get_litellm_provider_set() 对齐 —— 直接 import 避免硬编码漂移。
KNOWN = get_litellm_provider_set()


class TestComposeLitellmModelNameCustomOpenAIGateway:
    """
    custom_openai 网关路径：model_name 必须原样透传（含所有 vendor 前缀）。

    根因复盘（dogfood 8f3a3f40）：zenmux 注册的 model alias 是
    `anthropic/claude-sonnet-4.6` / `openai/gpt-5.3-chat` / `google/gemini-3.1-...`
    等带 vendor 前缀的完整字符串。原 compose 逻辑会把 `anthropic/openai/gemini`
    等 LiteLLM 已知 provider 前缀剥掉，导致发给 zenmux 的 model 字段变成
    `claude-sonnet-4.6` —— zenmux 没注册这个 alias，回 404。

    此测试族固化"custom_openai 路径必须原样透传"的契约。
    """

    def test_anthropic_prefix_preserved_under_custom_openai(self):
        """anthropic/ 前缀（LiteLLM 已知 provider）在 custom_openai 路径下必须保留。"""
        result = compose_litellm_model_name(
            model_name="anthropic/claude-sonnet-4.6",
            litellm_provider="custom_openai",
            known_providers=KNOWN,
        )
        # custom_openai/ 是 LiteLLM 内部识别用，剥掉后发给上游的 model 字段
        # 应该是完整的 `anthropic/claude-sonnet-4.6`，不能丢前缀。
        assert result == "custom_openai/anthropic/claude-sonnet-4.6"

    def test_openai_prefix_preserved_under_custom_openai(self):
        """openai/ 前缀同样必须保留（zenmux 注册的是 openai/gpt-5.3-chat）。"""
        result = compose_litellm_model_name(
            model_name="openai/gpt-5.3-chat",
            litellm_provider="custom_openai",
            known_providers=KNOWN,
        )
        assert result == "custom_openai/openai/gpt-5.3-chat"

    def test_google_prefix_preserved_under_custom_openai(self):
        """google/ 不是 LiteLLM 已知 provider（LiteLLM 用 gemini），但作为对照
        断言它在 custom_openai 路径下也走原样透传——逻辑统一不分叉。
        """
        result = compose_litellm_model_name(
            model_name="google/gemini-3.1-flash-lite-preview",
            litellm_provider="custom_openai",
            known_providers=KNOWN,
        )
        assert result == "custom_openai/google/gemini-3.1-flash-lite-preview"

    def test_no_prefix_under_custom_openai(self):
        """裸 model_name（无前缀）也应当被 custom_openai 包一层。"""
        result = compose_litellm_model_name(
            model_name="grok-4",
            litellm_provider="custom_openai",
            known_providers=KNOWN,
        )
        assert result == "custom_openai/grok-4"


class TestComposeLitellmModelNameDirectProviders:
    """
    LiteLLM 直连 provider（anthropic / openai / gemini / minimax 等）：
    model_name 的 vendor 前缀**应该**被剥掉，只发 raw model name 给上游。

    custom_openai 修复不能影响这条主路径。
    """

    def test_anthropic_direct_strips_prefix(self):
        """anthropic 直连：anthropic/claude-sonnet-4.6 → anthropic/claude-sonnet-4.6
        不变，因为 prefix 已经匹配 litellm_provider，相当于 no-op。
        """
        result = compose_litellm_model_name(
            model_name="anthropic/claude-sonnet-4.6",
            litellm_provider="anthropic",
            known_providers=KNOWN,
        )
        assert result == "anthropic/claude-sonnet-4.6"

    def test_openai_direct_known_prefix_replaced(self):
        """openai 直连：openai/gpt-5.3-chat → openai/gpt-5.3-chat 不变。"""
        result = compose_litellm_model_name(
            model_name="openai/gpt-5.3-chat",
            litellm_provider="openai",
            known_providers=KNOWN,
        )
        assert result == "openai/gpt-5.3-chat"

    def test_unknown_prefix_kept_with_litellm_provider_added(self):
        """未知前缀（譬如 google/）：保留原 model_name 并加 litellm_provider/ 前缀。
        这是兼容路径——已有功能，不能因 custom_openai 修复而回归。
        """
        result = compose_litellm_model_name(
            model_name="google/gemini-3.1-flash-lite-preview",
            litellm_provider="gemini",
            known_providers=KNOWN,
        )
        assert result == "gemini/google/gemini-3.1-flash-lite-preview"

    def test_no_prefix_no_litellm_provider(self):
        """完全未知组合：model_name 原样返回。"""
        result = compose_litellm_model_name(
            model_name="custom-model-x",
            litellm_provider=None,
            known_providers=KNOWN,
        )
        assert result == "custom-model-x"

    def test_empty_model_name(self):
        """空 model_name：edge case，原样返回（不构造 litellm_provider/ 空串）。"""
        result = compose_litellm_model_name(
            model_name="",
            litellm_provider="anthropic",
            known_providers=KNOWN,
        )
        assert result == ""

    def test_whitespace_only_model_name(self):
        """只含空白的 model_name：trim 后视同空。"""
        result = compose_litellm_model_name(
            model_name="   ",
            litellm_provider="anthropic",
            known_providers=KNOWN,
        )
        assert result == ""


class TestKnownProviderSetContainsCriticalProviders:
    """断言 known_providers 集合包含关键 provider，避免未来调整集合时让上面
    的契约测试静默通过（譬如有人删掉 'custom_openai'，custom_openai 短路就
    永远进不去，bug 就回归了）。"""

    def test_custom_openai_is_known(self):
        assert "custom_openai" in KNOWN

    def test_anthropic_is_known(self):
        assert "anthropic" in KNOWN

    def test_openai_is_known(self):
        assert "openai" in KNOWN


class TestPreloadLitellmInBackground:
    """#3806：启动期后台预热 litellm 惰性导入。"""

    def setup_method(self):
        from apps.services.llm import litellm_config
        litellm_config._PRELOAD_STARTED.clear()

    def teardown_method(self):
        from apps.services.llm import litellm_config
        litellm_config._PRELOAD_STARTED.clear()

    def test_preload_warms_provider_set_in_background(self, monkeypatch):
        from apps.services.llm import litellm_config

        calls = []
        monkeypatch.setattr(
            litellm_config, "get_litellm_provider_set",
            lambda: calls.append(1) or {"openai"},
        )
        thread = litellm_config.preload_litellm_in_background()
        assert thread is not None
        thread.join(timeout=5)
        assert not thread.is_alive()
        assert calls == [1]

    def test_preload_is_idempotent(self, monkeypatch):
        from apps.services.llm import litellm_config

        monkeypatch.setattr(
            litellm_config, "get_litellm_provider_set", lambda: {"openai"},
        )
        first = litellm_config.preload_litellm_in_background()
        second = litellm_config.preload_litellm_in_background()
        assert first is not None
        assert second is None
        first.join(timeout=5)

    def test_preload_failure_is_swallowed(self, monkeypatch):
        from apps.services.llm import litellm_config

        def _boom():
            raise RuntimeError("import failed")

        monkeypatch.setattr(litellm_config, "get_litellm_provider_set", _boom)
        thread = litellm_config.preload_litellm_in_background()
        assert thread is not None
        thread.join(timeout=5)
        assert not thread.is_alive()


class TestCollectChannelSearchHints:
    def test_dashscope_url_wins_over_openai_compatible_name(self):
        hints = collect_channel_search_hints(SimpleNamespace(
            name="dashscope",
            provider_key="dashscope",
            default_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        ))
        assert hints == {"dashscope", "qwen"}

    def test_openrouter_url_does_not_use_openai_catalog(self):
        hints = collect_channel_search_hints(SimpleNamespace(
            name="openai",
            provider_key="openai-openrouter",
            default_base_url="https://openrouter.ai/api/v1",
        ))
        assert hints == {"openrouter"}


class TestLiteLLMChannelSearchFilter:
    def test_keyword_match_stays_inside_channel(self, monkeypatch):
        from apps.services.llm.services.litellm_model_info import LiteLLMModelInfoService

        monkeypatch.setattr(
            LiteLLMModelInfoService,
            "_get_model_database",
            classmethod(lambda cls: {
                "gpt-4o": {"litellm_provider": "openai"},
                "qwen-max": {"litellm_provider": "dashscope"},
                "dashscope/qwen-plus": {"litellm_provider": "dashscope"},
            }),
        )
        matched = LiteLLMModelInfoService.search_models("qwen", provider_hints={"dashscope", "qwen"})
        assert set(matched) == {"qwen-max", "dashscope/qwen-plus"}
        assert "gpt-4o" not in LiteLLMModelInfoService.search_models(
            "gpt", provider_hints={"dashscope", "qwen"},
        )


class TestOpenAICompatibleGatewayKeepsVendorPrefix:
    def test_non_official_openai_compatible_gateway_uses_custom_openai(self):
        resolved = resolve_litellm_provider(
            SimpleNamespace(name="openai", provider_key="openai-ppio"),
            KNOWN,
            model=SimpleNamespace(base_url="https://api.ppio.com/openai/v1"),
        )
        assert resolved == "custom_openai"
        assert compose_litellm_model_name(
            model_name="deepseek/deepseek-v4-flash-vision-exp",
            litellm_provider=resolved,
            known_providers=KNOWN,
        ) == "custom_openai/deepseek/deepseek-v4-flash-vision-exp"

    def test_official_openai_keeps_direct_provider_behavior(self):
        resolved = resolve_litellm_provider(
            SimpleNamespace(name="openai", provider_key="openai"),
            KNOWN,
            model=SimpleNamespace(base_url="https://api.openai.com/v1"),
        )
        assert resolved == "openai"

"""capability_guard 纯函数单元测试。

使用 SimpleTestCase + mock DB 查询，验证 capability_guard 的逻辑。
"""

from types import SimpleNamespace
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase

from ..services.capability_guard import (
    CHAT_MODEL_MODES,
    LLM_CAPABILITY_DOMAIN,
    provider_supports_llm_capability,
    get_llm_capable_provider_names,
    is_chat_model_mode,
    is_llm_model_instance,
    normalize_model_modes,
    pick_first_llm_provider,
)


_DB_DOMAINS = {
    "openai": "chat",
    "minimax": "chat",
    "bytedance": "tts",
    "fal": "image_gen",
    "minimax_bgm": "audio_gen",
}


def _mock_db_lookup(name):
    return _DB_DOMAINS.get(name)


def _patch_db():
    """Mock LLMProvider.objects 以避免实际 DB 访问。

    v0.1.x：
    - ``provider_supports_chat_capability`` 一次 ``values_list('capability_domains')``
      返回 list-of-list，Python 端 union 判断；
    - ``get_chat_capable_provider_names`` 用 ArrayField ``__contains=['chat']``
      过滤，再 ``values_list('name').distinct()`` 收集。
    本 mock 模拟 ArrayField 语义：值是 list[str]，过滤条件按 list 语义匹配。
    """

    class _ValuesList:
        def __init__(self, items):
            self._items = list(items)

        def __iter__(self):
            return iter(self._items)

        def first(self):
            return self._items[0] if self._items else None

        def distinct(self):
            return _ValuesList(self._items)

    mock_manager = MagicMock()

    def _filter_side_effect(**kwargs):
        name = kwargs.get("name")
        # v0.1.x 后是 ArrayField __contains lookup，传入是 list（如 ['chat']）
        contains = kwargs.get("capability_domains__contains")
        result_qs = MagicMock()

        if name is not None:
            # provider_supports_chat_capability 走这条：返回 list-of-list
            domain = _DB_DOMAINS.get(name)
            domains_list = [[domain]] if domain else []
            result_qs.values_list.return_value = _ValuesList(domains_list)
            return result_qs

        if contains is not None:
            # get_chat_capable_provider_names 走这条：ArrayField __contains
            target = contains[0] if contains else None
            matching = [n for n, d in _DB_DOMAINS.items() if d == target]
            result_qs.values_list.return_value = _ValuesList(matching)
            return result_qs

        return result_qs

    mock_manager.filter.side_effect = _filter_side_effect
    return patch("apps.services.llm.models.LLMProvider.objects", mock_manager)


class TestProviderSupportsLlmCapability(SimpleTestCase):

    def test_llm_provider_returns_true(self):
        with _patch_db():
            self.assertTrue(provider_supports_llm_capability("openai"))
            self.assertTrue(provider_supports_llm_capability("minimax"))

    def test_non_llm_provider_returns_false(self):
        with _patch_db():
            self.assertFalse(provider_supports_llm_capability("bytedance"))
            self.assertFalse(provider_supports_llm_capability("fal"))
            self.assertFalse(provider_supports_llm_capability("minimax_bgm"))

    def test_none_and_empty_return_true(self):
        self.assertTrue(provider_supports_llm_capability(None))
        self.assertTrue(provider_supports_llm_capability(""))


class TestGetLlmCapableProviderNames(SimpleTestCase):

    def test_returns_only_llm_providers(self):
        with _patch_db():
            names = get_llm_capable_provider_names()
            self.assertEqual(names, {"openai", "minimax"})
            self.assertNotIn("bytedance", names)
            self.assertNotIn("fal", names)


class TestIsChatModelMode(SimpleTestCase):

    def test_chat_modes(self):
        self.assertTrue(is_chat_model_mode("chat"))
        self.assertTrue(is_chat_model_mode("completion"))
        self.assertTrue(is_chat_model_mode("Chat"))
        self.assertTrue(is_chat_model_mode(" completion "))

    def test_non_chat_modes(self):
        self.assertFalse(is_chat_model_mode("embedding"))
        self.assertFalse(is_chat_model_mode("audio_speech"))
        self.assertFalse(is_chat_model_mode("image_generation"))

    def test_none_defaults_to_chat(self):
        self.assertTrue(is_chat_model_mode(None))
        self.assertTrue(is_chat_model_mode(""))


class TestNormalizeModelModes(SimpleTestCase):

    def test_none_returns_none(self):
        self.assertIsNone(normalize_model_modes(None))

    def test_empty_returns_none(self):
        self.assertIsNone(normalize_model_modes([]))
        self.assertIsNone(normalize_model_modes([""]))

    def test_deduplicates_and_sorts(self):
        result = normalize_model_modes(["completion", "chat", "chat", " Completion "])
        self.assertEqual(result, ["chat", "completion"])

    def test_single_mode(self):
        self.assertEqual(normalize_model_modes(["chat"]), ["chat"])


class TestIsLlmModelInstance(SimpleTestCase):
    """v0.1：chat 域 = capability_domain='chat'，原 'llm' 字面量已不存在。"""

    def _make_model(self, provider_domain, model_domain="chat"):
        provider = SimpleNamespace(name="test", capability_domain=provider_domain)
        return SimpleNamespace(provider=provider, capability_domain=model_domain)

    def test_chat_model_passes(self):
        model = self._make_model("chat", "chat")
        self.assertTrue(is_llm_model_instance(model))
        self.assertTrue(is_llm_model_instance(model, require_chat_mode=True))

    def test_chat_provider_with_embedding_model_without_strict(self):
        model = self._make_model("chat", "embedding")
        self.assertTrue(is_llm_model_instance(model))

    def test_chat_provider_with_embedding_model_with_strict(self):
        model = self._make_model("chat", "embedding")
        self.assertFalse(is_llm_model_instance(model, require_chat_mode=True))

    def test_non_chat_provider(self):
        model = self._make_model("tts", "tts")
        self.assertFalse(is_llm_model_instance(model))

    def test_none_model(self):
        self.assertFalse(is_llm_model_instance(None))

    def test_model_without_provider(self):
        model = SimpleNamespace(provider=None, capability_domain="chat")
        self.assertFalse(is_llm_model_instance(model))


class TestPickFirstLlmProvider(SimpleTestCase):

    def test_picks_chat_provider(self):
        providers = [
            SimpleNamespace(name="bytedance", capability_domain="tts"),
            SimpleNamespace(name="openai", capability_domain="chat"),
            SimpleNamespace(name="fal", capability_domain="image_gen"),
        ]
        result = pick_first_llm_provider(providers)
        self.assertEqual(result.name, "openai")

    def test_returns_none_when_no_chat(self):
        providers = [
            SimpleNamespace(name="bytedance", capability_domain="tts"),
            SimpleNamespace(name="fal", capability_domain="image_gen"),
        ]
        result = pick_first_llm_provider(providers)
        self.assertIsNone(result)

    def test_empty_queryset(self):
        result = pick_first_llm_provider([])
        self.assertIsNone(result)


class TestChatModelModesConstant(SimpleTestCase):

    def test_contains_expected_modes(self):
        self.assertIn("chat", CHAT_MODEL_MODES)
        self.assertIn("completion", CHAT_MODEL_MODES)
        self.assertEqual(len(CHAT_MODEL_MODES), 2)

    def test_is_frozenset(self):
        self.assertIsInstance(CHAT_MODEL_MODES, frozenset)

    def test_chat_domain_constant(self):
        # v0.1：旧别名 LLM_CAPABILITY_DOMAIN 仍可导入，但具体值已对齐到 "chat"。
        self.assertEqual(LLM_CAPABILITY_DOMAIN, "chat")

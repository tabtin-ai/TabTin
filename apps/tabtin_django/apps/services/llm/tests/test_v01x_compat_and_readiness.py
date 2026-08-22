"""
v0.1.x 兼容层 + _check_provider_readiness 单测

覆盖：
- LLMProvider/LLMModel.__init__ 兼容已删字段（is_active / mode / max_tokens / base_url 等）
- ORM positional load 不跟兼容层冲突
- _check_provider_readiness 四个分支（routing_enabled / placeholder / capability_domains / base_url）
"""

from unittest import TestCase

import django
django.setup() if not django.apps.apps.ready else None

from apps.services.llm.models import LLMProvider, LLMModel
from apps.services.llm.services._runtime.model_resolver import _check_provider_readiness


class V01xKwargCompatTestCase(TestCase):
    """v0.1.x __init__ 兼容层吃掉已删字段 + max_tokens 重命名。

    用 SimpleTestCase 等价物（unittest.TestCase）—— 不需要 DB，
    只测 __init__ 的 in-memory 行为。
    """

    def test_llm_provider_swallows_deprecated_kwargs(self):
        """v0.1.0 老调用方/老测试用 base_url / is_active 创建 LLMProvider 不应 TypeError。"""
        p = LLMProvider(
            name='_test_compat',
            provider_key='_test_compat_pkey',
            display_name='Test Compat',
            api_key='sk-test',
            base_url='https://api.example.com/v1',  # 已删（migration 0030）
            is_active=True,                          # 已删（0022）
            capability_domains=['chat'],
        )
        # 旧字段不应出现在实例属性里
        self.assertFalse(hasattr(p, 'is_active'))
        # api_key setter 仍工作
        self.assertEqual(p.api_key, 'sk-test')

    def test_llm_model_swallows_deprecated_and_renames_max_tokens(self):
        """v0.1.0 老调用方用 max_tokens / mode / supports_streaming 创建 LLMModel 不应 TypeError，
        且 max_tokens 应自动重命名为 context_window_tokens。"""
        m = LLMModel(
            provider=None,  # 只测 __init__，不进 DB
            model_name='_test_compat_model',
            display_name='Test',
            max_tokens=8000,                # → context_window_tokens
            is_active=True,                 # 已删
            supports_streaming=True,        # 已删
            mode='chat',                    # 已删
            base_url='https://api.example.com/v1',
            capability_domain='chat',
        )
        self.assertEqual(m.context_window_tokens, 8000)

    def test_llm_model_setdefault_base_url(self):
        """v0.1.x：老调用方不传 base_url 时给个默认值（兜底测试场景）。"""
        m = LLMModel(
            model_name='_test_no_base_url',
            display_name='Test',
            context_window_tokens=8000,
        )
        self.assertTrue(m.base_url)
        self.assertTrue(m.base_url.startswith('http'))

    def test_orm_positional_load_no_conflict(self):
        """关键：ORM 从 DB load 实例时走 positional args，
        兼容层的 setdefault('base_url', ...) 不能跟 positional 重复。"""
        # 这里直接用 positional 模拟 ORM from_db 路径
        # （用 None 占位，只测 __init__ 不抛 'got both positional and keyword arguments'）
        try:
            # 模拟 12 个 positional args（按 LLMModel 字段顺序，前几个就够）
            # 真实调用方是 Django ORM iterator，本测试只验"不抛 positional 冲突"
            LLMModel(*([None] * 5))
        except TypeError as e:
            if 'got both positional and keyword arguments' in str(e):
                self.fail(
                    f"v0.1.x 兼容层跟 ORM positional 冲突: {e}"
                )
            # 其他 TypeError 是字段数不对，OK，本测试不关心
        except Exception:
            pass


class CheckProviderReadinessTestCase(TestCase):
    """v0.1.x Phase 2.5 _check_provider_readiness fail-fast 四个分支。"""

    def _make_fake(self, *, routing_enabled=True, api_key='sk-real-key-12345678',
                   capability_domains=None, base_url='https://example.com/v1'):
        provider = LLMProvider(
            name='_fake',
            provider_key='_fake',
            display_name='Fake',
            capability_domains=capability_domains if capability_domains is not None else ['chat'],
            routing_enabled=routing_enabled,
        )
        provider.api_key = api_key
        model = LLMModel(
            provider=provider,
            model_name='_fake',
            display_name='_fake',
            base_url=base_url,
            context_window_tokens=8000,
            capability_domain='chat',
        )
        return model

    def test_routing_disabled(self):
        m = self._make_fake(routing_enabled=False)
        reason = _check_provider_readiness(m, 'chat')
        self.assertIn('routing_enabled=False', reason)
        self.assertIn('AdminDash', reason)

    def test_placeholder_api_key(self):
        m = self._make_fake(api_key='<INSERT_VIA_ADMIN>')
        reason = _check_provider_readiness(m, 'chat')
        self.assertIn('占位符', reason)

    def test_capability_domain_mismatch(self):
        m = self._make_fake(capability_domains=['embedding'])
        reason = _check_provider_readiness(m, 'chat')
        self.assertIn('capability_domains', reason)
        self.assertIn("'chat'", reason)

    def test_empty_base_url(self):
        m = self._make_fake(base_url='')
        reason = _check_provider_readiness(m, 'chat')
        self.assertIn('base_url 为空', reason)
        self.assertIn('/ai/models', reason)

    def test_ready_returns_empty(self):
        """全部就绪时返回空字符串。"""
        m = self._make_fake()
        reason = _check_provider_readiness(m, 'chat')
        self.assertEqual(reason, '')


class ReadinessMetricsTestCase(TestCase):
    """v0.1.x：_check_provider_readiness 必须在 4 个分支 + ready 上各自打 metric，
    否则运营 dashboard 拿不到数据。回归 test。"""

    def _make_fake(self, **kwargs):
        from apps.services.llm.models import LLMProvider, LLMModel
        defaults = dict(routing_enabled=True, api_key='sk-real-key-12345678',
                        capability_domains=['chat'], base_url='https://example.com/v1')
        defaults.update(kwargs)
        provider = LLMProvider(
            name='_metric_fake', provider_key='_metric_fake', display_name='Fake',
            capability_domains=defaults['capability_domains'],
            routing_enabled=defaults['routing_enabled'],
        )
        provider.api_key = defaults['api_key']
        return LLMModel(
            provider=provider, model_name='_metric_fake', display_name='_metric_fake',
            base_url=defaults['base_url'],
            context_window_tokens=8000, capability_domain='chat',
        )

    def _read_counter(self, reason):
        """读 Counter 当前值。"""
        from apps.services.llm.services.llm_metrics import (
            llm_provider_readiness_check_total,
        )
        # prometheus-client Counter 可以通过 _metrics 访问内部 sample
        try:
            sample = llm_provider_readiness_check_total.labels(
                provider='_metric_fake',
                capability_domain='chat',
                reason=reason,
            )
            return sample._value.get()
        except AttributeError:
            return None  # _NullMetric (prometheus_client 不可用)

    def test_each_branch_increments_correct_label(self):
        cases = [
            ('routing_disabled', dict(routing_enabled=False)),
            ('placeholder_api_key', dict(api_key='<INSERT_VIA_ADMIN>')),
            ('empty_base_url', dict(base_url='')),
            ('capability_mismatch', dict(capability_domains=['embedding'])),
            ('ready', dict()),
        ]
        for expected_reason, kwargs in cases:
            before = self._read_counter(expected_reason) or 0
            m = self._make_fake(**kwargs)
            _check_provider_readiness(m, 'chat')
            after = self._read_counter(expected_reason) or 0
            self.assertEqual(
                after, before + 1,
                f"reason={expected_reason} 没正确埋点：before={before} after={after}",
            )

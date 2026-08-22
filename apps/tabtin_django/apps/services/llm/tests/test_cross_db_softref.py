"""跨库软引用通用 helper 单元测试（``apps.services.common.cross_db_softref``）。

借 ``ChatSession.current_model`` / ``ChatMessage.model`` 这两个真实的软引用做
fixture——它们用 LLMModel（PG）作为 target，刚好覆盖跨库场景。

测试矩阵：
- factory 生成的 property 命中缓存 / 缺失 fallback / 写回缓存
- factory 生成的 attach helper 单点 / 批量 / 幂等 / 空列表
- ``LLM_MODEL_CACHE_MISSING`` 哨兵语义（注入 None vs 未注入）
- strict 模式 env 让 fallback raise（CI 模式）
- N+1 防回归：50 条 session 列表只发 1 次 LLMModel SELECT
"""

from __future__ import annotations

import os
import unittest
import unittest.mock as mock
from contextlib import contextmanager

from django.contrib.auth import get_user_model
from django.db import connections
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.chat.conversation.services.llm_model_loader import (
    LLM_MODEL_CACHE_MISSING,
    attach_llm_models_to_messages,
    attach_llm_models_to_sessions,
    set_cached_session_models,
)
from apps.services.common.cross_db_softref import (
    SOFTREF_CACHE_MISSING,
    fetch_softref_targets_map,
    make_attach_helper,
    make_softref_property,
)
from apps.services.llm.models import LLMModel, LLMProvider


User = get_user_model()


@contextmanager
def _strict_softref_env():
    """临时设置 ``TABTIN_SOFTREF_STRICT=1`` 并在 yield 后恢复。"""
    previous = os.environ.get("TABTIN_SOFTREF_STRICT")
    os.environ["TABTIN_SOFTREF_STRICT"] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("TABTIN_SOFTREF_STRICT", None)
        else:
            os.environ["TABTIN_SOFTREF_STRICT"] = previous


# M3b（单库治理）：本文件借 ``ChatSession.current_model`` / ``ChatMessage.model`` 这两个
# LLM 软引用做通用 softref 基础设施的 fixture。它们已在 M3b 恢复为物理 FK，fixture 失效。
# 通用 cross_db_softref 基础设施仍被 space/tracker/tabdata 软引用使用，待 M3b 把最后一个
# 软引用也转成 FK 后，infra 与本测试一并退役。期间整体 skip，避免对着已转 FK 的关系断言旧软引用语义。
@unittest.skip(
    "M3b: current_model/model 已转物理 FK，softref fixture 失效；"
    "infra 待最后一个软引用转 FK 后与本测试一并退役"
)
class CrossDbSoftRefBaseTest(TransactionTestCase):
    """跨库测试基类——包含 LLMModel fixture（PG）+ ChatSession fixture（MySQL）。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create(
            username=f"softref-test-{id(self)}",
            email=f"softref-{id(self)}@test.local",
        )
        self.provider = LLMProvider.objects.create(
            name="test-provider",
            provider_key="test_provider_softref",
            scope="global",
            routing_enabled=True,
        )
        self.model = LLMModel.objects.create(
            provider=self.provider,
            model_name="test-softref-model",
            display_name="Test Softref Model",
        )

    def tearDown(self):
        # 用 raw SQL 清理 ChatSession，避免 GoalRun cross-db cascade 问题（见专题 1 P0-1）
        ChatMessage.objects.filter(session__user=self.user).delete()
        with connections["default"].cursor() as cursor:
            cursor.execute(
                "DELETE FROM chat_session WHERE user_id = %s", [str(self.user.id)]
            )
        self.user.delete()
        self.model.delete()
        self.provider.delete()


# ════════════════════════════════════════════════════════════════════════════
#  Property 行为
# ════════════════════════════════════════════════════════════════════════════


class SoftRefPropertyTest(CrossDbSoftRefBaseTest):
    """``make_softref_property`` 生成的 accessor 行为。"""

    def test_re_export_constants_match(self):
        """``LLM_MODEL_CACHE_MISSING`` 必须 ``is`` 通用 ``SOFTREF_CACHE_MISSING``。"""
        self.assertIs(LLM_MODEL_CACHE_MISSING, SOFTREF_CACHE_MISSING)

    def test_property_returns_none_for_empty_id(self):
        """``id_attr`` 为空时 property 返回 None 且写回缓存。"""
        session = ChatSession.objects.create(user=self.user, organization_id="t")
        self.assertIsNone(session.current_model_id)
        self.assertIsNone(session.current_model)
        # 缓存写回为 None（不是 SOFTREF_CACHE_MISSING）
        self.assertIsNone(session._cached_current_model)

    def test_property_fallback_fetches_and_writes_cache(self):
        """缓存缺失时 fallback fetch 一次 + 写回，第二次访问 ``is`` 命中缓存。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        # 重新 fetch 让缓存为空
        fresh = ChatSession.objects.get(id=session.id)
        self.assertEqual(
            getattr(fresh, "_cached_current_model", SOFTREF_CACHE_MISSING),
            SOFTREF_CACHE_MISSING,
        )
        m1 = fresh.current_model
        m2 = fresh.current_model
        # 关键：第二次访问 is 命中缓存（不是再 fetch 一次）
        self.assertIs(m1, m2, "fallback 没写回缓存（H-2 退化）")
        self.assertEqual(m1.id, self.model.id)

    def test_property_returns_attach_injected_value(self):
        """``attach_*`` 注入缓存后 property 直接返回，不触发 DB 查询。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        fresh = ChatSession.objects.get(id=session.id)
        attach_llm_models_to_sessions([fresh])

        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            value = fresh.current_model
        self.assertEqual(len(ctx.captured_queries), 0, "attach 后 property 不应查 DB")
        self.assertEqual(value.id, self.model.id)

    def test_property_set_raises_attribute_error(self):
        """property 无 setter——业务侧 ``foo.current_model = X`` 必抛错。

        这是有意设计：让 grep 能立刻发现"还在用 FK 赋值"的遗留代码。
        """
        session = ChatSession.objects.create(user=self.user, organization_id="t")
        with self.assertRaises(AttributeError):
            session.current_model = self.model

    def test_strict_mode_raises_on_fallback(self):
        """``TABTIN_SOFTREF_STRICT=1`` 时单点 fallback 不再 warning，直接 raise。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        fresh = ChatSession.objects.get(id=session.id)
        with _strict_softref_env(), self.assertRaises(RuntimeError) as ctx:
            _ = fresh.current_model
        self.assertIn("strict", str(ctx.exception))

    def test_property_handles_target_not_found(self):
        """target 模型实例已删时 property 返回 None（不抛错）。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        # 删 LLMModel 后再访问
        self.model.delete()
        fresh = ChatSession.objects.get(id=session.id)
        self.assertIsNone(fresh.current_model)
        # 缓存写回 None，第二次访问不再 fetch
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            _ = fresh.current_model
        self.assertEqual(len(ctx.captured_queries), 0)


# ════════════════════════════════════════════════════════════════════════════
#  Attach helper 行为
# ════════════════════════════════════════════════════════════════════════════


class SoftRefAttachHelperTest(CrossDbSoftRefBaseTest):

    def test_attach_empty_iterable(self):
        """空 list / generator 不抛错、不查 DB。"""
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            attach_llm_models_to_sessions([])
            attach_llm_models_to_sessions(iter([]))
        self.assertEqual(len(ctx.captured_queries), 0)

    def test_attach_idempotent(self):
        """已注入的 instance 不重复查询。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        attach_llm_models_to_sessions([session])
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            attach_llm_models_to_sessions([session])
        self.assertEqual(
            len(ctx.captured_queries), 0, "已 attach 的 instance 不应重新查询"
        )

    def test_attach_no_n_plus_1_for_50_sessions(self):
        """50 条 session（current/default 都设 model_id）attach 应只发 ≤ 2 条 PG SELECT。

        FK 模式下用 prefetch_related 是 1 条；现在 helper 拆 current/default 各
        一条共 2 条——仍是常数，与 session 数无关。
        """
        sessions = [
            ChatSession.objects.create(
                user=self.user, organization_id="t",
                current_model_id=self.model.id,
                default_model_id=self.model.id,
            )
            for _ in range(50)
        ]
        # 重新 fetch 让缓存为空
        sessions = list(
            ChatSession.objects.filter(id__in=[s.id for s in sessions])
        )
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            attach_llm_models_to_sessions(sessions)
        self.assertLessEqual(
            len(ctx.captured_queries), 2,
            f"attach helper 不该出现 N+1，实际发了 {len(ctx.captured_queries)} 条",
        )
        # 每个 session 都命中缓存
        for s in sessions:
            self.assertIs(s._cached_current_model.id, self.model.id)

    def test_attach_messages_no_n_plus_1(self):
        """50 条 message attach 只发 ≤ 1 条 PG SELECT。"""
        session = ChatSession.objects.create(user=self.user, organization_id="t")
        msgs = [
            ChatMessage.objects.create(
                session=session, role="user", content=f"msg-{i}",
                model_id=self.model.id,
            )
            for i in range(50)
        ]
        msgs = list(ChatMessage.objects.filter(id__in=[m.id for m in msgs]))
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            attach_llm_models_to_messages(msgs)
        self.assertLessEqual(len(ctx.captured_queries), 1)

    def test_attach_marks_missing_targets_as_none(self):
        """target ID 不存在时显式注入 None（不是 SOFTREF_CACHE_MISSING）。"""
        import uuid as _uuid

        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=_uuid.uuid4(),  # 不存在的 ID
        )
        attach_llm_models_to_sessions([session])
        # 已"查过、确定不存在"——必须是 None，不能是 sentinel
        self.assertIsNone(session._cached_current_model)
        self.assertIsNot(session._cached_current_model, SOFTREF_CACHE_MISSING)
        # property 直接返回 None，不再 fallback
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            value = session.current_model
        self.assertIsNone(value)
        self.assertEqual(len(ctx.captured_queries), 0)


# ════════════════════════════════════════════════════════════════════════════
#  Set cache + factory 复用
# ════════════════════════════════════════════════════════════════════════════


class SoftRefCacheSetterTest(CrossDbSoftRefBaseTest):

    def test_set_cached_session_models(self):
        """显式注入缓存（创建 session 时复用已 fetch 的实例）。"""
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
            default_model_id=self.model.id,
        )
        set_cached_session_models(session, current=self.model, default=self.model)
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            _ = session.current_model
            _ = session.default_model
        self.assertEqual(len(ctx.captured_queries), 0)


class FetchSoftrefTargetsMapTest(CrossDbSoftRefBaseTest):

    def test_fetch_filters_empty(self):
        """空 / None / '' 输入返回空 dict，不查 DB。"""
        with CaptureQueriesContext(connections["postgresql"]) as ctx:
            result = fetch_softref_targets_map("llm.LLMModel", [None, "", None])
        self.assertEqual(result, {})
        self.assertEqual(len(ctx.captured_queries), 0)

    def test_fetch_returns_id_string_keys(self):
        """返回 dict 的 key 一律是 str(id)，不管输入 UUID 还是 str。"""
        result = fetch_softref_targets_map("llm.LLMModel", [self.model.id])
        self.assertEqual(set(result.keys()), {str(self.model.id)})
        self.assertEqual(result[str(self.model.id)].id, self.model.id)


class FactoryReuseTest(CrossDbSoftRefBaseTest):
    """验证 factory 可以独立生成新的 attach helper（保证将来 GoalRun.chat_session
    等其他跨库 FK 用同一套 factory 也能工作）。"""

    def test_factory_generates_isolated_helper(self):
        custom_attach = make_attach_helper(
            target_model="llm.LLMModel",
            cache_attr="_my_custom_attr",
            id_attr="current_model_id",
            select_related=("provider",),
        )
        session = ChatSession.objects.create(
            user=self.user, organization_id="t",
            current_model_id=self.model.id,
        )
        custom_attach([session])
        self.assertEqual(getattr(session, "_my_custom_attr").id, self.model.id)
        # 不影响默认的 _cached_current_model
        default_cache = getattr(
            session, "_cached_current_model", SOFTREF_CACHE_MISSING,
        )
        self.assertIs(default_cache, SOFTREF_CACHE_MISSING)

    def test_factory_property_helper_isolation(self):
        """同一个 model 上 factory 生成两个不同 cache_attr 的 property，互不影响。"""
        # 用 mock model 简化，避免动 ChatSession 的 model class 定义
        prop_a = make_softref_property(
            target_model="llm.LLMModel",
            cache_attr="_attr_a",
            id_attr="model_id_a",
        )
        prop_b = make_softref_property(
            target_model="llm.LLMModel",
            cache_attr="_attr_b",
            id_attr="model_id_b",
        )
        # 用临时类模拟双 attr 场景
        class _Holder:
            model_id_a = self.model.id
            model_id_b = None

        _Holder.target_a = prop_a
        _Holder.target_b = prop_b
        h = _Holder()
        self.assertEqual(h.target_a.id, self.model.id)
        self.assertIsNone(h.target_b)

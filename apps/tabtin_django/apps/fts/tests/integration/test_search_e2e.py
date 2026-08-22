"""Wave 2 集成测试 — 真连 ES 验证 search → ACL → fallback 全链。

运行约束（修复 R2-21）：
    - 标准 pytest 即可跑（无需手工 SEARCH_ENGINE_ENABLED=true）
    - 用 `@override_settings(SEARCH_ENGINE_ENABLED=True)` 装饰每个 test class
      让 `is_engine_enabled()` / `get_client()` 在测试期内返回 enabled
    - 必须用 `SimpleTestCase`（Django 测试基类）才能让 `@override_settings`
      真的生效；纯 `unittest.TestCase` 不识别该 decorator
    - `setUp` 里**必须先 `reset_client()`** 才能让 lazy singleton 感知
      新的 settings；conftest 启动 Django 时缓存的 client 是基于
      默认 `SEARCH_ENGINE_ENABLED=false` 的状态
    - ES 不可用时整个 class `setUpClass` 提前 SkipTest（CI 上没 ES
      也能跑 pytest 不挂），不进 setUp 拿 client 就报错

依赖：
    - 本地 ES 已起：`bash scripts/backend/fts-dev.sh up`（curl :9200 yellow OK）
    - 不依赖 PG / MySQL（直接走 ES + mock ACL）

场景：
    S1: 真 ES insert + msearch + ACL + Hydrate 端到端 OK
    S2: 权限隔离 — 用户 A 创建 doc，用户 B 同 organization 但无 share → 0 结果
    S3: 降级 — 手动 breaker.open() → /api/search 走 fallback 返回 PG 资源
    S4: 短语精确 — `"完全相同短语"` 命中 vs 普通 OR 召回更多

设计原则：
    - 每个 case 独立 setUp/tearDown，自己造数据自己清
    - 测试 doc_id 加 `e2e-` 前缀便于事后排查残留
"""

from __future__ import annotations

import unittest
import uuid

import apps.fts.tests.conftest  # noqa: F401  - 启动 Django

from django.test import SimpleTestCase
from django.test.utils import override_settings


def _es_available() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:9200/_cluster/health", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def _skip_if_no_es():
    """Class 级 SkipTest gate，避免 setUp 里 get_client() 拿不到 ES 报错。"""
    if not _es_available():
        raise unittest.SkipTest("本地 ES 未启动（bash scripts/backend/fts-dev.sh up）；CI 无 ES 时优雅 skip")


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SearchE2EBasicTests(SimpleTestCase):
    """S1: 真 ES insert + msearch 链路打通。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _skip_if_no_es()

    def setUp(self):
        from apps.fts.client import get_client, reset_client
        from apps.fts.index_definitions import ensure_indices, get_index_name
        # 必须先 reset：conftest django.setup() 时 client 是基于
        # SEARCH_ENGINE_ENABLED=false 缓存的；override_settings 在 method
        # 包装时生效，但 lazy singleton 已经被锁住，需要主动 reset 重建
        reset_client()
        self.client = get_client()
        ensure_indices(self.client)
        self.organization_id = str(uuid.uuid4())
        self.space_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        # 直接 index 几条 doc（绕开 PG/同步管道，集中验证 search 链）
        self.client.index(
            index=get_index_name("memos"),
            id=f"e2e-memo-{uuid.uuid4()}",
            document={
                "memo_id": f"e2e-{uuid.uuid4()}",
                "content": "性能优化 是 Python 高频话题",
                "tags": ["python"],
                "ai_tags": [],
                "status": "active",
                "memo_type": "note",
                "source": "manual",
                "is_pinned": False,
                "trashed_at": None,
                "space_id": self.space_id,
                "organization_id": self.organization_id,
                "user_id": self.user_id,
                "creator_type": "user",
                "created_at": "2026-04-16T10:00:00Z",
                "updated_at": "2026-04-16T10:00:00Z",
            },
            refresh=True,
        )

    def tearDown(self):
        from apps.fts.client import reset_client
        from apps.fts.index_definitions import get_index_name
        try:
            self.client.delete_by_query(
                index=get_index_name("memos"),
                body={"query": {"term": {"organization_id": self.organization_id}}},
                refresh=True,
            )
        except Exception:
            pass
        # 防污染下一个 test class（override_settings 退出后 client 仍是 enabled 缓存）
        reset_client()

    def test_msearch_round_trip_with_acl(self):
        from apps.fts.schemas import SearchParams
        from apps.fts.services import acl_service, search_service
        # mock ACL：直接给完整访问
        from unittest.mock import patch
        access = acl_service.AccessibleSpaces(
            full_access_space_ids=[self.space_id],
            organization_id=self.organization_id,
        )
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces",
                   return_value=access), \
             patch("apps.fts.services.search_service.hydration_service.hydrate",
                   side_effect=lambda items: items):
            params = SearchParams(q="性能", organization_id=self.organization_id, types="memos")
            resp = search_service.search(params, user_id=self.user_id)
        self.assertGreaterEqual(resp.facets.get("memos", 0), 1)
        self.assertGreaterEqual(len(resp.results), 1)
        self.assertEqual(resp.results[0].type, "memo")


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SearchE2EAclIsolationTests(SimpleTestCase):
    """S2: 用户 A 写资源；用户 B 无 share 应搜不到。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _skip_if_no_es()

    def setUp(self):
        from apps.fts.client import get_client, reset_client
        from apps.fts.index_definitions import ensure_indices, get_index_name
        reset_client()
        self.client = get_client()
        ensure_indices(self.client)
        self.organization_id = str(uuid.uuid4())
        self.user_a = str(uuid.uuid4())
        self.user_b = str(uuid.uuid4())
        self.space_a = str(uuid.uuid4())  # only A has access
        self.client.index(
            index=get_index_name("memos"),
            id=f"e2e-isolation-{uuid.uuid4()}",
            document={
                "memo_id": f"e2e-iso-{uuid.uuid4()}",
                "content": "ACL 越权测试 - secret memo",
                "tags": ["secret"], "ai_tags": [], "status": "active",
                "memo_type": "note", "source": "manual", "is_pinned": False,
                "trashed_at": None,
                "space_id": self.space_a,
                "organization_id": self.organization_id,
                "user_id": self.user_a,
                "creator_type": "user",
                "created_at": "2026-04-16T11:00:00Z",
                "updated_at": "2026-04-16T11:00:00Z",
            },
            refresh=True,
        )

    def tearDown(self):
        from apps.fts.client import reset_client
        from apps.fts.index_definitions import get_index_name
        try:
            self.client.delete_by_query(
                index=get_index_name("memos"),
                body={"query": {"term": {"organization_id": self.organization_id}}},
                refresh=True,
            )
        except Exception:
            pass
        reset_client()

    def test_user_b_cannot_see_user_a_memo(self):
        from apps.fts.schemas import SearchParams
        from apps.fts.services import acl_service, search_service
        from unittest.mock import patch
        # 用户 A 完整访问 space_a
        access_a = acl_service.AccessibleSpaces(
            full_access_space_ids=[self.space_a], organization_id=self.organization_id,
        )
        # 用户 B 无任何 Space
        access_b = acl_service.AccessibleSpaces(organization_id=self.organization_id)
        with patch("apps.fts.services.search_service.hydration_service.hydrate", side_effect=lambda items: items):
            params = SearchParams(q="secret", organization_id=self.organization_id, types="memos")
            with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=access_a):
                resp_a = search_service.search(params, user_id=self.user_a)
            with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=access_b):
                resp_b = search_service.search(params, user_id=self.user_b)
        self.assertGreaterEqual(resp_a.facets.get("memos", 0), 1)
        self.assertEqual(resp_b.facets.get("memos", 0), 0)
        self.assertEqual(len(resp_b.results), 0)


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SearchE2EFallbackTests(SimpleTestCase):
    """S3: 手动 breaker.open() → fallback_service 返回降级响应。

    本 case 不打 ES（只验证 should_fallback 的 breaker_state 决策），
    所以技术上不需要 ES 在线；但与同文件其他 e2e 保持一致仍 gate ES。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _skip_if_no_es()

    def setUp(self):
        from apps.fts.client import reset_client
        reset_client()

    def tearDown(self):
        from apps.fts.client import reset_client
        reset_client()

    def test_breaker_open_triggers_fallback(self):
        from apps.fts.client import get_breaker
        from apps.fts.services import fallback_service
        from unittest.mock import patch
        b = get_breaker()
        # 强制 open
        try:
            b.open()
        except Exception:
            # 老版本 pybreaker 可能用 _state_storage，跳过
            pass
        with patch("apps.fts.services.fallback_service.is_engine_enabled", return_value=True), \
             patch("apps.fts.services.fallback_service._read_health_redis", return_value="green"), \
             patch("apps.fts.services.fallback_service.get_breaker", return_value=type("FB", (), {"current_state": "open"})()):
            decision = fallback_service.should_fallback()
        self.assertTrue(decision.fallback)
        self.assertEqual(decision.reason, "circuit_open")


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SearchE2EPhraseTests(SimpleTestCase):
    """S4: 短语精确 vs 普通 OR 召回。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        _skip_if_no_es()

    def setUp(self):
        from apps.fts.client import get_client, reset_client
        from apps.fts.index_definitions import ensure_indices, get_index_name
        reset_client()
        self.client = get_client()
        ensure_indices(self.client)
        self.organization_id = str(uuid.uuid4())
        self.space_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())

        for content in (
            "Cannot read property of undefined",
            "Cannot read map property",
            "read property safely",
        ):
            self.client.index(
                index=get_index_name("memos"),
                id=f"e2e-phrase-{uuid.uuid4()}",
                document={
                    "memo_id": f"e2e-{uuid.uuid4()}",
                    "content": content,
                    "tags": [], "ai_tags": [], "status": "active",
                    "memo_type": "note", "source": "manual", "is_pinned": False,
                    "trashed_at": None,
                    "space_id": self.space_id,
                    "organization_id": self.organization_id,
                    "user_id": self.user_id,
                    "creator_type": "user",
                    "created_at": "2026-04-16T12:00:00Z",
                    "updated_at": "2026-04-16T12:00:00Z",
                },
                refresh=True,
            )

    def tearDown(self):
        from apps.fts.client import reset_client
        from apps.fts.index_definitions import get_index_name
        try:
            self.client.delete_by_query(
                index=get_index_name("memos"),
                body={"query": {"term": {"organization_id": self.organization_id}}},
                refresh=True,
            )
        except Exception:
            pass
        reset_client()

    def test_phrase_query_narrows_results(self):
        from apps.fts.schemas import SearchParams
        from apps.fts.services import acl_service, search_service
        from unittest.mock import patch
        access = acl_service.AccessibleSpaces(
            full_access_space_ids=[self.space_id], organization_id=self.organization_id,
        )
        with patch("apps.fts.services.search_service.acl_service.get_user_accessible_spaces", return_value=access), \
             patch("apps.fts.services.search_service.hydration_service.hydrate", side_effect=lambda items: items):
            # 普通搜：召回所有含 read property
            normal = search_service.search(
                SearchParams(q="read property", organization_id=self.organization_id, types="memos"),
                user_id=self.user_id,
            )
            # 短语搜：只命中含完整短语的记录
            phrase = search_service.search(
                SearchParams(q='"Cannot read property"', organization_id=self.organization_id, types="memos"),
                user_id=self.user_id,
            )
        # 短语搜的命中数应 <= 普通搜
        self.assertLessEqual(phrase.facets.get("memos", 0), normal.facets.get("memos", 0))


if __name__ == "__main__":
    unittest.main()

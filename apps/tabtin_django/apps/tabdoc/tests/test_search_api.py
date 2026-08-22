"""TabDoc 全文检索端点的 HTTP 契约测试（P0 #5 工程侧补齐）

为什么补这一份
----------------
``apps_doc.go`` 暴露的 ``tabtin doc search`` 子命令打到
``GET /api/tabdoc/search``，但 ``test_documents_api.py`` 当时只覆盖了 6 个
核心 CRUD 端点，search 端点契约**完全没人测**——见
``scripts/audit_tabdoc_contracts.py``（28% 覆盖里的一格空缺）。

人肉验证（``docs/agent/tabdoc-coverage-progress.md`` P0 #5）发现 agent
经常用 ``doc list + 标题过滤`` 代替真正的 ``doc search``（ISSUE-G），导致
search 实际能力长期没人覆盖。本文件钉死的契约面：

- body / query 字段名重命名：``q`` → ``service.search_documents(keyword=...)``
  （这一处是 search 唯一的命名漂移点，CLI 端 flag 用 ``--query`` → query
  string ``q``）
- ``scope=organization`` 触发 ``_resolve_space_names``（跨 Space 检索时需要
  把 space_id 翻译成可读名），``scope=space`` 不触发
- 响应 schema：``items / total / page / page_size / total_pages / query``
  ——CLI ``--format json`` 把这些字段映到 JSON envelope
- 错误码：service ``PermissionError`` → 403、``ValueError`` → 400、
  缺必填 query → 400 ``VALIDATION_ERROR``、缺 JWT → 401

为什么不验真实搜索结果
----------------------
``DocumentSearchService.search_documents`` 跑真实 ORM + PostgreSQL FTS / SQLite
icontains 回退，业务逻辑覆盖在 ``test_tabdoc_service_metrics.py`` 等 service
层测试里。本文件只验 API 层契约（同 ``test_documents_api.py`` 的 ADR）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.db.models import Q

from apps.tabdoc.services.search_service import DocumentSearchHit, DocumentSearchService


# ---------------------------------------------------------------------------
# Helpers（与 test_documents_api.py 同款；刻意复制而非 import，让本文件独立可读）
# ---------------------------------------------------------------------------


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


def _build_document(
    *,
    document_id=None,
    organization_id=None,
    space_id=None,
    title: str = "Doc A",
    description_plaintext: str = "",
):
    """构造 ``_serialize_document`` 能吃的轻量 document 对象。

    search 路径只读 document 的属性 + ``isoformat()``，duck-typed 即可。"""
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=document_id or uuid4(),
        organization_id=organization_id or uuid4(),
        space_id=space_id or uuid4(),
        parent_id=None,
        title=title,
        status="active",
        latest_version=1,
        icon="",
        cover_image="",
        cover_position=0.5,
        tags=[],
        properties={},
        is_full_width=False,
        is_private=False,
        font_style="default",
        trashed_at=None,
        trashed_by=None,
        previous_status="",
        last_editor_type="",
        last_editor_id="",
        owner_id=None,
        created_by_id=None,
        updated_by_id=None,
        created_at=now,
        updated_at=now,
        description_json={},
        description_markdown="",
        description_plaintext=description_plaintext,
    )


def _hit(
    document,
    *,
    snippet="...西湖...",
    relevance_score=2.5,
    matched_on_title=False,
    block_id=None,
    block_type=None,
    block_index=None,
    block_preview="",
):
    return DocumentSearchHit(
        document=document,
        snippet=snippet,
        relevance_score=relevance_score,
        matched_on_title=matched_on_title,
        block_id=block_id,
        block_type=block_type,
        block_index=block_index,
        block_preview=block_preview,
    )


def _para(block_id: str | None, text: str) -> dict:
    node = {
        "type": "paragraph",
        "content": [{"type": "text", "text": text}],
    }
    if block_id is not None:
        node["attrs"] = {"blockId": block_id}
    return node


class SearchSnippetTests(SimpleTestCase):
    def test_build_snippet_uses_individual_query_term_when_phrase_not_contiguous(self):
        svc = DocumentSearchService()
        snippet = svc._build_snippet(
            "开头内容 " * 20 + "这里写了杭州西湖和龙井路线",
            "西湖 路线",
        )

        self.assertIn("西湖", snippet)
        self.assertTrue(snippet.startswith("..."))

    def test_find_first_block_hit_returns_operable_anchor(self):
        svc = DocumentSearchService()
        document = _build_document(title="杭州攻略")
        document.description_json = {
            "type": "doc",
            "content": [
                _para("intro", "开头"),
                _para("target", "这里写西湖龙井和路线"),
            ],
        }

        hit = svc._find_first_block_hit(document, "西湖")

        self.assertIsNotNone(hit)
        self.assertEqual(hit["block_id"], "target")
        self.assertEqual(hit["block_type"], "paragraph")
        self.assertEqual(hit["index"], 1)
        self.assertIn("西湖", hit["preview"])


class _FakeSearchQuerySet:
    def __init__(self, docs):
        self.docs = docs
        self.filter_calls = []

    def filter(self, *args, **kwargs):
        self.filter_calls.append((args, kwargs))
        return self

    def distinct(self):
        return self

    def annotate(self, **kwargs):
        return self

    def order_by(self, *fields):
        return self

    def count(self):
        return len(self.docs)

    def __getitem__(self, item):
        return self.docs[item]


def _q_contains_lookup(q: Q, lookup: str) -> bool:
    for child in getattr(q, "children", []):
        if isinstance(child, tuple) and child[0] == lookup:
            return True
        if isinstance(child, Q) and _q_contains_lookup(child, lookup):
            return True
    return False


def _q_contains_lookup_value(q: Q, lookup: str, value: str) -> bool:
    for child in getattr(q, "children", []):
        if isinstance(child, tuple) and child == (lookup, value):
            return True
        if isinstance(child, Q) and _q_contains_lookup_value(child, lookup, value):
            return True
    return False


# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------


class _SearchApiBase(SimpleTestCase):
    URL = "/api/tabdoc/search"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()
        cls._invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        )
        cls._invite_gate_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._invite_gate_patcher.stop()
        cls._auth_patcher.stop()
        super().tearDownClass()

    def _get(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.get(url, **headers)

    @staticmethod
    def _body(resp):
        return resp.json()

    def _patch_service(self):
        svc = MagicMock()
        patcher = patch("apps.tabdoc.api._build_search_service", return_value=svc)

        class _Ctx:
            def __enter__(self_inner):
                patcher.start()
                return svc

            def __exit__(self_inner, *args):
                patcher.stop()

        return _Ctx()


# ===========================================================================
# GET /api/tabdoc/search · search_documents
# ===========================================================================


class SearchDocumentsApiTests(_SearchApiBase):
    """钉死 search 端点的字段映射 / scope 分支 / 响应 schema / 错误码。

    CLI 对应：``tabtin doc search --query <kw> [--scope space|organization]``。
    Go 端 ``--query`` flag 映射到 query string ``q``——handler 必须把 ``q``
    再 rename 成 ``keyword`` 透传给 service，这条 rename 链是契约重点。"""

    def test_search_passes_query_params_to_service_with_keyword_rename(self):
        """字段映射 + ``q → keyword`` rename：CLI ``--query`` 进来是 query
        string ``q``，handler 必须传成 ``keyword=`` 给 ``service.search_documents``。
        任何一处忘记 rename（直接 ``q=``）都会让 service signature 报
        ``unexpected keyword argument 'q'``。"""
        organization_id = str(uuid4())
        space_id = str(uuid4())

        with self._patch_service() as svc:
            svc.search_documents.return_value = {
                "items": [],
                "total": 0,
                "page": 3,
                "page_size": 15,
                "total_pages": 0,
                "query": "西湖",
            }
            resp = self._get(
                f"{self.URL}?organization_id={organization_id}"
                f"&space_id={space_id}"
                f"&q=%E8%A5%BF%E6%B9%96"  # 西湖
                f"&page=3&page_size=15&scope=space"
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.search_documents.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], organization_id)
        self.assertEqual(kwargs["space_id"], space_id)
        # 关键 rename：query string ``q`` → service kwarg ``keyword``
        self.assertEqual(kwargs["keyword"], "西湖")
        self.assertNotIn("q", kwargs)
        self.assertEqual(kwargs["page"], 3)
        self.assertEqual(kwargs["page_size"], 15)
        self.assertEqual(kwargs["scope"], "space")

    def test_search_defaults_page_pagesize_scope(self):
        """默认值契约：``page=1 / page_size=20 / scope='space'``——
        agent 经常只传 ``q``，这套默认必须稳定（变了 CLI 行为会跟着漂）。"""
        with self._patch_service() as svc:
            svc.search_documents.return_value = {
                "items": [], "total": 0, "page": 1, "page_size": 20,
                "total_pages": 0, "query": "x",
            }
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.search_documents.call_args.kwargs
        self.assertEqual(kwargs["page"], 1)
        self.assertEqual(kwargs["page_size"], 20)
        self.assertEqual(kwargs["scope"], "space")

    def test_search_returns_items_total_pagination_query(self):
        """响应 schema 契约：``items / total / page / page_size / total_pages /
        query`` 六字段全在；每个 item 含 ``document / snippet / relevance_score
        / matched_on_title``。CLI ``--format json`` 把这些映到表格列。"""
        document = _build_document(title="杭州周末游", description_plaintext="西湖龙井")
        with self._patch_service() as svc:
            svc.search_documents.return_value = {
                "items": [_hit(
                    document,
                    snippet="...西湖龙井...",
                    relevance_score=3.2,
                    block_id="target",
                    block_type="paragraph",
                    block_index=1,
                    block_preview="这里写西湖龙井和路线",
                )],
                "total": 1,
                "page": 1,
                "page_size": 20,
                "total_pages": 1,
                "query": "西湖",
            }
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        data = self._body(resp)["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["page"], 1)
        self.assertEqual(data["page_size"], 20)
        self.assertEqual(data["total_pages"], 1)
        self.assertEqual(data["query"], "西湖")
        self.assertEqual(len(data["items"]), 1)
        item = data["items"][0]
        self.assertEqual(item["snippet"], "...西湖龙井...")
        self.assertEqual(item["relevance_score"], 3.2)
        self.assertFalse(item["matched_on_title"])
        self.assertEqual(item["block_id"], "target")
        self.assertEqual(item["block_type"], "paragraph")
        self.assertEqual(item["block_index"], 1)
        self.assertEqual(item["block_preview"], "这里写西湖龙井和路线")
        self.assertEqual(item["document"]["title"], "杭州周末游")

    def test_search_space_scope_does_not_resolve_space_names(self):
        """``scope='space'``（默认）= 单 Space 内检索，不需要把 space_id
        翻译成可读名——``_resolve_space_names`` 不该被调用，省一次 DB 查询。"""
        document = _build_document()
        with self._patch_service() as svc, patch(
            "apps.tabdoc.api._resolve_space_names",
            return_value={},
        ) as resolve:
            svc.search_documents.return_value = {
                "items": [_hit(document)],
                "total": 1, "page": 1, "page_size": 20, "total_pages": 1, "query": "x",
            }
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x&scope=space"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        resolve.assert_not_called()

    def test_search_organization_scope_resolves_space_names(self):
        """``scope='organization'`` = 跨 Space 检索，必须调 ``_resolve_space_names``
        把所有命中文档的 ``space_id`` 翻译成可读 ``space_name`` 注入到响应——
        前端跨 Space 结果列表靠这个字段分组显示。"""
        d1 = _build_document(title="A", space_id=uuid4())
        d2 = _build_document(title="B", space_id=uuid4())
        with self._patch_service() as svc, patch(
            "apps.tabdoc.api._resolve_space_names",
            return_value={str(d1.space_id): "S1", str(d2.space_id): "S2"},
        ) as resolve:
            svc.search_documents.return_value = {
                "items": [_hit(d1), _hit(d2)],
                "total": 2, "page": 1, "page_size": 20, "total_pages": 1, "query": "x",
            }
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x&scope=organization"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        resolve.assert_called_once()
        # 调用入参是命中文档的 space_id 列表（顺序与 items 一致）
        called_arg = resolve.call_args.args[0]
        self.assertEqual(list(called_arg), [d1.space_id, d2.space_id])

    def test_search_rejects_missing_q(self):
        """``q`` 是 required query param，缺失被 ninja Schema 422 拦下
        → 项目级 ``VALIDATION_ERROR`` (400)。"""
        resp = self._get(
            f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}"
        )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_rejects_missing_organization_id(self):
        resp = self._get(f"{self.URL}?space_id={uuid4()}&q=x")
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_returns_403_when_service_raises_permission_error(self):
        """service 抛 ``PermissionError`` → 403 + ``code='PERMISSION_DENIED'``，
        CLI 翻译成 exit code 4。常触发场景：用户对该 Space 无 viewer 权限。"""
        with self._patch_service() as svc:
            svc.search_documents.side_effect = PermissionError("无权访问该智能体空间文档")
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x"
            )
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_search_returns_400_when_service_raises_value_error(self):
        """service 抛 ``ValueError`` → 400 + ``VALIDATION_ERROR``。典型场景：
        ``q`` 为空串被 ``_normalize_keyword`` 拒掉（handler 不预先校验，
        透传给 service 让 service 一处定义边界）。"""
        with self._patch_service() as svc:
            svc.search_documents.side_effect = ValueError("q 不能为空")
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=%20"
            )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_returns_401_when_jwt_missing(self):
        resp = self._get(
            f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&q=x",
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


class SearchDocumentsServiceTests(SimpleTestCase):
    def test_postgresql_search_keeps_plaintext_icontains_fallback(self):
        """PostgreSQL FTS 之外必须保留正文 icontains 兜底。

        新建文档或格式转换异常时 search_vector 可能为空；Agent 仍应能用正文关键词
        找到刚写入的文档，而不是退化成 0 条结果。
        """
        document = _build_document(
            title="CLI smoke",
            description_plaintext="Alpha smoke paragraph.",
        )
        document.content_text_hit = 1
        fake_qs = _FakeSearchQuerySet([document])

        svc = DocumentSearchService(user=_make_user_namespace())
        svc._doc_service._parse_uuid = MagicMock(side_effect=[uuid4(), uuid4()])
        svc._doc_service._ensure_space_context = MagicMock()
        svc._doc_service.check_space_permission = MagicMock(return_value=True)
        svc._doc_service._build_permission_filter_q = MagicMock(return_value=Q())

        with patch("apps.tabdoc.services.search_service.Document.objects.filter", return_value=fake_qs), \
             patch("django.db.router.db_for_read", return_value="default"), \
             patch("django.db.connections", {"default": SimpleNamespace(vendor="postgresql")}):
            result = svc.search_documents(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                keyword="Alpha smoke",
            )

        self.assertEqual(result["total"], 1)
        candidate_filters = [
            arg
            for args, _kwargs in fake_qs.filter_calls
            for arg in args
            if isinstance(arg, Q)
        ]
        self.assertTrue(
            any(_q_contains_lookup(q, "description_plaintext__icontains") for q in candidate_filters),
            "PostgreSQL search must OR in description_plaintext__icontains as an AI-friendly fallback",
        )

    def test_postgresql_plaintext_fallback_includes_separator_normalized_query_variant(self):
        """正文 plaintext 会把 Markdown 分隔符归一为空格，fallback 也要同口径查询。"""
        raw_query = "cli-smoke-20260704154108"
        normalized_body_keyword = "cli smoke 20260704154108"
        document = _build_document(
            title="CLI smoke",
            description_plaintext=f"body contains {normalized_body_keyword}",
        )
        document.content_text_hit = 1
        fake_qs = _FakeSearchQuerySet([document])

        svc = DocumentSearchService(user=_make_user_namespace())
        svc._doc_service._parse_uuid = MagicMock(side_effect=[uuid4(), uuid4()])
        svc._doc_service._ensure_space_context = MagicMock()
        svc._doc_service.check_space_permission = MagicMock(return_value=True)
        svc._doc_service._build_permission_filter_q = MagicMock(return_value=Q())

        with patch("apps.tabdoc.services.search_service.Document.objects.filter", return_value=fake_qs), \
             patch("django.db.router.db_for_read", return_value="default"), \
             patch("django.db.connections", {"default": SimpleNamespace(vendor="postgresql")}):
            result = svc.search_documents(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                keyword=raw_query,
            )

        self.assertEqual(result["total"], 1)
        candidate_filters = [
            arg
            for args, _kwargs in fake_qs.filter_calls
            for arg in args
            if isinstance(arg, Q)
        ]
        self.assertTrue(
            any(
                _q_contains_lookup_value(
                    q,
                    "description_plaintext__icontains",
                    normalized_body_keyword,
                )
                for q in candidate_filters
            ),
            "PostgreSQL plaintext fallback must search the separator-normalized body keyword",
        )
        self.assertTrue(
            any(
                _q_contains_lookup_value(
                    q,
                    "title__icontains",
                    normalized_body_keyword,
                )
                for q in candidate_filters
            ),
            "Title fallback should also search separator-normalized query variants",
        )

    def test_title_only_hit_returns_title_snippet(self):
        document = _build_document(
            title="CLI smoke",
            description_plaintext="",
        )
        document.title_hit = 2
        fake_qs = _FakeSearchQuerySet([document])

        svc = DocumentSearchService(user=_make_user_namespace())
        svc._doc_service._parse_uuid = MagicMock(side_effect=[uuid4(), uuid4()])
        svc._doc_service._ensure_space_context = MagicMock()
        svc._doc_service.check_space_permission = MagicMock(return_value=True)
        svc._doc_service._build_permission_filter_q = MagicMock(return_value=Q())

        with patch("apps.tabdoc.services.search_service.Document.objects.filter", return_value=fake_qs), \
             patch("django.db.router.db_for_read", return_value="default"), \
             patch("django.db.connections", {"default": SimpleNamespace(vendor="postgresql")}):
            result = svc.search_documents(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                keyword="CLI smoke",
            )

        self.assertEqual(result["total"], 1)
        hit = result["items"][0]
        self.assertTrue(hit.matched_on_title)
        self.assertEqual(hit.snippet, "CLI smoke")

    def test_title_only_hit_matches_separator_normalized_query(self):
        document = _build_document(
            title="CLI smoke",
            description_plaintext="",
        )
        document.title_hit = 2
        fake_qs = _FakeSearchQuerySet([document])

        svc = DocumentSearchService(user=_make_user_namespace())
        svc._doc_service._parse_uuid = MagicMock(side_effect=[uuid4(), uuid4()])
        svc._doc_service._ensure_space_context = MagicMock()
        svc._doc_service.check_space_permission = MagicMock(return_value=True)
        svc._doc_service._build_permission_filter_q = MagicMock(return_value=Q())

        with patch("apps.tabdoc.services.search_service.Document.objects.filter", return_value=fake_qs), \
             patch("django.db.router.db_for_read", return_value="default"), \
             patch("django.db.connections", {"default": SimpleNamespace(vendor="postgresql")}):
            result = svc.search_documents(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                keyword="cli-smoke",
            )

        self.assertEqual(result["total"], 1)
        self.assertTrue(result["items"][0].matched_on_title)


class SearchBlocksApiTests(_SearchApiBase):
    URL = "/api/tabdoc/documents/{document_id}/search-blocks"

    def _url(self, document_id, query: str = "西湖", limit: int | None = None):
        url = self.URL.format(document_id=document_id)
        url = f"{url}?q={query}"
        if limit is not None:
            url = f"{url}&limit={limit}"
        return url

    def _patch_document_service(self):
        svc = MagicMock()
        patcher = patch("apps.tabdoc.api._build_service", return_value=svc)

        class _Ctx:
            def __enter__(self_inner):
                patcher.start()
                return svc

            def __exit__(self_inner, *args):
                patcher.stop()

        return _Ctx()

    def test_search_blocks_returns_operable_block_anchor(self):
        document = _build_document(title="杭州攻略")
        document.description_json = {
            "type": "doc",
            "content": [
                _para("intro", "开头"),
                _para("target", "这里写西湖龙井和路线"),
            ],
        }
        document.description_markdown = "开头\n\n这里写西湖龙井和路线"
        document.description_plaintext = "开头\n这里写西湖龙井和路线"
        with self._patch_document_service() as svc:
            svc.get_document.return_value = document
            resp = self._get(self._url(document.id, limit=5))

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        svc.get_document.assert_called_once_with(str(document.id), required_role="viewer")
        data = self._body(resp)["data"]
        self.assertEqual(data["query"], "西湖")
        self.assertEqual(data["limit"], 5)
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["document"]["title"], "杭州攻略")
        hit = data["blocks"][0]
        self.assertEqual(hit["block_id"], "target")
        self.assertEqual(hit["block_type"], "paragraph")
        self.assertEqual(hit["index"], 1)
        self.assertIn("西湖", hit["snippet"])

    def test_search_blocks_returns_400_when_query_empty(self):
        document = _build_document()
        with self._patch_document_service() as svc:
            svc.get_document.return_value = document
            resp = self._get(self._url(document.id, query="%20"))

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_blocks_returns_400_when_limit_invalid(self):
        document = _build_document()
        with self._patch_document_service() as svc:
            svc.get_document.return_value = document
            resp = self._get(self._url(document.id, limit=0))

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_blocks_returns_400_when_document_id_invalid(self):
        with self._patch_document_service() as svc:
            svc.get_document.side_effect = ValueError("document_id uuid format invalid")
            resp = self._get(self._url("not-a-uuid"))

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_search_blocks_returns_401_when_jwt_missing(self):
        resp = self._get(self._url(uuid4()), with_auth=False)

        self.assertEqual(resp.status_code, 401, msg=self._body(resp))

    def test_search_blocks_returns_403_when_permission_denied(self):
        with self._patch_document_service() as svc:
            svc.get_document.side_effect = PermissionError("无权访问该智能体空间文档")
            resp = self._get(self._url(uuid4()))

        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_search_blocks_returns_404_when_document_missing(self):
        with self._patch_document_service() as svc:
            svc.get_document.side_effect = ValueError("文档不存在")
            resp = self._get(self._url(uuid4()))

        self.assertEqual(resp.status_code, 404, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "NOT_FOUND")

    def test_search_blocks_returns_404_when_document_trashed(self):
        with self._patch_document_service() as svc:
            svc.get_document.side_effect = ValueError("文档已在回收站")
            resp = self._get(self._url(uuid4()))

        self.assertEqual(resp.status_code, 404, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "NOT_FOUND")

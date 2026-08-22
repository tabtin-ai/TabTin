"""TabDoc 主 API 的 HTTP 契约测试（ 跨语言契约治理 Day 2）

为什么需要这一层
----------------
``packages/tabtin-cli-go/cmd/apps_doc.go`` 30 个 ``tabtin doc`` 子命令通过
HTTP body 直接打到本文件覆盖的 6 个核心端点：

| CLI 命令               | 端点                                       |
|------------------------|--------------------------------------------|
| ``doc create``         | POST   ``/api/tabdoc/documents``           |
| ``doc list``           | GET    ``/api/tabdoc/documents``           |
| ``doc get``            | GET    ``/api/tabdoc/documents/{id}``      |
| ``doc update``         | PATCH  ``/api/tabdoc/documents/{id}``      |
| ``doc archive``        | DELETE ``/api/tabdoc/documents/{id}``      |
| ``doc save-content``   | POST   ``/api/tabdoc/documents/{id}/content`` |

CLI 那一侧的 DryRun golden test（``cmd/apps_doc_dryrun_test.go``）已经钉死
"flag → body 字段"映射。本文件钉的是另一端："body 字段 → service kwargs"
是否被 ninja Schema + handler 正确接住。两端合起来 = 端到端契约不漂移。

为什么用 SimpleTestCase + mock
------------------------------
沿用 ``test_plan_api.py`` 的同款 ADR：

- ``conversation/0024_add_fulltext_index_chat_message_content.py`` 是 MySQL
  FULLTEXT，SQLite 测试 DB 跑不通；TestCase 全部走不动
- 本测试目的是 **API 层契约**——schema 字段映射 / JWT auth / 错误码映射，
  不是 ``DocumentService`` 业务逻辑（后者由 ``test_document_service_clamp``、
  ``test_be01_be02_be03_be05_permission_fixes`` 等 service 层覆盖）
- 通过 patch ``apps.tabdoc.api._build_service`` 注入 mock service，
  ``self.client.<method>(...)`` 仍然走真实 ninja Router → JWTAuth → handler →
  ``i18n.response.{success,permission_denied,validation_error,not_found}_response``
  → JsonResponse 全链路

任何 CLI / Runtime 端改动 ``DocumentCreateRequest`` 等 schema 字段名或错误码
映射，本测试都能立刻发现漂移。
"""

from __future__ import annotations

import asyncio
import base64
import json
import zlib
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.services.billing.services.entitlement_limits_service import EntitlementLimitExceeded
from apps.tabdoc.api import get_document_binary
from apps.tabdoc.services import ConflictError, DocumentExchangeService, DocumentService


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    """构造最小可用的 user 对象供 ``request.auth`` 使用。

    ``_build_service(request) = DocumentService(user=request.auth)`` 只取
    truthy 值（service 已 mock），所以这里不需要真实 Django User。"""
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
    parent_id=None,
    title: str = "Doc A",
    status: str = "active",
    latest_version: int = 1,
    description_json: dict | None = None,
    description_markdown: str = "",
    description_plaintext: str = "",
):
    """构造满足 ``_serialize_document`` 字段访问的轻量 document 对象。

    用 ``SimpleNamespace`` 是因为 ``_serialize_document`` 只做属性读取 +
    ``isoformat()``——任何 duck-typed 对象都能喂进去，不依赖真 ORM。

    这里把"轻松会被忘"的字段（trashed_at / previous_status / owner_id）也
    都填 None / ""，让 ``_serialize_document`` 不会在 ``getattr`` 默认值上
    走偏路径——保证响应里看到什么就是 service 实际返回了什么。"""
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=document_id or uuid4(),
        organization_id=organization_id or uuid4(),
        space_id=space_id or uuid4(),
        parent_id=parent_id,
        title=title,
        status=status,
        latest_version=latest_version,
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
        description_json=description_json or {},
        description_markdown=description_markdown,
        description_plaintext=description_plaintext,
    )


class _TabDocApiBase(SimpleTestCase):
    """共享 setUp：mock JWTAuth.authenticate + 暴露 service mock 入口。

    `_service_patcher` 在每个 test 里返回独立 MagicMock，避免跨 test 状态污染。
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 模块级 patch：JWTAuth.authenticate 整个 class 范围内返回 mock user
        # （等价 plan_api 的处理；jwt_auth 是 ``JWTAuth()`` 单例，patch 类方法
        # 同时影响该单例的 ``authenticate``）
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()
        # SimpleTestCase 禁止打 DB；invite gate 会查 RegistrationInviteRedemption
        cls._invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware._has_redeemed_invite",
            return_value=True,
        )
        cls._invite_gate_patcher.start()
        # 写路径会走组织管控，内部查 Organization —— 测试里放行
        cls._org_write_guard_patcher = patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        )
        cls._org_write_guard_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._org_write_guard_patcher.stop()
        cls._invite_gate_patcher.stop()
        cls._auth_patcher.stop()
        super().tearDownClass()

    # ── HTTP helpers ────────────────────────────────────────────────────────

    def _post(self, url: str, payload: dict, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.post(
            url,
            data=json.dumps(payload),
            content_type="application/json",
            **headers,
        )

    def _get(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.get(url, **headers)

    def _patch(self, url: str, payload: dict, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.patch(
            url,
            data=json.dumps(payload),
            content_type="application/json",
            **headers,
        )

    def _delete(self, url: str, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.delete(url, **headers)

    @staticmethod
    def _body(resp):
        return resp.json()

    def _patch_service(self):
        """返回一个 ``patch(...) as svc_cls`` 上下文：use it as
        ``with self._patch_service() as svc:``，``svc`` 就是 ``MagicMock``，
        其方法（``create_document`` / ``get_document`` / ...）可被直接配置。

        我们 patch 的是 ``_build_service`` 函数本身（return 一个 MagicMock），
        而不是 ``DocumentService`` 类——因为 handler 调用形式是
        ``service = _build_service(request)``，patch 函数返回值最直接。"""
        svc = MagicMock()
        # 写响应会调用 compute_user_document_role；默认 None 表示省略字段，
        # 避免 MagicMock 泄漏进 JSON 序列化。
        svc.compute_user_document_role.return_value = None
        patcher = patch("apps.tabdoc.api._build_service", return_value=svc)
        # 用一个轻封装让 with-as 同时拿到 svc 和 patcher.stop 控制
        class _Ctx:
            def __enter__(self_inner):
                patcher.start()
                return svc
            def __exit__(self_inner, *args):
                patcher.stop()
        return _Ctx()


# ===========================================================================
# POST /api/tabdoc/import/markdown · import_markdown_draft
# ===========================================================================


class ImportMarkdownDraftApiTests(_TabDocApiBase):
    URL = "/api/tabdoc/import/markdown"

    def test_import_invalid_tabdata_reaches_real_service_and_returns_400(self):
        service = DocumentExchangeService(user=_make_user_namespace())
        with patch(
            "apps.tabdoc.api._build_exchange_service",
            return_value=service,
        ), patch.object(
            service,
            "check_organization_permission",
            return_value=True,
        ):
            resp = self._post(
                self.URL,
                {
                    "organization_id": str(uuid4()),
                    "markdown": ":::tabdata{tableId=tbl-bad}\n:::",
                },
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")
        self.assertIn("tableId", self._body(resp)["message"])


# ===========================================================================
# POST /api/tabdoc/documents · create_document
# ===========================================================================


class CreateDocumentApiTests(_TabDocApiBase):
    """覆盖 create_document 的字段映射 / 默认值 / 错误码 / auth 链路。

    CLI 对应：``tabtin doc create``。Go 端 DryRun golden 钉的是
    "kebab flag → snake body"；这边钉的是 "snake body → service kwargs"。"""

    URL = "/api/tabdoc/documents"

    def test_create_invalid_tabdata_reaches_real_service_and_returns_400(self):
        service = DocumentService(user=_make_user_namespace())
        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ), patch.object(
            service,
            "check_organization_permission",
            return_value=True,
        ):
            resp = self._post(
                self.URL,
                {
                    "organization_id": str(uuid4()),
                    "title": "非法嵌表",
                    "initial_content_markdown": ':::tabdata{tableId=""}\n:::',
                },
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")
        self.assertIn("tableId", self._body(resp)["message"])

    def test_create_passes_all_fields_to_service(self):
        """字段映射：所有 schema 字段必须按命名透传给 ``service.create_document``。

        重点钉死：``initial_content_pm_json / initial_content_markdown /
        initial_content_plaintext`` 三个 ``initial_content_*`` 前缀——CLI
        DryRun golden 里 body key 是这个，handler 必须以同名 kwargs 传给 service，
        中间任何一处 rename 都会破坏 CLI 端到端契约。"""
        organization_id = str(uuid4())
        space_id = str(uuid4())
        parent_id = str(uuid4())
        collection_id = str(uuid4())
        document = _build_document(
            organization_id=organization_id,
            space_id=space_id,
            parent_id=parent_id,
            title="发布 V1",
            description_markdown="# Body",
        )

        with self._patch_service() as svc:
            svc.create_document.return_value = document

            resp = self._post(
                self.URL,
                {
                    "organization_id": organization_id,
                    "space_id": space_id,
                    "parent_id": parent_id,
                    "collection_id": collection_id,
                    "title": "发布 V1",
                    "icon": "📘",
                    "cover_image": "https://cdn/x.png",
                    "initial_content_pm_json": {"type": "doc"},
                    "initial_content_markdown": "# Body",
                    "initial_content_plaintext": "Body",
                },
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertEqual(body["code"], "SUCCESS")

        # 响应字段契约
        self.assertEqual(body["data"]["document"]["id"], str(document.id))
        self.assertEqual(body["data"]["document"]["title"], "发布 V1")
        self.assertNotIn("content", body["data"])
        # 兼容旧前端的 latest_revision 字段必须存在但为 None
        self.assertIsNone(body["data"]["latest_revision"])

        # 入参契约：body → service kwargs
        kwargs = svc.create_document.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], organization_id)
        self.assertEqual(kwargs["space_id"], space_id)
        self.assertEqual(kwargs["parent_id"], parent_id)
        self.assertEqual(kwargs["collection_id"], collection_id)
        self.assertEqual(kwargs["title"], "发布 V1")
        self.assertEqual(kwargs["icon"], "📘")
        self.assertEqual(kwargs["cover_image"], "https://cdn/x.png")
        self.assertEqual(kwargs["initial_content_pm_json"], {"type": "doc"})
        self.assertEqual(kwargs["initial_content_markdown"], "# Body")
        self.assertEqual(kwargs["initial_content_plaintext"], "Body")

    def test_create_defaults_optional_fields_to_empty(self):
        """schema 默认值契约：optional 字段不传时 handler 必须以空串/空 dict
        传给 service（而非 None）——service 签名期望 ``title: str``，传 None
        会触发下游 TypeError 或写入 NULL。"""
        document = _build_document()
        with self._patch_service() as svc:
            svc.create_document.return_value = document
            resp = self._post(
                self.URL,
                {"organization_id": str(uuid4()), "space_id": str(uuid4())},
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.create_document.call_args.kwargs
        # handler 显式 ``payload.title or ""``——title=None 必须变 ""
        self.assertEqual(kwargs["title"], "")
        self.assertEqual(kwargs["icon"], "")
        self.assertEqual(kwargs["cover_image"], "")
        # parent_id 是 Optional[str]，None 应原样透传（service 用 None 判"无父"）
        self.assertIsNone(kwargs["parent_id"])
        self.assertIsNone(kwargs["collection_id"])
        # initial_content_* 三个字段有 default_factory，未传时为默认空值
        self.assertEqual(kwargs["initial_content_pm_json"], {})
        self.assertEqual(kwargs["initial_content_markdown"], "")
        self.assertEqual(kwargs["initial_content_plaintext"], "")

    def test_create_rejects_missing_organization_id_via_schema(self):
        """ninja Schema 422 → 项目级 ``VALIDATION_ERROR``（400）。
        ``organization_id`` 是 required ``str``，缺失被 Pydantic 拦在 handler 前。"""
        resp = self._post(self.URL, {"space_id": str(uuid4())})
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")

    def test_create_returns_403_when_service_raises_permission_error(self):
        """service 抛 ``PermissionError`` → 403 + ``code='PERMISSION_DENIED'``。
        CLI 看到 PERMISSION_DENIED → 翻译成 exit code 4。"""
        with self._patch_service() as svc:
            svc.create_document.side_effect = PermissionError("无权在该 Space 创建文档")
            resp = self._post(
                self.URL,
                {"organization_id": str(uuid4()), "space_id": str(uuid4()), "title": "X"},
            )
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PERMISSION_DENIED")

    def test_create_returns_400_when_service_raises_value_error(self):
        """service 抛 ``ValueError`` → 400 + ``code='VALIDATION_ERROR'``，
        且 ``data.detail`` 透传原始消息——CLI 可以把 detail 显示给用户。"""
        with self._patch_service() as svc:
            svc.create_document.side_effect = ValueError("title 不能超过 255 字符")
            resp = self._post(
                self.URL,
                {"organization_id": str(uuid4()), "space_id": str(uuid4()), "title": "X"},
            )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        self.assertEqual(body["data"]["detail"], "title 不能超过 255 字符")

    def test_create_returns_entitlement_code_when_document_limit_exceeded(self):
        with self._patch_service() as svc:
            svc.create_document.side_effect = EntitlementLimitExceeded(
                code="ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED",
                message="当前套餐文档额度已用完，请升级套餐或购买文档扩容包。",
                quota_key="max_documents",
                used=10,
                limit=10,
                plan_limit=10,
            )
            resp = self._post(
                self.URL,
                {"organization_id": str(uuid4()), "space_id": str(uuid4()), "title": "X"},
            )

        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED")
        self.assertEqual(body["data"]["quotaKey"], "max_documents")
        self.assertEqual(body["data"]["used"], 10)
        self.assertEqual(body["data"]["limit"], 10)

    def test_create_returns_401_when_jwt_missing(self):
        """无 ``Authorization`` 头 → ninja JWTAuth 拦截返回 401。
        本 case 不能用 ``_patch_service``——auth 在 handler 之前就 reject。"""
        resp = self._post(
            self.URL,
            {"organization_id": str(uuid4()), "space_id": str(uuid4())},
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# GET /api/tabdoc/documents · list_documents
# ===========================================================================


class ListDocumentsApiTests(_TabDocApiBase):
    """覆盖 list_documents 的 query 参数透传 / 分页 / 错误码。

    CLI 对应：``tabtin doc list``。GET 端点的入参是 query string——契约风险
    最大的是 ``include_archived`` / ``scope`` 这种 enum-ish 字符串到 service
    参数的映射。"""

    URL = "/api/tabdoc/documents"

    def test_list_passes_query_params_to_service(self):
        """字段映射：query string → service kwargs。重点钉
        ``include_archived=true``（query 是 str "true"，handler 用 ``bool`` 类型，
        ninja 自动转 True；这里防 ninja 行为漂移）。"""
        organization_id = str(uuid4())
        space_id = str(uuid4())
        parent_id = str(uuid4())
        with self._patch_service() as svc:
            svc.list_documents.return_value = ([], 0)
            resp = self._get(
                f"{self.URL}?organization_id={organization_id}"
                f"&space_id={space_id}"
                f"&parent_id={parent_id}"
                f"&include_archived=true"
                f"&page=2&page_size=10"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.list_documents.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], organization_id)
        self.assertEqual(kwargs["space_id"], space_id)
        self.assertEqual(kwargs["parent_id"], parent_id)
        self.assertIs(kwargs["include_archived"], True)
        self.assertEqual(kwargs["page"], 2)
        self.assertEqual(kwargs["page_size"], 10)

    def test_list_returns_documents_total_page_pagesize(self):
        """响应 schema 契约：``documents / total / page / page_size`` 四字段
        都必须存在——CLI ``--format json`` 把这些字段映到表格列。"""
        document = _build_document(title="X")
        with self._patch_service() as svc:
            svc.list_documents.return_value = ([document], 1)
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        data = self._body(resp)["data"]
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["page"], 1)
        self.assertEqual(data["page_size"], 200)  # 默认值
        self.assertEqual(len(data["documents"]), 1)
        self.assertEqual(data["documents"][0]["title"], "X")

    def test_list_clamps_page_size_at_500(self):
        """page_size 上限 500：传 1000 应该被 handler ``min(page_size, 500)`` 钉死。
        CLI 端无法对 ``--page-size 1000`` 设防（agent 可能自由传），后端必须兜底。"""
        with self._patch_service() as svc:
            svc.list_documents.return_value = ([], 0)
            resp = self._get(
                f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}&page_size=1000"
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        # 响应里的 page_size 必须是 clamp 后的 500
        self.assertEqual(self._body(resp)["data"]["page_size"], 500)
        # service 也应该收到 500 而不是 1000
        kwargs = svc.list_documents.call_args.kwargs
        self.assertEqual(kwargs["page_size"], 500)

    def test_list_returns_401_when_jwt_missing(self):
        resp = self._get(
            f"{self.URL}?organization_id={uuid4()}&space_id={uuid4()}",
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# GET /api/tabdoc/documents/{id} · get_document
# ===========================================================================


class GetDocumentApiTests(_TabDocApiBase):
    """覆盖 get_document 的内容回填 / 用户角色 / URL-as-id 兜底。"""

    def test_get_returns_document_with_content_and_role(self):
        """主路径：响应同时含 document（属性） + content（最新版本）
        + current_user_role（前端 canManage 判定依据）。
        latest_revision 兼容字段也存在。"""
        document = _build_document(title="X", description_markdown="# new")
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.get_latest_revision.return_value = None  # 新架构无 Revision
            svc.compute_user_document_role.return_value = "editor"
            resp = self._get(f"/api/tabdoc/documents/{document.id}")
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        data = self._body(resp)["data"]
        self.assertEqual(data["document"]["id"], str(document.id))
        self.assertEqual(data["document"]["current_user_role"], "editor")
        self.assertEqual(data["content"]["description_markdown"], "# new")
        self.assertIsNone(data["latest_revision"])
        # required_role="viewer"——任何已登录用户都能读
        kwargs = svc.get_document.call_args.kwargs
        self.assertEqual(kwargs.get("required_role") or svc.get_document.call_args.args[1:], "viewer")

    def test_get_returns_400_on_uuid_format_value_error(self):
        """ValueError 含 "uuid" / "format" 关键字 → 400 ``VALIDATION_ERROR``。
        这是 ``str(uuid.UUID(bad_id))`` 抛 ``ValueError("badly formed hexadecimal UUID")``
        的兜底路径——agent 误传非 UUID 字符串时 CLI 立刻看到"格式问题"而非"找不到"。"""
        with self._patch_service() as svc:
            svc.get_document.side_effect = ValueError(
                "badly formed hexadecimal UUID string"
            )
            resp = self._get(f"/api/tabdoc/documents/not-a-uuid")
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_get_returns_404_on_other_value_error(self):
        """ValueError 其它消息（如"文档不存在"）→ 404 ``NOT_FOUND``。
        CLI 据此走 retry-with-different-id 还是 give-up 分支。"""
        with self._patch_service() as svc:
            svc.get_document.side_effect = ValueError("Document not found")
            resp = self._get(f"/api/tabdoc/documents/{uuid4()}")
        self.assertEqual(resp.status_code, 404, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "NOT_FOUND")

    def test_get_returns_403_on_permission_error(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("当前用户无权访问该文档")
            resp = self._get(f"/api/tabdoc/documents/{uuid4()}")
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_get_returns_401_when_jwt_missing(self):
        resp = self._get(f"/api/tabdoc/documents/{uuid4()}", with_auth=False)
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# PATCH /api/tabdoc/documents/{id} · update_document
# ===========================================================================


class UpdateDocumentApiTests(_TabDocApiBase):
    """覆盖 update_document 的部分更新语义 / 乐观锁 / 字段校验。

    CLI 对应：``tabtin doc update``。乐观锁字段 ``base_version`` /
    ``base_updated_at`` 是 P0 契约——传错会被 CLI 用户当成"更新莫名其妙失败"。"""

    def test_update_passes_partial_fields_with_optimistic_lock(self):
        """部分更新：只传 title + base_version，其它字段应以 None 传给 service
        （service 用 None 区分"不更新"vs"清空"）。"""
        document = _build_document()
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.update_document.return_value = document
            svc.compute_user_document_role.return_value = "owner"
            resp = self._patch(
                f"/api/tabdoc/documents/{document.id}",
                {"title": "新标题", "base_version": 3},
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.update_document.call_args.kwargs
        self.assertEqual(kwargs["title"], "新标题")
        self.assertEqual(kwargs["base_version"], 3)
        # 未传的字段必须是 None，不能是 "" 或 其它默认值——
        # service 用 None 当 "skip" sentinel
        self.assertIsNone(kwargs["icon"])
        self.assertIsNone(kwargs["status"])
        self.assertIsNone(kwargs["tags"])
        self.assertIsNone(kwargs["cover_position"])
        # ：PATCH 元数据也回填 current_user_role
        self.assertEqual(self._body(resp)["data"]["document"]["current_user_role"], "owner")
        svc.compute_user_document_role.assert_called_once_with(document)

    def test_update_rejects_cover_position_out_of_range(self):
        """R-A3 契约：``cover_position`` 必须在 [0, 1]，1.5 被 ninja Schema
        ``Field(ge=0, le=1)`` 拦截 → 400 ``VALIDATION_ERROR``。
        service 层 clamp 是 defense-in-depth，但 schema 必须先拦。"""
        resp = self._patch(
            f"/api/tabdoc/documents/{uuid4()}",
            {"cover_position": 1.5},
        )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_update_rejects_invalid_base_updated_at(self):
        """``base_updated_at`` 必须是 ISO 8601，``"yesterday"`` 被 schema
        field_validator 拦在 handler 前。"""
        resp = self._patch(
            f"/api/tabdoc/documents/{uuid4()}",
            {"base_updated_at": "yesterday"},
        )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_update_returns_409_on_version_conflict(self):
        """乐观锁失败：service 抛 ``ConflictError`` →
        ``code='VERSION_CONFLICT'`` (HTTP 409)——CLI 看到 409 触发 retry 逻辑。"""
        document = _build_document()
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.update_document.side_effect = ConflictError("base_version 过期")
            resp = self._patch(
                f"/api/tabdoc/documents/{document.id}",
                {"title": "新标题", "base_version": 1},
            )
        self.assertEqual(resp.status_code, 409, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "VERSION_CONFLICT")

    def test_update_returns_403_when_get_document_denies(self):
        """``get_document(..., required_role="editor")`` 失败 →
        PermissionError → 403。钉这一层是因为 update 路径**先 get 再 update**，
        get 失败时 update 不该被触达。"""
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("需要 editor 角色")
            resp = self._patch(
                f"/api/tabdoc/documents/{uuid4()}",
                {"title": "X"},
            )
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        # 关键断言：update_document 不能被调到（auth 失败后流程必须 short-circuit）
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("x")
            self._patch(f"/api/tabdoc/documents/{uuid4()}", {"title": "X"})
            svc.update_document.assert_not_called()

    def test_update_returns_401_when_jwt_missing(self):
        resp = self._patch(
            f"/api/tabdoc/documents/{uuid4()}",
            {"title": "X"},
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# DELETE /api/tabdoc/documents/{id} · archive_document
# ===========================================================================


class ArchiveDocumentApiTests(_TabDocApiBase):
    """覆盖 archive_document（软删除）。

    CLI 对应：``tabtin doc archive``（注意不是 ``doc delete``，"delete" CLI
    走的是另一个 ``permanent-delete`` 端点；这里钉的是默认归档语义）。"""

    def test_archive_calls_service_and_returns_archived_document(self):
        """主路径：DELETE → service.archive_document → 返回归档后的 document。
        响应里 ``status='archived'`` 是 CLI 判断"我档真的归档了"的依据。"""
        document = _build_document(status="active")
        archived = _build_document(document_id=document.id, status="archived")
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.archive_document.return_value = archived
            resp = self._delete(f"/api/tabdoc/documents/{document.id}")
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["document"]["status"], "archived")
        # archive 走 editor 角色（与 update 一致），不是 viewer
        svc.get_document.assert_called_once()
        svc.archive_document.assert_called_once_with(document)

    def test_archive_returns_403_when_get_document_denies(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("需要 editor 角色")
            resp = self._delete(f"/api/tabdoc/documents/{uuid4()}")
            svc.archive_document.assert_not_called()
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))

    def test_archive_returns_400_when_service_raises_value_error(self):
        """已经归档的文档再 archive → service ValueError → 400."""
        document = _build_document(status="archived")
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.archive_document.side_effect = ValueError("文档已归档")
            resp = self._delete(f"/api/tabdoc/documents/{document.id}")
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_archive_returns_401_when_jwt_missing(self):
        resp = self._delete(f"/api/tabdoc/documents/{uuid4()}", with_auth=False)
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# GET /api/tabdoc/documents/{id}/binary · get_document_binary
# ===========================================================================


class DocumentBinaryApiTests(_TabDocApiBase):
    """覆盖 Hocuspocus 拉取 TabDoc Y.js binary 的契约。"""

    def test_unwraps_binary_snapshot_and_persists_raw_binary(self):
        """历史 wrapper 进入当前 binary 字段时，端点返回并落库原始 Y.js bytes。"""
        raw_binary = b"\x01\x02tabdoc-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "title": "wrapped",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        document = _build_document()
        document.description_binary = wrapped_binary

        async def run_inline(fn):
            return fn()

        request = SimpleNamespace(auth=_make_user_namespace(), headers={})

        with self._patch_service() as svc, patch(
            "apps.tabdoc.api.run_in_agent_io_executor",
            side_effect=run_inline,
        ), patch("apps.tabdoc.models.Document") as doc_model:
            svc.get_document.return_value = document
            svc.assert_document_collab_writable = MagicMock()
            doc_model.objects.using.return_value.filter.return_value.update.return_value = 1

            response = asyncio.run(get_document_binary(request, str(document.id)))

        data = response["data"]
        self.assertTrue(data["has_binary"])
        self.assertEqual(data["binary_b64"], base64.b64encode(raw_binary).decode())
        self.assertEqual(data["description_markdown"], "")
        svc.get_document.assert_called_once_with(str(document.id), required_role="viewer")
        svc.assert_document_collab_writable.assert_called_once_with(document)
        doc_model.objects.using.return_value.filter.assert_called_once_with(
            id=document.id,
            description_binary=wrapped_binary,
        )
        doc_model.objects.using.return_value.filter.return_value.update.assert_called_once_with(
            description_binary=raw_binary,
        )

    def test_resolve_vh_content_unwraps_binary_snapshot(self):
        raw_binary = b"\x01\x02history-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        vh = SimpleNamespace(blob=zlib.compress(wrapped_binary))

        resolved = DocumentService(user=None)._resolve_vh_content(vh)

        self.assertEqual(resolved["format"], "yjs_binary")
        self.assertEqual(resolved["binary"], raw_binary)

    def test_unwraps_binary_snapshot_cas_miss_returns_latest_binary(self):
        raw_binary = b"\x01\x02old-yjs-update"
        latest_binary = b"\x01\x02new-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        document = _build_document()
        document.description_binary = wrapped_binary

        async def run_inline(fn):
            return fn()

        request = SimpleNamespace(auth=_make_user_namespace(), headers={})
        latest_doc = SimpleNamespace(description_binary=latest_binary)

        with self._patch_service() as svc, patch(
            "apps.tabdoc.api.run_in_agent_io_executor",
            side_effect=run_inline,
        ), patch("apps.tabdoc.models.Document") as doc_model:
            svc.get_document.return_value = document
            svc.assert_document_collab_writable = MagicMock()
            manager = doc_model.objects.using.return_value
            manager.filter.return_value.update.return_value = 0
            manager.only.return_value.get.return_value = latest_doc

            response = asyncio.run(get_document_binary(request, str(document.id)))

        data = response["data"]
        self.assertTrue(data["has_binary"])
        self.assertEqual(data["binary_b64"], base64.b64encode(latest_binary).decode())
        manager.only.assert_called_once_with("description_binary")
        manager.only.return_value.get.assert_called_once_with(id=document.id)

    def test_resolve_history_content_unwraps_binary_snapshot(self):
        raw_binary = b"\x01\x02doc-history-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")
        history = SimpleNamespace(
            id=uuid4(),
            blob=zlib.compress(wrapped_binary),
            is_snapshot=True,
        )

        resolved = DocumentService(user=None)._resolve_history_content(history)

        self.assertEqual(resolved["format"], "yjs_binary")
        self.assertEqual(resolved["binary"], raw_binary)

    def test_export_binary_conversion_unwraps_binary_snapshot(self):
        raw_binary = b"\x01\x02export-yjs-update"
        wrapped_binary = json.dumps({
            "format": "binary_snapshot",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }).encode("utf-8")

        with patch("apps.services.common.live_api.call_live_api") as live_api:
            live_api.return_value = {
                "json": {"type": "doc"},
                "markdown": "# Exported",
            }

            result = DocumentExchangeService._resolve_from_binary(wrapped_binary, uuid4())

        self.assertEqual(result, ({"type": "doc"}, "# Exported"))
        live_api.assert_called_once()
        payload = live_api.call_args.args[1]
        self.assertEqual(payload["binary_b64"], base64.b64encode(raw_binary).decode())


# ===========================================================================
# POST /api/tabdoc/documents/{id}/content · save_document_content
# ===========================================================================


class SaveDocumentContentApiTests(_TabDocApiBase):
    """覆盖 save_content 的 CRDT 三态字段 / 乐观锁 / 内容回填。

    CLI 对应：``tabtin doc save-content``。content 三态（pm_json / markdown /
    plaintext）是契约里最容易踩坑的——CLI 一般只填一个，其它两个由后端
    转换填充，但 schema 要求都接受。"""

    URL_TMPL = "/api/tabdoc/documents/{id}/content"

    def test_save_passes_content_fields_to_service(self):
        """字段映射：``content_pm_json / content_markdown / content_plaintext``
        三件套都必须按命名透传给 ``service.save_content``。
        遗失任何一个，agent 写的 markdown 会"看起来保存了"但实际丢内容。"""
        document = _build_document(description_markdown="# new")
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.save_content.return_value = document
            svc.compute_user_document_role.return_value = "owner"
            resp = self._post(
                self.URL_TMPL.format(id=document.id),
                {
                    "title": "新标题",
                    "base_version": 1,
                    "content_pm_json": {"type": "doc"},
                    "content_markdown": "# new",
                    "content_plaintext": "new",
                },
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.save_content.call_args.kwargs
        self.assertEqual(kwargs["title"], "新标题")
        self.assertEqual(kwargs["base_version"], 1)
        self.assertEqual(kwargs["content_pm_json"], {"type": "doc"})
        self.assertEqual(kwargs["content_markdown"], "# new")
        self.assertEqual(kwargs["content_plaintext"], "new")
        # 写成功只返 document 元数据，不回显正文
        self.assertNotIn("content", self._body(resp)["data"])
        self.assertEqual(self._body(resp)["data"]["document"]["latest_version"], document.latest_version)
        # ：写响应须回填 current_user_role，否则前端 canManage 偶发变 false
        self.assertEqual(self._body(resp)["data"]["document"]["current_user_role"], "owner")
        svc.compute_user_document_role.assert_called_once_with(document)

    def test_save_defaults_content_fields_to_empty(self):
        """全部 content 字段都有 schema default——空 body（只传 base_version）
        必须能成功调到 service，content 三件套默认空值。
        这是"清空文档"路径——agent 偶尔会用，不能挂。"""
        document = _build_document()
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.save_content.return_value = document
            resp = self._post(
                self.URL_TMPL.format(id=document.id),
                {"base_version": 1},
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.save_content.call_args.kwargs
        self.assertEqual(kwargs["content_pm_json"], {})
        self.assertEqual(kwargs["content_markdown"], "")
        self.assertEqual(kwargs["content_plaintext"], "")

    def test_save_returns_409_on_conflict(self):
        document = _build_document()
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.save_content.side_effect = ConflictError("base_version 过期")
            resp = self._post(
                self.URL_TMPL.format(id=document.id),
                {"base_version": 1, "content_markdown": "x"},
            )
        self.assertEqual(resp.status_code, 409, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VERSION_CONFLICT")

    def test_save_invalid_tabdata_reaches_real_service_and_returns_400(self):
        """非法 tabdata 必须穿过真实 DocumentService 转换链返回 400。

        这里仅 mock 文档查找和权限，不 mock save_content；因此能抓住
        save_content catch-all 吞 ValueError 后继续返回 200 的回归。
        """
        document = _build_document(
            description_json={"type": "doc", "content": [{"type": "paragraph"}]},
            description_markdown="旧正文",
        )
        service = DocumentService(user=_make_user_namespace())
        service.get_document = MagicMock(return_value=document)

        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ), patch.object(
            service,
            "check_document_permission",
            return_value=True,
        ):
            resp = self._post(
                self.URL_TMPL.format(id=document.id),
                {
                    "base_version": document.latest_version,
                    "content_markdown": ":::tabdata{tableId=tbl-bad}\n:::",
                },
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")
        self.assertIn("tableId", self._body(resp)["message"])
        self.assertEqual(document.description_markdown, "旧正文")

    def test_save_returns_403_when_get_document_denies(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("需要 editor 角色")
            resp = self._post(
                self.URL_TMPL.format(id=uuid4()),
                {"content_markdown": "x"},
            )
            svc.save_content.assert_not_called()
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))

    def test_save_returns_401_when_jwt_missing(self):
        resp = self._post(
            self.URL_TMPL.format(id=uuid4()),
            {"content_markdown": "x"},
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


class BlockWriteTabdataValidationApiTests(_TabDocApiBase):
    def _real_service_and_document(self):
        document = _build_document(
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "attrs": {"blockId": "blk-a"},
                        "content": [{"type": "text", "text": "原文"}],
                    }
                ],
            },
            description_markdown="原文",
        )
        service = DocumentService(user=_make_user_namespace())
        service.get_document = MagicMock(return_value=document)
        return service, document

    def test_insert_block_invalid_tabdata_returns_400(self):
        service, document = self._real_service_and_document()
        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ):
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks",
                {"markdown": ':::tabdata{tableId=""}\n:::'},
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_insert_block_at_start_is_additive_and_keeps_default_contract(self):
        service, document = self._real_service_and_document()
        service.save_content = MagicMock(return_value=document)
        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ):
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks",
                {"markdown": "顶部图片", "at_start": True},
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        data = self._body(resp)["data"]
        self.assertNotIn("at_start", data)
        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        self.assertEqual(content[0]["content"][0]["text"], "顶部图片")
        self.assertEqual(content[1]["attrs"]["blockId"], "blk-a")

    def test_insert_block_old_request_still_appends_with_old_response_fields(self):
        service, document = self._real_service_and_document()
        service.save_content = MagicMock(return_value=document)
        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ):
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks",
                {"markdown": "末尾图片"},
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        data = self._body(resp)["data"]
        self.assertIn("document", data)
        self.assertIn("inserted_block_ids", data)
        self.assertIsNone(data["after_block_id"])
        self.assertNotIn("at_start", data)
        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        self.assertEqual(content[0]["attrs"]["blockId"], "blk-a")
        self.assertEqual(content[1]["content"][0]["text"], "末尾图片")

    def test_update_block_invalid_tabdata_returns_400(self):
        service, document = self._real_service_and_document()
        with patch("apps.tabdoc.api._build_service", return_value=service), patch(
            "apps.tabdoc.api._organization_resource_write_block_response",
            return_value=None,
        ):
            resp = self._patch(
                f"/api/tabdoc/documents/{document.id}/blocks/blk-a",
                {"markdown": ":::tabdata{tableId=tbl-bad}\n:::"},
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")


class HighlightDocumentBlockApiTests(_TabDocApiBase):
    def test_format_text_exposes_toolbar_style_contract(self):
        document = _build_document(
            description_json={
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "attrs": {"blockId": "blk-a"},
                    "content": [{"type": "text", "text": "父亲说：我买几个橘子去。"}],
                }],
            },
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.save_content.return_value = document
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks/blk-a/format-text",
                {
                    "text": "我买几个橘子去。",
                    "bold": True,
                    "underline": True,
                    "text_color": "red",
                    "background_color": "yellow",
                    "link_url": "https://example.com/dialogue",
                    "base_version": 1,
                },
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        self.assertEqual(self._body(resp)["data"]["applied"]["text_color"], "#E00000")
        node = svc.save_content.call_args.kwargs["content_pm_json"]["content"][0]["content"][1]
        self.assertIn({"type": "bold"}, node["marks"])
        self.assertIn({"type": "underline"}, node["marks"])
        self.assertIn({"type": "highlight", "attrs": {"color": "#fef9c3"}}, node["marks"])
        self.assertIn({"type": "link", "attrs": {"href": "https://example.com/dialogue"}}, node["marks"])

    def test_highlight_passes_native_mark_to_save_without_markdown_rewrite(self):
        document = _build_document(
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "attrs": {"blockId": "blk-a"},
                        "content": [
                            {"type": "text", "text": "父亲说："},
                            {"type": "text", "text": "我买几个橘子去。", "marks": [{"type": "bold"}]},
                        ],
                    }
                ],
            },
            description_markdown="父亲说：我买几个橘子去。",
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.save_content.return_value = document
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks/blk-a/highlight",
                {"text": "我买几个橘子去。", "color": "yellow", "base_version": 1},
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        self.assertEqual(self._body(resp)["data"]["color"], "yellow")
        node = svc.save_content.call_args.kwargs["content_pm_json"]["content"][0]["content"][1]
        self.assertIn({"type": "bold"}, node["marks"])
        self.assertIn(
            {"type": "highlight", "attrs": {"color": "#fef9c3"}},
            node["marks"],
        )

    def test_highlight_rejects_ambiguous_text_before_save(self):
        document = _build_document(
            description_json={
                "type": "doc",
                "content": [{
                    "type": "paragraph",
                    "attrs": {"blockId": "blk-a"},
                    "content": [{"type": "text", "text": "对话 对话"}],
                }],
            },
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/blocks/blk-a/highlight",
                {"text": "对话"},
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")
        svc.save_content.assert_not_called()


class RecoveryDraftApiTests(_TabDocApiBase):
    def _recovery(self, document):
        now = datetime.now(timezone.utc)
        return SimpleNamespace(
            id=uuid4(),
            document_id=document.id,
            base_version=3,
            status="active",
            created_at=now,
            expires_at=now,
            restored_at=None,
            creator_id=uuid4(),
        )

    def test_create_preserves_draft_without_writing_document_content(self):
        document = _build_document(latest_version=4)
        recovery = self._recovery(document)
        payload = {
            "base_version": 3,
            "content_pm_json": {"type": "doc", "content": []},
            "content_markdown": "local draft",
            "content_plaintext": "local draft",
        }
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.create_recovery_draft.return_value = recovery
            resp = self._post(f"/api/tabdoc/documents/{document.id}/recovery-drafts", payload)

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        svc.get_document.assert_called_once_with(str(document.id), required_role="editor")
        svc.create_recovery_draft.assert_called_once_with(
            document,
            base_version=3,
            content_pm_json=payload["content_pm_json"],
            content_markdown="local draft",
            content_plaintext="local draft",
        )
        svc.save_content.assert_not_called()

    def test_list_uses_viewer_permission_and_does_not_expose_content(self):
        document = _build_document()
        recovery = self._recovery(document)
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.list_recovery_drafts.return_value = [recovery]
            resp = self._get(f"/api/tabdoc/documents/{document.id}/recovery-drafts")

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        svc.get_document.assert_called_once_with(str(document.id), required_role="viewer")
        item = self._body(resp)["data"]["recovery_drafts"][0]
        self.assertEqual(item["id"], str(recovery.id))
        self.assertNotIn("content_markdown", item)
        self.assertNotIn("content_pm_json", item)

    def test_restore_requires_explicit_confirmation_before_editor_service_call(self):
        document = _build_document()
        with self._patch_service() as svc:
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/recovery-drafts/{uuid4()}/restore",
                {"confirm_replace": False},
            )

        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        svc.get_document.assert_not_called()
        svc.restore_recovery_draft.assert_not_called()

    def test_restore_uses_editor_permission_and_current_base_version(self):
        document = _build_document(latest_version=4)
        recovery_id = uuid4()
        with self._patch_service() as svc:
            svc.get_document.return_value = document
            svc.restore_recovery_draft.return_value = document
            svc.compute_user_document_role.return_value = "editor"
            resp = self._post(
                f"/api/tabdoc/documents/{document.id}/recovery-drafts/{recovery_id}/restore",
                {"confirm_replace": True, "base_version": 4},
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        svc.get_document.assert_called_once_with(str(document.id), required_role="editor")
        svc.restore_recovery_draft.assert_called_once_with(
            document,
            str(recovery_id),
            base_version=4,
            base_updated_at=None,
        )


__all__ = [
    "ImportMarkdownDraftApiTests",
    "CreateDocumentApiTests",
    "ListDocumentsApiTests",
    "GetDocumentApiTests",
    "UpdateDocumentApiTests",
    "ArchiveDocumentApiTests",
    "DocumentBinaryApiTests",
    "SaveDocumentContentApiTests",
    "BlockWriteTabdataValidationApiTests",
    "HighlightDocumentBlockApiTests",
    "RecoveryDraftApiTests",
]

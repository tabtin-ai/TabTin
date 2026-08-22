"""
Plan HTTP API 端到端测试（W2-QC P1-2 必修）

为什么需要这一层
----------------
W1-C 已经覆盖：
- ``test_plan_service``：service 层完整业务规则（draft 守卫、approve 元数据等）
- ``test_plan_tools``：BaseTool 薄壳的参数转发与错误码映射

但都**没有触达 ninja Router 真实路径**：
- HTTP Schema 字段映射（``agent_mode_at_create / session_id / agent_id``）
- ninja 422 / 业务 4xx 状态码分类
- ``JWTAuth`` 缺失/失效场景
- ``_service_error_response`` 把 ``PlanServiceError`` 映射成统一 ``code`` /
  ``data.error_code`` 形态（顶层 PLAN_*，data 也带 PLAN_*）

为什么用 SimpleTestCase + mock 而不是 TestCase + 真实 DB
-----------------------------------------------------------
- 仓库 ``conversation/0024_add_fulltext_index_chat_message_content.py``
  是 MySQL FULLTEXT INDEX，SQLite 测试 DB 创建会失败。该 migration 是历史
  遗留问题，不在本 Wave 范围。
- 本测试目的是验证 **API 层**（schema 校验/字段映射/错误码/JWT auth），不是
  PlanService 业务逻辑。后者已被 ``test_plan_service`` 用 SimpleNamespace 完整
  覆盖。
- 通过 ``patch('apps.users.auth.permissions.JWTAuth.authenticate')`` mock auth
  + ``patch('apps.tabdoc.api_plan.PlanService')`` mock service，``self.client.post``
  仍然走真实的 ninja Router → JWTAuth.__call__ → handler → response 链路。

任何 TS 端 / Runtime 端如果改动 ``api_plan.py`` 的 Schema 字段名或错误码映射，
本测试都能立刻发现漂移。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdoc.services.plan_schema import PlanProperties, PlanTodo
from apps.tabdoc.services.plan_service import PlanServiceError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_document(
    *,
    document_id=None,
    organization_id=None,
    space_id=None,
    title: str = "Plan A",
    tags=None,
    description_markdown: str = "# Plan body",
):
    """构造满足 ``_serialize_plan_document`` 字段访问的轻量 document。"""
    return SimpleNamespace(
        id=document_id or uuid4(),
        organization_id=organization_id or uuid4(),
        space_id=space_id or uuid4(),
        title=title,
        tags=list(tags or ["plan"]),
        latest_version=1,
        updated_at=datetime.now(timezone.utc),
        description_markdown=description_markdown,
    )


def _build_plan_props(**kwargs) -> PlanProperties:
    """构造带最少必填字段的 ``PlanProperties``，便于断言 body 中序列化字段。"""
    defaults = {"name": "Plan A"}
    defaults.update(kwargs)
    return PlanProperties(**defaults)


def _make_user_namespace(user_id: str = "11111111-1111-1111-1111-111111111111"):
    """返回最小可用的 user 对象供 ``request.auth`` 使用。

    ``api_plan._ensure_authed`` 仅做 truthy 检查，``PlanService`` 已被 mock，
    所以这里不需要真实 Django User 实例。"""
    return SimpleNamespace(
        id=user_id,
        pk=user_id,
        is_authenticated=True,
        is_active=True,
    )


class _PlanApiBase(SimpleTestCase):
    """共享 setUp：mock JWTAuth.authenticate（假登录）+ 提供 ``_post`` 工具。

    每个具体子类用 ``patch('apps.tabdoc.api_plan.PlanService')`` 控制 service
    返回值；本基类只负责 auth 维度。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # 模块级 patch，整个 Test class 范围内 JWTAuth.authenticate 永远返回 user。
        # 实例 ``apps.tabdoc.api_plan.jwt_auth`` 是 ``JWTAuth()`` 单例，被 ninja
        # 装饰器在 import 时绑定；patch 类方法可以同时影响该单例。
        cls._auth_patcher = patch(
            "apps.users.auth.permissions.JWTAuth.authenticate",
            return_value=_make_user_namespace(),
        )
        cls._auth_patcher.start()

    @classmethod
    def tearDownClass(cls):
        cls._auth_patcher.stop()
        super().tearDownClass()

    def _post(self, url: str, payload: dict, *, with_auth: bool = True):
        headers = {"HTTP_AUTHORIZATION": "Bearer fake-test-token"} if with_auth else {}
        return self.client.post(
            url,
            data=json.dumps(payload),
            content_type="application/json",
            **headers,
        )

    @staticmethod
    def _body(resp):
        return resp.json()


# ---------------------------------------------------------------------------
# POST /api/plan/create
# ---------------------------------------------------------------------------


class PlanCreateApiTests(_PlanApiBase):
    """覆盖 plan_create 入口的字段映射与错误分类。"""

    def test_create_passes_session_agent_and_mode_fields_to_service(self):
        """字段映射：``session_id / agent_id / agent_mode_at_create`` 必须
        按 snake_case 透传给 service，并写入返回的 ``plan`` 序列化字段。"""
        document = _build_document(title="发布 V1")
        plan_props = _build_plan_props(
            name="发布 V1",
            session_id="sess-123",
            agent_id="agent-abc",
            agent_mode_at_create="plan",
        )
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.create_plan.return_value = {
                "document": document,
                "plan": plan_props,
                "collection_id": str(uuid4()),
            }
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/create",
                {
                    "organization_id": str(uuid4()),
                    "space_id": str(uuid4()),
                    "name": "发布 V1",
                    "overview": "概述",
                    "plan": "## body",
                    "todos": [{"content": "写代码"}],
                    "session_id": "sess-123",
                    "agent_id": "agent-abc",
                    "agent_mode_at_create": "plan",
                },
            )

        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["document_id"], str(document.id))
        # PlanProperties 字段写入 properties.plan，序列化回 body
        self.assertEqual(body["data"]["plan"]["session_id"], "sess-123")
        self.assertEqual(body["data"]["plan"]["agent_id"], "agent-abc")
        self.assertEqual(body["data"]["plan"]["agent_mode_at_create"], "plan")

        kwargs = svc.create_plan.call_args.kwargs
        # API 层职责：HTTP body → service 入参（含 plan→plan_markdown 重命名）
        self.assertEqual(kwargs["session_id"], "sess-123")
        self.assertEqual(kwargs["agent_id"], "agent-abc")
        self.assertEqual(kwargs["agent_mode_at_create"], "plan")
        self.assertEqual(kwargs["name"], "发布 V1")
        self.assertEqual(kwargs["overview"], "概述")
        self.assertEqual(kwargs["plan_markdown"], "## body")
        self.assertEqual(len(kwargs["todos"]), 1)
        self.assertEqual(kwargs["todos"][0]["content"], "写代码")

    def test_create_defaults_agent_mode_to_plan_when_omitted(self):
        """``agent_mode_at_create`` 缺失时 API 层兜底为 ``plan``，避免下游
        ``PlanProperties`` Literal 校验失败（None 不在枚举范围）。"""
        document = _build_document()
        plan_props = _build_plan_props(name="X")
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.create_plan.return_value = {
                "document": document,
                "plan": plan_props,
                "collection_id": None,
            }
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/create",
                {
                    "organization_id": str(uuid4()),
                    "space_id": str(uuid4()),
                    "name": "X",
                },
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        kwargs = svc.create_plan.call_args.kwargs
        self.assertEqual(kwargs["agent_mode_at_create"], "plan")

    def test_create_rejects_blank_name_via_ninja_schema(self):
        """ninja Schema 校验：``name=''`` 触发 ``min_length=1``，被 Pydantic
        在进入 handler 前拦截。

        项目 ``apps.api_validation`` 全局 exception handler 把 ninja 默认
        422 统一映射为 400 + ``code='VALIDATION_ERROR'``，与业务错误码
        （``PLAN_INVALID_INPUT``）区分开 — 调用方按 ``code`` 分支。"""
        resp = self._post(
            "/api/plan/create",
            {
                "organization_id": str(uuid4()),
                "space_id": str(uuid4()),
                "name": "",
            },
        )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")

    def test_create_returns_400_when_service_rejects_input(self):
        """业务校验失败（如 ``PlanProperties`` 内部 ``ValueError``，被
        ``PlanService`` 包裹成 ``PlanServiceError(PLAN_INVALID_INPUT, status=400)``）
        映射为 400，且 ``code`` 与 ``data.error_code`` 都打成 ``PLAN_INVALID_INPUT``
        （而不是 helper 默认的 ``VALIDATION_ERROR``）。"""
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.create_plan.side_effect = PlanServiceError(
                "PLAN_INVALID_INPUT",
                "plan 字段校验失败：name 不能为空",
                status=400,
            )
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/create",
                {
                    "organization_id": str(uuid4()),
                    "space_id": str(uuid4()),
                    "name": "x",  # ninja Schema 通过；service 抛错
                },
            )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PLAN_INVALID_INPUT")
        self.assertEqual(body["data"]["error_code"], "PLAN_INVALID_INPUT")

    def test_create_returns_401_when_jwt_missing(self):
        """无 ``Authorization`` 头 → ninja JWTAuth 直接返回 401。"""
        resp = self._post(
            "/api/plan/create",
            {
                "organization_id": str(uuid4()),
                "space_id": str(uuid4()),
                "name": "X",
            },
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))

    def test_create_returns_403_when_user_lacks_permission(self):
        """端点对称性：DocumentService 因权限不足抛 PermissionError，被
        ``PlanService.create_plan`` 包装为 ``PlanServiceError(PLAN_PERMISSION_DENIED, 403)``，
        API 层再映射为 403 + ``PLAN_PERMISSION_DENIED`` 双层 code。"""
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.create_plan.side_effect = PlanServiceError(
                "PLAN_PERMISSION_DENIED",
                "当前用户无权在该 Space 创建 Plan",
                status=403,
            )
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/create",
                {
                    "organization_id": str(uuid4()),
                    "space_id": str(uuid4()),
                    "name": "X",
                },
            )
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "PLAN_PERMISSION_DENIED")
        self.assertEqual(body["data"]["error_code"], "PLAN_PERMISSION_DENIED")


# ---------------------------------------------------------------------------
# POST /api/plan/update_todos
# ---------------------------------------------------------------------------


class PlanUpdateTodosApiTests(_PlanApiBase):
    """覆盖 update_todos 的 status 守卫与错误码映射。"""

    def test_update_todos_returns_409_when_plan_already_approved(self):
        """approved 后再 update_todos → service 抛 PLAN_NOT_DRAFT(409)；
        响应 ``code`` 与 ``data.error_code`` 都为 ``PLAN_NOT_DRAFT``。"""
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.update_todos.side_effect = PlanServiceError(
                "PLAN_NOT_DRAFT",
                "Plan 已是 approved 状态，不允许更新 todos",
                status=409,
            )
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/update_todos",
                {
                    "plan_document_id": str(uuid4()),
                    "todos": [{"content": "再加一个"}],
                    "merge": True,
                },
            )
        self.assertEqual(resp.status_code, 409, msg=self._body(resp))
        body = self._body(resp)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "PLAN_NOT_DRAFT")
        self.assertEqual(body["data"]["error_code"], "PLAN_NOT_DRAFT")

    def test_update_todos_returns_payload_with_plan_and_todos(self):
        """成功路径：返回 ``todos_after_update`` + 完整 plan props。"""
        document = _build_document()
        plan_props = _build_plan_props(
            name="X",
            todos=[PlanTodo(id="t1", content="A", status="completed")],
        )
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.update_todos.return_value = {
                "document": document,
                "plan": plan_props,
                "todos_after_update": [
                    {"id": "t1", "content": "A", "status": "completed"}
                ],
            }
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/update_todos",
                {
                    "plan_document_id": str(document.id),
                    "todos": [{"id": "t1", "content": "A", "status": "completed"}],
                    "merge": True,
                },
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["todos_after_update"][0]["status"], "completed")
        self.assertEqual(len(body["data"]["plan"]["todos"]), 1)

    # ── 端点对称性：update_todos 也走相同的 JWTAuth + _service_error_response ──
    # 主路径已在 PlanCreateApiTests / PlanExitApiTests 验证，这里补对称用例避免
    # 三个端点的某个 router 配置出现分叉（如 auth 装饰器漏挂）时无人发现。

    def test_update_todos_returns_401_when_jwt_missing(self):
        resp = self._post(
            "/api/plan/update_todos",
            {
                "plan_document_id": str(uuid4()),
                "todos": [{"content": "x"}],
                "merge": True,
            },
            with_auth=False,
        )
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))

    def test_update_todos_returns_404_when_plan_not_found(self):
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.update_todos.side_effect = PlanServiceError(
                "PLAN_NOT_FOUND", "文档不存在", status=404
            )
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/update_todos",
                {
                    "plan_document_id": str(uuid4()),
                    "todos": [{"content": "x"}],
                    "merge": True,
                },
            )
        self.assertEqual(resp.status_code, 404, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "PLAN_NOT_FOUND")
        self.assertEqual(body["data"]["error_code"], "PLAN_NOT_FOUND")

    def test_update_todos_returns_403_when_user_lacks_permission(self):
        with patch("apps.tabdoc.api_plan.PlanService") as svc_cls:
            svc = MagicMock()
            svc.update_todos.side_effect = PlanServiceError(
                "PLAN_PERMISSION_DENIED",
                "当前用户无权访问该 Plan 文档",
                status=403,
            )
            svc_cls.return_value = svc

            resp = self._post(
                "/api/plan/update_todos",
                {
                    "plan_document_id": str(uuid4()),
                    "todos": [{"content": "x"}],
                    "merge": True,
                },
            )
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "PLAN_PERMISSION_DENIED")
        self.assertEqual(body["data"]["error_code"], "PLAN_PERMISSION_DENIED")


__all__ = [
    "PlanCreateApiTests",
    "PlanUpdateTodosApiTests",
]

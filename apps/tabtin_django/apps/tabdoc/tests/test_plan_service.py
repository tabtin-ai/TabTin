"""
PlanService 单元测试（Wave 1-C）

策略：避免依赖 DB / Collection / ContextItem 的真实实例，全部用 MagicMock
注入；重点验证：
- 三件套核心业务规则（Plan vs Todo 分工、status 守卫、approve 后冻结）；
- properties.plan schema 的读写正确性；
- 兜底逻辑（Collection 缺失时不阻塞 Plan 创建）。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from apps.tabdoc.services.plan_schema import (
    PLAN_DOCUMENT_TAG,
    PlanProperties,
    PlanTodo,
)
from apps.tabdoc.services.plan_service import PlanService, PlanServiceError


def _make_user(user_id: str = "11111111-1111-1111-1111-111111111111") -> SimpleNamespace:
    return SimpleNamespace(id=user_id, pk=user_id)


def _make_document(
    *,
    properties: dict | None = None,
    tags: list | None = None,
    description_markdown: str = "",
    description_json: dict | None = None,
    description_plaintext: str = "",
) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        space_id=uuid4(),
        parent_id=None,
        title="测试 Plan",
        status="active",
        latest_version=1,
        tags=list(tags or []),
        properties=dict(properties or {}),
        description_json=dict(description_json or {"type": "doc", "content": []}),
        description_markdown=description_markdown,
        description_plaintext=description_plaintext,
        updated_at=datetime.now(timezone.utc),
        save=MagicMock(),
        get_context_type=lambda: "tabdoc",
    )


class _TxStub:
    """模拟 ``transaction.atomic(using='postgresql')`` + ``on_commit``。

    保证 ``with transaction.atomic(...):`` 不报错；on_commit 立即执行 callback。
    """

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _patch_transaction():
    """统一 patch service 内的 transaction.atomic / on_commit。

    使用 contextmanager 链方式不太合适，这里返回一个 helper：调用方在
    setUp 中持有 patcher 列表统一 stop。
    """
    import apps.tabdoc.services.plan_service as plan_module
    atomic_patch = patch.object(plan_module.transaction, "atomic", lambda using=None: _TxStub())
    on_commit_patch = patch.object(plan_module.transaction, "on_commit", lambda fn, using=None: fn())
    return atomic_patch, on_commit_patch


class PlanServiceCreateTests(unittest.TestCase):
    def setUp(self):
        self.user = _make_user()
        atomic_patch, on_commit_patch = _patch_transaction()
        self._patches = [atomic_patch, on_commit_patch]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_create_plan_writes_properties_and_tags(self):
        document = _make_document()

        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls, patch(
            "apps.tabdoc.services.plan_service._ensure_planning_collection",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.create_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            result = service.create_plan(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                name="发布 V1",
                overview="一句话",
                plan_markdown="## 步骤\n\n- [ ] 写代码\n- [ ] 写文档",
                todos=[
                    {"content": "写代码"},
                    {"content": "写文档"},
                ],
                is_project=False,
                agent_mode_at_create="plan",
                session_id="sess-1",
                agent_id="agent-1",
            )

        plan_props = result["plan"]
        self.assertEqual(plan_props.status, "draft")
        self.assertEqual(plan_props.name, "发布 V1")
        self.assertEqual(len(plan_props.todos), 2)
        self.assertIn(PLAN_DOCUMENT_TAG, document.tags)
        self.assertIn("plan", document.properties)
        self.assertEqual(document.properties["plan"]["status"], "draft")

        # save() 必须被调用且包含 tags / properties
        document.save.assert_called()
        save_kwargs = document.save.call_args.kwargs
        self.assertIn("tags", save_kwargs.get("update_fields") or [])
        self.assertIn("properties", save_kwargs.get("update_fields") or [])

    def test_create_plan_falls_back_when_collection_creation_fails(self):
        document = _make_document()

        with patch("apps.tabdoc.services.plan_service.DocumentService") as doc_cls, patch(
            "apps.tabdoc.services.plan_service._ensure_planning_collection",
            return_value=None,
        ), patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.create_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            result = service.create_plan(
                organization_id=str(uuid4()),
                space_id=str(uuid4()),
                name="兜底测试",
                plan_markdown="",
                todos=[],
            )

        self.assertEqual(result["collection_id"], None)
        self.assertEqual(result["plan"].status, "draft")

    def test_create_plan_rejects_blank_name(self):
        with patch("apps.tabdoc.services.plan_service.DocumentService"):
            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.create_plan(
                    organization_id=str(uuid4()),
                    space_id=str(uuid4()),
                    name="   ",  # 空白名
                )
        # PlanProperties 的 validator 抛 ValueError，被 PlanServiceError 包裹
        self.assertEqual(ctx.exception.code, "PLAN_INVALID_INPUT")

    def test_create_plan_requires_organization(self):
        with patch("apps.tabdoc.services.plan_service.DocumentService"):
            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.create_plan(organization_id="", space_id="", name="X")
        self.assertEqual(ctx.exception.code, "PLAN_MISSING_SCOPE")

    def test_create_plan_allows_missing_space_id(self):
        """#6603：space_id 可选，缺省时不应因 scope 拒绝，且不挂规划 Collection。"""
        document = _make_document()
        document.space_id = None

        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls, patch(
            "apps.tabdoc.services.plan_service._ensure_planning_collection",
        ) as ensure_coll, patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.create_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            result = service.create_plan(
                organization_id=str(document.organization_id),
                name="Org-only Plan",
            )

        ensure_coll.assert_not_called()
        self.assertIsNone(result["collection_id"])
        self.assertIsNone(doc_service.create_document.call_args.kwargs.get("space_id"))

    def test_create_plan_rejects_duplicate_todo_ids(self):
        with patch("apps.tabdoc.services.plan_service.DocumentService"):
            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.create_plan(
                    organization_id=str(uuid4()),
                    space_id=str(uuid4()),
                    name="X",
                    todos=[
                        {"id": "t1", "content": "a"},
                        {"id": "t1", "content": "b"},
                    ],
                )
        self.assertEqual(ctx.exception.code, "PLAN_DUPLICATE_TODO_ID")


class PlanServiceUpdateTodosTests(unittest.TestCase):
    def setUp(self):
        self.user = _make_user()
        atomic_patch, on_commit_patch = _patch_transaction()
        self._patches = [atomic_patch, on_commit_patch]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def _draft_document(self):
        plan_props = PlanProperties(
            name="X",
            todos=[
                PlanTodo(id="t1", content="A", status="pending"),
                PlanTodo(id="t2", content="B", status="pending"),
            ],
        )
        document = _make_document(
            properties={"plan": plan_props.model_dump(mode="json")},
            tags=[PLAN_DOCUMENT_TAG],
            description_markdown="- [ ] A\n- [ ] B",
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "taskList",
                        "content": [
                            {
                                "type": "taskItem",
                                "attrs": {"checked": False, "todoId": "t1"},
                                "content": [
                                    {"type": "paragraph", "content": [
                                        {"type": "text", "text": "A"}
                                    ]},
                                ],
                            },
                            {
                                "type": "taskItem",
                                "attrs": {"checked": False, "todoId": "t2"},
                                "content": [
                                    {"type": "paragraph", "content": [
                                        {"type": "text", "text": "B"}
                                    ]},
                                ],
                            },
                        ],
                    }
                ],
            },
        )
        return document

    def test_update_todos_merge_updates_status(self):
        document = self._draft_document()
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls, patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.get_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            result = service.update_todos(
                plan_document_id=str(document.id),
                todos=[{"id": "t1", "content": "A", "status": "completed"}],
                merge=True,
            )

        # 原来两个 todo 仍然在；t1 改为 completed
        plan_props = result["plan"]
        self.assertEqual(len(plan_props.todos), 2)
        statuses = {t.id: t.status for t in plan_props.todos}
        self.assertEqual(statuses["t1"], "completed")
        self.assertEqual(statuses["t2"], "pending")

        # PM JSON 的 taskItem.attrs.checked 也被同步
        task_items = document.description_json["content"][0]["content"]
        self.assertTrue(task_items[0]["attrs"]["checked"])
        self.assertFalse(task_items[1]["attrs"]["checked"])

    def test_update_todos_falls_back_to_index_when_attrs_stripped(self):
        """前端协作回写可能 strip 未注册的 attrs.todoId；
        此时按出现顺序对齐 todos，仍能同步 checked。"""
        plan_props = PlanProperties(
            name="X",
            todos=[
                PlanTodo(id="t1", content="A", status="pending"),
                PlanTodo(id="t2", content="B", status="pending"),
            ],
        )
        document = _make_document(
            properties={"plan": plan_props.model_dump(mode="json")},
            tags=[PLAN_DOCUMENT_TAG],
            description_markdown="- [ ] A\n- [ ] B",
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "taskList",
                        "content": [
                            {
                                "type": "taskItem",
                                "attrs": {"checked": False},  # 没有 todoId
                                "content": [{"type": "paragraph", "content": [
                                    {"type": "text", "text": "A"}
                                ]}],
                            },
                            {
                                "type": "taskItem",
                                "attrs": {"checked": False},  # 没有 todoId
                                "content": [{"type": "paragraph", "content": [
                                    {"type": "text", "text": "B"}
                                ]}],
                            },
                        ],
                    }
                ],
            },
        )
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls, patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.get_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            service.update_todos(
                plan_document_id=str(document.id),
                todos=[{"id": "t1", "content": "A", "status": "completed"}],
                merge=True,
            )

        # fallback 路径：按下标对齐，第一个 taskItem 应该被 t1（completed）打勾
        # 同时把 todoId 补回去，方便下次精确匹配
        task_items = document.description_json["content"][0]["content"]
        self.assertTrue(task_items[0]["attrs"]["checked"])
        self.assertEqual(task_items[0]["attrs"]["todoId"], "t1")
        self.assertFalse(task_items[1]["attrs"]["checked"])
        self.assertEqual(task_items[1]["attrs"]["todoId"], "t2")

    def test_update_todos_replace_overrides_all(self):
        document = self._draft_document()
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls, patch(
            "apps.tabdoc.services.plan_service.ResourceBridge"
        ):
            doc_service = MagicMock()
            doc_service.get_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            result = service.update_todos(
                plan_document_id=str(document.id),
                todos=[{"id": "t3", "content": "新增", "status": "in_progress"}],
                merge=False,
            )

        plan_props = result["plan"]
        self.assertEqual(len(plan_props.todos), 1)
        self.assertEqual(plan_props.todos[0].id, "t3")
        self.assertEqual(plan_props.todos[0].status, "in_progress")

    def test_update_todos_rejects_when_approved(self):
        plan_props = PlanProperties(name="X", status="approved")
        document = _make_document(
            properties={"plan": plan_props.model_dump(mode="json")},
            tags=[PLAN_DOCUMENT_TAG],
        )
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls:
            doc_service = MagicMock()
            doc_service.get_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.update_todos(
                    plan_document_id=str(document.id),
                    todos=[{"id": "t1", "content": "X"}],
                    merge=True,
                )
        self.assertEqual(ctx.exception.code, "PLAN_NOT_DRAFT")
        self.assertEqual(ctx.exception.status, 409)

    def test_update_todos_rejects_non_plan_document(self):
        document = _make_document(properties={}, tags=[])  # 不是 Plan
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls:
            doc_service = MagicMock()
            doc_service.get_document.return_value = document
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.update_todos(
                    plan_document_id=str(document.id),
                    todos=[{"id": "t1", "content": "x"}],
                )
        self.assertEqual(ctx.exception.code, "PLAN_NOT_A_PLAN")

    def test_update_todos_propagates_not_found(self):
        with patch(
            "apps.tabdoc.services.plan_service.DocumentService"
        ) as doc_cls:
            doc_service = MagicMock()
            doc_service.get_document.side_effect = ValueError("文档不存在")
            doc_cls.return_value = doc_service

            service = PlanService(user=self.user)
            with self.assertRaises(PlanServiceError) as ctx:
                service.update_todos(
                    plan_document_id=str(uuid4()),
                    todos=[{"id": "t1", "content": "x"}],
                )
        self.assertEqual(ctx.exception.code, "PLAN_NOT_FOUND")
        self.assertEqual(ctx.exception.status, 404)


class PlanServiceConstructionTests(unittest.TestCase):
    def test_requires_user(self):
        with self.assertRaises(PlanServiceError) as ctx:
            PlanService(user=None)
        self.assertEqual(ctx.exception.code, "PLAN_NO_USER")
        self.assertEqual(ctx.exception.status, 401)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

"""
PlanService 集成测试 — 真实 ORM 验证 plan_create → Document → ContextItem → Collection 链路。

运行方式::

    cd apps/tabtin_django
    DJANGO_SETTINGS_MODULE=tabtin.settings_plan_integration_test \
        python -m pytest apps/tabdoc/tests/test_plan_service_integration.py -v

设计思路：
- 用 ``TransactionTestCase``（而非 ``TestCase``）确保 ``transaction.on_commit``
  回调在测试内被执行——这是验证 ResourceBridge.on_create → ContextItem 创建
  → _bind_context_item_to_collection 的关键路径。
- Mock 掉 WS 推送、EventBus、搜索向量更新等重型侧效应（只保留 ORM 链路）。
- 用 SQLite in-memory 数据库（settings_plan_integration_test 配置），
  避免 MySQL FULLTEXT migration 问题。
"""

from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_plan_integration_test")

import django  # noqa: E402
django.setup()

from unittest.mock import patch  # noqa: E402
from uuid import uuid4  # noqa: E402

import pytest  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TransactionTestCase  # noqa: E402

from apps.tabdoc.services.plan_schema import (  # noqa: E402
    PLANNING_COLLECTION_SYSTEM_KEY,
)
from apps.tabdoc.services.plan_service import PlanService  # noqa: E402
from apps.tabtinspace.models import (  # noqa: E402
    Agent,
    Collection,
    ContextItem,
    Space,
    SpaceMembership,
    Organization,
)

User = get_user_model()


def _noop(*args, **kwargs):
    pass


_SIDE_EFFECT_MOCKS = [
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._update_search_vector",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_signal",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._push_ws",
    "apps.tabtinspace.services.resource_bridge.ResourceBridge._emit_event_bus",
    "apps.tabdoc.services.document_service.DocumentService._init_description_binary",
    "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
]


def _mock_side_effects(fn):
    """Stack all side-effect mocks onto a test method."""
    for target in reversed(_SIDE_EFFECT_MOCKS):
        fn = patch(target, _noop)(fn)
    return fn


class PlanServiceIntegrationTests(TransactionTestCase):
    """验证 plan_create 走完真实 ORM 后 ContextItem 正确绑定到「规划」Collection。"""

    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email=f"test_{uuid4().hex[:8]}@tabtin-test.local",
            password="testpass",
        )
        self.organization = Organization.objects.create(
            name="测试团队",
            owner=self.user,
        )
        self.agent = Agent.objects.create(
            organization=self.organization,
            owner_user=self.user,
            name="测试 Agent",
            type="bot",
            is_active=True,
        )
        self.space = Space.objects.create(
            name="测试 Space",
            organization=self.organization,
            agent=self.agent,
            type=Space.SpaceType.BOT,
        )
        SpaceMembership.objects.create(
            workspace=self.space,
            user=self.user,
            role="owner",
        )

    @_mock_side_effects
    def test_create_plan_binds_context_item_to_planning_collection(self):
        """plan_create → Document 创建 → ContextItem 存在 → collection_id = 规划 Collection"""
        service = PlanService(user=self.user)
        result = service.create_plan(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="集成测试 Plan",
            overview="验证 ContextItem 绑定链路",
            plan_markdown="## 步骤\n\n- [ ] 第一步\n- [ ] 第二步",
            todos=[
                {"content": "第一步"},
                {"content": "第二步"},
            ],
            agent_mode_at_create="plan",
            session_id="int-test-session",
        )

        document = result["document"]
        plan_props = result["plan"]
        collection_id = result["collection_id"]

        assert document.pk is not None, "Document 应已持久化"
        assert plan_props.status == "draft"
        assert "plan" in (document.tags or [])
        assert len(plan_props.todos) == 2

        planning_coll = Collection.objects.filter(
            workspace_id=self.space.id,
            system_key=PLANNING_COLLECTION_SYSTEM_KEY,
        ).first()
        assert planning_coll is not None, "「规划」Collection 应已创建"
        assert collection_id == str(planning_coll.id)

        ctx_item = ContextItem.objects.filter(
            workspace_id=self.space.id,
            item_type="tabdoc",
            resource_id=str(document.id),
        ).first()
        assert ctx_item is not None, "ContextItem 应由 ResourceBridge.on_create 创建"
        assert str(ctx_item.collection_id) == str(planning_coll.id), (
            f"ContextItem.collection_id ({ctx_item.collection_id}) "
            f"应指向「规划」Collection ({planning_coll.id})"
        )

    @_mock_side_effects
    def test_create_plan_reuses_existing_planning_collection(self):
        """连续创建两个 Plan，都应归入同一个「规划」Collection。"""
        service = PlanService(user=self.user)

        r1 = service.create_plan(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="Plan A",
            todos=[{"content": "a"}],
        )
        r2 = service.create_plan(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="Plan B",
            todos=[{"content": "b"}],
        )

        assert r1["collection_id"] == r2["collection_id"], (
            "两个 Plan 应归入同一个「规划」Collection"
        )

        coll_count = Collection.objects.filter(
            workspace_id=self.space.id,
            system_key=PLANNING_COLLECTION_SYSTEM_KEY,
        ).count()
        assert coll_count == 1, "「规划」Collection 应只有一个"

    @_mock_side_effects
    def test_create_plan_preserves_todo_ids_in_pm_json(self):
        """plan_create 后 PM JSON 中 taskItem 的 todoId 应与 todos[i].id 对应。"""
        service = PlanService(user=self.user)
        result = service.create_plan(
            organization_id=str(self.organization.id),
            space_id=str(self.space.id),
            name="TodoId 测试",
            plan_markdown="- [ ] 步骤一\n- [ ] 步骤二",
            todos=[
                {"content": "步骤一"},
                {"content": "步骤二"},
            ],
        )

        document = result["document"]
        pm_json = document.description_json
        assert isinstance(pm_json, dict)

        task_items = []
        for node in pm_json.get("content", []):
            if node.get("type") == "taskList":
                for item in node.get("content", []):
                    if item.get("type") == "taskItem":
                        task_items.append(item)

        assert len(task_items) >= 2, f"应至少有 2 个 taskItem，实际 {len(task_items)}"

        todo_ids = [result["plan"].todos[i].id for i in range(2)]
        for i in range(2):
            attrs = task_items[i].get("attrs", {})
            assert attrs.get("todoId") == todo_ids[i], (
                f"taskItem[{i}].attrs.todoId ({attrs.get('todoId')}) "
                f"应等于 todos[{i}].id ({todo_ids[i]})"
            )

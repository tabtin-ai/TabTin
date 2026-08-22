"""
Plan 二件套工具单元测试（Wave 1-C）

只测试 ``run`` 路径的薄壳：参数转发、错误映射、出参 schema。
深层业务逻辑由 ``test_plan_service`` 覆盖。
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from apps.services.tools.domains.plan.plan_tools import (
    PLAN_AVAILABLE_MODES,
    PlanCreateTool,
    PlanUpdateTodosTool,
    get_plan_tools,
)
from apps.tabdoc.services.plan_schema import PlanProperties, PlanTodo
from apps.tabdoc.services.plan_service import PlanServiceError


def _make_user(uid: str = "11111111-1111-1111-1111-111111111111") -> SimpleNamespace:
    return SimpleNamespace(id=uid, pk=uid)


def _make_document(*, properties=None, tags=None, description_markdown=""):
    return SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        space_id=uuid4(),
        title="Plan",
        tags=tags or [],
        properties=properties or {},
        latest_version=1,
        description_markdown=description_markdown,
        updated_at=datetime.now(timezone.utc),
    )


class PlanCreateToolTests(unittest.TestCase):
    def test_run_success_passes_args_and_returns_payload(self):
        document = _make_document()
        plan_props = PlanProperties(
            name="X", todos=[PlanTodo(id="t1", content="A")]
        )

        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=_make_user(),
        ), patch(
            "apps.services.tools.domains.plan.plan_tools.PlanService"
        ) as svc_cls:
            svc = MagicMock()
            svc.create_plan.return_value = {
                "document": document,
                "plan": plan_props,
                "collection_id": str(uuid4()),
            }
            svc_cls.return_value = svc

            tool = PlanCreateTool()
            result = tool.run(
                name="发布 V1",
                overview="一句话",
                plan="## body",
                todos=[{"content": "A"}],
                is_project=False,
                phases=None,
                allowed_prompts=None,
                user_id="33333333-3333-3333-3333-333333333333",
                organization_id="11111111-1111-1111-1111-111111111111",
                space_id="22222222-2222-2222-2222-222222222222",
                session_id="sess",
                agent_id="agent",
                agent_mode="plan",
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["document_id"], str(document.id))
        self.assertEqual(result["plan"]["name"], "X")
        self.assertEqual(len(result["plan"]["todos"]), 1)

        kwargs = svc.create_plan.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], "11111111-1111-1111-1111-111111111111")
        self.assertEqual(kwargs["space_id"], "22222222-2222-2222-2222-222222222222")
        self.assertEqual(kwargs["plan_markdown"], "## body")
        self.assertEqual(kwargs["agent_mode_at_create"], "plan")
        self.assertEqual(kwargs["session_id"], "sess")

    def test_run_without_user_returns_error(self):
        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=None,
        ):
            tool = PlanCreateTool()
            result = tool.run(name="X")
        self.assertFalse(result["success"])
        self.assertIn("未登录", result["error"])

    def test_run_without_scope_returns_error(self):
        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=_make_user(),
        ):
            tool = PlanCreateTool()
            result = tool.run(name="X", organization_id=None, space_id=None)
        self.assertFalse(result["success"])
        self.assertIn("organization_id", result["error"])

    def test_run_maps_service_error(self):
        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=_make_user(),
        ), patch(
            "apps.services.tools.domains.plan.plan_tools.PlanService"
        ) as svc_cls:
            svc = MagicMock()
            svc.create_plan.side_effect = PlanServiceError(
                "PLAN_INVALID_INPUT", "name 太长", status=400,
            )
            svc_cls.return_value = svc

            tool = PlanCreateTool()
            result = tool.run(
                name="X",
                user_id="u",
                organization_id="w",
                space_id="s",
            )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_kind"], "invalid_param_format")
        self.assertEqual(result["upstream_code"], "PLAN_INVALID_INPUT")
        self.assertTrue(result["hint"])

    def test_available_modes_constant(self):
        tool = PlanCreateTool()
        self.assertEqual(tool.available_modes, PLAN_AVAILABLE_MODES)
        self.assertEqual(set(PLAN_AVAILABLE_MODES), {"plan", "study"})

    def test_risk_levels_align_with_product_decision(self):
        """独立 QC 反馈必修：plan_create / plan_update_todos 是草稿写入，
        必须为 'safe'，避免在 cautious 预设下被 PermissionRuleEngine 误触发
        HITL confirm（违反产品决策「plan_create 非 HITL」）。"""
        self.assertEqual(PlanCreateTool().risk_level, "safe")
        self.assertEqual(PlanUpdateTodosTool().risk_level, "safe")

    def test_get_plan_tools_exposes_two_current_tools(self):
        self.assertEqual(
            [tool.name for tool in get_plan_tools()],
            ["plan_create", "plan_update_todos"],
        )


class PlanUpdateTodosToolTests(unittest.TestCase):
    def test_run_success_returns_todos_after_update(self):
        document = _make_document(
            tags=["plan"],
            properties={"plan": PlanProperties(name="X").model_dump(mode="json")},
        )
        plan_props = PlanProperties(name="X", todos=[PlanTodo(id="t1", content="A", status="completed")])

        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=_make_user(),
        ), patch(
            "apps.services.tools.domains.plan.plan_tools.PlanService"
        ) as svc_cls:
            svc = MagicMock()
            svc.update_todos.return_value = {
                "document": document,
                "plan": plan_props,
                "todos_after_update": [{"id": "t1", "content": "A", "status": "completed"}],
            }
            svc_cls.return_value = svc

            tool = PlanUpdateTodosTool()
            result = tool.run(
                plan_document_id=str(document.id),
                todos=[{"id": "t1", "content": "A", "status": "completed"}],
                merge=True,
                user_id="u",
            )

        self.assertTrue(result["success"])
        self.assertEqual(len(result["todos_after_update"]), 1)
        self.assertEqual(result["todos_after_update"][0]["status"], "completed")

    def test_run_maps_not_draft_error(self):
        with patch(
            "apps.services.tools.domains.plan.plan_tools._load_user",
            return_value=_make_user(),
        ), patch(
            "apps.services.tools.domains.plan.plan_tools.PlanService"
        ) as svc_cls:
            svc = MagicMock()
            svc.update_todos.side_effect = PlanServiceError(
                "PLAN_NOT_DRAFT", "Plan 已是 approved 状态", status=409,
            )
            svc_cls.return_value = svc

            tool = PlanUpdateTodosTool()
            result = tool.run(
                plan_document_id=str(uuid4()),
                todos=[{"id": "t1", "content": "x"}],
                user_id="u",
            )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_kind"], "mode_restricted")
        self.assertEqual(result["upstream_code"], "PLAN_NOT_DRAFT")
        self.assertTrue(result["hint"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()

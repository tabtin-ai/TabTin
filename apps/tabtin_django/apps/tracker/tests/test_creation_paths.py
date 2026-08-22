"""Tracker 创建路径契约测试（charter v1.8 §6.2 / §6.4 / §7.1）。

「创建路径必须只有一条」收敛到 ``TrackerService.create_tracker``。

波次 4 Stage 2.2 一刀切后，DTO 已合并 —— 不再有历史 Agenda 中间 DTO 与
翻译 helper；两入口直接构造
``TrackerCreate``。"两入口等价" 由 ``test_two_entries_equivalence.py`` 覆盖；本文
只保留 ``agent_id`` 必填的应用层校验（charter §7.1）。
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.tracker.tracker_schemas import TrackerCreate


class AgentIdRequiredTest(SimpleTestCase):
    """charter v1.8 §7.1：``agent_id`` 必填——Service 层兜底校验。"""

    BASE_INPUT = {
        "name": "测试 Tracker",
        "description": "调研 dify 产品架构",
        "trigger_type": "manual",
        "trigger_config": {},
        "skill_key": "research_skill",
        "skill_params": {"target": "dify"},
        "agent_id": str(uuid.uuid4()),
    }

    def test_create_tracker_rejects_when_agent_id_missing_and_no_space_agent(self):
        """charter §7.1：执行 Agent 必须确定。agent_id=None 且 Space 也解析不到
        绑定 Agent 时 → ValidationError（极简表单兜底失败的边界）。"""
        from django.core.exceptions import ValidationError as DjangoValidationError
        from apps.tracker.services.tracker_service import TrackerService

        payload = TrackerCreate(**{**self.BASE_INPUT, "agent_id": None})
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch(
                 "apps.tracker.services.tracker_service._resolve_space_default_agent",
                 return_value=None,
             ):
            with self.assertRaises(DjangoValidationError) as ctx:
                svc.create_tracker("wt-1", "sp-1", payload, MagicMock())
        self.assertIn("Agent", str(ctx.exception))

    def test_create_tracker_rejects_empty_string_agent_id_and_no_space_agent(self):
        """空字符串/全空白同样视为「未指定」；Space 也无绑定 Agent → 报错。"""
        from django.core.exceptions import ValidationError as DjangoValidationError
        from apps.tracker.services.tracker_service import TrackerService

        payload = TrackerCreate(**{**self.BASE_INPUT, "agent_id": "   "})
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch(
                 "apps.tracker.services.tracker_service._resolve_space_default_agent",
                 return_value=None,
             ):
            with self.assertRaises(DjangoValidationError):
                svc.create_tracker("wt-1", "sp-1", payload, MagicMock())

    def test_create_tracker_falls_back_to_space_agent_when_agent_id_blank(self):
        """极简表单（2026-06）：未显式选 Agent 时回落到 Space 绑定的执行 Agent，
        而非直接报错——这是让「名称+指令」极简表单开箱可用的关键。"""
        from apps.tracker.services.tracker_service import TrackerService

        space_agent_id = uuid.uuid4()
        payload = TrackerCreate(**{**self.BASE_INPUT, "agent_id": None})
        svc = TrackerService(user=MagicMock())

        fake_tracker = MagicMock(id=uuid.uuid4())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch(
                 "apps.tracker.services.tracker_service._resolve_space_default_agent",
                 return_value=MagicMock(id=space_agent_id),
             ), \
             patch("apps.tracker.services.tracker_service.transaction.atomic"), \
             patch(
                 "apps.tracker.services.tracker_service._ensure_webhook_secret",
                 return_value=({}, False),
             ), \
             patch(
                 "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_tracker_cls.objects.create.return_value = fake_tracker
            svc.create_tracker("wt-1", "sp-1", payload, MagicMock())

        _, kwargs = mock_tracker_cls.objects.create.call_args
        self.assertEqual(kwargs.get("agent_id"), str(space_agent_id))

    def test_create_tracker_orm_kwargs_exclude_dropped_space_id(self):
        """#6342：Tracker.space FK 已 Drop；create 不得再传 space_id ORM kwarg。"""
        from apps.tracker.services.tracker_service import TrackerService

        workspace_id = str(uuid.uuid4())
        agent_id = str(uuid.uuid4())
        payload = TrackerCreate(
            **{
                **self.BASE_INPUT,
                "agent_id": agent_id,
                "workspace_id": workspace_id,
                "skill_params": {"instructions": "run daily check"},
            }
        )
        svc = TrackerService(user=MagicMock(id=uuid.uuid4()))
        fake_tracker = MagicMock(id=uuid.uuid4())
        user = MagicMock(id=uuid.uuid4())

        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch("apps.tabtinspace.models.Agent.objects") as mock_agent_objects, \
             patch("apps.tabtinspace.models.Workspace.objects") as mock_ws_objects, \
             patch("apps.tracker.services.tracker_service.transaction.atomic"), \
             patch(
                 "apps.tracker.services.tracker_service._ensure_webhook_secret",
                 return_value=({}, False),
             ), \
             patch(
                 "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_agent_objects.filter.return_value.exists.return_value = True
            mock_ws_objects.filter.return_value.exists.return_value = True
            mock_tracker_cls.objects.create.return_value = fake_tracker
            svc.create_tracker("org-1", "host-1", payload, user)

        _, kwargs = mock_tracker_cls.objects.create.call_args
        self.assertNotIn("space_id", kwargs)
        self.assertNotIn("space", kwargs)
        self.assertEqual(kwargs.get("workspace_id"), workspace_id)
        self.assertEqual(kwargs.get("agent_id"), agent_id)

    def test_create_tracker_falls_back_to_team_space_execution_agent(self):
        """#2526：团队 Space 里新建自动化时，默认 Agent 需要解析到 owner
        选择的 execution_space；否则 mac 端发空 agent_id 会报「必须指定执行 Agent」。"""
        from apps.tabtinspace.models import Space
        from apps.tracker.services.tracker_service import TrackerService

        space_agent_id = uuid.uuid4()
        execution_space = SimpleNamespace(
            id="space-owner",
            type=Space.SpaceType.WORKSPACE,
            agent_id=str(space_agent_id),
            control_device=None,
            bound_device=None,
        )
        team_space = SimpleNamespace(
            id="space-team",
            type=Space.SpaceType.TEAM_SPACE,
            execution_space=execution_space,
        )
        payload = TrackerCreate(**{**self.BASE_INPUT, "agent_id": None})
        svc = TrackerService(user=MagicMock())
        fake_tracker = MagicMock(id=uuid.uuid4())
        fake_agent = MagicMock(id=space_agent_id)

        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_objects, \
             patch("apps.tabtinspace.models.Agent.objects") as mock_agent_objects, \
             patch("apps.tracker.services.tracker_service.transaction.atomic"), \
             patch(
                 "apps.tracker.services.tracker_service._ensure_webhook_secret",
                 return_value=({}, False),
             ), \
             patch(
                 "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_space_objects.filter.return_value.first.return_value = team_space
            mock_agent_objects.select_related.return_value.filter.return_value.first.return_value = fake_agent
            mock_tracker_cls.objects.create.return_value = fake_tracker

            svc.create_tracker("wt-1", "space-team", payload, MagicMock())

        _, kwargs = mock_tracker_cls.objects.create.call_args
        self.assertEqual(kwargs.get("agent_id"), str(space_agent_id))

    def test_create_tracker_accepts_valid_agent_id(self):
        """sanity：合法 agent_id 时 Service 调用进入 model layer（mock 阻断 DB）。"""
        from apps.tracker.services.tracker_service import TrackerService

        payload = TrackerCreate(**self.BASE_INPUT)
        svc = TrackerService(user=MagicMock())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch.object(TrackerService, "create_tracker") as mock_create:
            mock_create.return_value = MagicMock(id=uuid.uuid4())
            # 这里只是确认 payload 验证通过，不真创建
            mock_create("wt-1", "sp-1", payload, MagicMock())
            mock_create.assert_called_once()


class SkillOptionalCreateTest(SimpleTestCase):
    """纯 Agent 模式（2026-06）：``create_tracker`` 不再强制 ``skill_key`` 非空。

    空 skill_key 应顺利进入 model 层（不再抛「必须关联 Skill」ValidationError）——
    执行时走「指令驱动 + Agent 自助找 Skill」的纯 Agent 路径。
    """

    BASE_INPUT = {
        "name": "纯 Agent Tracker",
        "trigger_type": "manual",
        "trigger_config": {},
        "skill_key": "",  # 关键：空 skill_key
        "skill_params": {"instructions": "每天汇总今日邮件"},
        "agent_id": str(uuid.uuid4()),
    }

    def test_create_tracker_accepts_empty_skill_key(self):
        from apps.tracker.services.tracker_service import TrackerService

        payload = TrackerCreate(**self.BASE_INPUT)
        svc = TrackerService(user=MagicMock())

        fake_tracker = MagicMock(id=uuid.uuid4())
        with patch.object(svc, "check_space_permission", return_value=True), \
             patch(
                 "apps.tracker.services.tracker_service.ensure_space_in_organization",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.transaction.atomic"), \
             patch(
                 "apps.tracker.services.tracker_service._ensure_webhook_secret",
                 return_value=({}, False),
             ), \
             patch(
                 "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws",
                 return_value=None,
             ), \
             patch("apps.tracker.services.tracker_service.Tracker") as mock_tracker_cls:
            mock_tracker_cls.objects.create.return_value = fake_tracker
            result = svc.create_tracker("wt-1", "sp-1", payload, MagicMock())

        # 没抛 ValidationError，且空 skill_key 原样透传到 model 层
        self.assertIs(result, fake_tracker)
        _, kwargs = mock_tracker_cls.objects.create.call_args
        self.assertEqual(kwargs.get("skill_key"), "")


class ActivateOnCreateTest(SimpleTestCase):
    """新版一方入口原子创建 active；旧调用不传字段时继续保留兼容行为。"""

    def _create_with_mocks(self, *, activate_on_create: bool, trigger_type: str):
        from apps.tracker.services.tracker_service import TrackerService

        agent_id = str(uuid.uuid4())
        workspace_id = str(uuid.uuid4())
        trigger_config = {"cron": "0 9 * * *"} if trigger_type == "cron" else {}
        payload = TrackerCreate(
            name="状态契约测试",
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            skill_params={"instructions": "执行状态契约测试"},
            agent_id=agent_id,
            workspace_id=workspace_id,
            activate_on_create=activate_on_create,
        )
        user = MagicMock(id=uuid.uuid4())
        svc = TrackerService(user=user)
        fake_tracker = MagicMock(id=uuid.uuid4(), trigger_type=trigger_type)

        patches = (
            patch.object(svc, "check_space_permission", return_value=True),
            patch(
                "apps.tracker.services.tracker_service.ensure_space_in_organization",
                return_value=None,
            ),
            patch("apps.tabtinspace.models.Agent.objects"),
            patch("apps.tabtinspace.models.Workspace.objects"),
            patch("apps.tracker.services.tracker_service.transaction.atomic"),
            patch(
                "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws",
                return_value=None,
            ),
            patch("apps.tracker.services.tracker_service.Tracker"),
        )
        with patches[0], patches[1], patches[2] as agent_objects, \
             patches[3] as workspace_objects, patches[4], patches[5], \
             patches[6] as tracker_model:
            agent_objects.filter.return_value.exists.return_value = True
            workspace_objects.filter.return_value.exists.return_value = True
            tracker_model.objects.create.return_value = fake_tracker
            result = svc.create_tracker("org-1", "host-1", payload, user)

        return result, fake_tracker

    @patch("apps.tracker.services.tracker_service._validate_activation_schedule")
    def test_requested_create_transitions_to_active_without_persisting_next_run(self, validate_schedule):
        result, tracker = self._create_with_mocks(
            activate_on_create=True,
            trigger_type="cron",
        )

        self.assertIs(result, tracker)
        tracker.transition_status.assert_called_once_with("active")
        validate_schedule.assert_called_once_with(tracker)
        tracker.save.assert_called_once_with()

    def test_omitted_flag_keeps_legacy_draft_creation_contract(self):
        result, tracker = self._create_with_mocks(
            activate_on_create=False,
            trigger_type="manual",
        )

        self.assertIs(result, tracker)
        tracker.transition_status.assert_not_called()
        tracker.save.assert_not_called()

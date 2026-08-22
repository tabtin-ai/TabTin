"""``update_agent`` 字段级审计扩展测试（yolo PR3 模式延伸 / 附录 A.4）。

覆盖 ``AgentService.update_agent`` 在 security 子树以外的 5 个 action_type：

  - ``agent_prompt_update``      custom_rules
  - ``agent_working_dir_update`` working_dir / working_dir_type
  - ``agent_backend_update``     agent_config.agent_backend / runtime_plane
  - ``agent_capability_update``  agent_config.capabilities
  - ``agent_profile_update``     name / goal / keywords / tags /
                                 crawl_config / conversation /
                                 suggested_prompts

``agent_security_update`` 由 yolo PR3 单独写、单独测，本文件不重复。

测试模式与 ``test_pr3_allow_yolo_mode_and_audit.py`` 对齐：
  - ``TestCase`` + ``databases = {"default", "postgresql"}``（与 fixtures 一致）
  - 通过 fixtures 创建完整 Organization → Agent → Space 链路
  - 每个 case ``setUp`` 时清掉历史审计日志，保证计数精确
"""
from __future__ import annotations

from copy import deepcopy

from django.test import TestCase

from apps.tabtinspace.agent_config_v2 import build_default_agent_config_v2
from apps.tabtinspace.models import SpaceAdminActionLog
from apps.tabtinspace.services.agent_service import AgentService
from apps.tabtinspace.tests.fixtures import (
    cleanup_test_organization,
    create_test_organization_with_agent,
)


class _AgentUpdateAuditBase(TestCase):
    """公共 setUp / tearDown / 查询助手。"""

    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.ctx = create_test_organization_with_agent(prefix="auditexp")
        self.user = self.ctx["user"]
        self.organization = self.ctx["organization"]
        self.agent = self.ctx["agent"]
        # 落 v2 默认 agent_config，让所有子树（agent_backend / capabilities /
        # conversation / runtime_plane）都有可 diff 的起点。
        self.agent.agent_config = build_default_agent_config_v2()
        self.agent.custom_rules = "保持简洁"
        self.agent.goal = "辅助测试"
        self.agent.keywords = ["init", "kw"]
        self.agent.tags = ["t1"]
        self.agent.crawl_config = {"max_depth": 2}
        self.agent.working_dir = "/tmp/initial"
        self.agent.working_dir_type = "code"
        self.agent.suggested_prompts = ["hello"]
        self.agent.save(using="postgresql")
        # 清掉本 agent 上历史 audit，避免 fixture 内的副作用污染计数。
        SpaceAdminActionLog.objects.using("postgresql").filter(
            target_type="agent", target_id=self.agent.id,
        ).delete()

    def tearDown(self) -> None:
        cleanup_test_organization(self.organization, delete_user=True)

    def _service(self) -> AgentService:
        return AgentService(user=self.user)

    def _audits(self, action_type: str):
        return SpaceAdminActionLog.objects.using("postgresql").filter(
            target_type="agent",
            target_id=self.agent.id,
            action_type=action_type,
        )


class AgentPromptAuditTests(_AgentUpdateAuditBase):
    """``custom_rules`` → ``agent_prompt_update``。"""

    def test_custom_rules_change_writes_prompt_audit(self) -> None:
        self._service().update_agent(
            agent_id=self.agent.id,
            custom_rules="新规则集",
        )
        logs = self._audits("agent_prompt_update")
        self.assertEqual(logs.count(), 1)
        log = logs.first()
        self.assertEqual(log.organization_id, self.organization.id)
        self.assertEqual(
            log.request_payload["before"]["custom_rules"], "保持简洁",
        )
        self.assertEqual(
            log.request_payload["after"]["custom_rules"], "新规则集",
        )


class AgentWorkingDirAuditTests(_AgentUpdateAuditBase):
    """``working_dir`` / ``working_dir_type`` → ``agent_working_dir_update``。"""

    def test_working_dir_change_writes_working_dir_audit(self) -> None:
        self._service().update_agent(
            agent_id=self.agent.id,
            working_dir="/tmp/new",
        )
        logs = self._audits("agent_working_dir_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["before"]["working_dir"], "/tmp/initial")
        self.assertEqual(payload["after"]["working_dir"], "/tmp/new")

    def test_clear_working_dir_cascades_to_type_in_same_audit(self) -> None:
        """清空 working_dir 同事务联动清空 type；审计反映两个字段都变了。"""
        self._service().update_agent(
            agent_id=self.agent.id,
            working_dir="",
        )
        logs = self._audits("agent_working_dir_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["after"]["working_dir"], "")
        # 副作用：working_dir_type 也被清空
        self.assertEqual(payload["before"]["working_dir_type"], "code")
        self.assertEqual(payload["after"]["working_dir_type"], "")


class AgentBackendAuditTests(_AgentUpdateAuditBase):
    """``agent_config.agent_backend`` / ``runtime_plane`` → ``agent_backend_update``。"""

    def test_agent_backend_subtree_change_writes_backend_audit(self) -> None:
        next_cfg = deepcopy(self.agent.agent_config)
        next_cfg["agent_backend"] = {
            "type": "builtin",
            "config_version": 2,
            "tag": "v2-experiment",  # 新增字段，触发 diff
        }
        self._service().update_agent(
            agent_id=self.agent.id,
            agent_config=next_cfg,
        )
        logs = self._audits("agent_backend_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(
            payload["after"]["agent_backend"].get("tag"), "v2-experiment",
        )
        self.assertNotIn("tag", payload["before"]["agent_backend"])

    def test_runtime_plane_change_writes_backend_audit(self) -> None:
        next_cfg = deepcopy(self.agent.agent_config)
        next_cfg["runtime_plane"] = "cloud"
        self._service().update_agent(
            agent_id=self.agent.id,
            agent_config=next_cfg,
        )
        logs = self._audits("agent_backend_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["before"]["runtime_plane"], "local")
        self.assertEqual(payload["after"]["runtime_plane"], "cloud")


class AgentCapabilityAuditTests(_AgentUpdateAuditBase):
    """``agent_config.capabilities`` → ``agent_capability_update``（成本/能力开关）。"""

    def test_capabilities_change_writes_capability_audit(self) -> None:
        next_cfg = deepcopy(self.agent.agent_config)
        # capabilities.overrides.cost.execution_limits 是 v2 默认形状里就有的字段
        next_cfg["capabilities"]["overrides"]["cost"]["execution_limits"][
            "max_iterations_per_run"
        ] = 50
        self._service().update_agent(
            agent_id=self.agent.id,
            agent_config=next_cfg,
        )
        logs = self._audits("agent_capability_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        before_limit = (
            payload["before"]["capabilities"]["overrides"]["cost"][
                "execution_limits"
            ]["max_iterations_per_run"]
        )
        after_limit = (
            payload["after"]["capabilities"]["overrides"]["cost"][
                "execution_limits"
            ]["max_iterations_per_run"]
        )
        self.assertIsNone(before_limit)
        self.assertEqual(after_limit, 50)


class AgentProfileAuditTests(_AgentUpdateAuditBase):
    """name / goal / keywords / tags / crawl_config / conversation /
    suggested_prompts → ``agent_profile_update``。"""

    def test_name_change_writes_profile_audit(self) -> None:
        self._service().update_agent(
            agent_id=self.agent.id,
            name="新名字",
        )
        logs = self._audits("agent_profile_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["after"]["name"], "新名字")

    def test_goal_keywords_tags_share_single_profile_audit(self) -> None:
        self._service().update_agent(
            agent_id=self.agent.id,
            goal="新目标",
            keywords=["a", "b"],
            tags=["t2"],
        )
        logs = self._audits("agent_profile_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["after"]["goal"], "新目标")
        self.assertEqual(payload["after"]["keywords"], ["a", "b"])
        self.assertEqual(payload["after"]["tags"], ["t2"])

    def test_crawl_config_change_writes_profile_audit(self) -> None:
        self._service().update_agent(
            agent_id=self.agent.id,
            crawl_config={"max_depth": 5, "follow_external": True},
        )
        logs = self._audits("agent_profile_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["before"]["crawl_config"], {"max_depth": 2})
        self.assertEqual(
            payload["after"]["crawl_config"],
            {"max_depth": 5, "follow_external": True},
        )

    def test_conversation_subtree_change_writes_profile_audit(self) -> None:
        """conversation 折叠到 profile 而非独立 action_type（设计决策）。"""
        next_cfg = deepcopy(self.agent.agent_config)
        next_cfg["conversation"]["cross_turn_memory"] = False
        self._service().update_agent(
            agent_id=self.agent.id,
            agent_config=next_cfg,
        )
        logs = self._audits("agent_profile_update")
        self.assertEqual(logs.count(), 1)
        payload = logs.first().request_payload
        self.assertEqual(payload["before"]["conversation"]["cross_turn_memory"], True)
        self.assertEqual(payload["after"]["conversation"]["cross_turn_memory"], False)


class AgentUpdateNoDiffTests(_AgentUpdateAuditBase):
    """无变化时不写任何审计。"""

    def test_all_none_writes_no_audit(self) -> None:
        self._service().update_agent(agent_id=self.agent.id)
        for action in (
            "agent_profile_update",
            "agent_prompt_update",
            "agent_working_dir_update",
            "agent_backend_update",
            "agent_capability_update",
        ):
            self.assertEqual(
                self._audits(action).count(), 0,
                f"action_type={action} should not fire when no field changed",
            )

    def test_same_value_writes_no_audit(self) -> None:
        """传入与现值相同的字段 → 不写审计（diff 为空）。"""
        self._service().update_agent(
            agent_id=self.agent.id,
            name=self.agent.name,
            custom_rules=self.agent.custom_rules,
            working_dir=self.agent.working_dir,
        )
        for action in (
            "agent_profile_update",
            "agent_prompt_update",
            "agent_working_dir_update",
        ):
            self.assertEqual(
                self._audits(action).count(), 0,
                f"unchanged identity write should not fire {action}",
            )


class AgentUpdateMultiCategoryTests(_AgentUpdateAuditBase):
    """一次调用覆盖多个类别 → 每类别各 1 条审计。"""

    def test_multi_category_change_writes_multiple_audits(self) -> None:
        next_cfg = deepcopy(self.agent.agent_config)
        next_cfg["capabilities"]["overrides"]["cost"]["execution_limits"][
            "max_iterations_per_run"
        ] = 99
        next_cfg["runtime_plane"] = "cloud"

        self._service().update_agent(
            agent_id=self.agent.id,
            name="多类别改名",
            custom_rules="多类别新规则",
            working_dir="/tmp/multi",
            agent_config=next_cfg,
        )
        self.assertEqual(self._audits("agent_profile_update").count(), 1)
        self.assertEqual(self._audits("agent_prompt_update").count(), 1)
        self.assertEqual(self._audits("agent_working_dir_update").count(), 1)
        self.assertEqual(self._audits("agent_backend_update").count(), 1)
        self.assertEqual(self._audits("agent_capability_update").count(), 1)

    def test_operator_and_message_populated(self) -> None:
        """每条审计都带 operator + 可读 message。"""
        self._service().update_agent(
            agent_id=self.agent.id,
            custom_rules="带 operator 的规则",
        )
        log = self._audits("agent_prompt_update").first()
        self.assertIsNotNone(log)
        self.assertEqual(log.operator_id, str(self.user.id))
        self.assertIn("提示词", log.message)
        self.assertIn(self.agent.name, log.message)

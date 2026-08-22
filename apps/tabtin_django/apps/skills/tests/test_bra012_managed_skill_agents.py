"""Wave 1 重写（W0 决策补丁 1 + 阻塞 3 修复）：

- ``Skill.agents_json`` 字段保留，存 ``agents/*.md`` frontmatter 解析结果
- ``AgentSyncService.sync_skill_agents`` 链路：启用 user 来源 skill → SubAgentTemplate
  按 ``agents_json`` 自动注册
- 禁用动作 → SubAgentTemplate 自动清理
"""
from __future__ import annotations

import uuid

import pytest
from django.test import TransactionTestCase

from apps.skills.models import Skill
from apps.skills.services.agent_sync_service import AgentSyncService
from apps.skills.services.skill_service import SkillService


@pytest.mark.django_db(databases=["default", "postgresql"])
class SkillAgentsJsonFieldTest(TransactionTestCase):
    """W0 决策补丁 1：``Skill.agents_json`` 字段在新模型保留。"""

    databases = {"default", "postgresql"}

    def test_skill_has_agents_json_field(self):
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(),
            slug="with-agents",
            name="With Agents",
            agents_json=[{"name": "reviewer", "description": "审核者"}],
        )
        self.assertEqual(skill.agents_json, [{"name": "reviewer", "description": "审核者"}])

    def test_agents_json_default_is_empty_list(self):
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(),
            slug="no-agents",
            name="No Agents",
        )
        self.assertEqual(skill.agents_json, [])

    def test_to_index_entry_includes_agents(self):
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(),
            slug="idx",
            name="Idx",
            agents_json=[{"name": "agent-a"}, {"name": "agent-b"}],
        )
        entry = skill.to_index_entry()
        self.assertEqual(entry["agents"], [{"name": "agent-a"}, {"name": "agent-b"}])

    def test_to_index_entry_quick_use_empty_by_default(self):
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(), slug="qu-empty", name="QU Empty",
        )
        entry = skill.to_index_entry()
        self.assertIsNone(entry["quick_use"])

    def test_to_index_entry_quick_use_from_draft_when_unpublished(self):
        """未发布版本（owner 草稿）回退读 Skill.quick_use_json（preset 列表）。"""
        presets = [{"id": "p1", "label": "画图", "promptTemplate": "画一个 {{subject}}",
                    "variables": [{"key": "subject", "type": "textarea"}]}]
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(), slug="qu-draft", name="QU Draft",
            quick_use_json=presets,
        )
        entry = skill.to_index_entry()
        self.assertEqual(entry["quick_use"], presets)

    def test_to_index_entry_quick_use_prefers_published_version_snapshot(self):
        """已发布时优先用版本快照列表，而非草稿工作副本。"""
        from apps.skills.models import SkillPublishedVersion

        draft = [{"label": "草稿", "promptTemplate": "草稿", "variables": []}]
        snapshot = [{"label": "示例", "promptTemplate": "已发布快照 {{x}}",
                     "variables": [{"key": "x", "type": "input"}]}]
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(), slug="qu-pub", name="QU Pub",
            quick_use_json=draft, latest_version_seq=1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill, version_seq=1, version_label="1.0.0",
            published_by=skill.owner_user_id, quick_use_json=snapshot,
        )
        entry = skill.to_index_entry()
        self.assertEqual(entry["quick_use"], snapshot)

    def test_to_index_entry_quick_use_active_version_override(self):
        """active_version_seq 指定时优先采用该版本的快照列表（Space 安装版本固定场景）。"""
        from apps.skills.models import SkillPublishedVersion

        v1 = [{"label": "v1", "promptTemplate": "v1", "variables": []}]
        v2 = [{"label": "v2", "promptTemplate": "v2", "variables": []}]
        skill = Skill.objects.create(
            owner_user_id=uuid.uuid4(), slug="qu-pin", name="QU Pin",
            latest_version_seq=2,
        )
        SkillPublishedVersion.objects.create(
            skill=skill, version_seq=1, version_label="1.0.0",
            published_by=skill.owner_user_id, quick_use_json=v1,
        )
        SkillPublishedVersion.objects.create(
            skill=skill, version_seq=2, version_label="2.0.0",
            published_by=skill.owner_user_id, quick_use_json=v2,
        )
        self.assertEqual(skill.to_index_entry()["quick_use"], v2)
        self.assertEqual(skill.to_index_entry(active_version_seq=1)["quick_use"], v1)


@pytest.mark.django_db(databases=["default", "postgresql"])
class EnableTriggersAgentSyncTest(TransactionTestCase):
    """阻塞 3 修复：enable_skill 成功后触发 AgentSyncService.sync_skill_agents。

    user 来源 → 直接读 Skill.agents_json

    ：Skill HTTP 已换到 (organization_id, agent_id)；SubAgent 同步的
    workspace 由 Agent 最近会话推导（通过 mock ChatSession.workspace_id）。
    """

    databases = {"default", "postgresql"}

    def _enable_context(self, *, workspace_id):
        """构造 owner + Agent，并把最近会话 workspace_id 存到 ChatSession。"""
        from apps.agent.models import Agent
        from apps.tabtinspace.models import Device, Organization, Workspace
        from apps.users.auth.models import User

        user = User.objects.create_user(
            email=f"bra012-{uuid.uuid4().hex[:8]}@example.com",
            password="test-password",
        )
        org = Organization.objects.create(
            name=f"BRA012 {uuid.uuid4().hex[:8]}",
            owner=user,
        )
        agent = Agent.objects.create(
            organization=org,
            owner_user=user,
            name="BRA012 Agent",
        )
        device = Device.objects.create(
            organization=org,
            user=user,
            name="BRA012 Device",
            fingerprint=f"bra012-device-{uuid.uuid4().hex[:8]}",
        )
        root = f"/tmp/bra012-{uuid.uuid4().hex[:8]}"
        Workspace.objects.create(
            id=workspace_id,
            organization=org,
            device=device,
            name="BRA012 Space",
            working_dir=root,
            normalized_working_dir=root,
            created_by=user,
        )
        return org, agent, user.id

    def _stub_recent_session(self, agent_id, workspace_id):
        """让 AgentSkillLinkWriter.resolve_sync_space_id 认到目标 workspace。"""
        from unittest.mock import MagicMock, patch

        chat_qs = MagicMock()
        chat_qs.filter.return_value.order_by.return_value.values_list.return_value.first.return_value = workspace_id

        return patch(
            "apps.chat.conversation.models.ChatSession.objects",
            new=chat_qs,
        )

    def test_enable_user_skill_creates_subagent_templates(self):
        from unittest.mock import patch

        from apps.services.agent_engine.models import SubAgentTemplate

        workspace_id = uuid.uuid4()
        org, agent, owner = self._enable_context(workspace_id=workspace_id)
        skill = Skill.objects.create(
            owner_user_id=owner,
            slug="weekly-report",
            name="Weekly Report",
            agents_json=[
                {
                    "name": "weekly-summarizer",
                    "description": "汇总本周进展",
                    "system_prompt": "你是专业周报助手",
                    "tool_domains": ["tabdoc"],
                    "subagent_type": "execute",
                }
            ],
        )

        SubAgentTemplate.objects.filter(
            space_id=workspace_id, skill_key=skill.canonical_key,
        ).delete()

        with self._stub_recent_session(agent.id, workspace_id):
            SkillService.enable_skill(
                user_id=owner,
                organization_id=org.id,
                agent_id=agent.id,
                skill_canonical_key=skill.canonical_key,
            )

        templates = SubAgentTemplate.objects.filter(
            space_id=workspace_id, skill_key=skill.canonical_key,
        )
        self.assertEqual(templates.count(), 1)
        tpl = templates.first()
        self.assertEqual(tpl.name, "weekly-summarizer")
        self.assertEqual(tpl.description, "汇总本周进展")
        self.assertEqual(tpl.tool_domains, ["tabdoc"])

    def test_disable_user_skill_removes_subagent_templates(self):
        from unittest.mock import patch

        from apps.services.agent_engine.models import SubAgentTemplate

        workspace_id = uuid.uuid4()
        org, agent, owner = self._enable_context(workspace_id=workspace_id)
        skill = Skill.objects.create(
            owner_user_id=owner,
            slug="auto-replier",
            name="Auto Replier",
            agents_json=[{"name": "replier", "description": "自动回复"}],
        )

        with self._stub_recent_session(agent.id, workspace_id):
            SkillService.enable_skill(
                user_id=owner,
                organization_id=org.id,
                agent_id=agent.id,
                skill_canonical_key=skill.canonical_key,
            )
        self.assertTrue(
            SubAgentTemplate.objects.filter(
                space_id=workspace_id, skill_key=skill.canonical_key,
            ).exists()
        )

        with self._stub_recent_session(agent.id, workspace_id):
            SkillService.disable_skill(
                user_id=owner,
                skill_canonical_key=skill.canonical_key,
                remove=True,
            )
        self.assertFalse(
            SubAgentTemplate.objects.filter(
                space_id=workspace_id, skill_key=skill.canonical_key,
            ).exists()
        )


@pytest.mark.django_db(databases=["default", "postgresql"])
class AgentSyncServiceSyncSkillAgentsTest(TransactionTestCase):
    """AgentSyncService.sync_skill_agents 直接调用回归。"""

    databases = {"default", "postgresql"}

    def test_sync_creates_then_updates_then_deletes(self):
        from apps.services.agent_engine.models import SubAgentTemplate

        space_id = str(uuid.uuid4())
        skill_key = "user:demo-skill"

        result = AgentSyncService.sync_skill_agents(
            space_id=space_id, skill_key=skill_key,
            agents=[
                {"name": "alice", "description": "原始描述"},
                {"name": "bob", "description": "另一个 agent"},
            ],
        )
        self.assertEqual(result["created"], 2)

        result = AgentSyncService.sync_skill_agents(
            space_id=space_id, skill_key=skill_key,
            agents=[{"name": "alice", "description": "更新后描述"}],
        )
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["deleted"], 1)

        self.assertTrue(
            SubAgentTemplate.objects.filter(
                space_id=space_id, skill_key=skill_key, name="alice",
            ).exists()
        )
        self.assertFalse(
            SubAgentTemplate.objects.filter(
                space_id=space_id, skill_key=skill_key, name="bob",
            ).exists()
        )

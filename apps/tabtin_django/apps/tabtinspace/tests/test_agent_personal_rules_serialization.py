"""Agent 详情/列表 API 序列化 personal_rules（ / RT-5）。

Electron IPC 主路径读 currentAgent.personal_rules 透传 buildCustomRulesBlock；
此前 AgentOut 不含该字段 → 恒 undefined。本测锁定 serialize_agent / _serialize_agent_data
按 organization owner 读 UserProfile.personal_rules 并写入响应。

跑法：
    python -m pytest apps/tabtinspace/tests/test_agent_personal_rules_serialization.py -v
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.tabtinspace.routers.shared import _serialize_agent_data


def _fake_agent(*, owner_id="owner-uid"):
    organization = SimpleNamespace(owner_id=owner_id, settings={})
    return SimpleNamespace(
        id="agent-1",
        organization=organization,
        owner_user_id=None,
        agent_config={},
    )


def _agent_out_dict(*, personal_rules=None):
    return {
        "id": "agent-1",
        "organization_id": "wt-1",
        "name": "Test Agent",
        "type": "bot",
        "is_active": True,
        "custom_rules": "",
        "personal_rules": personal_rules,
        "agent_config": {},
        "suggested_prompts": [],
        "preferred_model_id": "",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


class AgentPersonalRulesSerializationTests(SimpleTestCase):
    def test_includes_personal_rules_from_owner_profile(self):
        agent = _fake_agent(owner_id="owner-123")
        with patch(
            "apps.agent.serializers.AgentOut.model_validate",
            return_value=SimpleNamespace(model_dump=lambda: _agent_out_dict()),
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService.resolve_personal_rules_by_owner_id",
            return_value="请用中文",
        ) as mock_resolve:
            data = _serialize_agent_data(agent)

        mock_resolve.assert_called_once_with("owner-123")
        self.assertEqual(data["personal_rules"], "请用中文")

    def test_personal_rules_none_when_owner_has_no_rules(self):
        agent = _fake_agent(owner_id="owner-123")
        with patch(
            "apps.agent.serializers.AgentOut.model_validate",
            return_value=SimpleNamespace(model_dump=lambda: _agent_out_dict()),
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService.resolve_personal_rules_by_owner_id",
            return_value=None,
        ):
            data = _serialize_agent_data(agent)

        self.assertIsNone(data["personal_rules"])

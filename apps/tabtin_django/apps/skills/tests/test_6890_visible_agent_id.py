"""#6890 / ：选定 Agent → 可见 Skill / config 契约。

不依赖共享 test DB（并行 Agent 常抢占 test_tabtin_single）：
- API 缺参 / 上下文错误 → 稳定 400
- list_visible_skills 把已解析 agent_id 传给 resolve_agent_skill_state
- config API 把 query 上的 agent_id 交给 AgentSkillLink.filter
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.skills.api import get_skill_configs, list_visible_skills
from apps.skills.services.registry_service import SkillsRegistryService
from apps.skills.services.skill_service import SkillService, SkillServiceError
from apps.skills.services.space_context import SkillSpaceContext, SkillSpaceContextError


def _json(response):
    return json.loads(response.content.decode("utf-8"))


class VisibleSkillsAgentIdContractTest(SimpleTestCase):
    def test_list_visible_skill_service_error_returns_400_not_500(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"), GET={})
        with patch(
            "apps.skills.api._check_organization_member", return_value=True,
        ), patch.object(
            SkillService,
            "list_visible_skills",
            side_effect=SkillServiceError(
                "agent_id 必填：Skill 归属身份，不再从 Workspace 反推"
            ),
        ):
            response = list_visible_skills(
                request,
                organization_id="11111111-1111-1111-1111-111111111111",
                agent_id=None,
            )

        self.assertEqual(response.status_code, 400)
        body = _json(response)
        self.assertEqual(body.get("code"), "VALIDATION_ERROR")
        self.assertIn("agent_id", str(body.get("data", {}).get("detail", "")))

    def test_list_visible_space_context_error_returns_400_not_500(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"), GET={})
        with patch(
            "apps.skills.api._check_organization_member", return_value=True,
        ), patch.object(
            SkillService,
            "list_visible_skills",
            side_effect=SkillSpaceContextError(
                "agent_id 必填：Skill 归属身份，不再从 Workspace 反推"
            ),
        ):
            response = list_visible_skills(
                request,
                organization_id="11111111-1111-1111-1111-111111111111",
                agent_id=None,
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(_json(response).get("code"), "VALIDATION_ERROR")

    def test_get_skill_configs_requires_organization_membership(self):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"), GET={})
        with patch(
            "apps.skills.api._check_organization_member", return_value=False,
        ):
            response = get_skill_configs(
                request,
                organization_id="11111111-1111-1111-1111-111111111111",
                agent_id="22222222-2222-2222-2222-222222222222",
            )

        self.assertEqual(response.status_code, 403)

    def test_list_visible_passes_resolved_agent_id_into_skill_state(self):
        """选定 Agent 后，可见集合状态解析必须带上该 agent_id（ 根因）。"""
        organization_id = uuid.uuid4()
        agent_id = uuid.uuid4()
        context = SkillSpaceContext(
            space_id=agent_id,
            agent_id=agent_id,
            organization_id=organization_id,
            device_id=None,
        )
        skill_key = "user:selected-agent-skill"
        from apps.skills.services.user_preference_service import UserSkillPreferenceService

        with patch.object(
            SkillService, "_resolve_agent_context", return_value=context
        ), patch.object(
            SkillsRegistryService, "list_platform_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_app_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService, "list_device_skills", return_value=[]
        ), patch.object(
            SkillsRegistryService,
            "list_user_skills_visible",
            return_value=[
                {
                    "skill_id": "skill-1",
                    "skill_key": skill_key,
                    "name": "Selected",
                    "source": "user",
                }
            ],
        ), patch.object(
            SkillsRegistryService,
            "merge_skills",
            side_effect=lambda **kwargs: kwargs["user_skills"],
        ), patch.object(
            SkillsRegistryService,
            "resolve_agent_skill_state",
            return_value={
                skill_key: {
                    "carried": True,
                    "enabled": True,
                    "installed_version_seq": 1,
                    "install_content_hash": "hash",
                    "installed_on_device": False,
                }
            },
        ) as mock_state, patch.object(
            SkillService, "_batch_review_status", return_value={}
        ), patch.object(
            SkillService, "_batch_installed_version_labels", return_value={}
        ), patch.object(
            UserSkillPreferenceService, "map_for_user", return_value={skill_key: True}
        ):
            entries = SkillService.list_visible_skills(
                user_id=uuid.uuid4(),
                organization_id=organization_id,
                agent_id=agent_id,
            )

        mock_state.assert_called_once_with(
            None, agent_id=str(agent_id), user_id=mock_state.call_args.kwargs["user_id"],
        )
        entry = next(item for item in entries if item["skill_key"] == skill_key)
        self.assertTrue(entry["enabled"])
        self.assertTrue(entry["installed"])

    def test_get_skill_configs_forwards_agent_id_and_returns_agent_rows(self):
        organization_id = "11111111-1111-1111-1111-111111111111"
        agent_id = "22222222-2222-2222-2222-222222222222"
        row = SimpleNamespace(
            skill_canonical_key="user:selected-agent-skill",
            config_json={"mode": "for-selected"},
            enabled=True,
        )
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"), GET={})
        mock_filter = MagicMock(return_value=[row])
        with patch(
            "apps.skills.api._check_organization_member", return_value=True,
        ), patch(
            "apps.skills.models.AgentSkillLink.objects.filter",
            mock_filter,
        ):
            response = get_skill_configs(
                request, organization_id=organization_id, agent_id=agent_id,
            )

        mock_filter.assert_called_once_with(agent_id=agent_id)
        self.assertEqual(response.get("success"), True)
        self.assertEqual(
            response["data"]["configs"]["user:selected-agent-skill"]["mode"],
            "for-selected",
        )

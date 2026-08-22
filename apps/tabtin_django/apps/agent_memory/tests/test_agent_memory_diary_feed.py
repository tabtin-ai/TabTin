from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.db import connections
from django.test import TransactionTestCase
from django.utils import timezone

from apps.agent_memory.error_codes import ErrorCode, ServiceError
from apps.agent_memory.models import AgentMemory
from apps.agent_memory.services import (
    LEGACY_TABMEMO_DIARY_POLICY,
    AgentMemoryService,
)


pytestmark = pytest.mark.requires_pg_native


class AgentMemoryDiaryFeedTest(TransactionTestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.tabtinspace.models import OrganizationMember
        from apps.tabtinspace.tests.fixtures import (
            create_test_agent,
            create_test_organization_with_agent,
            create_test_user,
        )

        connections["postgresql"].close()
        context = create_test_organization_with_agent(prefix="amdiary")
        self.user_a = context["user"]
        self.organization = context["organization"]
        self.agent_a = context["agent"]
        self.agent_a.settings = {
            "avatar_key": "code-engineer",
            "avatar_url": "https://cdn.example.com/a.png",
        }
        self.agent_a.save(update_fields=["settings"])

        self.user_b = create_test_user(prefix="amdiary-b")
        OrganizationMember.objects.create(
            organization=self.organization,
            user_id=self.user_b.id,
            role="viewer",
        )
        self.agent_b = create_test_agent(
            organization=self.organization,
            owner_user=self.user_a,
            prefix="amdiary-agent-b",
        )
        self.agent_b.name = "Beta Agent"
        self.agent_b.save(update_fields=["name"])

        self.other_org = create_test_organization_with_agent(prefix="amdiary-other")
        self.other_org_agent = self.other_org["agent"]
        self.other_org_user = self.other_org["user"]

        self.service_a = AgentMemoryService(self.user_a)
        self.service_b = AgentMemoryService(self.user_b)

    def tearDown(self):
        from apps.tabtinspace.models import Organization
        from apps.tabtinspace.tests.fixtures import cleanup_test_organization

        AgentMemory.objects.filter(
            organization_id__in=[self.organization.id, self.other_org["organization"].id]
        ).delete()
        owner_ids = [self.user_a.id, self.user_b.id, self.other_org_user.id]
        for org in list(Organization.objects.filter(owner_id__in=owner_ids)):
            cleanup_test_organization(org, delete_user=True)

    def _diary(self, *, agent=None, owner=None, content="diary", organization=None, **kwargs):
        return AgentMemory.objects.create(
            organization_id=(organization or self.organization).id,
            agent=agent or self.agent_a,
            owner_id=(owner or self.user_a).id,
            memo_type=AgentMemory.MemoType.DIARY,
            content_plaintext=content,
            content_markdown=content,
            **kwargs,
        )

    def test_aggregates_diaries_across_owned_agents(self):
        d1 = self._diary(agent=self.agent_a, content="alpha diary")
        d2 = self._diary(agent=self.agent_b, content="beta diary")
        AgentMemory.objects.create(
            organization_id=self.organization.id,
            agent=self.agent_a,
            owner_id=self.user_a.id,
            memo_type=AgentMemory.MemoType.INSIGHT,
            content_plaintext="insight not diary",
            content_markdown="insight not diary",
        )

        result = self.service_a.list_org_diary_feed(
            organization_id=str(self.organization.id),
        )
        ids = {item["id"] for item in result["items"]}
        self.assertEqual(ids, {str(d1.id), str(d2.id)})
        self.assertEqual(result["legacy_policy"], LEGACY_TABMEMO_DIARY_POLICY)
        by_id = {item["id"]: item for item in result["items"]}
        self.assertEqual(by_id[str(d1.id)]["agent_name"], self.agent_a.name)
        self.assertEqual(by_id[str(d1.id)]["agent_avatar"], "https://cdn.example.com/a.png")
        self.assertEqual(by_id[str(d2.id)]["agent_name"], "Beta Agent")
        self.assertEqual(by_id[str(d1.id)]["memory_type"], "diary")

    def test_hides_other_subject_and_other_organization(self):
        mine = self._diary(owner=self.user_a, content="mine")
        self._diary(owner=self.user_b, content="other-subject")
        self._diary(
            agent=self.other_org_agent,
            owner=self.other_org_user,
            organization=self.other_org["organization"],
            content="other-org",
        )

        result = self.service_a.list_org_diary_feed(
            organization_id=str(self.organization.id),
        )
        self.assertEqual([item["id"] for item in result["items"]], [str(mine.id)])

        # user_b 不是 agent owner → 可用 Agent 为空 → 空 feed
        result_b = self.service_b.list_org_diary_feed(
            organization_id=str(self.organization.id),
        )
        self.assertEqual(result_b["items"], [])

    def test_memory_switch_off_returns_empty(self):
        self._diary(content="secret diary")
        with patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(False, ""),
        ):
            result = self.service_a.list_org_diary_feed(
                organization_id=str(self.organization.id),
            )
        self.assertEqual(result["items"], [])
        self.assertFalse(result["has_more"])
        self.assertFalse(result["memory_enabled"])

    def test_keyset_cursor_and_cjk_search(self):
        older = self._diary(content="晨会纪要 alpha")
        newer = self._diary(content="晨会纪要 beta")
        AgentMemory.objects.filter(id=older.id).update(
            created_at=timezone.now() - timedelta(hours=2),
        )
        AgentMemory.objects.filter(id=newer.id).update(
            created_at=timezone.now() - timedelta(hours=1),
        )
        older.refresh_from_db()
        newer.refresh_from_db()

        page1 = self.service_a.list_org_diary_feed(
            organization_id=str(self.organization.id),
            limit=1,
            search="晨会",
        )
        self.assertEqual(len(page1["items"]), 1)
        self.assertEqual(page1["items"][0]["id"], str(newer.id))
        self.assertTrue(page1["has_more"])
        self.assertTrue(page1["next_cursor"])

        page2 = self.service_a.list_org_diary_feed(
            organization_id=str(self.organization.id),
            limit=1,
            search="晨会",
            cursor=page1["next_cursor"],
        )
        self.assertEqual([item["id"] for item in page2["items"]], [str(older.id)])
        self.assertFalse(page2["has_more"])

    def test_invalid_cursor_rejected(self):
        with self.assertRaises(ServiceError) as captured:
            self.service_a.list_org_diary_feed(
                organization_id=str(self.organization.id),
                cursor="not-a-cursor",
            )
        self.assertEqual(captured.exception.code, ErrorCode.INVALID_CURSOR)

    def test_api_endpoint_returns_feed(self):
        from django.test import RequestFactory

        from apps.agent_memory.api import list_org_diary_feed

        diary = self._diary(content="via api")
        request = RequestFactory().get("/agent-memory/diary-feed/")
        request.auth = self.user_a
        response = list_org_diary_feed(
            request,
            organization_id=str(self.organization.id),
        )
        self.assertEqual(response["success"], True)
        ids = {item["id"] for item in response["data"]["items"]}
        self.assertIn(str(diary.id), ids)

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.agent_memory.isolation import (
    CrossWorkspaceCompactionError,
    MemoryAggregationScope,
    assert_compaction_group_scope,
)
from apps.user_portrait.models import UserPortrait


class WorkspaceMemoryIsolationContractTests(SimpleTestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.agent_id = str(uuid.uuid4())
        self.personal_id = str(uuid.uuid4())
        self.org_a_id = str(uuid.uuid4())
        self.org_b_id = str(uuid.uuid4())
        self.memories = [
            self._memory("P", self.personal_id),
            self._memory("A", self.org_a_id),
            self._memory("B", self.org_b_id),
        ]

    def _memory(self, content: str, organization_id: str):
        return SimpleNamespace(
            content=content,
            organization_id=organization_id,
            owner_id=self.user_id,
            agent_id=self.agent_id,
        )

    def _scope(self, organization_id: str):
        return MemoryAggregationScope(
            organization_id=organization_id,
            subject_user_id=self.user_id,
            agent_id=self.agent_id,
        )

    def test_personal_aggregate_reads_personal_only(self):
        selected = self._scope(self.personal_id).select(self.memories)
        self.assertEqual([memory.content for memory in selected], ["P"])

    def test_org_a_aggregate_reads_org_a_only(self):
        selected = self._scope(self.org_a_id).select(self.memories)
        self.assertEqual([memory.content for memory in selected], ["A"])

    def test_org_b_aggregate_reads_org_b_only(self):
        selected = self._scope(self.org_b_id).select(self.memories)
        self.assertEqual([memory.content for memory in selected], ["B"])

    def test_portrait_has_organization_user_agent_unique_scope(self):
        constraint = next(
            item
            for item in UserPortrait._meta.constraints
            if item.name == "up_user_org_agent_unique"
        )
        self.assertEqual(
            tuple(constraint.fields),
            ("user", "organization_id", "agent_id"),
        )

    def test_cross_workspace_compaction_is_blocked(self):
        group = [
            {
                "memo_id": "a",
                "organization_id": self.org_a_id,
                "owner_id": self.user_id,
                "agent_id": self.agent_id,
            },
            {
                "memo_id": "b",
                "organization_id": self.org_b_id,
                "owner_id": self.user_id,
                "agent_id": self.agent_id,
            },
        ]
        with self.assertRaises(CrossWorkspaceCompactionError):
            assert_compaction_group_scope(self._scope(self.org_a_id), group)

    @patch("apps.services.llm.services.chat.unified_llm_call")
    @patch(
        "apps.services.billing.organization_resolver.resolve_organization_id_from_space",
        return_value=None,
    )
    def test_invalid_compaction_scope_never_calls_provider(
        self,
        _resolve_organization,
        unified_llm_call,
    ):
        from apps.services.agent_engine.tasks.memory.compaction import _merge_group

        result = _merge_group(
            [
                {"memo_id": "a", "content": "A"},
                {"memo_id": "b", "content": "B"},
            ],
            space_id="missing-space",
            user_id=self.user_id,
        )
        self.assertFalse(result)
        unified_llm_call.assert_not_called()

    @patch("apps.services.llm.services.chat.unified_llm_call")
    @patch(
        "apps.services.agent_engine.utils.memory_constants.resolve_space_execution_agent_id"
    )
    @patch(
        "apps.services.billing.organization_resolver.resolve_organization_id_from_space"
    )
    def test_mixed_compaction_group_is_blocked_before_provider(
        self,
        resolve_organization,
        resolve_agent,
        unified_llm_call,
    ):
        from apps.services.agent_engine.tasks.memory.compaction import _merge_group

        resolve_organization.return_value = self.org_a_id
        resolve_agent.return_value = self.agent_id
        group = [
            {
                "memo_id": "a",
                "organization_id": self.org_a_id,
                "owner_id": self.user_id,
                "agent_id": self.agent_id,
                "content": "A",
            },
            {
                "memo_id": "b",
                "organization_id": self.org_b_id,
                "owner_id": self.user_id,
                "agent_id": self.agent_id,
                "content": "B",
            },
        ]

        with self.assertRaises(CrossWorkspaceCompactionError):
            _merge_group(group, space_id="space-a", user_id=self.user_id)
        unified_llm_call.assert_not_called()

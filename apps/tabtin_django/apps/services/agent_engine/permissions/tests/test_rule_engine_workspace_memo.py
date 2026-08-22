"""PermissionRuleEngine ALWAYS 决策必须落 Workspace 事实源。"""

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.services.agent_engine.permissions.rule_engine import (
    PermissionAction,
    PermissionRuleEngine,
)
from apps.tabtinspace.services.base import ServiceError


class PermissionRuleWorkspaceMemoTests(SimpleTestCase):
    @patch(
        "apps.tabtinspace.services.approval_memo_service.ApprovalMemoService"
    )
    def test_persist_delegates_to_workspace_approval_service(self, service_cls):
        workspace_id = uuid4()
        user_id = uuid4()
        service = service_cls.return_value
        service.get_memo.return_value = SimpleNamespace(generation=3)

        PermissionRuleEngine._persist_always_decision(
            "shell",
            PermissionAction.ALLOW,
            {
                "current_space_id": str(workspace_id),
                "user_id": str(user_id),
            },
        )

        self.assertEqual(str(service_cls.call_args.kwargs["user"].id), str(user_id))
        service.upsert_entry.assert_called_once_with(
            workspace_id=workspace_id,
            entry_key="permission_rule::tool::shell",
            decision="allow",
            reason="PermissionRuleEngine ALWAYS decision",
            last_seen_generation=3,
        )

    @patch(
        "apps.tabtinspace.services.approval_memo_service.ApprovalMemoService"
    )
    def test_load_reads_only_permission_rule_namespace(self, service_cls):
        workspace_id = uuid4()
        service_cls.return_value.get_memo.return_value = SimpleNamespace(
            entries={
                "permission_rule::tool::shell": {"decision": "allow"},
                "permission_rule::tool::delete": {"decision": "deny"},
                "shell::run::*": {"decision": "allow"},
                "permission_rule::tool::ask": {"decision": "ask"},
            }
        )

        decisions = PermissionRuleEngine._load_always_decisions(
            str(workspace_id),
            str(uuid4()),
        )

        self.assertEqual(decisions, {"shell": "allow", "delete": "deny"})

    @patch(
        "apps.tabtinspace.services.approval_memo_service.ApprovalMemoService"
    )
    def test_persist_retries_one_generation_conflict(self, service_cls):
        service = service_cls.return_value
        service.get_memo.side_effect = [
            SimpleNamespace(generation=3),
            SimpleNamespace(generation=4),
        ]
        service.upsert_entry.side_effect = [
            ServiceError(
                "GENERATION_CONFLICT",
                "conflict",
                status=409,
                data={"current_generation": 4},
            ),
            None,
        ]

        PermissionRuleEngine._persist_always_decision(
            "shell",
            PermissionAction.ALLOW,
            {
                "current_space_id": str(uuid4()),
                "user_id": str(uuid4()),
            },
        )

        self.assertEqual(service.upsert_entry.call_count, 2)
        self.assertEqual(
            service.upsert_entry.call_args.kwargs["last_seen_generation"],
            4,
        )

    @patch("time.sleep")
    @patch(
        "apps.tabtinspace.services.approval_memo_service.ApprovalMemoService"
    )
    def test_persist_retries_transient_row_lock_busy(self, service_cls, sleep):
        service = service_cls.return_value
        service.get_memo.return_value = SimpleNamespace(generation=3)
        service.upsert_entry.side_effect = [
            ServiceError("APPROVAL_MEMO_BUSY", "busy", status=409),
            None,
        ]

        PermissionRuleEngine._persist_always_decision(
            "shell",
            PermissionAction.ALLOW,
            {
                "current_space_id": str(uuid4()),
                "user_id": str(uuid4()),
            },
        )

        self.assertEqual(service.upsert_entry.call_count, 2)
        sleep.assert_called_once()


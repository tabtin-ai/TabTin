"""prompt.forward 的 crash-resume wire 投影回归。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import (
    PromptForwardService,
)


def _space() -> SimpleNamespace:
    return SimpleNamespace(
        id="workspace-1",
        organization_id="organization-1",
        working_dir="/tmp/tabtin-workspace",
        approval_grant="always_ask",
    )


def _pending_single_hitl() -> dict:
    return {
        "kind": "ask_choice",
        "request_key": "request-1",
        "thread_id": "chat-session-1",
        "status": "resolved",
        "payload": {"questions": []},
        "result": {"answers": {"question-1": "answer-1"}},
        "expires_at": None,
        "created_at": 1,
        "resolved_at": 2,
        "runtime_mode": "interactive",
    }


class PromptForwardInterruptStateTests(SimpleTestCase):
    def _forward_and_capture(self, interrupt_state: dict) -> dict:
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service."
            "_resolve_pressure_threshold_fields",
            return_value={},
        ), patch.object(
            PromptForwardService,
            "_route_to_device",
            return_value=1,
        ) as publish:
            PromptForwardService().forward_prompt(
                thread_id="chat-session-1",
                space=_space(),
                prompt="continue",
                attachments=[],
                agent_backend_config={"type": "claude"},
                interrupt_state=interrupt_state,
            )

        return publish.call_args.args[2]["payload"]["interrupt_state"]

    def test_single_hitl_without_conversation_state_omits_null_metadata(self) -> None:
        wire_state = self._forward_and_capture({
            "pending_single_hitl": [_pending_single_hitl()],
        })

        self.assertEqual(
            wire_state,
            {"pending_single_hitl": [_pending_single_hitl()]},
        )
        self.assertNotIn("version", wire_state)
        self.assertNotIn("snapshot", wire_state)

    def test_agent_mention_interrupt_flag_is_written_to_wire_payload(self) -> None:
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service."
            "_resolve_pressure_threshold_fields",
            return_value={},
        ), patch.object(
            PromptForwardService,
            "_route_to_device",
            return_value=1,
        ) as publish:
            PromptForwardService().forward_prompt(
                thread_id="chat-session-1",
                space=_space(),
                prompt="@Agent 处理这个任务",
                attachments=[],
                agent_backend_config={"type": "claude"},
                interrupt_active=True,
            )

        self.assertIs(
            publish.call_args.args[2]["payload"]["interrupt_active"],
            True,
        )

    def test_valid_resume_metadata_is_preserved(self) -> None:
        snapshot = {"budget": {"remaining": 2}}
        wire_state = self._forward_and_capture({
            "version": 3,
            "snapshot": snapshot,
            "pending_single_hitl": [_pending_single_hitl()],
        })

        self.assertEqual(wire_state["version"], 3)
        self.assertEqual(wire_state["snapshot"], snapshot)

    def test_pending_approval_omits_nullable_storage_fields_on_wire(self) -> None:
        wire_state = self._forward_and_capture({
            "version": 2,
            "pending_approvals": [
                {
                    "batch_id": "batch-1",
                    "runtime_mode": "interactive",
                    "created_at": 1,
                    "entries": [
                        {
                            "request_id": "request-1",
                            "tool_call_id": "tool-call-1",
                            "tool_name": "execute_command",
                            "status": "pending",
                            "outcome": None,
                            "scope": None,
                            "resolved_at": None,
                            "approver_identity": None,
                        },
                    ],
                },
            ],
        })

        self.assertEqual(wire_state["version"], 2)
        self.assertEqual(len(wire_state["pending_approvals"]), 1)
        pending = wire_state["pending_approvals"][0]
        self.assertEqual(pending["batch_id"], "batch-1")
        self.assertEqual(pending["status"], "pending")
        self.assertNotIn("outcome", pending)
        self.assertNotIn("scope", pending)
        self.assertNotIn("resolved_at", pending)
        self.assertNotIn("approver_identity", pending)

    def test_invalid_pending_approval_isolated_from_valid_siblings(self) -> None:
        flat = PromptForwardService._flatten_pending_approvals_for_wire([
            {
                "batch_id": "batch-1",
                "entries": [
                    {
                        "request_id": "invalid",
                        "tool_call_id": "tool-call-invalid",
                        "tool_name": "execute_command",
                        "status": "not-a-status",
                    },
                    {
                        "request_id": "valid",
                        "tool_call_id": "tool-call-valid",
                        "tool_name": "execute_command",
                        "status": "resolved",
                        "outcome": "allow",
                        "scope": "",
                    },
                ],
            },
        ])

        self.assertEqual(len(flat), 1)
        self.assertEqual(flat[0]["request_id"], "valid")
        self.assertEqual(flat[0]["outcome"], "allow")
        self.assertNotIn("scope", flat[0])

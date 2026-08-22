from django.test import TestCase

from apps.chat.conversation.models import (
    ChatMessage,
    ChatSession,
    SessionWorkspaceFileReference,
)
from apps.chat.conversation.services.workspace_file import (
    extract_local_file_candidates,
    index_message_workspace_file_refs,
    strip_approval_note_prefix,
    surviving_file_ops,
)
from apps.chat.conversation.services.workspace_file.reference import (
    _parse_tool_result_json,
)
from apps.tabtinspace.models import Device, Organization, Workspace
from django.contrib.auth import get_user_model

User = get_user_model()


class WorkspaceFileReferenceServiceTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            username="owner-swfr",
            email="owner-swfr@test.com",
            password="x",
        )
        self.org = Organization.objects.create(name="org-swfr", owner=self.user)
        self.device = Device.objects.create(
            organization=self.org,
            user=self.user,
            name="swfr-device",
            device_type="electron",
            role="control",
            fingerprint="swfr-device-fp",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            name="ws-swfr",
            organization=self.org,
            device=self.device,
            created_by=self.user,
            working_dir="/tmp/ws-swfr",
            normalized_working_dir="/tmp/ws-swfr",
            kind=Workspace.Kind.STANDARD,
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.org.id),
            workspace=self.workspace,
            title="swfr",
        )

    def test_extract_local_file_and_tool_ops(self):
        blocks = [
            {
                "type": "tabtin_rich_content",
                "kind": "file",
                "payload": {
                    "artifact_kind": "local_file",
                    "relative_path": "./artifacts/a.xlsx",
                    "filename": "a.xlsx",
                    "file_type": "xlsx",
                    "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "file_size": 12,
                    "url": "tabtin://resource/file/artifacts%2Fa.xlsx?hint=tabfiles",
                    "self_check": {"status": "passed", "summary": "ok"},
                },
            },
            {
                "type": "tool_use",
                "name": "delete_file",
                "input": {"path": "artifacts/a.xlsx"},
            },
            {
                "type": "tool_use",
                "name": "write_file",
                "input": {"path": "artifacts/b.md"},
            },
        ]
        ops = extract_local_file_candidates(blocks)
        survivors = surviving_file_ops(ops)
        paths = {op["relative_path"] for op in survivors}
        self.assertEqual(paths, {"artifacts/b.md"})

    def test_index_message_upserts_and_deactivates(self):
        create_msg = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tabtin_rich_content",
                    "kind": "file",
                    "payload": {
                        "artifact_kind": "local_file",
                        "relative_path": "artifacts/report.pdf",
                        "filename": "report.pdf",
                        "file_type": "pdf",
                        "mime_type": "application/pdf",
                        "file_size": 100,
                        "url": "tabtin://resource/file/artifacts%2Freport.pdf?hint=tabfiles",
                        "self_check": {"status": "passed", "summary": "ok"},
                    },
                }
            ],
        )
        index_message_workspace_file_refs(create_msg)
        ref = SessionWorkspaceFileReference.objects.get(session=self.session)
        self.assertTrue(ref.is_active)
        self.assertEqual(ref.relative_path, "artifacts/report.pdf")

        delete_msg = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "name": "delete_file",
                    "input": {"path": "artifacts/report.pdf"},
                }
            ],
        )
        index_message_workspace_file_refs(delete_msg)
        ref.refresh_from_db()
        self.assertFalse(ref.is_active)

    def test_same_message_delete_then_recreate_keeps_active(self):
        """同消息先删后建：净算后路径仍存活，不得被 deactivate。"""
        msg = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "name": "delete_file",
                    "input": {"path": "artifacts/report.pdf"},
                },
                {
                    "type": "tabtin_rich_content",
                    "kind": "file",
                    "payload": {
                        "artifact_kind": "local_file",
                        "relative_path": "artifacts/report.pdf",
                        "filename": "report.pdf",
                        "file_type": "pdf",
                        "mime_type": "application/pdf",
                        "file_size": 100,
                        "url": "tabtin://resource/file/artifacts%2Freport.pdf?hint=tabfiles",
                        "self_check": {"status": "passed", "summary": "ok"},
                    },
                },
            ],
        )
        index_message_workspace_file_refs(msg)
        ref = SessionWorkspaceFileReference.objects.get(session=self.session)
        self.assertTrue(ref.is_active)
        self.assertEqual(ref.relative_path, "artifacts/report.pdf")

    def test_strip_approval_note_prefix_aligns_with_frontend(self):
        raw = (
            "<approval_note>\n"
            "User approved tool 'run_terminal_command'.\n"
            "</approval_note>\n\n"
            '{"exit_code":0,"file_history":{"created_paths":["test70m.txt"]}}'
        )
        stripped = strip_approval_note_prefix(raw)
        self.assertTrue(stripped.startswith("{"))
        self.assertNotIn("approval_note", stripped)
        parsed = _parse_tool_result_json(raw)
        self.assertIsNotNone(parsed)
        self.assertEqual(
            parsed["file_history"]["created_paths"],
            ["test70m.txt"],
        )

    def test_index_shell_file_history_behind_approval_note(self):
        """#4760 审批回执前缀不得挡住 shell file_history 写时索引。"""
        inner = (
            '{"status":"completed","exit_code":0,'
            '"file_history":{"created_paths":["test70m.txt"],'
            '"modified_paths":[],"deleted_paths":[]}}'
        )
        msg = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "id": "tu_shell",
                    "name": "run_terminal_command",
                    "input": {
                        "command": "dd if=/dev/zero of=test70m.txt bs=1M count=70",
                    },
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "tu_shell",
                    "content": (
                        "<approval_note>\n"
                        "User approved tool 'run_terminal_command'.\n"
                        f"</approval_note>\n\n{inner}"
                    ),
                },
            ],
        )
        touched = index_message_workspace_file_refs(msg)
        self.assertGreaterEqual(touched, 1)
        ref = SessionWorkspaceFileReference.objects.get(session=self.session)
        self.assertTrue(ref.is_active)
        self.assertEqual(ref.relative_path, "test70m.txt")
        self.assertEqual(ref.source_kind, "shell_history")

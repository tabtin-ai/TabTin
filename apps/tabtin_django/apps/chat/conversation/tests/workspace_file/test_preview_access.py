from datetime import timedelta
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlparse

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.chat.conversation.models import (
    ChatMessage,
    ChatSession,
    SessionShare,
    SessionWorkspaceFileReference,
    SessionWorkspaceFileSnapshot,
)
from apps.chat.conversation.services.workspace_file import (
    WorkspaceFilePreviewService,
    revoke_session_workspace_file_snapshots,
)
from apps.tabtinspace.models import Device, Organization, Workspace

User = get_user_model()


class WorkspaceFilePreviewAccessTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(
            username="preview-owner",
            email="preview-owner@test.com",
            password="x",
        )
        self.grantee = User.objects.create_user(
            username="preview-grantee",
            email="preview-grantee@test.com",
            password="x",
        )
        self.stranger = User.objects.create_user(
            username="preview-stranger",
            email="preview-stranger@test.com",
            password="x",
        )
        self.org = Organization.objects.create(name="org-preview", owner=self.owner)
        self.device = Device.objects.create(
            organization=self.org,
            user=self.owner,
            name="preview-device",
            device_type="electron",
            role="control",
            fingerprint="preview-device-fp",
            status="online",
        )
        self.workspace = Workspace.objects.create(
            name="ws-preview",
            organization=self.org,
            device=self.device,
            created_by=self.owner,
            working_dir="/tmp/ws-preview",
            normalized_working_dir="/tmp/ws-preview",
            kind=Workspace.Kind.STANDARD,
        )
        self.session = ChatSession.objects.create(
            user=self.owner,
            organization_id=str(self.org.id),
            workspace=self.workspace,
            title="preview-session",
        )
        SessionWorkspaceFileReference.objects.create(
            session=self.session,
            relative_path="artifacts/note.md",
            path_key="artifacts/note.md",
            filename="note.md",
            source_kind="local_file",
            is_active=True,
        )
        self.share = SessionShare.objects.create(
            session=self.session,
            organization_id=str(self.org.id),
            owner_user_id=str(self.owner.id),
            grantee_user_id=str(self.grantee.id),
            status="active",
        )

    def test_stranger_denied(self):
        result = WorkspaceFilePreviewService(self.stranger).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/note.md",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "FORBIDDEN")

    def test_revoked_share_denied(self):
        self.share.status = "revoked"
        self.share.save(update_fields=["status"])
        result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/note.md",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "FORBIDDEN")

    def test_preview_scope_does_not_borrow_active_sibling_share(self):
        sibling = SessionShare.objects.create(
            session=self.session,
            organization_id=str(self.org.id),
            owner_user_id=str(self.owner.id),
            grantee_user_id=str(self.grantee.id),
            status="active",
        )
        self.share.status = "revoked"
        self.share.save(update_fields=["status"])

        revoked_result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/note.md",
            share_id=str(self.share.id),
        )
        self.assertFalse(revoked_result["success"])
        self.assertEqual(revoked_result["error_code"], "FORBIDDEN")

        sibling_result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="secrets/passwords.txt",
            share_id=str(sibling.id),
        )
        self.assertEqual(sibling_result["error_code"], "FILE_NOT_INDEXED")

    def test_unindexed_path_denied(self):
        result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="secrets/passwords.txt",
        )
        self.assertFalse(result["success"])
        # 有 share 但路径不在索引：与「无权」区分，避免误导。
        self.assertEqual(result["error_code"], "FILE_NOT_INDEXED")
        self.assertIn("索引", result["error"])

    def test_known_oversized_text_rejected_before_inline(self):
        SessionWorkspaceFileReference.objects.create(
            session=self.session,
            relative_path="artifacts/huge.txt",
            path_key="artifacts/huge.txt",
            filename="huge.txt",
            source_kind="shell_history",
            file_size=50 * 1024 * 1024 + 1,
            is_active=True,
        )
        result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/huge.txt",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "FILE_TOO_LARGE")
        self.assertEqual(result["http_status"], 413)

    @patch(
        "apps.chat.conversation.services.workspace_file.preview."
        "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action"
    )
    def test_grantee_inline_text_preview(self, mock_dispatch):
        mock_dispatch.return_value = {
            "success": True,
            "data": {
                "kind": "text",
                "content": "hello shared",
                "size": 12,
                "truncated": False,
            },
        }
        result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/note.md",
        )
        self.assertTrue(result["success"])
        self.assertEqual(result["transport"]["mode"], "inline")
        self.assertEqual(result["transport"]["data"]["content"], "hello shared")
        mock_dispatch.assert_called()
        kwargs = mock_dispatch.call_args.kwargs
        self.assertEqual(kwargs["execution_owner_user_id"], str(self.owner.id))
        self.assertEqual(kwargs["action"], "fs.read_file_preview")

    @patch(
        "apps.chat.conversation.services.workspace_file.preview."
        "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action"
    )
    def test_path_denied_does_not_fall_through_to_materialize(self, mock_dispatch):
        mock_dispatch.return_value = {
            "success": False,
            "error": "path is not accessible",
            "error_code": "PATH_DENIED",
            "http_status": 403,
        }
        result = WorkspaceFilePreviewService(self.grantee).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/note.md",
        )
        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "PATH_DENIED")
        self.assertEqual(mock_dispatch.call_count, 1)
        self.assertEqual(
            mock_dispatch.call_args.kwargs["action"],
            "fs.read_file_preview",
        )

    @patch(
        "apps.chat.conversation.services.workspace_file.preview.get_oss_service"
    )
    def test_revoke_snapshots_calls_delete_file(self, mock_get_oss):
        oss = mock_get_oss.return_value
        ref = SessionWorkspaceFileReference.objects.get(session=self.session)
        SessionWorkspaceFileSnapshot.objects.create(
            reference=ref,
            session=self.session,
            content_version="sha256:abc",
            object_key="session-share/org/sess/ref/v1",
            status="ready",
            preview_kind="pdf",
        )
        count = revoke_session_workspace_file_snapshots(session=self.session)
        self.assertEqual(count, 1)
        oss.delete_file.assert_called_once_with("session-share/org/sess/ref/v1")
        snap = SessionWorkspaceFileSnapshot.objects.get(reference=ref)
        self.assertEqual(snap.status, "revoked")

    @patch(
        "apps.chat.conversation.services.workspace_file.preview."
        "DeviceRuntimeQueryService.dispatch_owner_workspace_fs_action"
    )
    @patch(
        "apps.chat.conversation.services.workspace_file.preview.get_oss_service"
    )
    def test_signed_url_rewrites_loopback_to_request_host(
        self,
        mock_get_oss,
        mock_dispatch,
    ):
        """LAN grantee 请求 Host=192.168.x.x 时，GET signed_url 不得仍是 127.0.0.1。"""
        # probe 成功后命中 ready 快照；不应再走 upload。
        mock_dispatch.return_value = {
            "success": True,
            "data": {
                "content_version": "sha256:cached",
                "size_bytes": 1024,
            },
        }
        oss = MagicMock()
        oss.generate_presigned_url.return_value = (
            "http://127.0.0.1:6060/api/services/oss/local-object"
            "?object_key=session-share%2Fdemo&signature=sig"
        )
        mock_get_oss.return_value = oss

        SessionWorkspaceFileReference.objects.create(
            session=self.session,
            relative_path="artifacts/deck.pptx",
            path_key="artifacts/deck.pptx",
            filename="deck.pptx",
            source_kind="local_file",
            is_active=True,
            mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
        ref = SessionWorkspaceFileReference.objects.get(
            session=self.session,
            path_key="artifacts/deck.pptx",
        )
        SessionWorkspaceFileSnapshot.objects.create(
            reference=ref,
            session=self.session,
            content_version="sha256:cached",
            object_key="session-share/demo",
            status="ready",
            preview_kind="pptx",
            expires_at=timezone.now() + timedelta(hours=1),
            size_bytes=1024,
            mime_type=ref.mime_type,
        )

        request = RequestFactory().post(
            f"/api/chat/sessions/{self.session.id}/shared-file-preview",
            HTTP_HOST="192.168.8.10:6060",
        )
        result = WorkspaceFilePreviewService(self.grantee, request=request).preview(
            session_id=str(self.session.id),
            relative_path="artifacts/deck.pptx",
        )
        self.assertTrue(result["success"], result)
        url = result["transport"]["url"]
        parsed = urlparse(url)
        self.assertEqual(parsed.hostname, "192.168.8.10")
        self.assertEqual(parsed.port, 6060)
        self.assertEqual(
            (parse_qs(parsed.query).get("object_key") or [None])[0],
            "session-share/demo",
        )
        # 仅 probe，不再 upload
        self.assertEqual(mock_dispatch.call_count, 1)
        self.assertEqual(
            mock_dispatch.call_args.kwargs["params"].get("phase"),
            "probe",
        )

"""#7845 TabDoc HTML 块继承文档权限：双通道鉴权 + browser-link。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import HttpResponse, JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.services.common.public_share.exceptions import (
    ShareExpiredError,
    ShareNotFoundError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
)
from apps.services.oss.models import FileRecord, FileUsage
from apps.tabdoc.api import get_document_html_artifact, get_html_block_browser_link
from apps.tabdoc.api_share import (
    HtmlBlockBrowserOpenRequest,
    SharedHtmlArtifactRequest,
    get_shared_html_artifact,
    open_html_block_in_browser,
)
from apps.tabdoc.models import Document, DocumentPermission, DocumentShare
from apps.tabdoc.services.html_artifact_service import (
    HtmlArtifactAccessError,
    HtmlArtifactService,
    build_html_artifact_response,
    collect_html_block_file_ids,
)
from apps.tabdoc.services.share_service import DocumentShareService
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()
TABDOC_DB = (
    "default"
    if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
    else "postgresql"
)


def _extract(response):
    if isinstance(response, HttpResponse) and not isinstance(response, JsonResponse):
        return response, response.status_code
    if isinstance(response, JsonResponse):
        return json.loads(response.content.decode("utf-8")), response.status_code
    if isinstance(response, dict):
        return response, 200
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        return body, status
    raise AssertionError(f"unexpected view response type: {type(response)!r}")


class HtmlArtifactAccessTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization

        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        self.factory = RequestFactory()
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"html_owner_{suffix}",
            email=f"html_owner_{suffix}@example.com",
            password="x",
        )
        self.outsider = User.objects.create_user(
            username=f"html_out_{suffix}",
            email=f"html_out_{suffix}@example.com",
            password="x",
        )
        self.member = User.objects.create_user(
            username=f"html_mem_{suffix}",
            email=f"html_mem_{suffix}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="HTML Artifact Org",
            owner=self.owner,
            type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            role="editor",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="HTML Space",
        )
        self.block_id = f"html-block-{suffix}"
        self.file_record = self._make_file_record(organization_id=str(self.organization.id))
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="html artifact doc",
            description_json={
                "type": "doc",
                "content": [
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            "blockId": self.block_id,
                            "fileId": str(self.file_record.id),
                            "src": "",
                            "title": "chart",
                            "height": 360,
                        },
                    }
                ],
            },
        )
        FileUsage.add_usage(
            self.file_record,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )
        self.doc_editor = User.objects.create_user(
            username=f"html_editor_{suffix}",
            email=f"html_editor_{suffix}@example.com",
            password="x",
        )
        self.doc_admin = User.objects.create_user(
            username=f"html_admin_{suffix}",
            email=f"html_admin_{suffix}@example.com",
            password="x",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.doc_editor,
            role="editor",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.doc_admin,
            role="editor",
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.doc_editor.id),
            permission="editor",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.doc_admin.id),
            permission="admin",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        # 显式 viewer：无文档权限的组织成员对照
        self.doc_viewer = User.objects.create_user(
            username=f"html_viewer_{suffix}",
            email=f"html_viewer_{suffix}@example.com",
            password="x",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.doc_viewer,
            role="viewer",
        )
        DocumentPermission.objects.create(
            document=self.doc,
            subject_type="user",
            subject_id=str(self.doc_viewer.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )

    def _make_file_record(self, *, organization_id: str, is_public: bool = False) -> FileRecord:
        return FileRecord.objects.create(
            file_name="block.html",
            file_key=f"tabdoc/html/{uuid.uuid4().hex}.html",
            file_path="/tabdoc/html/",
            file_size=32,
            file_type="document",
            mime_type="text/html",
            file_extension="html",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=organization_id,
            is_public=is_public,
            access_url="https://cdn.example.com/should-not-be-used.html",
        )

    def _patch_download(self, content: bytes = b"<html>private</html>"):
        return patch(
            "apps.tabdoc.services.html_artifact_service.get_oss_service",
            return_value=type(
                "OSS",
                (),
                {
                    "download_file": staticmethod(
                        lambda _key: {
                            "success": True,
                            "data": {
                                "content": content,
                                "content_type": "text/html",
                            },
                        }
                    )
                },
            )(),
        )

    def _browser_open(self, *, user=None, share_id="", password=""):
        return HtmlArtifactService.load_for_browser_open(
            document_id=self.doc.id,
            block_id=self.block_id,
            user=user,
            share_id=share_id,
            password=password,
        )

    # ── 嵌入态 fileId 路径（保留）────────────────────────────────

    def test_owner_can_load_via_service(self):
        with self._patch_download():
            payload = HtmlArtifactService.load_for_document_member(
                document_id=self.doc.id,
                file_id=self.file_record.id,
                user=self.owner,
            )
        self.assertEqual(payload.content, b"<html>private</html>")
        self.assertEqual(payload.file_id, str(self.file_record.id))

    def test_outsider_denied_file_id_path(self):
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_document_member(
                document_id=self.doc.id,
                file_id=self.file_record.id,
                user=self.outsider,
            )
        self.assertEqual(ctx.exception.reason, "permission_denied")

    def test_inactive_usage_denied(self):
        FileUsage.objects.filter(file_record=self.file_record).update(is_active=False)
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_document_member(
                document_id=self.doc.id,
                file_id=self.file_record.id,
                user=self.owner,
            )
        self.assertEqual(ctx.exception.reason, "usage_mismatch")

    def test_wrong_document_usage_denied(self):
        other_doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="other",
        )
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_document_member(
                document_id=other_doc.id,
                file_id=self.file_record.id,
                user=self.owner,
            )
        self.assertEqual(ctx.exception.reason, "usage_mismatch")

    def test_org_mismatch_denied(self):
        self.file_record.organization_id = str(uuid.uuid4())
        self.file_record.save(update_fields=["organization_id"])
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_document_member(
                document_id=self.doc.id,
                file_id=self.file_record.id,
                user=self.owner,
            )
        self.assertEqual(ctx.exception.reason, "org_mismatch")

    def test_public_share_anonymous_can_load_embedded(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download():
            payload = HtmlArtifactService.load_for_share(
                share_id=share.share_id,
                file_id=self.file_record.id,
                user=None,
                password="",
            )
        self.assertEqual(payload.content, b"<html>private</html>")

    def test_password_share_requires_password_embedded(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
            password="s3cret",
        )
        with self._patch_download():
            with self.assertRaises(SharePasswordRequiredError):
                HtmlArtifactService.load_for_share(
                    share_id=share.share_id,
                    file_id=self.file_record.id,
                    user=None,
                    password="",
                )
            payload = HtmlArtifactService.load_for_share(
                share_id=share.share_id,
                file_id=self.file_record.id,
                user=None,
                password="s3cret",
            )
        self.assertEqual(payload.content, b"<html>private</html>")

    def test_organization_share_member_ok_outsider_denied_embedded(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        with self._patch_download():
            payload = HtmlArtifactService.load_for_share(
                share_id=share.share_id,
                file_id=self.file_record.id,
                user=self.member,
            )
            self.assertEqual(payload.content, b"<html>private</html>")
            with self.assertRaises(SharePermissionDeniedError):
                HtmlArtifactService.load_for_share(
                    share_id=share.share_id,
                    file_id=self.file_record.id,
                    user=self.outsider,
                )

    def test_public_to_organization_narrow_invalidates_old_share_id_embedded(self):
        public_share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        old_share_id = public_share.share_id
        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        with self._patch_download(), self.assertRaises(ShareNotFoundError):
            HtmlArtifactService.load_for_share(
                share_id=old_share_id,
                file_id=self.file_record.id,
                user=None,
            )

    def test_expired_share_denied_embedded(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        DocumentShare.objects.using(TABDOC_DB).filter(id=share.id).update(
            expire_at=timezone.now() - timedelta(hours=1),
        )
        with self._patch_download(), self.assertRaises(ShareExpiredError):
            HtmlArtifactService.load_for_share(
                share_id=share.share_id,
                file_id=self.file_record.id,
                user=None,
            )

    def test_response_headers_are_private_no_store(self):
        from apps.tabdoc.services.html_artifact_service import HtmlArtifactPayload

        response = build_html_artifact_response(
            HtmlArtifactPayload(
                content=b"<html>x</html>",
                content_type="text/html; charset=utf-8",
                file_id="f1",
                file_name="x.html",
            )
        )
        self.assertEqual(response["Cache-Control"], "private, no-store")
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        self.assertEqual(response["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox allow-scripts", response["Content-Security-Policy"])
        self.assertTrue(getattr(response, "xframe_options_exempt", False))

    def test_member_view_returns_html_bytes(self):
        request = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-artifacts/{self.file_record.id}"
        )
        request.auth = self.owner
        with self._patch_download(b"<html>view</html>"):
            response = get_document_html_artifact(request, self.doc.id, self.file_record.id)
        body, status = _extract(response)
        self.assertEqual(status, 200)
        self.assertIsInstance(body, HttpResponse)
        self.assertEqual(body.content, b"<html>view</html>")
        self.assertEqual(body["Cache-Control"], "private, no-store")

    def test_member_view_hides_existence_from_outsider(self):
        request = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-artifacts/{self.file_record.id}"
        )
        request.auth = self.outsider
        with self._patch_download():
            response = get_document_html_artifact(request, self.doc.id, self.file_record.id)
        payload, status = _extract(response)
        self.assertEqual(status, 404)
        self.assertIsInstance(payload, dict)

    def test_share_view_password_in_body(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
            password="pw",
        )
        request = self.factory.post(
            f"/api/tabdoc/shared/{share.share_id}/html-artifacts/{self.file_record.id}",
            data=json.dumps({"password": "pw"}),
            content_type="application/json",
        )
        request.auth = None
        data = SharedHtmlArtifactRequest(password="pw")
        with self._patch_download(b"<html>shared</html>"):
            response = get_shared_html_artifact(
                request, share.share_id, self.file_record.id, data
            )
        body, status = _extract(response)
        self.assertEqual(status, 200)
        self.assertEqual(body.content, b"<html>shared</html>")

    # ── 双通道：未分享 ────────────────────────────────────────────

    def test_browser_unshared_owner_and_viewer_ok_outsider_denied(self):
        with self._patch_download(b"<html>acl</html>"):
            for user in (self.owner, self.doc_viewer, self.doc_editor):
                payload = self._browser_open(user=user)
                self.assertEqual(payload.content, b"<html>acl</html>")
            with self.assertRaises(HtmlArtifactAccessError) as ctx:
                self._browser_open(user=self.outsider)
            self.assertEqual(ctx.exception.reason, "permission_denied")
            # 组织成员但无文档 ACL、又无 share → 拒绝
            with self.assertRaises(HtmlArtifactAccessError) as ctx2:
                self._browser_open(user=self.member)
            self.assertEqual(ctx2.exception.reason, "permission_denied")
            with self.assertRaises(HtmlArtifactAccessError):
                self._browser_open(user=None)

    # ── 双通道：organization share ────────────────────────────────

    def test_browser_organization_share_matrix(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        with self._patch_download(b"<html>org</html>"):
            payload = self._browser_open(user=self.member, share_id=share.share_id)
            self.assertEqual(payload.content, b"<html>org</html>")
            with self.assertRaises(SharePermissionDeniedError):
                self._browser_open(user=None, share_id=share.share_id)
            with self.assertRaises(SharePermissionDeniedError):
                self._browser_open(user=self.outsider, share_id=share.share_id)

    # ── 双通道：public / password ─────────────────────────────────

    def test_browser_public_anonymous_ok(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download(b"<html>pub</html>"):
            payload = self._browser_open(user=None, share_id=share.share_id)
        self.assertEqual(payload.content, b"<html>pub</html>")

    def test_browser_password_share_matrix(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
            password="s3cret",
        )
        with self._patch_download(b"<html>pw</html>"):
            with self.assertRaises(SharePasswordRequiredError):
                self._browser_open(user=None, share_id=share.share_id, password="")
            payload = self._browser_open(
                user=None, share_id=share.share_id, password="s3cret"
            )
        self.assertEqual(payload.content, b"<html>pw</html>")

    # ── 关闭 / 过期 / 收窄 / refresh：旧链失效，成员仍可 ──────────

    def test_browser_closed_share_rejects_outsider_member_still_ok(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        old_share_id = share.share_id
        DocumentShare.objects.using(TABDOC_DB).filter(id=share.id).update(is_active=False)
        with self._patch_download(b"<html>closed</html>"):
            with self.assertRaises(ShareNotFoundError):
                self._browser_open(user=None, share_id=old_share_id)
            # 成员 ACL 优先：带失效旧 share 仍可开
            payload = self._browser_open(user=self.owner, share_id=old_share_id)
            self.assertEqual(payload.content, b"<html>closed</html>")
            payload2 = self._browser_open(user=self.doc_viewer)
            self.assertEqual(payload2.content, b"<html>closed</html>")

    def test_browser_expired_share_rejects_outsider_member_still_ok(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        DocumentShare.objects.using(TABDOC_DB).filter(id=share.id).update(
            expire_at=timezone.now() - timedelta(hours=1),
        )
        with self._patch_download(b"<html>exp</html>"):
            with self.assertRaises(ShareExpiredError):
                self._browser_open(user=None, share_id=share.share_id)
            payload = self._browser_open(user=self.doc_editor, share_id=share.share_id)
            self.assertEqual(payload.content, b"<html>exp</html>")

    def test_browser_narrow_and_refresh_invalidate_old_share(self):
        public_share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        old_public_id = public_share.share_id
        org_share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        with self._patch_download(b"<html>narrow</html>"):
            with self.assertRaises(ShareNotFoundError):
                self._browser_open(user=None, share_id=old_public_id)
            # org 成员带新 share 可开；匿名不可
            payload = self._browser_open(user=self.member, share_id=org_share.share_id)
            self.assertEqual(payload.content, b"<html>narrow</html>")

        before_refresh = org_share.share_id
        refreshed = DocumentShareService.refresh_share_id(self.doc, "organization")
        self.assertIsNotNone(refreshed)
        self.assertNotEqual(refreshed.share_id, before_refresh)
        with self._patch_download(b"<html>refresh</html>"):
            with self.assertRaises(ShareNotFoundError):
                self._browser_open(user=self.member, share_id=before_refresh)
            payload = self._browser_open(
                user=self.member, share_id=refreshed.share_id
            )
            self.assertEqual(payload.content, b"<html>refresh</html>")
            # 文档成员不带 share 仍可
            payload_member = self._browser_open(user=self.owner, share_id=before_refresh)
            self.assertEqual(payload_member.content, b"<html>refresh</html>")

    def test_browser_cross_document_share_id_rejected(self):
        other_doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="other-doc",
        )
        other_share = DocumentShareService.create_or_update_share_exclusive(
            other_doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download(), self.assertRaises(ShareNotFoundError):
            self._browser_open(user=None, share_id=other_share.share_id)

    def test_browser_deleted_block_fail_closed(self):
        self.doc.description_json = {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"blockId": "para-1"},
                    "content": [{"type": "text", "text": "gone"}],
                }
            ],
        }
        self.doc.save(update_fields=["description_json"])
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            self._browser_open(user=self.owner, share_id=share.share_id)
        self.assertEqual(ctx.exception.reason, "block_missing")

    def test_browser_follows_block_after_file_rotation(self):
        """换 fileId 后浏览地址仍解析该块最新内容。"""
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        new_file = self._make_file_record(organization_id=str(self.organization.id))
        FileUsage.add_usage(
            new_file,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )
        self.doc.description_json = {
            "type": "doc",
            "content": [
                {
                    "type": "htmlBlock",
                    "attrs": {
                        "blockId": self.block_id,
                        "fileId": str(new_file.id),
                        "src": "",
                        "title": "chart",
                        "height": 360,
                    },
                }
            ],
        }
        self.doc.save(update_fields=["description_json"])
        with self._patch_download(b"<html>rotated</html>"):
            payload = self._browser_open(user=None, share_id=share.share_id)
        self.assertEqual(payload.content, b"<html>rotated</html>")
        self.assertEqual(payload.file_id, str(new_file.id))

    # ── browser-link API ─────────────────────────────────────────

    def test_browser_link_viewer_gets_null_share_when_unshared(self):
        req = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser-link"
        )
        req.auth = self.doc_viewer
        body, status = _extract(
            get_html_block_browser_link(req, self.doc.id, self.block_id)
        )
        self.assertEqual(status, 200)
        data = body.get("data") if isinstance(body.get("data"), dict) else body
        self.assertEqual(data["document_id"], str(self.doc.id))
        self.assertEqual(data["block_id"], self.block_id)
        self.assertIsNone(data["share_id"])

    def test_browser_link_returns_effective_share_id(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        req = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser-link"
        )
        req.auth = self.owner
        body, status = _extract(
            get_html_block_browser_link(req, self.doc.id, self.block_id)
        )
        self.assertEqual(status, 200)
        data = body.get("data") if isinstance(body.get("data"), dict) else body
        self.assertEqual(data["share_id"], share.share_id)

    def test_browser_link_missing_block_404(self):
        req = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/missing-block/browser-link"
        )
        req.auth = self.owner
        body, status = _extract(
            get_html_block_browser_link(req, self.doc.id, "missing-block")
        )
        self.assertEqual(status, 404)
        self.assertIsInstance(body, dict)

    def test_browser_link_client_file_id_hint_for_unsynced_block(self):
        """协作未落库：成员带 file_id hint 仍可拿 browser-link。"""
        unsynced_block = str(uuid.uuid4())
        pending = self._make_file_record(organization_id=str(self.organization.id))
        FileUsage.add_usage(
            pending,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )
        req = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{unsynced_block}/browser-link"
            f"?file_id={pending.id}"
        )
        req.auth = self.owner
        body, status = _extract(
            get_html_block_browser_link(
                req, self.doc.id, unsynced_block, file_id=str(pending.id)
            )
        )
        self.assertEqual(status, 200)
        data = body.get("data") if isinstance(body.get("data"), dict) else body
        self.assertEqual(data["block_id"], unsynced_block)
        self.assertEqual(data.get("file_id_hint"), str(pending.id))

    def test_browser_open_client_file_id_hint_for_member(self):
        unsynced_block = str(uuid.uuid4())
        pending = self._make_file_record(organization_id=str(self.organization.id))
        FileUsage.add_usage(
            pending,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )
        with self._patch_download(b"<html>unsynced</html>"):
            payload = HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id=unsynced_block,
                user=self.owner,
                client_file_id=str(pending.id),
            )
        self.assertEqual(payload.content, b"<html>unsynced</html>")
        self.assertEqual(payload.file_id, str(pending.id))

    def test_browser_open_share_allows_bound_client_file_id_hint(self):
        """#7892：外链在 DocumentShare + FileUsage 绑定下可用 file_id 兜底未落库块。"""
        unsynced_block = str(uuid.uuid4())
        pending = self._make_file_record(organization_id=str(self.organization.id))
        FileUsage.add_usage(
            pending,
            self.owner.id,
            module="tabdoc",
            context_type="document",
            context_id=str(self.doc.id),
        )
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download(b"<html>share-unsynced</html>"):
            payload = HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id=unsynced_block,
                user=None,
                share_id=share.share_id,
                client_file_id=str(pending.id),
            )
        self.assertEqual(payload.content, b"<html>share-unsynced</html>")
        self.assertEqual(payload.file_id, str(pending.id))

    def test_browser_open_share_rejects_unbound_client_file_id_hint(self):
        """外链不得靠无 FileUsage 绑定的随机 file_id 猜文件。"""
        unsynced_block = str(uuid.uuid4())
        unbound = self._make_file_record(organization_id=str(self.organization.id))
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id=unsynced_block,
                user=None,
                share_id=share.share_id,
                client_file_id=str(unbound.id),
            )
        self.assertEqual(ctx.exception.reason, "block_missing")

    def test_browser_link_outsider_denied(self):
        req = self.factory.get(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser-link"
        )
        req.auth = self.outsider
        body, status = _extract(
            get_html_block_browser_link(req, self.doc.id, self.block_id)
        )
        self.assertEqual(status, 404)

    def test_browser_open_api_public_and_password(self):
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
            password="pw",
        )
        req = self.factory.post(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser",
            data=json.dumps({"share_id": share.share_id, "password": "pw"}),
            content_type="application/json",
        )
        req.auth = None
        data = HtmlBlockBrowserOpenRequest(share_id=share.share_id, password="pw")
        with self._patch_download(b"<html>api</html>"):
            response = open_html_block_in_browser(
                req, self.doc.id, self.block_id, data
            )
        body, status = _extract(response)
        self.assertEqual(status, 200)
        self.assertEqual(body.content, b"<html>api</html>")

    def test_browser_open_api_unshared_anonymous_asks_login(self):
        """未分享 + 匿名 → 403 Need login（前端引导登录，非「分享已关闭」404）。"""
        req = self.factory.post(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser",
            data=json.dumps({"share_id": "", "password": ""}),
            content_type="application/json",
        )
        req.auth = None
        data = HtmlBlockBrowserOpenRequest(share_id="", password="")
        with self._patch_download():
            response = open_html_block_in_browser(
                req, self.doc.id, self.block_id, data
            )
        _body, status = _extract(response)
        self.assertEqual(status, 403)

    def test_browser_open_api_unshared_outsider_forbidden(self):
        req = self.factory.post(
            f"/api/tabdoc/documents/{self.doc.id}/html-blocks/{self.block_id}/browser",
            data=json.dumps({"share_id": "", "password": ""}),
            content_type="application/json",
        )
        req.auth = self.outsider
        data = HtmlBlockBrowserOpenRequest(share_id="", password="")
        with self._patch_download():
            response = open_html_block_in_browser(
                req, self.doc.id, self.block_id, data
            )
        _body, status = _extract(response)
        self.assertEqual(status, 403)

    def test_collect_html_block_file_ids_skips_position_aliases(self):
        mapping = collect_html_block_file_ids(
            {
                "type": "doc",
                "content": [
                    {
                        "type": "htmlBlock",
                        "attrs": {"fileId": str(self.file_record.id), "title": "orphan"},
                    },
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            "blockId": "auto_1",
                            "fileId": str(uuid.uuid4()),
                            "title": "alias",
                        },
                    },
                    {
                        "type": "htmlBlock",
                        "attrs": {
                            "blockId": self.block_id,
                            "fileId": str(self.file_record.id),
                            "title": "stable",
                        },
                    },
                ],
            }
        )
        self.assertEqual(mapping, {self.block_id: str(self.file_record.id)})

    def test_browser_rejects_position_alias_block_id(self):
        with self._patch_download(), self.assertRaises(HtmlArtifactAccessError) as ctx:
            HtmlArtifactService.load_for_browser_open(
                document_id=self.doc.id,
                block_id="auto_0",
                user=self.owner,
            )
        self.assertEqual(ctx.exception.reason, "block_missing")

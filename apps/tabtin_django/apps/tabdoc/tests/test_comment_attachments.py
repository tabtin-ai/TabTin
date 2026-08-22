"""TabDoc 私有评论图片附件接口测试。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import Mock, patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.tabdoc.api import (
    confirm_document_comment_attachment_upload,
    create_document_comment_attachment_upload,
    create_document_comment_thread,
    create_document_comment_message,
    preview_document_comment_attachment,
)
from apps.tabdoc.api_share import (
    confirm_shared_comment_attachment_upload,
    create_shared_comment_attachment_upload,
    create_shared_comment_thread,
    preview_shared_comment_attachment,
)
from apps.services.oss.models import FileRecord, FileUsage
from apps.tabdoc.models import (
    CommentAttachment,
    CommentMessage,
    CommentThread,
    Document,
    DocumentShare,
)
from apps.tabdoc.schemas import (
    CommentAttachmentConfirmRequest,
    CommentAttachmentPreviewRequest,
    CommentAttachmentUploadRequest,
    CommentMessageCreateRequest,
    CommentThreadCreateRequest,
)
from apps.tabdoc.services.share_service import TABDOC_DB
from apps.tabdoc.tasks import cleanup_orphan_comment_attachments
from apps.tabtinspace.models import Organization


User = get_user_model()


def _extract(response):
    if isinstance(response, JsonResponse):
        return json.loads(response.content.decode("utf-8")), response.status_code
    if isinstance(response, dict):
        return response, 200
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        return body, status
    raise AssertionError(f"unexpected view response type: {type(response).__name__}")


class DocumentCommentAttachmentTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.signals import create_user_profile, save_user_profile

        for handler in (create_default_organization, create_user_profile, save_user_profile):
            post_save.disconnect(handler, sender=User)

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"comment_attachment_owner_{uuid.uuid4().hex[:8]}",
            email=f"comment_attachment_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.using(TABDOC_DB).create(
            name="Comment Attachment Organization",
            owner_id=self.owner.id,
        )
        self.document = Document.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            space_id=uuid.uuid4(),
            owner_id=self.owner.id,
            title="附件文档",
            description_json={"type": "doc", "content": []},
        )
        self.comment_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.comment_share.set_password("attachment-secret")
        self.comment_share.save(update_fields=["password_hash"])
        self.oss = Mock()
        self.oss.config = {"bucket_name": "private-comment-test"}
        self.oss.generate_presigned_url.side_effect = (
            lambda object_key, expiration=300, method="GET", **kwargs:
            "https://oss.example.test/private-upload"
            if method == "PUT"
            else "https://oss.example.test/private-preview"
        )
        self.oss.file_exists.return_value = True
        self.oss.get_file_info.return_value = {
            "success": True,
            "data": {"content_length": 1024, "content_type": "image/png"},
        }
        self.oss.set_object_private.return_value = True
        self.oss.build_access_url.return_value = "https://oss.example.test/permanent-access"
        self.oss.build_cdn_url.return_value = "https://cdn.example.test/permanent-cdn"

    def _request(self, method: str, path: str, body: dict | None = None):
        if method == "get":
            request = self.factory.get(path, data=body or {})
        else:
            request = getattr(self.factory, method)(
                path,
                data=json.dumps(body or {}),
                content_type="application/json",
            )
        request.auth = self.owner
        return request

    def _make_confirmed_file(self, *, user=None, document=None, **overrides) -> FileRecord:
        document = document or self.document
        user = user or self.owner
        file_id = uuid.uuid4()
        values = {
            "file_name": "confirmed.png",
            "file_key": f"tabdoc/comment-attachments/{document.id}/{file_id}.png",
            "file_path": f"tabdoc/comment-attachments/{document.id}",
            "file_size": 1024,
            "file_type": "image",
            "mime_type": "image/png",
            "file_extension": "png",
            "file_hash": file_id.hex,
            "bucket_name": "private-comment-test",
            "status": "completed",
            "organization_id": str(document.organization_id),
            "upload_user": str(user.id),
            "is_public": False,
            "metadata": {
                "comment_attachment": True,
                "module": "tabdoc",
                "context_type": "comment_attachment",
                "context_id": str(document.id),
            },
        }
        values.update(overrides)
        return FileRecord.objects.using(TABDOC_DB).create(**values)

    @patch("apps.services.oss.services.factory.get_oss_service")
    @patch("apps.tabdoc.services.comment_attachment_service.get_oss_service")
    def test_document_private_upload_confirm_bind_and_preview(self, get_attachment_oss, get_registry_oss):
        get_attachment_oss.return_value = self.oss
        get_registry_oss.return_value = self.oss
        upload_body = {
            "file_name": "evidence.png",
            "content_type": "image/png",
            "file_size": 1024,
        }

        issued, status = _extract(create_document_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-attachments/presign-upload",
                upload_body,
            ),
            str(self.document.id),
            CommentAttachmentUploadRequest(**upload_body),
        ))

        self.assertEqual(status, 200)
        credential = issued["data"]
        self.assertEqual(credential["method"], "PUT")
        self.assertEqual(credential["upload_url"], "https://oss.example.test/private-upload")
        self.assertEqual(credential["headers"], {"Content-Type": "image/png"})
        self.assertNotIn("object_key", credential)

        confirm_body = {"upload_token": credential["upload_token"]}
        confirmed, status = _extract(confirm_document_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-attachments/confirm-upload",
                confirm_body,
            ),
            str(self.document.id),
            CommentAttachmentConfirmRequest(**confirm_body),
        ))
        self.assertEqual(status, 200)
        file_data = confirmed["data"]["attachment"]
        self.assertEqual(file_data["metadata"]["mime_type"], "image/png")
        self.assertNotIn("access_url", file_data)
        self.assertNotIn("cdn_url", file_data)
        self.assertNotIn("object_key", file_data)

        thread_body = {"attachment_ids": [file_data["file_id"]]}
        created, status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                thread_body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**thread_body),
        ))
        self.assertEqual(status, 200)
        attachment = created["data"]["thread"]["messages"][0]["attachments"][0]
        self.assertEqual(attachment["file_id"], file_data["file_id"])
        self.assertEqual(
            attachment["preview_url"],
            f"/api/tabdoc/documents/{self.document.id}/comment-attachments/{file_data['file_id']}/preview",
        )
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 1)

        previewed, status = _extract(preview_document_comment_attachment(
            self._request(
                "get",
                f"/tabdoc/documents/{self.document.id}/comment-attachments/{file_data['file_id']}/preview",
            ),
            str(self.document.id),
            file_data["file_id"],
        ))
        self.assertEqual(status, 200)
        self.assertEqual(previewed["data"]["preview_url"], "https://oss.example.test/private-preview")
        self.assertEqual(previewed["data"]["expires_in"], 300)

    @patch("apps.services.oss.services.factory.get_oss_service")
    @patch("apps.tabdoc.services.comment_attachment_service.get_oss_service")
    def test_share_upload_confirm_and_preview_reuse_comment_permission_gate(
        self,
        get_attachment_oss,
        get_registry_oss,
    ):
        get_attachment_oss.return_value = self.oss
        get_registry_oss.return_value = self.oss
        upload_body = {
            "password": "attachment-secret",
            "file_name": "shared.png",
            "content_type": "image/png",
            "file_size": 1024,
        }

        issued, status = _extract(create_shared_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/presign-upload",
                upload_body,
            ),
            self.comment_share.share_id,
            CommentAttachmentUploadRequest(**upload_body),
        ))
        self.assertEqual(status, 200)

        confirm_body = {
            "password": "attachment-secret",
            "upload_token": issued["data"]["upload_token"],
        }
        confirmed, status = _extract(confirm_shared_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/confirm-upload",
                confirm_body,
            ),
            self.comment_share.share_id,
            CommentAttachmentConfirmRequest(**confirm_body),
        ))
        self.assertEqual(status, 200)
        file_id = confirmed["data"]["attachment"]["file_id"]

        thread_body = {
            "password": "attachment-secret",
            "attachment_ids": [file_id],
        }
        created, status = _extract(create_shared_comment_thread(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads",
                thread_body,
            ),
            self.comment_share.share_id,
            CommentThreadCreateRequest(**thread_body),
        ))
        self.assertEqual(status, 200)
        attachment = created["data"]["thread"]["messages"][0]["attachments"][0]
        self.assertEqual(
            attachment["preview_url"],
            f"/api/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/{file_id}/preview",
        )

        preview_body = {"password": "attachment-secret"}
        previewed, status = _extract(preview_shared_comment_attachment(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/{file_id}/preview",
                preview_body,
            ),
            self.comment_share.share_id,
            file_id,
            CommentAttachmentPreviewRequest(**preview_body),
        ))
        self.assertEqual(status, 200)
        self.assertEqual(previewed["data"]["expires_in"], 300)

        denied, status = _extract(preview_shared_comment_attachment(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/{file_id}/preview",
                {"password": "wrong"},
            ),
            self.comment_share.share_id,
            file_id,
            CommentAttachmentPreviewRequest(password="wrong"),
        ))
        self.assertEqual(status, 403)
        self.assertNotIn("preview_url", denied.get("data") or {})

        self.comment_share.permission = "view"
        self.comment_share.save(update_fields=["permission"])
        _, status = _extract(preview_shared_comment_attachment(
            self._request(
                "post",
                f"/tabdoc/shared/{self.comment_share.share_id}/comment-attachments/{file_id}/preview",
                preview_body,
            ),
            self.comment_share.share_id,
            file_id,
            CommentAttachmentPreviewRequest(**preview_body),
        ))
        self.assertEqual(status, 403)

    def test_confirmed_attachment_can_bind_only_once_without_half_reply(self):
        file_record = self._make_confirmed_file()
        root_body = {"attachment_ids": [str(file_record.id)]}
        created, status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                root_body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**root_body),
        ))
        self.assertEqual(status, 200)
        thread_id = created["data"]["thread"]["id"]

        reply_body = {"attachment_ids": [str(file_record.id)]}
        rejected, status = _extract(create_document_comment_message(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/messages",
                reply_body,
            ),
            str(self.document.id),
            thread_id,
            CommentMessageCreateRequest(**reply_body),
        ))

        self.assertEqual(status, 400)
        self.assertIn("已绑定", rejected["data"]["detail"])
        self.assertEqual(CommentThread.objects.using(TABDOC_DB).count(), 1)
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 1)
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 1)

    def test_client_request_id_retries_return_original_thread_and_reply(self):
        root_file = self._make_confirmed_file()
        root_body = {
            "attachment_ids": [str(root_file.id)],
            "client_request_id": f"root-{uuid.uuid4()}",
        }

        first, first_status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                root_body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**root_body),
        ))
        retried, retry_status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                root_body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**root_body),
        ))

        self.assertEqual((first_status, retry_status), (200, 200))
        self.assertEqual(first["data"]["thread"]["id"], retried["data"]["thread"]["id"])
        self.assertEqual(CommentThread.objects.using(TABDOC_DB).count(), 1)
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 1)
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 1)

        reply_file = self._make_confirmed_file()
        reply_body = {
            "attachment_ids": [str(reply_file.id)],
            "client_request_id": f"reply-{uuid.uuid4()}",
        }
        thread_id = first["data"]["thread"]["id"]
        reply_responses = []
        for _ in range(2):
            reply_responses.append(_extract(create_document_comment_message(
                self._request(
                    "post",
                    f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/messages",
                    reply_body,
                ),
                str(self.document.id),
                thread_id,
                CommentMessageCreateRequest(**reply_body),
            )))

        self.assertEqual([status for _, status in reply_responses], [200, 200])
        self.assertEqual(
            reply_responses[0][0]["data"]["message"]["id"],
            reply_responses[1][0]["data"]["message"]["id"],
        )
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 2)
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 2)

    @patch("apps.tabdoc.services.comment_attachment_service.get_oss_service")
    def test_confirm_rejects_spoofed_actual_mime_and_deletes_unregistered_object(
        self,
        get_attachment_oss,
    ):
        get_attachment_oss.return_value = self.oss
        upload_body = {
            "file_name": "spoofed.png",
            "content_type": "image/png",
            "file_size": 1024,
        }
        issued, status = _extract(create_document_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-attachments/presign-upload",
                upload_body,
            ),
            str(self.document.id),
            CommentAttachmentUploadRequest(**upload_body),
        ))
        self.assertEqual(status, 200)
        self.oss.get_file_info.return_value = {
            "success": True,
            "data": {"content_length": 1024, "content_type": "text/html"},
        }
        confirm_body = {"upload_token": issued["data"]["upload_token"]}

        rejected, status = _extract(confirm_document_comment_attachment_upload(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-attachments/confirm-upload",
                confirm_body,
            ),
            str(self.document.id),
            CommentAttachmentConfirmRequest(**confirm_body),
        ))

        self.assertEqual(status, 400)
        self.assertIn("安全图片", rejected["data"]["detail"])
        self.assertEqual(FileRecord.objects.using(TABDOC_DB).count(), 0)
        self.oss.delete_file.assert_called_once()

    @patch("apps.tabdoc.services.comment_attachment_service.get_oss_service")
    def test_upload_credential_rejects_non_image_and_image_preset_oversize(
        self,
        get_attachment_oss,
    ):
        get_attachment_oss.return_value = self.oss
        max_image_size = settings.OSS_UPLOAD_PRESETS["IMAGE"]["maxSize"]
        invalid_requests = [
            {
                "file_name": "notes.txt",
                "content_type": "text/plain",
                "file_size": 1024,
            },
            {
                "file_name": "huge.png",
                "content_type": "image/png",
                "file_size": max_image_size + 1,
            },
        ]

        for body in invalid_requests:
            with self.subTest(body=body):
                rejected, status = _extract(create_document_comment_attachment_upload(
                    self._request(
                        "post",
                        f"/tabdoc/documents/{self.document.id}/comment-attachments/presign-upload",
                        body,
                    ),
                    str(self.document.id),
                    CommentAttachmentUploadRequest(**body),
                ))
                self.assertEqual(status, 400)
                self.assertEqual(rejected["code"], "VALIDATION_ERROR")

        self.oss.generate_presigned_url.assert_not_called()

    def test_attachment_uploaded_by_another_user_cannot_create_half_thread(self):
        other_user = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"attachment_other_{uuid.uuid4().hex[:8]}",
            email=f"attachment_other_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        foreign_upload = self._make_confirmed_file(user=other_user)
        body = {"attachment_ids": [str(foreign_upload.id)]}

        rejected, status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**body),
        ))

        self.assertEqual(status, 400)
        self.assertEqual(rejected["code"], "VALIDATION_ERROR")
        self.assertEqual(CommentThread.objects.using(TABDOC_DB).count(), 0)
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 0)
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 0)

    def test_thread_accepts_exactly_nine_confirmed_images(self):
        file_ids = [str(self._make_confirmed_file().id) for _ in range(9)]
        body = {"attachment_ids": file_ids}

        created, status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**body),
        ))

        self.assertEqual(status, 200)
        self.assertCountEqual(
            [item["file_id"] for item in created["data"]["thread"]["messages"][0]["attachments"]],
            file_ids,
        )
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 9)

    @patch("apps.tabdoc.services.comment_attachment_service.get_oss_service")
    def test_cleanup_removes_only_unbound_comment_uploads_older_than_24_hours(
        self,
        get_attachment_oss,
    ):
        get_attachment_oss.return_value = self.oss
        self.oss.delete_file.return_value = {"success": True}
        old_orphan = self._make_confirmed_file()
        fresh_orphan = self._make_confirmed_file()
        bound_old = self._make_confirmed_file()
        for record in (old_orphan, fresh_orphan, bound_old):
            FileUsage.add_usage(
                file_record=record,
                user_id=self.owner.id,
                module="tabdoc",
                context_type="comment_attachment",
                context_id=str(self.document.id),
            )
        old_time = timezone.now() - timedelta(hours=25)
        FileRecord.objects.using(TABDOC_DB).filter(
            id__in=[old_orphan.id, bound_old.id],
        ).update(created_at=old_time, updated_at=old_time)

        bind_body = {"attachment_ids": [str(bound_old.id)]}
        _, status = _extract(create_document_comment_thread(
            self._request(
                "post",
                f"/tabdoc/documents/{self.document.id}/comment-threads",
                bind_body,
            ),
            str(self.document.id),
            CommentThreadCreateRequest(**bind_body),
        ))
        self.assertEqual(status, 200)

        result = cleanup_orphan_comment_attachments.run()

        old_orphan.refresh_from_db()
        fresh_orphan.refresh_from_db()
        bound_old.refresh_from_db()
        self.assertEqual(result, {"deleted_count": 1, "skipped_count": 0})
        self.assertEqual(old_orphan.status, "deleted")
        self.assertEqual(fresh_orphan.status, "completed")
        self.assertEqual(bound_old.status, "completed")
        self.assertFalse(
            FileUsage.objects.using(TABDOC_DB).get(file_record=old_orphan).is_active
        )
        self.oss.delete_file.assert_called_once_with(old_orphan.file_key)

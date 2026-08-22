"""TabDoc 评论线程接口的 PostgreSQL 集成测试。"""

from __future__ import annotations

import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connections
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase, TransactionTestCase
from pydantic import ValidationError as PydanticValidationError

from apps.services.oss.models import FileRecord

from apps.tabdoc.api import (
    DocumentCommentCreateRequest,
    create_document_comment,
    create_document_comment_message,
    create_document_comment_thread,
    delete_document_comment,
    delete_document_comment_thread,
    delete_document_comment_message,
    list_document_comment_threads,
    reanchor_document_comment_thread,
    update_document_comment_thread_status,
)
from apps.tabdoc.api_share import (
    create_shared_comment_message,
    create_shared_comment_thread,
    delete_shared_comment_message,
    list_shared_comment_threads,
    reanchor_shared_comment_thread,
    update_shared_comment_thread_status,
)
from apps.tabdoc.models import (
    CommentAttachment,
    CommentMessage,
    CommentThread,
    Document,
    DocumentPermission,
    DocumentShare,
    DocumentShareComment,
)
from apps.tabdoc.schemas import (
    CommentMessageCreateRequest,
    CommentThreadAnchorRequest,
    CommentThreadCreateRequest,
    CommentThreadStatusRequest,
)
from apps.tabdoc.services.share_service import TABDOC_DB
from apps.tabdoc.services.comment_service import DocumentCommentService
from apps.tabtinspace.models import Organization, OrganizationMember

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


class DocumentCommentThreadTests(TestCase):
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
            username=f"thread_owner_{uuid.uuid4().hex[:8]}",
            email=f"thread_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.using(TABDOC_DB).create(
            name="Comment Thread Organization",
            owner_id=self.owner.id,
        )
        self.document = Document.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            space_id=uuid.uuid4(),
            owner_id=self.owner.id,
            title="线程文档",
            description_json={"type": "doc", "content": []},
        )
        self.comment_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.comment_share.set_password("thread-secret")
        self.comment_share.save(update_fields=["password_hash"])

    def _post_thread(self, body: dict, *, user=None):
        request = self.factory.post(
            f"/tabdoc/documents/{self.document.id}/comment-threads",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return create_document_comment_thread(
            request,
            str(self.document.id),
            CommentThreadCreateRequest(**body),
        )

    def _get_threads(self, *, user=None):
        request = self.factory.get(
            f"/tabdoc/documents/{self.document.id}/comment-threads"
        )
        request.auth = user
        return list_document_comment_threads(request, str(self.document.id))

    def _post_legacy_comment(self, body: dict, *, user=None):
        request = self.factory.post(
            f"/tabdoc/documents/{self.document.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return create_document_comment(
            request,
            str(self.document.id),
            DocumentCommentCreateRequest(**body),
        )

    def _delete_legacy_comment(self, comment_id: str, *, user=None):
        request = self.factory.delete(
            f"/tabdoc/documents/{self.document.id}/comments/{comment_id}"
        )
        request.auth = user
        return delete_document_comment(
            request,
            str(self.document.id),
            comment_id,
        )

    def _post_reply(self, thread_id: str, body: dict, *, user=None):
        request = self.factory.post(
            f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/messages",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return create_document_comment_message(
            request,
            str(self.document.id),
            thread_id,
            CommentMessageCreateRequest(**body),
        )

    def _patch_status(self, thread_id: str, status_value: str, *, user=None):
        request = self.factory.patch(
            f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/status",
            data=json.dumps({"status": status_value}),
            content_type="application/json",
        )
        request.auth = user
        return update_document_comment_thread_status(
            request,
            str(self.document.id),
            thread_id,
            CommentThreadStatusRequest(status=status_value),
        )

    def _patch_anchor(self, thread_id: str, body: dict, *, user=None):
        request = self.factory.patch(
            f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/anchor",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return reanchor_document_comment_thread(
            request,
            str(self.document.id),
            thread_id,
            CommentThreadAnchorRequest(**body),
        )

    def _delete_message(self, thread_id: str, message_id: str, *, user=None):
        request = self.factory.delete(
            f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}/messages/{message_id}"
        )
        request.auth = user
        return delete_document_comment_message(
            request,
            str(self.document.id),
            thread_id,
            message_id,
        )

    def _delete_thread(self, thread_id: str, *, user=None):
        request = self.factory.delete(
            f"/tabdoc/documents/{self.document.id}/comment-threads/{thread_id}"
        )
        request.auth = user
        return delete_document_comment_thread(
            request,
            str(self.document.id),
            thread_id,
        )

    def _post_shared_thread(self, body: dict, *, user=None):
        request = self.factory.post(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return create_shared_comment_thread(
            request,
            self.comment_share.share_id,
            CommentThreadCreateRequest(**body),
        )

    def _post_shared_reply(self, thread_id: str, body: dict, *, user=None):
        request = self.factory.post(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads/{thread_id}/messages",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return create_shared_comment_message(
            request,
            self.comment_share.share_id,
            thread_id,
            CommentMessageCreateRequest(**body),
        )

    def _get_shared_threads(self, *, password: str, user=None):
        request = self.factory.get(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads",
            data={"password": password},
        )
        request.auth = user
        return list_shared_comment_threads(
            request,
            self.comment_share.share_id,
            password=password,
        )

    def _patch_shared_status(self, thread_id: str, status_value: str, *, user=None):
        body = {"password": "thread-secret", "status": status_value}
        request = self.factory.patch(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads/{thread_id}/status",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return update_shared_comment_thread_status(
            request,
            self.comment_share.share_id,
            thread_id,
            CommentThreadStatusRequest(**body),
        )

    def _patch_shared_anchor(self, thread_id: str, body: dict, *, user=None):
        request = self.factory.patch(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads/{thread_id}/anchor",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        return reanchor_shared_comment_thread(
            request,
            self.comment_share.share_id,
            thread_id,
            CommentThreadAnchorRequest(**body),
        )

    def _delete_shared_message(self, thread_id: str, message_id: str, *, user=None):
        from apps.tabdoc.schemas import CommentMessageDeleteRequest

        request = self.factory.delete(
            f"/tabdoc/shared/{self.comment_share.share_id}/comment-threads/{thread_id}/messages/{message_id}",
            data=json.dumps({"password": "thread-secret"}),
            content_type="application/json",
        )
        request.auth = user
        return delete_shared_comment_message(
            request,
            self.comment_share.share_id,
            thread_id,
            message_id,
            CommentMessageDeleteRequest(password="thread-secret"),
        )

    def _make_file_record(
        self,
        *,
        organization_id: str | None = None,
        is_public: bool = False,
        status: str = "completed",
        metadata: dict | None = None,
    ) -> FileRecord:
        file_id = uuid.uuid4()
        record_metadata = {
            "comment_attachment": True,
            "module": "tabdoc",
            "context_type": "comment_attachment",
            "context_id": str(self.document.id),
        }
        record_metadata.update(metadata or {})
        return FileRecord.objects.using(TABDOC_DB).create(
            file_name="comment.png",
            file_key=f"tabdoc/comments/{file_id}.png",
            file_path="/tabdoc/comments/",
            file_size=128,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash=file_id.hex,
            bucket_name="test-bucket",
            status=status,
            organization_id=organization_id or str(self.organization.id),
            is_public=is_public,
            upload_user=str(self.owner.id),
            metadata=record_metadata,
        )

    def test_pure_image_thread_and_reply_bind_private_completed_file_safely(self):
        image = self._make_file_record(
            metadata={
                "width": 640,
                "height": 480,
                "secret_token": "must-not-leak",
                "storage_provider": "must-not-leak",
            }
        )

        created, status = _extract(self._post_thread(
            {"attachment_ids": [str(image.id)]},
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        thread = created["data"]["thread"]
        root = thread["messages"][0]
        self.assertEqual(root["body"], "")
        self.assertEqual(len(root["attachments"]), 1)
        self.assertEqual(root["attachments"][0]["file_id"], str(image.id))
        self.assertEqual(
            root["attachments"][0]["metadata"],
            {
                "file_name": "comment.png",
                "file_size": 128,
                "mime_type": "image/png",
                "width": 640,
                "height": 480,
            },
        )
        self.assertEqual(
            CommentAttachment.objects.using(TABDOC_DB).filter(
                message_id=root["id"],
                file_record_id=image.id,
                organization_id=self.organization.id,
            ).count(),
            1,
        )

        reply_image = self._make_file_record()
        replied, status = _extract(self._post_reply(
            thread["id"],
            {"attachment_ids": [str(reply_image.id)]},
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        reply = replied["data"]["message"]
        self.assertEqual(reply["body"], "")
        self.assertEqual(reply["attachments"][0]["file_id"], str(reply_image.id))

        _, status = _extract(self._delete_message(
            thread["id"], reply["id"], user=self.owner,
        ))
        self.assertEqual(status, 200)
        listed, status = _extract(self._get_threads(user=self.owner))
        self.assertEqual(status, 200)
        deleted_reply = next(
            message
            for message in listed["data"]["threads"][0]["messages"]
            if message["id"] == reply["id"]
        )
        self.assertTrue(deleted_reply["is_deleted"])
        self.assertEqual(deleted_reply["attachments"], [])

    def test_comment_content_requires_body_or_attachment_and_caps_attachments(self):
        rejected, status = _extract(self._post_thread({}, user=self.owner))
        self.assertEqual(status, 400)
        self.assertEqual(
            rejected["data"]["detail"],
            "评论内容和附件不能同时为空",
        )

        with self.assertRaises(PydanticValidationError):
            CommentThreadCreateRequest(
                attachment_ids=[str(uuid.uuid4()) for _ in range(10)],
            )
        with self.assertRaises(PydanticValidationError):
            CommentMessageCreateRequest(
                attachment_ids=[str(uuid.uuid4()) for _ in range(10)],
            )

        created, _ = _extract(self._post_thread({"body": "根消息"}, user=self.owner))
        rejected, status = _extract(self._post_reply(
            created["data"]["thread"]["id"],
            {},
            user=self.owner,
        ))
        self.assertEqual(status, 400)
        self.assertEqual(rejected["data"]["detail"], "评论内容和附件不能同时为空")
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 1)

    def test_comment_attachment_rejects_cross_org_public_and_uncompleted_files(self):
        invalid_files = {
            "cross_org": self._make_file_record(organization_id=str(uuid.uuid4())),
            "public": self._make_file_record(is_public=True),
            "uploading": self._make_file_record(status="uploading"),
        }

        for case_name, file_record in invalid_files.items():
            with self.subTest(case=case_name):
                rejected, status = _extract(self._post_thread(
                    {"attachment_ids": [str(file_record.id)]},
                    user=self.owner,
                ))
                self.assertEqual(status, 400)
                self.assertEqual(rejected["code"], "VALIDATION_ERROR")

        self.assertEqual(CommentThread.objects.using(TABDOC_DB).count(), 0)
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).count(), 0)
        self.assertEqual(CommentAttachment.objects.using(TABDOC_DB).count(), 0)

    def test_legacy_comment_post_keeps_required_body_error_semantics(self):
        rejected, status = _extract(self._post_legacy_comment(
            {"body": "   "},
            user=self.owner,
        ))

        self.assertEqual(status, 400)
        self.assertEqual(rejected["data"]["detail"], "评论内容不能为空")

    def test_create_thread_dual_writes_root_and_legacy_projection(self):
        created, status = _extract(self._post_thread(
            {
                "body": "这个结论需要来源",
                "scope": "text_range",
                "anchor": {"version": 2, "from": 10, "to": 18, "selected_text": "这个结论"},
            },
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        thread_payload = created["data"]["thread"]
        root_payload = thread_payload["messages"][0]
        self.assertEqual(thread_payload["scope"], "text_range")
        self.assertEqual(root_payload["body"], "这个结论需要来源")

        thread = CommentThread.objects.using(TABDOC_DB).get(id=thread_payload["id"])
        root = CommentMessage.objects.using(TABDOC_DB).get(thread=thread, kind="root")
        projection = DocumentShareComment.objects.using(TABDOC_DB).get(id=root.id)
        self.assertEqual(projection.body, root.body)

        listed, status = _extract(self._get_threads(user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(listed["data"]["capabilities"], ["comment_threads_v1"])
        self.assertEqual(listed["data"]["threads"][0]["messages"][0]["id"], str(root.id))

    def test_reply_writes_only_new_message_model(self):
        created, _ = _extract(self._post_thread({"body": "根消息"}, user=self.owner))
        thread_id = created["data"]["thread"]["id"]

        replied, status = _extract(self._post_reply(
            thread_id,
            {"body": "这是回复"},
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        reply = replied["data"]["message"]
        self.assertEqual(reply["kind"], "reply")
        self.assertEqual(reply["body"], "这是回复")
        self.assertEqual(CommentMessage.objects.using(TABDOC_DB).filter(thread_id=thread_id).count(), 2)
        self.assertEqual(DocumentShareComment.objects.using(TABDOC_DB).count(), 1)

    def test_resolve_reopen_and_reanchor_keep_status_and_anchor_state_independent(self):
        created, _ = _extract(self._post_thread(
            {
                "body": "块批注",
                "scope": "block",
                "anchor": {"version": 1, "block_id": "block-old"},
            },
            user=self.owner,
        ))
        thread_id = created["data"]["thread"]["id"]

        resolved, status = _extract(self._patch_status(thread_id, "resolved", user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(resolved["data"]["thread"]["status"], "resolved")
        self.assertEqual(resolved["data"]["thread"]["anchor_status"], "attached")

        reanchored, status = _extract(self._patch_anchor(
            thread_id,
            {"scope": "block", "anchor": {"version": 2, "block_id": "block-new"}},
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(reanchored["data"]["thread"]["status"], "resolved")
        self.assertEqual(reanchored["data"]["thread"]["anchor"]["block_id"], "block-new")

        reopened, status = _extract(self._patch_status(thread_id, "open", user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(reopened["data"]["thread"]["status"], "open")
        self.assertEqual(reopened["data"]["thread"]["anchor_status"], "attached")

    def test_message_delete_soft_deletes_reply_and_updates_root_projection(self):
        created, _ = _extract(self._post_thread({"body": "根消息"}, user=self.owner))
        thread = created["data"]["thread"]
        root_id = thread["messages"][0]["id"]
        replied, _ = _extract(self._post_reply(
            thread["id"],
            {"body": "要删除的回复"},
            user=self.owner,
        ))
        reply_id = replied["data"]["message"]["id"]

        deleted, status = _extract(self._delete_message(
            thread["id"], reply_id, user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(deleted["data"]["message_id"], reply_id)
        self.assertTrue(CommentMessage.objects.using(TABDOC_DB).get(id=reply_id).is_deleted)
        self.assertFalse(DocumentShareComment.objects.using(TABDOC_DB).get(id=root_id).is_deleted)

        _, status = _extract(self._delete_message(
            thread["id"], root_id, user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertTrue(CommentMessage.objects.using(TABDOC_DB).get(id=root_id).is_deleted)
        self.assertTrue(DocumentShareComment.objects.using(TABDOC_DB).get(id=root_id).is_deleted)

    def test_delete_thread_removes_thread_and_messages_and_soft_deletes_projection(self):
        created, _ = _extract(self._post_thread(
            {
                "body": "锚点评论",
                "scope": "text_range",
                "anchor": {"version": 1, "selected_text": "将被删除的锚点"},
            },
            user=self.owner,
        ))
        thread = created["data"]["thread"]
        root_id = thread["messages"][0]["id"]

        deleted, status = _extract(self._delete_thread(thread["id"], user=self.owner))

        self.assertEqual(status, 200)
        self.assertEqual(deleted["data"]["thread_id"], thread["id"])
        self.assertFalse(CommentThread.objects.using(TABDOC_DB).filter(id=thread["id"]).exists())
        self.assertFalse(CommentMessage.objects.using(TABDOC_DB).filter(id=root_id).exists())
        self.assertTrue(DocumentShareComment.objects.using(TABDOC_DB).get(id=root_id).is_deleted)

    def test_delete_thread_requires_login(self):
        created, _ = _extract(self._post_thread({"body": "锚点评论"}, user=self.owner))

        _, status = _extract(self._delete_thread(created["data"]["thread"]["id"]))

        self.assertEqual(status, 403)

    def test_legacy_post_and_delete_keep_thread_root_projection_in_sync(self):
        created, status = _extract(self._post_legacy_comment(
            {"body": "旧接口根消息", "selected_text": "旧选区"},
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        comment_id = created["data"]["comment"]["id"]
        root = CommentMessage.objects.using(TABDOC_DB).get(id=comment_id)
        self.assertEqual(root.kind, "root")
        self.assertEqual(root.thread.scope, "text_range")

        deleted, status = _extract(self._delete_legacy_comment(comment_id, user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(deleted["data"]["comment_id"], comment_id)
        self.assertTrue(CommentMessage.objects.using(TABDOC_DB).get(id=comment_id).is_deleted)
        self.assertTrue(DocumentShareComment.objects.using(TABDOC_DB).get(id=comment_id).is_deleted)

    def test_document_and_share_thread_routes_enforce_existing_access_checks(self):
        _, status = _extract(self._get_threads())
        self.assertEqual(status, 403)

        _, status = _extract(self._get_shared_threads(
            password="thread-secret",
        ))
        self.assertEqual(status, 403)

        _, status = _extract(self._get_shared_threads(
            password="wrong-secret",
            user=self.owner,
        ))
        self.assertEqual(status, 403)

        self.comment_share.permission = "view"
        self.comment_share.save(update_fields=["permission"])
        _, status = _extract(self._get_shared_threads(
            password="thread-secret",
            user=self.owner,
        ))
        self.assertEqual(status, 403)

    def test_thread_id_cannot_cross_document_or_organization_boundary(self):
        created, _ = _extract(self._post_thread({"body": "组织一根消息"}, user=self.owner))
        thread_id = created["data"]["thread"]["id"]

        other_owner = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"other_thread_owner_{uuid.uuid4().hex[:8]}",
            email=f"other_thread_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        other_organization = Organization.objects.using(TABDOC_DB).create(
            name="Other Comment Thread Organization",
            owner_id=other_owner.id,
        )
        other_document = Document.objects.using(TABDOC_DB).create(
            organization_id=other_organization.id,
            space_id=uuid.uuid4(),
            owner_id=other_owner.id,
            title="其他组织文档",
            description_json={"type": "doc", "content": []},
        )

        request = self.factory.post(
            f"/tabdoc/documents/{other_document.id}/comment-threads/{thread_id}/messages",
            data=json.dumps({"body": "越权回复"}),
            content_type="application/json",
        )
        request.auth = other_owner
        _, status = _extract(create_document_comment_message(
            request,
            str(other_document.id),
            thread_id,
            CommentMessageCreateRequest(body="越权回复"),
        ))
        self.assertEqual(status, 404)

        other_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=other_document,
            share_type="public",
            permission="comment",
        )
        request = self.factory.post(
            f"/tabdoc/shared/{other_share.share_id}/comment-threads/{thread_id}/messages",
            data=json.dumps({"body": "分享越权回复"}),
            content_type="application/json",
        )
        request.auth = other_owner
        _, status = _extract(create_shared_comment_message(
            request,
            other_share.share_id,
            thread_id,
            CommentMessageCreateRequest(body="分享越权回复"),
        ))
        self.assertEqual(status, 404)
        self.assertEqual(
            CommentMessage.objects.using(TABDOC_DB).filter(thread_id=thread_id).count(),
            1,
        )

    def test_share_thread_create_reply_and_list_reuse_password_and_login_checks(self):
        created, status = _extract(self._post_shared_thread(
            {"password": "thread-secret", "body": "分享页根消息"},
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        thread = created["data"]["thread"]
        root_id = thread["messages"][0]["id"]
        projection = DocumentShareComment.objects.using(TABDOC_DB).get(id=root_id)
        self.assertEqual(projection.share_id, self.comment_share.id)

        replied, status = _extract(self._post_shared_reply(
            thread["id"],
            {"password": "thread-secret", "body": "分享页回复"},
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(replied["data"]["message"]["kind"], "reply")

        listed, status = _extract(self._get_shared_threads(
            password="thread-secret",
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(listed["data"]["capabilities"], ["comment_threads_v1"])
        self.assertEqual(
            [message["body"] for message in listed["data"]["threads"][0]["messages"]],
            ["分享页根消息", "分享页回复"],
        )

    def test_share_status_reanchor_and_message_delete_use_same_share_grant(self):
        created, _ = _extract(self._post_shared_thread(
            {
                "password": "thread-secret",
                "body": "分享页块批注",
                "scope": "block",
                "anchor": {"version": 1, "block_id": "old"},
            },
            user=self.owner,
        ))
        thread = created["data"]["thread"]
        root_id = thread["messages"][0]["id"]

        resolved, status = _extract(self._patch_shared_status(
            thread["id"], "resolved", user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(resolved["data"]["thread"]["status"], "resolved")

        reanchored, status = _extract(self._patch_shared_anchor(
            thread["id"],
            {
                "password": "thread-secret",
                "scope": "block",
                "anchor": {"version": 2, "block_id": "new"},
            },
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(reanchored["data"]["thread"]["anchor"]["block_id"], "new")

        deleted, status = _extract(self._delete_shared_message(
            thread["id"], root_id, user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertTrue(deleted["data"]["deleted"])
        self.assertTrue(DocumentShareComment.objects.using(TABDOC_DB).get(id=root_id).is_deleted)

    def test_thread_lifecycle_emits_new_events_and_keeps_legacy_root_event(self):
        with patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_ws:
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                created, _ = _extract(self._post_thread(
                    {"body": "事件根消息"},
                    user=self.owner,
                ))
            thread = created["data"]["thread"]
            root_id = thread["messages"][0]["id"]
            created_types = {call.args[1]["type"] for call in mock_ws.call_args_list}
            self.assertIn("doc.events.comment_thread", created_types)
            self.assertIn("doc.events.comment_message", created_types)
            self.assertIn("doc.events.comment", created_types)

            mock_ws.reset_mock()
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                _extract(self._patch_status(thread["id"], "resolved", user=self.owner))
                _extract(self._patch_anchor(
                    thread["id"],
                    {"scope": "block", "anchor": {"version": 2, "block_id": "event-block"}},
                    user=self.owner,
                ))
                _extract(self._delete_message(thread["id"], root_id, user=self.owner))

            payloads = [call.args[1] for call in mock_ws.call_args_list]
        thread_actions = {
            envelope["payload"]["action"]
            for envelope in payloads
            if envelope["type"] == "doc.events.comment_thread"
        }
        message_actions = {
            envelope["payload"]["action"]
            for envelope in payloads
            if envelope["type"] == "doc.events.comment_message"
        }
        legacy_actions = {
            envelope["payload"]["action"]
            for envelope in payloads
            if envelope["type"] == "doc.events.comment"
        }
        self.assertEqual(thread_actions, {"status_changed", "anchor_changed"})
        self.assertEqual(message_actions, {"deleted"})
        self.assertEqual(legacy_actions, {"deleted"})

    def test_reply_notifies_participants_and_mentions_once_excluding_actor(self):
        actor = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"thread_actor_{uuid.uuid4().hex[:8]}",
            email=f"thread_actor_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        mentioned = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"thread_mentioned_{uuid.uuid4().hex[:8]}",
            email=f"thread_mentioned_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        for user in (actor, mentioned):
            OrganizationMember.objects.using(TABDOC_DB).create(
                organization=self.organization,
                user=user,
                role="editor",
            )
        DocumentPermission.objects.using(TABDOC_DB).create(
            document=self.document,
            subject_type="user",
            subject_id=str(actor.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        created, _ = _extract(self._post_thread({"body": "参与者根消息"}, user=self.owner))
        thread_id = created["data"]["thread"]["id"]

        with patch(
            "apps.services.notification.services.notification_service.NotificationService.notify"
        ) as mock_notify, patch(
            "apps.tabdoc.services.doc_event_service.publish_ws_event_reliable"
        ):
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                replied, status = _extract(self._post_reply(
                    thread_id,
                    {
                        "body": "回复并提醒",
                        "mention_user_ids": [
                            str(mentioned.id),
                            str(mentioned.id),
                            str(self.owner.id),
                            str(actor.id),
                        ],
                    },
                    user=actor,
                ))

        self.assertEqual(status, 200)
        self.assertEqual(
            replied["data"]["message"]["mention_user_ids"],
            [str(mentioned.id), str(self.owner.id)],
        )
        notified_user_ids = [call.kwargs["user_id"] for call in mock_notify.call_args_list]
        self.assertCountEqual(notified_user_ids, [str(self.owner.id), str(mentioned.id)])
        self.assertEqual(len(notified_user_ids), len(set(notified_user_ids)))
        self.assertNotIn(str(actor.id), notified_user_ids)
        self.assertTrue(all(call.kwargs["type"] == "tabdoc.comment.mention" for call in mock_notify.call_args_list))


class DocumentCommentIdempotencyRaceTests(TransactionTestCase):
    """相同 client_request_id 并发提交只能落一条，并返回同一结果。"""

    databases = {"default", "postgresql"}
    reset_sequences = False

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.signals import create_user_profile, save_user_profile

        for handler in (create_default_organization, create_user_profile, save_user_profile):
            post_save.disconnect(handler, sender=User)

    def setUp(self):
        self.owner = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"thread_race_{uuid.uuid4().hex[:8]}",
            email=f"thread_race_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.using(TABDOC_DB).create(
            name="Comment Idempotency Race",
            owner_id=self.owner.id,
        )
        self.document = Document.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            space_id=uuid.uuid4(),
            owner_id=self.owner.id,
            title="并发幂等文档",
            description_json={"type": "doc", "content": []},
        )

    def test_concurrent_create_with_same_request_id_returns_one_thread(self):
        request_id = f"race-{uuid.uuid4()}"
        barrier = threading.Barrier(2)
        original_lookup = DocumentCommentService._idempotent_message

        def synchronized_lookup(*, user, client_request_id):
            result = original_lookup(user=user, client_request_id=client_request_id)
            if result is None:
                barrier.wait(timeout=10)
            return result

        def create_once():
            close_old_connections()
            try:
                user = User.objects.using(TABDOC_DB).get(id=self.owner.id)
                document = Document.objects.using(TABDOC_DB).get(id=self.document.id)
                return str(DocumentCommentService.create_thread(
                    document,
                    user=user,
                    body="同一次提交",
                    client_request_id=request_id,
                ).id)
            finally:
                connections[TABDOC_DB].close()

        with patch.object(
            DocumentCommentService,
            "_idempotent_message",
            side_effect=synchronized_lookup,
        ), patch.object(DocumentCommentService, "_schedule_root_created"):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: create_once(), range(2)))

        self.assertEqual(results[0], results[1])
        self.assertEqual(
            CommentMessage.objects.using(TABDOC_DB).filter(
                author_id=self.owner.id,
                client_request_id=request_id,
            ).count(),
            1,
        )
        self.assertEqual(
            CommentThread.objects.using(TABDOC_DB).filter(
                document_id=self.document.id,
            ).count(),
            1,
        )
        self.assertEqual(
            DocumentShareComment.objects.using(TABDOC_DB).filter(
                document_id=self.document.id,
            ).count(),
            1,
        )

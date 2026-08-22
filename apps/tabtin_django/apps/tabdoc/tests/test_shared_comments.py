"""公开分享文档评论权限回归测试。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.tabdoc.api_share import (
    CreateSharedCommentRequest,
    create_shared_comment,
    list_shared_comments,
    list_shared_mention_candidates,
)
from apps.tabdoc.api import (
    DocumentCommentCreateRequest,
    create_document_comment,
    delete_document_comment,
    list_document_comments,
)
from apps.tabdoc.models import (
    CommentMessage,
    CommentThread,
    Document,
    DocumentPermission,
    DocumentShare,
    DocumentShareComment,
)
from apps.tabdoc.services.share_service import DocumentShareService, TABDOC_DB
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


class SharedCommentsTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        from apps.tabtinspace.signals import create_default_organization
        from apps.users.auth.signals import create_user_profile, save_user_profile

        for handler in (create_default_organization, create_user_profile, save_user_profile):
            try:
                post_save.disconnect(handler, sender=User)
            except Exception:
                pass

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"share_comment_owner_{uuid.uuid4().hex[:8]}",
            email=f"share_comment_owner_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.using(TABDOC_DB).create(
            name="Share Comment WT",
            owner_id=self.owner.id,
        )
        self.space_id = uuid.uuid4()
        self.document = Document.objects.using(TABDOC_DB).create(
            organization_id=self.organization.id,
            space_id=self.space_id,
            owner_id=self.owner.id,
            title="可评论分享文档",
            description_markdown="正文",
            description_plaintext="正文",
            description_json={"type": "doc", "content": []},
        )
        self.comment_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.view_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="view",
            is_active=False,
        )
        self.edit_share = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.document,
            share_type="public",
            permission="edit",
            is_active=False,
        )

    def _activate_share(self, share_id: str) -> None:
        DocumentShare.objects.using(TABDOC_DB).filter(document=self.document).update(is_active=False)
        DocumentShare.objects.using(TABDOC_DB).filter(share_id=share_id).update(is_active=True)

    def _post_comment(self, share_id: str, body: dict, user=None):
        self._activate_share(share_id)
        request = self.factory.post(
            f"/tabdoc/shared/{share_id}/comments",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        payload = CreateSharedCommentRequest(**body)
        return create_shared_comment(request, share_id, payload)

    def _get_comments(self, share_id: str, user=None):
        self._activate_share(share_id)
        request = self.factory.get(f"/tabdoc/shared/{share_id}/comments")
        request.auth = user
        return list_shared_comments(request, share_id)

    def _get_mention_candidates(self, share_id: str, user=None, password: str = ""):
        self._activate_share(share_id)
        request = self.factory.get(
            f"/tabdoc/shared/{share_id}/mention-candidates",
            data={"password": password} if password else None,
        )
        request.auth = user
        return list_shared_mention_candidates(request, share_id, password=password)

    def _post_document_comment(self, body: dict, user=None):
        request = self.factory.post(
            f"/tabdoc/documents/{self.document.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        payload = DocumentCommentCreateRequest(**body)
        return create_document_comment(request, str(self.document.id), payload)

    def _get_document_comments(self, user=None):
        request = self.factory.get(f"/tabdoc/documents/{self.document.id}/comments")
        request.auth = user
        return list_document_comments(request, str(self.document.id))

    def _delete_document_comment(self, comment_id, user=None):
        request = self.factory.delete(f"/tabdoc/documents/{self.document.id}/comments/{comment_id}")
        request.auth = user
        return delete_document_comment(request, str(self.document.id), str(comment_id))

    def test_comment_permission_can_create_comment_after_login(self):
        payload, status = _extract(self._post_comment(
            self.comment_share.share_id,
            {
                "body": "这里需要补充例子",
                "selected_text": "正文",
                "author_name": "访客 A",
            },
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        self.assertTrue(payload.get("success"))
        comment = payload["data"]["comment"]
        self.assertEqual(comment["body"], "这里需要补充例子")
        self.assertEqual(comment["selected_text"], "正文")
        self.assertEqual(comment["author_name"], self.owner.username)
        self.assertEqual(comment["author_user_id"], str(self.owner.id))
        self.assertIsNone(comment["author_avatar"])
        self.assertEqual(comment["author_account_name"], self.owner.username)
        self.assertEqual(DocumentShareComment.objects.using(TABDOC_DB).count(), 1)

    def test_mention_candidates_available_for_comment_share(self):
        member = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"share_member_{uuid.uuid4().hex[:8]}",
            email=f"share_member_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        member.nickname = "成员甲"
        member.save(update_fields=["nickname"])
        OrganizationMember.objects.using(TABDOC_DB).create(
            organization=self.organization,
            user=member,
            role="editor",
        )
        OrganizationMember.objects.using(TABDOC_DB).create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )

        payload, status = _extract(self._get_mention_candidates(
            self.comment_share.share_id,
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        self.assertTrue(payload.get("success"))
        candidates = payload["data"]["candidates"]
        user_ids = {item["user_id"] for item in candidates}
        self.assertIn(str(member.id), user_ids)
        self.assertIn(str(self.owner.id), user_ids)
        member_item = next(item for item in candidates if item["user_id"] == str(member.id))
        self.assertEqual(member_item["display_name"], "成员甲")
        self.assertIn("account_name", member_item)

    def test_mention_candidates_denied_for_view_share(self):
        payload, status = _extract(self._get_mention_candidates(
            self.view_share.share_id,
            user=self.owner,
        ))

        self.assertEqual(status, 403)
        self.assertFalse(payload.get("success"))

    def test_mention_candidates_require_login_for_comment_share(self):
        payload, status = _extract(self._get_mention_candidates(
            self.comment_share.share_id,
            user=None,
        ))

        self.assertEqual(status, 403)
        self.assertFalse(payload.get("success"))

    def test_comment_permission_requires_login_to_create_comment(self):
        _, status = _extract(self._post_comment(
            self.comment_share.share_id,
            {"body": "匿名不应创建"},
        ))

        self.assertEqual(status, 403)
        self.assertEqual(DocumentShareComment.objects.using(TABDOC_DB).count(), 0)

    def test_view_permission_cannot_create_comment(self):
        _, status = _extract(self._post_comment(
            self.view_share.share_id,
            {"body": "不应创建"},
        ))

        self.assertEqual(status, 403)
        self.assertEqual(DocumentShareComment.objects.using(TABDOC_DB).count(), 0)

    def test_edit_permission_can_create_comment(self):
        payload, status = _extract(self._post_comment(
            self.edit_share.share_id,
            {"body": "编辑权限也允许评论"},
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["comment"]["body"], "编辑权限也允许评论")

    def test_list_comments_available_to_comment_share_after_login(self):
        first = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=self.comment_share,
            author_name="访客 B",
            body="已有评论",
        )
        second = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=self.edit_share,
            author_name="访客 C",
            body="同文档其它入口的评论",
        )
        third = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author_name="客户端用户",
            body="客户端评论",
        )
        base_time = timezone.now()
        for offset, comment in enumerate((first, second, third)):
            DocumentShareComment.objects.using(TABDOC_DB).filter(id=comment.id).update(
                created_at=base_time + timedelta(microseconds=offset)
            )

        payload, status = _extract(self._get_comments(self.comment_share.share_id, user=self.owner))

        self.assertEqual(status, 200)
        comments = payload["data"]["comments"]
        self.assertEqual([item["id"] for item in comments], [str(first.id), str(second.id), str(third.id)])
        self.assertEqual(
            [item["body"] for item in comments],
            ["已有评论", "同文档其它入口的评论", "客户端评论"],
        )

    def test_comment_permission_requires_login_to_list_comments(self):
        _, status = _extract(self._get_comments(self.comment_share.share_id))
        self.assertEqual(status, 403)

    def test_view_permission_cannot_list_comments(self):
        DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=self.view_share,
            author_name="访客 D",
            body="只读分享不应展示评论",
        )

        _, status = _extract(self._get_comments(self.view_share.share_id, user=self.owner))
        self.assertEqual(status, 403)

    def test_empty_comment_rejected(self):
        payload, status = _extract(self._post_comment(
            self.comment_share.share_id,
            {"body": "   "},
            user=self.owner,
        ))

        self.assertEqual(status, 400)
        self.assertFalse(payload.get("success"))

    def test_document_comment_can_create_without_share_after_login(self):
        payload, status = _extract(self._post_document_comment(
            {"body": "客户端里的全文评论"},
            user=self.owner,
        ))

        self.assertEqual(status, 200)
        self.assertTrue(payload.get("success"))
        comment = payload["data"]["comment"]
        self.assertEqual(comment["body"], "客户端里的全文评论")
        self.assertEqual(comment["author_user_id"], str(self.owner.id))
        self.assertIsNone(comment["author_avatar"])
        self.assertEqual(comment["author_account_name"], self.owner.username)
        stored = DocumentShareComment.objects.using(TABDOC_DB).get(id=comment["id"])
        self.assertIsNone(stored.share_id)
        root = CommentMessage.objects.using(TABDOC_DB).get(id=stored.id, kind="root")
        self.assertEqual(root.thread.document_id, self.document.id)
        self.assertEqual(root.body, stored.body)
        self.assertEqual(CommentThread.objects.using(TABDOC_DB).count(), 1)

    def test_document_comment_mentions_emit_event_and_notify_targets(self):
        mentioned = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"mentioned_{uuid.uuid4().hex[:8]}",
            email=f"mentioned_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        outsider = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"outsider_{uuid.uuid4().hex[:8]}",
            email=f"outsider_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        OrganizationMember.objects.using(TABDOC_DB).create(
            organization=self.organization,
            user=mentioned,
            role="editor",
        )

        with patch("apps.extensions.event_bus.EventBus.emit") as mock_emit, \
                patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_ws, \
                patch("apps.services.notification.services.notification_service.NotificationService.notify") as mock_notify:
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                payload, status = _extract(self._post_document_comment(
                    {
                        "body": "请 @同事 看一下",
                        "mention_user_ids": [
                            str(mentioned.id),
                            str(mentioned.id),
                            str(self.owner.id),
                            str(outsider.id),
                            "",
                        ],
                    },
                    user=self.owner,
                ))

        self.assertEqual(status, 200)
        comment = payload["data"]["comment"]
        self.assertEqual(comment["mention_user_ids"], [str(mentioned.id)])

        stored = DocumentShareComment.objects.using(TABDOC_DB).get(id=comment["id"])
        self.assertEqual(stored.mention_user_ids, [str(mentioned.id)])

        mock_emit.assert_called_once()
        event = mock_emit.call_args.args[0]
        self.assertEqual(event.source, "tabdoc")
        self.assertEqual(event.event_type, "tabdoc.document.commented")
        self.assertEqual(event.payload["doc_id"], str(self.document.id))
        self.assertEqual(event.payload["comment_author_id"], str(self.owner.id))
        self.assertEqual(event.payload["mention_user_ids"], [str(mentioned.id)])

        mock_ws.assert_called()
        topics = [call.args[0] for call in mock_ws.call_args_list]
        self.assertIn(f"doc.events.{self.document.id}", topics)
        mock_notify.assert_called_once()
        self.assertEqual(mock_notify.call_args.kwargs["user_id"], str(mentioned.id))
        self.assertEqual(mock_notify.call_args.kwargs["type"], "tabdoc.comment.mention")
        self.assertEqual(
            mock_notify.call_args.kwargs["metadata"]["source_event_key"],
            "tabdoc.document.commented",
        )

    def test_document_comments_include_share_and_document_comments(self):
        share_comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=self.comment_share,
            author_name="分享访客",
            body="分享页评论",
        )
        document_comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author_name="客户端用户",
            body="客户端评论",
        )
        base_time = timezone.now()
        for offset, comment in enumerate((share_comment, document_comment)):
            DocumentShareComment.objects.using(TABDOC_DB).filter(id=comment.id).update(
                created_at=base_time + timedelta(microseconds=offset)
            )

        payload, status = _extract(self._get_document_comments(user=self.owner))

        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["capabilities"], ["comment_threads_v1"])
        bodies = [item["body"] for item in payload["data"]["comments"]]
        self.assertEqual(bodies, ["分享页评论", "客户端评论"])

    def test_document_comment_author_can_delete_own_comment(self):
        comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=self.owner,
            author_name=self.owner.username,
            body="误发评论",
        )

        payload, status = _extract(self._delete_document_comment(comment.id, user=self.owner))

        self.assertEqual(status, 200)
        self.assertTrue(payload["data"]["deleted"])
        comment.refresh_from_db(using=TABDOC_DB)
        self.assertTrue(comment.is_deleted)

        payload, status = _extract(self._get_document_comments(user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["comments"], [])

    def test_document_comment_delete_emits_deleted_event_and_share_fanout(self):
        comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=self.owner,
            author_name=self.owner.username,
            body="将被删除并广播",
        )

        with patch(
            "apps.tabdoc.services.doc_event_service.DocEventService._list_commentable_share_ids",
            return_value=[self.comment_share.share_id, self.edit_share.share_id],
        ), patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_ws:
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                payload, status = _extract(self._delete_document_comment(comment.id, user=self.owner))

        self.assertEqual(status, 200)
        self.assertTrue(payload["data"]["deleted"])

        topics = [call.args[0] for call in mock_ws.call_args_list]
        self.assertIn(f"doc.events.{self.document.id}", topics)
        self.assertIn(f"share.events.{self.comment_share.share_id}", topics)
        self.assertIn(f"share.events.{self.edit_share.share_id}", topics)
        self.assertNotIn(f"share.events.{self.view_share.share_id}", topics)

        deleted_envelopes = [
            call.args[1]
            for call in mock_ws.call_args_list
            if call.args[1].get("type") in {"doc.events.comment", "share.events.comment"}
        ]
        self.assertTrue(deleted_envelopes)
        for envelope in deleted_envelopes:
            self.assertEqual(envelope["payload"]["action"], "deleted")
            self.assertEqual(envelope["payload"]["comment_id"], str(comment.id))

    def test_document_comment_create_fans_out_to_commentable_shares(self):
        with patch("apps.extensions.event_bus.EventBus.emit"), \
                patch(
                    "apps.tabdoc.services.doc_event_service.DocEventService._list_commentable_share_ids",
                    return_value=[self.comment_share.share_id, self.edit_share.share_id],
                ), \
                patch("apps.tabdoc.services.doc_event_service.publish_ws_event_reliable") as mock_ws:
            with self.captureOnCommitCallbacks(execute=True, using=TABDOC_DB):
                payload, status = _extract(self._post_document_comment(
                    {"body": "客户端发评应推到分享页"},
                    user=self.owner,
                ))

        self.assertEqual(status, 200)
        comment_id = payload["data"]["comment"]["id"]
        topics = [call.args[0] for call in mock_ws.call_args_list]
        self.assertIn(f"doc.events.{self.document.id}", topics)
        self.assertIn(f"share.events.{self.comment_share.share_id}", topics)
        self.assertIn(f"share.events.{self.edit_share.share_id}", topics)
        self.assertNotIn(f"share.events.{self.view_share.share_id}", topics)

        created_payloads = [
            call.args[1]["payload"]
            for call in mock_ws.call_args_list
            if call.args[1].get("type") in {"doc.events.comment", "share.events.comment"}
        ]
        self.assertTrue(created_payloads)
        for item in created_payloads:
            self.assertEqual(item["action"], "created")
            self.assertEqual(item["comment_id"], comment_id)

    def test_document_comment_non_author_cannot_delete_comment(self):
        viewer = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"comment_viewer_{uuid.uuid4().hex[:8]}",
            email=f"comment_viewer_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        OrganizationMember.objects.using(TABDOC_DB).create(
            organization=self.organization,
            user=viewer,
            role="viewer",
        )
        DocumentPermission.objects.using(TABDOC_DB).create(
            document=self.document,
            subject_type="user",
            subject_id=str(viewer.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
            created_by=self.owner,
        )
        comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=self.owner,
            author_name=self.owner.username,
            body="不能被别人删除",
        )

        _, status = _extract(self._delete_document_comment(comment.id, user=viewer))

        self.assertEqual(status, 403)
        comment.refresh_from_db(using=TABDOC_DB)
        self.assertFalse(comment.is_deleted)

    def test_document_comment_delete_requires_login(self):
        comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=self.owner,
            author_name=self.owner.username,
            body="登录后才能删",
        )

        _, status = _extract(self._delete_document_comment(comment.id))

        self.assertEqual(status, 403)
        comment.refresh_from_db(using=TABDOC_DB)
        self.assertFalse(comment.is_deleted)

    def test_document_comment_delete_missing_comment_returns_not_found(self):
        _, status = _extract(self._delete_document_comment("not-a-comment-id", user=self.owner))

        self.assertEqual(status, 404)

    @patch("apps.tabdoc.services.comment_service.build_public_asset_url")
    def test_document_comments_return_author_brief(self, mock_build_public_asset_url):
        mock_build_public_asset_url.side_effect = (
            lambda ref: f"https://assets.example.com/{ref}" if ref else ""
        )
        author = User.objects.db_manager(TABDOC_DB).create_user(
            username=f"comment_author_{uuid.uuid4().hex[:8]}",
            email=f"comment_author_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        author.nickname = "评论作者"
        author.avatar = "avatars/comment-author.png"
        author.save(using=TABDOC_DB, update_fields=["nickname", "avatar"])
        DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=author,
            author_name="评论作者",
            body="带头像评论",
        )
        DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author=None,
            author_name="历史访客",
            body="历史评论",
        )

        payload, status = _extract(self._get_document_comments(user=self.owner))

        self.assertEqual(status, 200)
        comments = {item["body"]: item for item in payload["data"]["comments"]}
        authored = comments["带头像评论"]
        self.assertEqual(authored["author_name"], "评论作者")
        self.assertEqual(authored["author_user_id"], str(author.id))
        self.assertEqual(authored["author_avatar"], "https://assets.example.com/avatars/comment-author.png")
        self.assertEqual(authored["author_account_name"], author.username)
        mock_build_public_asset_url.assert_any_call("avatars/comment-author.png")

        legacy = comments["历史评论"]
        self.assertEqual(legacy["author_name"], "历史访客")
        self.assertIsNone(legacy["author_user_id"])
        self.assertIsNone(legacy["author_avatar"])
        self.assertEqual(legacy["author_account_name"], "")

    def test_serialize_comment_ignores_missing_author_relation(self):
        comment = DocumentShareComment.objects.using(TABDOC_DB).create(
            document=self.document,
            share=None,
            author_id=uuid.uuid4(),
            author_name="残留作者",
            body="用户已不存在的评论",
        )

        payload = DocumentShareService.serialize_comment(comment)

        self.assertEqual(payload["author_name"], "残留作者")
        self.assertIsNone(payload["author_user_id"])
        self.assertIsNone(payload["author_avatar"])
        self.assertEqual(payload["author_account_name"], "")

        projected_root = CommentMessage.objects.using(TABDOC_DB).get(
            id=comment.id,
            kind="root",
        )
        self.assertIsNone(projected_root.author_id)
        self.assertIsNone(projected_root.thread.created_by_id)

    def test_document_comments_require_login(self):
        _, status = _extract(self._get_document_comments())
        self.assertEqual(status, 403)

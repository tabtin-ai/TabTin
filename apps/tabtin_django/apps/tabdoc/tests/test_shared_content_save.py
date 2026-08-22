"""公开分享文档可编辑保存 — view / service smoke 测试。"""

from __future__ import annotations

import json
import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase

from apps.tabdoc.api_share import (
    SaveSharedContentRequest,
    VerifyPasswordRequest,
    get_shared_content,
    save_shared_content,
    verify_password,
)
from apps.tabdoc.models import Document, DocumentShare
from apps.tabdoc.services.share_service import DocumentShareService
from apps.tabtinspace.models import Space, Organization

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


class SharedContentSaveTests(TestCase):
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
        # 单库模式下 tabtinspace/tabdoc 都路由到 default；owner 必须落在同一别名，
        # 否则 TestCase 里 User 与 Organization 分处两个连接/事务、跨事务不可见，
        # 触发 teardown 的 SET CONSTRAINTS ALL IMMEDIATE 外键校验失败。
        from apps.services.common.db_router import postgres_app_db_alias

        self._db_alias = postgres_app_db_alias()
        self.owner = User.objects.db_manager(self._db_alias).create_user(
            username=f"owner_{uuid.uuid4().hex[:8]}",
            email=f"owner_{uuid.uuid4().hex[:8]}@example.com",
            password="pass1234",
        )
        self.organization = Organization.objects.create(
            name="Share Save WT",
            owner_id=self.owner.id,
        )
        self.space = Space.objects.create(
            organization_id=self.organization.id,
            name="Share Save Space",
            type="team",
        )
        self.document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="可编辑分享文档",
            description_markdown="初始正文",
            description_plaintext="初始正文",
            description_json={"type": "doc", "content": []},
            latest_version=3,
        )
        self.edit_share = DocumentShare.objects.create(
            document=self.document,
            share_type="public",
            permission="edit",
        )
        self.view_share = DocumentShare.objects.create(
            document=self.document,
            share_type="public",
            permission="view",
        )
        self.comment_share = DocumentShare.objects.create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.password_comment_share = DocumentShare.objects.create(
            document=self.document,
            share_type="public",
            permission="comment",
        )
        self.password_comment_share.set_password("secret")
        self.password_comment_share.save(update_fields=["password_hash"])

    def _call_save(self, share_id: str, *, body: dict, user=None):
        request = self.factory.post(
            f"/tabdoc/shared/{share_id}/content",
            data=json.dumps(body),
            content_type="application/json",
        )
        request.auth = user
        payload = SaveSharedContentRequest(**body)
        return save_shared_content(request, share_id, payload)

    def _call_get_content(self, share_id: str, *, user=None):
        request = self.factory.get(f"/tabdoc/shared/{share_id}/content")
        request.auth = user
        return get_shared_content(request, share_id)

    def _call_verify_password(self, share_id: str, *, password: str, user=None):
        request = self.factory.post(
            f"/tabdoc/shared/{share_id}/verify",
            data=json.dumps({"password": password}),
            content_type="application/json",
        )
        request.auth = user
        payload = VerifyPasswordRequest(password=password)
        return verify_password(request, share_id, payload)

    def test_save_shared_content_success_after_login(self):
        body = {
            "base_version": 3,
            "content_pm_json": {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "新正文"}]}],
            },
            "content_markdown": "新正文",
            "content_plaintext": "新正文",
        }
        with patch("apps.tabdoc.services.document_service.DocumentService._update_search_vector"):
            payload, status = _extract(self._call_save(self.edit_share.share_id, body=body, user=self.owner))
        self.assertEqual(status, 200)
        self.assertTrue(payload.get("success"))
        self.assertEqual(payload["data"]["latest_version"], 4)

        self.document.refresh_from_db()
        self.assertEqual(self.document.latest_version, 4)
        self.assertEqual(self.document.description_markdown, "新正文")

    def test_save_shared_content_pushes_as_system_trusted_internal(self):
        """#3524 回归：分享编辑保存后，须以 system trusted_internal 身份把整篇替换
        推进在线 Y.Doc（editor_type=share 会在 collab 主体权限校验处被拒，推送失败，
        文档所有者协作态看不到访客改动）。捕获 apply-ops 入参断言推送身份/策略。"""
        captured = {}

        def _fake_apply_docs_ops(**kwargs):
            captured.update(kwargs)
            return {"status": "ok"}

        body = {
            "base_version": 3,
            "content_pm_json": {
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "访客改动"}]}],
            },
            "content_markdown": "访客改动",
            "content_plaintext": "访客改动",
        }

        with patch(
            "apps.tabdoc.services.document_service.DocumentService._update_search_vector",
        ), patch(
            "apps.tabdoc.services.document_service.call_live_api",
            return_value={"update_b64": "AQID"},
        ), patch(
            "apps.collab.apply_ops.CollabApplyOpsService.apply_docs_ops",
            side_effect=_fake_apply_docs_ops,
        ):
            payload, status = _extract(
                self._call_save(self.edit_share.share_id, body=body, user=self.owner)
            )

        self.assertEqual(status, 200)
        self.assertTrue(payload.get("success"))
        self.assertTrue(captured, "apply_docs_ops 未被调用，分享写入没有推进 Y.Doc")
        self.assertEqual(captured.get("editor_type"), "system")
        self.assertEqual(captured.get("editor_id"), "system:share_sync")
        self.assertEqual(captured.get("system_policy"), "trusted_internal")
        self.assertEqual(captured.get("document_id"), str(self.document.id))

        self.document.refresh_from_db()
        self.assertEqual(self.document.latest_version, 4)
        self.assertEqual(self.document.description_markdown, "访客改动")

    def test_get_shared_content_comment_share_requires_login(self):
        _, status = _extract(self._call_get_content(self.comment_share.share_id))
        self.assertEqual(status, 403)

    def test_get_shared_content_edit_share_requires_login(self):
        _, status = _extract(self._call_get_content(self.edit_share.share_id))
        self.assertEqual(status, 403)

    def test_get_shared_content_comment_share_after_login(self):
        payload, status = _extract(self._call_get_content(self.comment_share.share_id, user=self.owner))
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["title"], "可编辑分享文档")

    def test_verify_password_comment_share_requires_login(self):
        _, status = _extract(self._call_verify_password(
            self.password_comment_share.share_id,
            password="secret",
        ))
        self.assertEqual(status, 403)

    def test_verify_password_comment_share_after_login(self):
        payload, status = _extract(self._call_verify_password(
            self.password_comment_share.share_id,
            password="secret",
            user=self.owner,
        ))
        self.assertEqual(status, 200)
        self.assertEqual(payload["data"]["title"], "可编辑分享文档")

    def test_save_shared_content_edit_share_requires_login(self):
        body = {
            "base_version": 3,
            "content_markdown": "匿名不应保存",
            "content_plaintext": "匿名不应保存",
            "content_pm_json": {"type": "doc", "content": []},
        }
        _, status = _extract(self._call_save(self.edit_share.share_id, body=body))
        self.assertEqual(status, 403)

        self.document.refresh_from_db()
        self.assertEqual(self.document.description_markdown, "初始正文")

    def test_save_shared_content_readonly_share_denied(self):
        body = {
            "base_version": 3,
            "content_markdown": "不应保存",
            "content_plaintext": "不应保存",
            "content_pm_json": {"type": "doc", "content": []},
        }
        _, status = _extract(self._call_save(self.view_share.share_id, body=body))
        self.assertEqual(status, 403)

        self.document.refresh_from_db()
        self.assertEqual(self.document.description_markdown, "初始正文")

    def test_save_shared_content_comment_share_denied(self):
        body = {
            "base_version": 3,
            "content_markdown": "评论权限不应保存正文",
            "content_plaintext": "评论权限不应保存正文",
            "content_pm_json": {"type": "doc", "content": []},
        }
        _, status = _extract(self._call_save(self.comment_share.share_id, body=body, user=self.owner))
        self.assertEqual(status, 403)

        self.document.refresh_from_db()
        self.assertEqual(self.document.description_markdown, "初始正文")

    def test_serialize_content_includes_latest_version(self):
        meta = DocumentShareService.serialize_content(self.edit_share)
        self.assertEqual(meta["latest_version"], 3)

    def test_serialize_meta_includes_horizontal_cover_position(self):
        self.document.cover_position = 0.25
        self.document.properties = {
            "plan": {"status": "draft"},
            "cover_position_x": 0.75,
            "cover_scale": 1.8,
        }
        self.document.save(update_fields=["cover_position", "properties"])

        meta = DocumentShareService.serialize_meta(self.edit_share, include_protected=False)

        self.assertEqual(meta["cover_position"], 0.25)
        self.assertEqual(meta["cover_position_x"], 0.75)
        self.assertEqual(meta["cover_scale"], 1.8)

    def test_serialize_meta_defaults_invalid_horizontal_cover_position(self):
        self.document.properties = {"cover_position_x": "right", "cover_scale": "large"}
        self.document.save(update_fields=["properties"])

        meta = DocumentShareService.serialize_meta(self.edit_share, include_protected=False)

        self.assertEqual(meta["cover_position_x"], 0.5)
        self.assertEqual(meta["cover_scale"], 1.0)

    def test_serialize_meta_protected_includes_document_path(self):
        parent = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="父文档合集",
            description_markdown="",
            description_plaintext="",
            description_json={"type": "doc", "content": []},
        )
        self.document.parent = parent
        self.document.save(update_fields=["parent"])

        meta = DocumentShareService.serialize_meta(self.edit_share, include_protected=True)

        self.assertEqual(meta["document_id"], str(self.document.id))
        self.assertEqual(meta["space_id"], str(self.space.id))
        self.assertEqual(meta["organization_id"], str(self.organization.id))
        self.assertEqual(
            [node["title"] for node in meta["location_path"]],
            ["父文档合集", "可编辑分享文档"],
        )

        public_meta = DocumentShareService.serialize_meta(
            self.edit_share, include_protected=False,
        )
        self.assertNotIn("document_id", public_meta)
        self.assertNotIn("location_path", public_meta)

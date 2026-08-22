"""#7761 TabDoc 分享安全收口：默认组织内、公网扩权确认、范围互斥。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.services.common.public_share.exceptions import SharePermissionDeniedError
from apps.tabdoc.api_share import (
    CreateShareRequest,
    close_share,
    create_share,
    get_share,
    get_shared_meta,
    refresh_share,
)
from apps.tabdoc.models import Document, DocumentShare
from apps.tabdoc.services.share_service import DocumentShareService
from apps.tabtinspace.models import Organization, OrganizationMember, Project

User = get_user_model()
TABDOC_DB = (
    "default"
    if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
    else "postgresql"
)


def _extract(response):
    if isinstance(response, JsonResponse):
        return json.loads(response.content.decode("utf-8")), response.status_code
    if isinstance(response, dict):
        return response, 200
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        return body, status
    raise AssertionError(f"unexpected view response type: {type(response)!r}")


class ShareScopeSecurityTests(TestCase):
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
        self.owner = User.objects.create_user(
            username=f"scope_owner_{uuid.uuid4().hex[:8]}",
            email=f"scope_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Scope WT", owner=self.owner, type="team",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.owner,
            role="owner",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="Scope Space",
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="scope security doc",
        )

    def _request(self, *, method="POST", body=None):
        path = f"/api/tabdoc/documents/{self.doc.id}/share"
        kwargs = {}
        if body is not None:
            kwargs["data"] = json.dumps(body)
            kwargs["content_type"] = "application/json"
        request = getattr(self.factory, method.lower())(path, **kwargs)
        request.auth = self.owner
        return request

    def _active_count(self) -> int:
        return (
            DocumentShare.objects.using(TABDOC_DB)
            .filter(document=self.doc, is_active=True)
            .count()
        )

    def test_default_create_is_organization(self):
        data = CreateShareRequest()
        self.assertEqual(data.share_type, "organization")
        result = create_share(
            self._request(body={}),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        share = payload["data"]["share"]
        self.assertEqual(share["share_type"], "organization")
        self.assertEqual(share["organization_id"], str(self.organization.id))
        self.assertEqual(self._active_count(), 1)

    def test_public_without_ack_returns_409(self):
        data = CreateShareRequest(share_type="public", permission="view")
        result = create_share(
            self._request(body={"share_type": "public", "permission": "view"}),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 409, payload)
        self.assertEqual(payload.get("code"), "PUBLIC_EXPOSURE_ACK_REQUIRED")
        self.assertEqual(self._active_count(), 0)

    def test_public_with_ack_succeeds(self):
        data = CreateShareRequest(
            share_type="public",
            permission="view",
            acknowledge_public_exposure=True,
        )
        result = create_share(
            self._request(
                body={
                    "share_type": "public",
                    "permission": "view",
                    "acknowledge_public_exposure": True,
                },
            ),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["share_type"], "public")

    def test_scope_switch_disables_previous_public_link(self):
        public_share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        old_share_id = public_share.share_id

        org_share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        self.assertEqual(self._active_count(), 1)
        self.assertEqual(org_share.share_type, "organization")

        public_share.refresh_from_db()
        self.assertFalse(public_share.is_active)

        from apps.services.common.public_share.exceptions import ShareNotFoundError

        with self.assertRaises(ShareNotFoundError):
            DocumentShareService.get_share_by_id(old_share_id)

    def test_get_share_returns_effective_without_type(self):
        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        result = get_share(self._request(method="GET"), self.doc.id, share_type="")
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["data"]["enabled"])
        self.assertEqual(payload["data"]["share"]["share_type"], "organization")

    def test_already_public_update_permission_no_ack_required(self):
        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
        )
        data = CreateShareRequest(share_type="public", permission="edit")
        result = create_share(
            self._request(body={"share_type": "public", "permission": "edit"}),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["share"]["permission"], "edit")

    def test_invalid_permission_rejected(self):
        data = CreateShareRequest(share_type="organization", permission="admin")
        result = create_share(
            self._request(body={"share_type": "organization", "permission": "admin"}),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 400, payload)

    @patch("apps.tabtinspace.services.audit_service.AuditService.log")
    def test_enable_writes_audit(self, audit_log):
        data = CreateShareRequest(
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        result = create_share(
            self._request(
                body={
                    "share_type": "organization",
                    "organization_id": str(self.organization.id),
                },
            ),
            self.doc.id,
            data,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        audit_log.assert_called()
        kwargs = audit_log.call_args.kwargs
        self.assertEqual(kwargs.get("action_type"), "resource_share")
        self.assertEqual(kwargs.get("target_type"), "document")
        req = kwargs.get("request_payload") or {}
        self.assertNotIn("share_id", req)
        self.assertNotIn("password", req)

    def test_close_without_type_closes_effective(self):
        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        result = close_share(self._request(method="DELETE"), self.doc.id, share_type="")
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["data"]["disabled_count"], 1)
        self.assertEqual(self._active_count(), 0)

    def test_expired_public_reopen_requires_ack(self):
        """已过期的 public 不算可访问；不带 ack 不得静默复活旧 share_id。"""
        expired = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="public",
            acknowledge_public_exposure=True,
            expire_at=timezone.now() - timedelta(hours=1),
        )
        old_share_id = expired.share_id
        self.assertTrue(expired.is_expired())

        denied = CreateShareRequest(share_type="public", permission="view")
        result = create_share(
            self._request(body={"share_type": "public", "permission": "view"}),
            self.doc.id,
            denied,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 409, payload)
        self.assertEqual(payload.get("code"), "PUBLIC_EXPOSURE_ACK_REQUIRED")

        expired.refresh_from_db()
        self.assertTrue(expired.is_active)
        self.assertTrue(expired.is_expired())
        self.assertEqual(expired.share_id, old_share_id)

        acked = CreateShareRequest(
            share_type="public",
            permission="view",
            acknowledge_public_exposure=True,
        )
        result = create_share(
            self._request(
                body={
                    "share_type": "public",
                    "permission": "view",
                    "acknowledge_public_exposure": True,
                },
            ),
            self.doc.id,
            acked,
        )
        payload, status = _extract(result)
        self.assertEqual(status, 200, payload)
        revived = DocumentShare.objects.using(TABDOC_DB).get(pk=expired.pk)
        self.assertEqual(revived.share_id, old_share_id)
        self.assertIsNone(revived.expire_at)
        self.assertFalse(revived.is_expired())

    def test_invalid_share_type_on_get_close_refresh_returns_400(self):
        """非空非法 share_type 不得回退到当前有效分享（拼写错误防破坏）。"""
        DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
            share_type="organization",
            organization_id=str(self.organization.id),
        )
        typo = "organizaton"

        get_payload, get_status = _extract(
            get_share(self._request(method="GET"), self.doc.id, share_type=typo),
        )
        self.assertEqual(get_status, 400, get_payload)

        refresh_payload, refresh_status = _extract(
            refresh_share(self._request(method="POST"), self.doc.id, share_type=typo),
        )
        self.assertEqual(refresh_status, 400, refresh_payload)

        close_payload, close_status = _extract(
            close_share(self._request(method="DELETE"), self.doc.id, share_type=typo),
        )
        self.assertEqual(close_status, 400, close_payload)
        self.assertEqual(self._active_count(), 1, "非法 close 不得关掉有效分享")

    def test_exclusive_default_organization_fills_org_id_from_document(self):
        """非 HTTP 直调 exclusive 省略 organization_id 时，必须绑定文档归属组织。"""
        share = DocumentShareService.create_or_update_share_exclusive(
            self.doc,
            self.owner,
        )
        self.assertEqual(share.share_type, "organization")
        self.assertEqual(share.organization_id, str(self.organization.id))

        with self.assertRaises(SharePermissionDeniedError):
            DocumentShareService.verify_share_access(share, user=None)

    def test_organization_share_empty_org_id_anonymous_meta_denied(self):
        """历史脏数据：organization + 空 organization_id → 公开端点匿名拒绝。"""
        dirty = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.doc,
            share_type="organization",
            organization_id="",
            permission="view",
            is_active=True,
            created_by=self.owner,
        )
        with self.assertRaises(SharePermissionDeniedError):
            DocumentShareService.verify_share_access(dirty, user=None)

        anon = self.factory.get(f"/api/tabdoc/shared/{dirty.share_id}")
        anon.auth = None
        payload, status = _extract(get_shared_meta(anon, dirty.share_id))
        self.assertEqual(status, 403, payload)

    def test_exclusive_rejects_unknown_share_type_without_persist(self):
        """直调 exclusive 传入非法 share_type 必须 ValidationError，且不落库。"""
        before = self._active_count()
        with self.assertRaises(ValidationError) as ctx:
            DocumentShareService.create_or_update_share_exclusive(
                self.doc,
                self.owner,
                share_type="typo",
                permission="view",
            )
        self.assertIn("share_type", str(ctx.exception).lower())
        self.assertEqual(self._active_count(), before)
        self.assertFalse(
            DocumentShare.objects.using(TABDOC_DB)
            .filter(document=self.doc, share_type="typo")
            .exists()
        )

    def test_unknown_share_type_anonymous_public_endpoint_fail_closed(self):
        """历史脏数据 share_type=typo：鉴权门与匿名 meta 均拒绝（不得当公开链接）。"""
        dirty = DocumentShare.objects.using(TABDOC_DB).create(
            document=self.doc,
            share_type="typo",
            organization_id="",
            permission="view",
            is_active=True,
            created_by=self.owner,
        )
        with self.assertRaises(SharePermissionDeniedError):
            DocumentShareService.verify_share_access(dirty, user=None)

        anon = self.factory.get(f"/api/tabdoc/shared/{dirty.share_id}")
        anon.auth = None
        payload, status = _extract(get_shared_meta(anon, dirty.share_id))
        self.assertEqual(status, 403, payload)

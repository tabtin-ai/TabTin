"""tabdoc share view 层 smoke 测试（R-A1 / S1 修复回归保护）

修复背景：``apps/tabtin_django/apps/tabdoc/api_share.py`` 的 ``create_share``
view 此前用 ``document=`` / ``user=`` 关键字调
``DocumentShareService.create_or_update_share``，但父类
``PublicShareService.create_or_update_share`` 签名是
``(cls, resource, operator, *, share_type, ...)``，两个位置参数，
**没有 kwargs 别名**。任何走 view 的 ``doc share set`` 调用必抛
``TypeError: create_or_update_share() got an unexpected keyword argument 'document'``。

由于 ``test_share_service_e2e.py`` 都是直接调 service 的位置参数，
service 层契约始终被掩盖，view 层这个 bug 长期没被测试覆盖。

本文件以 ``RequestFactory + 直接调 view 函数`` 的方式补 view 层 smoke 测试，
确保 ``create_share`` 真的能把请求 dispatch 到 service 并落库；同时顺路
``get_share`` / ``close_share`` / ``refresh_share`` 三个 view 也做一次
end-to-end smoke，防止同类 kwarg 错位回归。

为什么不用 Django Ninja TestClient：tabdoc 测试 settings 没装 ROOT_URLCONF
（见 ``test_share_service_e2e.py`` 的注释），TestClient 没法 dispatch。
直接调 view 函数等价于路由层在 thin shim 之上的真实行为。
"""

from __future__ import annotations

import json
import uuid

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.http import JsonResponse
from django.test import RequestFactory, TestCase

from apps.tabdoc.api_share import (
    CreateShareRequest,
    close_share,
    create_share,
    get_share,
    refresh_share,
)
from apps.tabdoc.models import Document, DocumentShare
from apps.tabtinspace.models import Organization, Project

User = get_user_model()
TABDOC_DB = (
    "default"
    if getattr(settings, "TABTIN_SINGLE_DATABASE_MODE", False)
    else "postgresql"
)


def _extract(response):
    """统一抽取 view 函数返回值：兼容 ``dict``（success_response 的裸 dict）、
    ``JsonResponse``（error_response_with_status / not_found_response 等），
    以及 ``(status, body)`` 元组。

    返回 ``(payload_dict, status_code)``。
    """
    if isinstance(response, JsonResponse):
        return json.loads(response.content.decode("utf-8")), response.status_code
    if isinstance(response, dict):
        return response, 200
    if isinstance(response, tuple) and len(response) == 2:
        status, body = response
        return body, status
    raise AssertionError(f"unexpected view response type: {type(response).__name__}: {response!r}")


class _BaseShareViewTestCase(TestCase):
    """share view 测试公共底座。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # tabtinspace 信号会在 User 保存时自动建个 personal organization，
        # 干扰 owner 与测试 organization 的关系断言。复用 test_share_service.py
        # 的同款做法：临时断开信号，test runner 进程级别。
        from apps.tabtinspace.signals import create_default_organization

        try:
            post_save.disconnect(create_default_organization, sender=User)
        except Exception:
            pass

    def setUp(self):
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username=f"share_view_owner_{uuid.uuid4().hex[:8]}",
            email=f"share_view_{uuid.uuid4().hex[:8]}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name="Share View WT", owner=self.owner, type="team",
        )
        self.space = Project.objects.create(
            organization=self.organization,
            name="Share View Space",
        )
        self.doc = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            owner_id=self.owner.id,
            title="share view doc",
        )

    def _make_request(self, *, method: str = "POST", body: dict | None = None):
        path = f"/api/tabdoc/documents/{self.doc.id}/share"
        kwargs: dict = {}
        if body is not None:
            kwargs["data"] = json.dumps(body)
            kwargs["content_type"] = "application/json"
        request = getattr(self.factory, method.lower())(path, **kwargs)
        request.auth = self.owner
        return request


class CreateShareViewTests(_BaseShareViewTestCase):
    """R-A1 / S1：覆盖 view 层调用 create_share，防 kwarg 错位回归。"""

    # ── 关键 P0 smoke ──

    def test_create_share_public_view_actually_runs(self):
        """S1 修复 smoke test：view 函数能跑过 create_or_update_share 不抛 TypeError，
        并真的落了一条 active DocumentShare。

        ：扩大到 public 须 acknowledge_public_exposure=true。
        """
        data = CreateShareRequest(
            share_type="public",
            permission="view",
            acknowledge_public_exposure=True,
        )
        request = self._make_request(
            body={
                "share_type": "public",
                "permission": "view",
                "acknowledge_public_exposure": True,
            },
        )
        result = create_share(request, self.doc.id, data)
        payload, status = _extract(result)

        self.assertEqual(status, 200, f"应 200，实际 {status}：{payload}")
        self.assertTrue(payload.get("success"), f"success 应为 True：{payload}")
        share = payload.get("data", {}).get("share")
        self.assertIsNotNone(share, f"返回里应含 share 对象：{payload}")
        self.assertTrue(share.get("share_id"), "share_id 不应为空")
        self.assertEqual(share["share_type"], "public")
        self.assertEqual(share["permission"], "view")
        # DB 端到端：新建了一条 active share
        self.assertEqual(
            DocumentShare.objects.using(TABDOC_DB)
            .filter(document=self.doc, share_type="public", is_active=True)
            .count(),
            1,
            "应新建恰好 1 条 active public share",
        )

    def test_create_share_organization_view_actually_runs(self):
        """organization 分享路径 smoke test：必须带 organization_id 且等于资源所属团队。"""
        data = CreateShareRequest(
            share_type="organization",
            permission="edit",
            organization_id=str(self.organization.id),
        )
        request = self._make_request(body={
            "share_type": "organization",
            "permission": "edit",
            "organization_id": str(self.organization.id),
        })
        result = create_share(request, self.doc.id, data)
        payload, status = _extract(result)

        self.assertEqual(status, 200, f"应 200，实际 {status}：{payload}")
        share = payload["data"]["share"]
        self.assertEqual(share["share_type"], "organization")
        self.assertEqual(share["organization_id"], str(self.organization.id))

    # ── 业务约束防回归 ──

    def test_create_share_invalid_share_type_returns_400(self):
        """share_type 必须 ∈ {public, organization}，其他值走 400 validation。"""
        data = CreateShareRequest(share_type="invalid", permission="view")
        request = self._make_request(body={"share_type": "invalid"})
        result = create_share(request, self.doc.id, data)
        payload, status = _extract(result)

        self.assertEqual(status, 400, f"非法 share_type 应 400，实际 {status}：{payload}")

    def test_create_share_idempotent_upsert(self):
        """PATCH 语义：同 doc 同 share_type 调用两次应复用同一 share_id，
        active share 数量始终为 1。"""
        data1 = CreateShareRequest(
            share_type="public",
            permission="view",
            acknowledge_public_exposure=True,
        )
        data2 = CreateShareRequest(share_type="public", permission="edit")
        request1 = self._make_request(
            body={
                "share_type": "public",
                "permission": "view",
                "acknowledge_public_exposure": True,
            },
        )
        request2 = self._make_request(body={"share_type": "public", "permission": "edit"})

        result1 = create_share(request1, self.doc.id, data1)
        payload1, status1 = _extract(result1)
        self.assertEqual(status1, 200)
        share_id_1 = payload1["data"]["share"]["share_id"]

        result2 = create_share(request2, self.doc.id, data2)
        payload2, status2 = _extract(result2)
        self.assertEqual(status2, 200)
        share_id_2 = payload2["data"]["share"]["share_id"]

        self.assertEqual(share_id_1, share_id_2, "同 doc 同 share_type 应复用同一 share_id")
        self.assertEqual(payload2["data"]["share"]["permission"], "edit", "permission 应被更新")
        self.assertEqual(
            DocumentShare.objects.using(TABDOC_DB)
            .filter(document=self.doc, share_type="public", is_active=True)
            .count(),
            1,
            "active share 数量应始终为 1，不允许重复建 active 行",
        )

    def test_get_close_refresh_share_view_smoke(self):
        """顺路 smoke 测下 get / close / refresh 三个 view 都能跑通，
        防同类 kwarg 错位回归（任何一个炸都直接 TypeError）。"""
        # 先建一个 share
        data = CreateShareRequest(
            share_type="public",
            permission="view",
            acknowledge_public_exposure=True,
        )
        create_share(
            self._make_request(
                body={
                    "share_type": "public",
                    "acknowledge_public_exposure": True,
                },
            ),
            self.doc.id,
            data,
        )

        # GET：能查到 share + enabled=True
        get_result = get_share(
            self._make_request(method="GET"), self.doc.id, share_type="public",
        )
        get_payload, get_status = _extract(get_result)
        self.assertEqual(get_status, 200)
        self.assertTrue(get_payload["data"]["enabled"])

        # REFRESH：换 share_id 不改 active
        refresh_result = refresh_share(
            self._make_request(method="POST"), self.doc.id, share_type="public",
        )
        refresh_payload, refresh_status = _extract(refresh_result)
        self.assertEqual(refresh_status, 200)
        self.assertIn("share", refresh_payload.get("data", {}))

        # CLOSE：关掉 public share
        close_result = close_share(
            self._make_request(method="DELETE"), self.doc.id, share_type="public",
        )
        close_payload, close_status = _extract(close_result)
        self.assertEqual(close_status, 200)
        self.assertEqual(close_payload["data"]["disabled_count"], 1, "应关掉 1 条 active share")
        self.assertEqual(
            DocumentShare.objects.using(TABDOC_DB)
            .filter(document=self.doc, share_type="public", is_active=True)
            .count(),
            0,
            "关闭后不应有 active public share",
        )

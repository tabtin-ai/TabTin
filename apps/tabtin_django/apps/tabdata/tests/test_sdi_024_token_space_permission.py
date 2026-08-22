"""
SDI-024 回归测试

SDI-024: API Token 管理端点必须校验调用方对绑定 space_ids 的访问权限。

验证:
- create_token: space_id 归属校验（API 层纵深防御）
- update_token: space_ids 变更时的权限校验 + manageable 检查
- delete_token: manageable 检查
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabdata.api_token import (
    CreateTokenRequest,
    UpdateTokenRequest,
    create_token,
    delete_token,
    update_token as update_api_token,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models_token import TableApiToken
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


def _ensure_membership(organization, space, user, role="editor"):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"name": user.get_display_name(), "type": "human", "is_active": True},
    )
    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={"role": role, "is_active": True},
    )


def _unwrap(resp):
    """统一解包 Django Ninja 响应格式。"""
    if isinstance(resp, tuple):
        return resp[0], resp[1]
    if hasattr(resp, "status_code"):
        import json
        return resp.status_code, json.loads(resp.content)
    return 200, resp


class SDI024CreateTokenSpacePermissionTests(TestCase):
    """SDI-024: create_token 必须校验调用方对 space_id 的访问权限。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()

        self.owner = User.objects.create_user(
            username=f"sdi024_owner_{uuid.uuid4().hex[:6]}",
            email=f"sdi024_owner_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.outsider = User.objects.create_user(
            username=f"sdi024_outsider_{uuid.uuid4().hex[:6]}",
            email=f"sdi024_outsider_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

        self.organization = Organization.objects.create(name="sdi024-ws", owner=self.owner)
        self.space = Space.objects.create(organization=self.organization, name="sdi024-space")
        _ensure_membership(self.organization, self.space, self.owner, "owner")

        self.foreign_organization = Organization.objects.create(name="sdi024-foreign-ws", owner=self.outsider)
        self.foreign_space = Space.objects.create(organization=self.foreign_organization, name="sdi024-foreign-space")
        _ensure_membership(self.foreign_organization, self.foreign_space, self.outsider, "owner")

    def test_create_token_rejects_inaccessible_space_id(self):
        """调用方无权访问 space_id 时，应返回 403。"""
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateTokenRequest(
            name="foreign-space-token",
            scopes=["table:read"],
            space_id=str(self.foreign_space.id),
        )
        status, payload = _unwrap(create_token(request, body))

        self.assertEqual(status, 403, f"应返回 403，实际返回 {status}: {payload}")
        self.assertIn("PERMISSION_DENIED", str(payload.get("code", "")))

    def test_create_token_allows_accessible_space_id(self):
        """调用方有权访问 space_id 时，应成功创建。"""
        request = self.factory.post("/fake")
        request.auth = self.owner
        request.api_token = None

        body = CreateTokenRequest(
            name="own-space-token",
            scopes=["table:read"],
            space_id=str(self.space.id),
        )
        status, payload = _unwrap(create_token(request, body))

        self.assertEqual(status, 200, f"应返回 200，实际返回 {status}: {payload}")
        self.assertTrue(payload.get("success", False))


class SDI024UpdateTokenSpacePermissionTests(TestCase):
    """SDI-024: update_token 变更 space_ids 时必须校验权限。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()

        self.owner = User.objects.create_user(
            username=f"sdi024u_owner_{uuid.uuid4().hex[:6]}",
            email=f"sdi024u_owner_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

        self.organization = Organization.objects.create(name="sdi024u-ws", owner=self.owner)
        self.space = Space.objects.create(organization=self.organization, name="sdi024u-space")
        _ensure_membership(self.organization, self.space, self.owner, "owner")

        self.foreign_owner = User.objects.create_user(
            username=f"sdi024u_foreign_{uuid.uuid4().hex[:6]}",
            email=f"sdi024u_foreign_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.foreign_organization = Organization.objects.create(name="sdi024u-fws", owner=self.foreign_owner)
        self.foreign_space = Space.objects.create(organization=self.foreign_organization, name="sdi024u-fspace")
        _ensure_membership(self.foreign_organization, self.foreign_space, self.foreign_owner, "owner")

        self.token, _ = TableApiToken.create_token(
            user=self.owner,
            name="sdi024-update-test",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
        )

    def test_update_token_rejects_inaccessible_space_ids(self):
        """更新 space_ids 到无权访问的 space 时，应返回 403。"""
        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        body = UpdateTokenRequest(space_ids=[str(self.foreign_space.id)])
        status, payload = _unwrap(update_api_token(request, token_id=self.token.id, body=body))

        self.assertEqual(status, 403, f"应返回 403，实际返回 {status}: {payload}")

    def test_update_token_allows_accessible_space_ids(self):
        """更新 space_ids 到有权访问的 space 时，应成功。"""
        request = self.factory.patch("/fake")
        request.auth = self.owner
        request.api_token = None

        body = UpdateTokenRequest(name="renamed-token")
        status, payload = _unwrap(update_api_token(request, token_id=self.token.id, body=body))

        self.assertEqual(status, 200, f"应返回 200，实际返回 {status}: {payload}")


class SDI024DeleteTokenManageableTests(TestCase):
    """SDI-024: delete_token 通过 API Token 调用时必须检查 manageable 约束。"""

    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()

        self.owner = User.objects.create_user(
            username=f"sdi024d_owner_{uuid.uuid4().hex[:6]}",
            email=f"sdi024d_owner_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

        self.organization = Organization.objects.create(name="sdi024d-ws", owner=self.owner)
        self.space = Space.objects.create(organization=self.organization, name="sdi024d-space")
        _ensure_membership(self.organization, self.space, self.owner, "owner")

        self.parent_token, _ = TableApiToken.create_token(
            user=self.owner,
            name="parent",
            scopes=["table:read", "token:manage"],
            space_ids=[str(self.space.id)],
        )
        self.child_token, _ = TableApiToken.create_token(
            user=self.owner,
            parent_token=self.parent_token,
            actor_token=self.parent_token,
            name="child",
            scopes=["table:read"],
            space_ids=[str(self.space.id)],
        )
        self.sibling_token, _ = TableApiToken.create_token(
            user=self.owner,
            name="sibling",
            scopes=["table:read", "token:manage"],
            space_ids=[str(self.space.id)],
        )

    def test_delete_via_jwt_succeeds(self):
        """通过 JWT 调用 delete_token 应成功。"""
        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = None

        status, payload = _unwrap(delete_token(request, token_id=self.child_token.id))

        self.assertEqual(status, 200, f"应返回 200，实际返回 {status}: {payload}")

    def test_delete_via_api_token_rejects_non_descendant(self):
        """通过 API Token 删除非后代 Token 时，应返回 403。"""
        request = self.factory.delete("/fake")
        request.auth = self.owner
        request.api_token = self.parent_token

        status, payload = _unwrap(delete_token(request, token_id=self.sibling_token.id))

        self.assertEqual(status, 403, f"应返回 403，实际返回 {status}: {payload}")
        self.assertIn("PERMISSION_DENIED", str(payload.get("code", "")))

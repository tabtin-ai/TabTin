"""
CD-003 回归测试：list_connectors 端点使用查询参数 space_id 时权限校验正常工作。

根因：@require_space_access 装饰器从 kwargs.get('space_id') 读取，对查询参数始终为 None，
导致所有请求返回 400。修复后改用函数体内 _ensure_space_access() 调用。
"""

import uuid
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabdata.api_connector import list_connectors
from apps.tabdata.tests.test_permissions import _ensure_free_tier
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.tabtinspace.signals import create_default_organization

User = get_user_model()


def _setup_membership(organization, space, user, role):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={"name": user.username, "type": "human", "is_active": True},
    )
    SpaceMembership.objects.update_or_create(
        workspace=space,
        agent=agent,
        defaults={"role": role, "is_active": True, "invited_by": user},
    )


def _prepare_request(factory, owner, organization, space, *, api_token=None):
    """构造带有 Open API scope 解析所需属性的 request。"""
    request = factory.get("/fake", {"space_id": str(space.id)})
    request.auth = owner
    request.api_token = api_token
    request._api_organization_id = str(organization.id)
    request._api_space_id = str(space.id)
    return request


class ListConnectorsSpaceAccessTests(TestCase):
    """验证 list_connectors 端点在 space_id 作为查询参数时能正确执行权限校验。"""

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
            username="cd003_owner", email="cd003_owner@test.com", password="pass123"
        )
        self.outsider = User.objects.create_user(
            username="cd003_outsider", email="cd003_outsider@test.com", password="pass123"
        )

        self.organization = Organization.objects.create(name="CD003 WS", owner=self.owner)
        self.space = Space.objects.create(organization=self.organization, name="CD003 Space")
        _setup_membership(self.organization, self.space, self.owner, "owner")

    def test_list_connectors_succeeds_with_query_param_space_id(self):
        """CD-003 核心回归：space_id 作为查询参数传入时不再返回 400。"""
        request = _prepare_request(
            self.factory, self.owner, self.organization, self.space,
        )

        mock_svc = MagicMock()
        mock_svc.list_connectors.return_value = []

        with patch(
            "apps.tabdata.services.connector_service.ConnectorService",
            return_value=mock_svc,
        ):
            result = list_connectors(request, space_id=str(self.space.id))

        if isinstance(result, tuple):
            status, payload = result
        else:
            status = 200
            payload = result

        self.assertEqual(status, 200, f"Expected 200, got {status}. Response: {payload}")
        self.assertTrue(payload["success"])

    def test_list_connectors_does_not_return_400_missing_parameter(self):
        """CD-003 核心断言：修复后不再因 space_id 为 None 触发 MISSING_PARAMETER 400。"""
        request = _prepare_request(
            self.factory, self.owner, self.organization, self.space,
        )

        mock_svc = MagicMock()
        mock_svc.list_connectors.return_value = []

        with patch(
            "apps.tabdata.services.connector_service.ConnectorService",
            return_value=mock_svc,
        ):
            result = list_connectors(request, space_id=str(self.space.id))

        if isinstance(result, tuple):
            status, payload = result
            self.assertNotEqual(status, 400, "CD-003 regression: should not return 400")
            if isinstance(payload, dict):
                self.assertNotEqual(
                    payload.get("code"), "MISSING_PARAMETER",
                    "CD-003 regression: should not return MISSING_PARAMETER",
                )

    def test_list_connectors_rejects_outsider(self):
        """无 Space 访问权限的用户应被拒绝（非 200）。"""
        request = self.factory.get("/fake", {"space_id": str(self.space.id)})
        request.auth = self.outsider
        request.api_token = None
        request._api_organization_id = str(self.organization.id)
        request._api_space_id = str(self.space.id)

        result = list_connectors(request, space_id=str(self.space.id))

        self.assertIsInstance(result, tuple, "Expected error tuple for outsider")
        status, _ = result
        self.assertIn(status, (403, 404), f"Expected 403 or 404, got {status}")

    def test_list_connectors_rejects_nonexistent_space(self):
        """不存在的 space_id 应被拒绝（非 200）。"""
        fake_id = str(uuid.uuid4())
        request = self.factory.get("/fake", {"space_id": fake_id})
        request.auth = self.owner
        request.api_token = None
        request._api_organization_id = str(self.organization.id)
        request._api_space_id = fake_id

        result = list_connectors(request, space_id=fake_id)

        self.assertIsInstance(result, tuple, "Expected error tuple for nonexistent space")
        status, _ = result
        self.assertIn(status, (403, 404), f"Expected 403 or 404, got {status}")

    def test_list_connectors_rejects_restricted_api_token(self):
        """API Token 绑定了不同 Space 时应被拒绝。"""
        from apps.tabdata.models_token import TableApiToken

        other_space = Space.objects.create(organization=self.organization, name="Other Space")
        _setup_membership(self.organization, other_space, self.owner, "owner")

        token_instance, _ = TableApiToken.create_token(
            user=self.owner,
            name="restricted-token",
            scopes=["connector:read"],
            space_ids=[str(other_space.id)],
        )

        request = _prepare_request(
            self.factory, self.owner, self.organization, self.space,
            api_token=token_instance,
        )

        result = list_connectors(request, space_id=str(self.space.id))

        self.assertIsInstance(result, tuple, "Expected error tuple for restricted token")
        status, _ = result
        self.assertEqual(status, 403)

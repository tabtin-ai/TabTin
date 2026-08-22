"""
CR-035 / CR-036 / CR-037 并发竞态回归测试

CR-035: Token 限额检查必须在 transaction.atomic + select_for_update 内执行
CR-036: validate_parent_delegation 在事务内必须对祖先行加锁
CR-037: _ensure_token_manageable_by_request 必须在事务内加锁遍历委托链
"""

from __future__ import annotations

import uuid
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.db import connections, transaction
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.tabdata.api_token import (
    CreateTokenRequest,
    create_token,
    _ensure_token_manageable_by_request,
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
    if isinstance(resp, tuple):
        return resp[0], resp[1]
    if hasattr(resp, "status_code"):
        import json
        return resp.status_code, json.loads(resp.content)
    return 200, resp


def _make_request(factory, user, *, api_token=None):
    request = factory.post("/fake")
    request.auth = user
    request.api_token = api_token
    return request


class CR035TokenLimitAtomicTests(TestCase):
    """CR-035: 限额检查必须在 select_for_update + transaction.atomic 内。"""

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
        self.user = User.objects.create_user(
            username=f"cr035_{uuid.uuid4().hex[:6]}",
            email=f"cr035_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )
        self.organization = Organization.objects.create(name="cr035-ws", owner=self.user)
        self.space = Space.objects.create(organization=self.organization, name="cr035-space")
        _ensure_membership(self.organization, self.space, self.user, "owner")

    def test_limit_reached_rejects_creation(self):
        """达到 20 个 Token 限额后，新创建应被拒绝。"""
        for i in range(20):
            TableApiToken.create_token(
                user=self.user,
                name=f"token-{i}",
                scopes=["table:read"],
                space=self.space,
                space_ids=[str(self.space.id)],
            )

        request = _make_request(self.factory, self.user)
        body = CreateTokenRequest(
            name="token-overflow",
            scopes=["table:read"],
            space_id=str(self.space.id),
        )
        status, payload = _unwrap(create_token(request, body))
        self.assertEqual(status, 400, f"应返回 400，实际: {status}: {payload}")

    def test_limit_check_uses_select_for_update(self):
        """限额检查 QuerySet 必须使用 select_for_update 防并发。"""
        for i in range(18):
            TableApiToken.create_token(
                user=self.user,
                name=f"token-{i}",
                scopes=["table:read"],
                space=self.space,
                space_ids=[str(self.space.id)],
            )

        original_select_for_update = TableApiToken.objects.using(TABDATA_DB_ALIAS).__class__.select_for_update
        sfu_called = {"value": False}

        def tracking_sfu(self_qs, *args, **kwargs):
            sfu_called["value"] = True
            return original_select_for_update(self_qs, *args, **kwargs)

        with patch.object(
            TableApiToken.objects.using(TABDATA_DB_ALIAS).__class__,
            'select_for_update',
            tracking_sfu,
        ):
            request = _make_request(self.factory, self.user)
            body = CreateTokenRequest(
                name="token-sfu-check",
                scopes=["table:read"],
                space_id=str(self.space.id),
            )
            status, payload = _unwrap(create_token(request, body))

        self.assertEqual(status, 200, f"创建应成功: {payload}")
        self.assertTrue(sfu_called["value"], "限额检查必须使用 select_for_update")

    def test_limit_per_space_isolation(self):
        """不同 Space 的 Token 限额互不影响。"""
        space_b = Space.objects.create(organization=self.organization, name="cr035-space-b")
        _ensure_membership(self.organization, space_b, self.user, "owner")

        for i in range(20):
            TableApiToken.create_token(
                user=self.user,
                name=f"space-a-token-{i}",
                scopes=["table:read"],
                space=self.space,
                space_ids=[str(self.space.id)],
            )

        request = _make_request(self.factory, self.user)
        body = CreateTokenRequest(
            name="space-b-token",
            scopes=["table:read"],
            space_id=str(space_b.id),
        )
        status, payload = _unwrap(create_token(request, body))
        self.assertEqual(status, 200, f"Space B 未满额，创建应成功: {payload}")


class CR036ValidateParentDelegationLockTests(TestCase):
    """CR-036: validate_parent_delegation 在事务内必须对祖先链加锁。"""

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
        self.user = User.objects.create_user(
            username=f"cr036_{uuid.uuid4().hex[:6]}",
            email=f"cr036_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

    def test_lock_ancestors_param_accepted(self):
        """validate_parent_delegation 接受 lock_ancestors 参数。"""
        root, _ = TableApiToken.create_token(
            user=self.user,
            name="root",
            scopes=["table:read"],
        )
        child, _ = TableApiToken.create_token(
            user=self.user,
            parent_token=root,
            name="child",
            scopes=["table:read"],
        )
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            child_refreshed = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=child.pk)
            child_refreshed.validate_parent_delegation(lock_ancestors=True)

    def test_save_in_transaction_locks_ancestors(self):
        """在事务内调用 save() 时，validate_parent_delegation 应自动启用 lock_ancestors。"""
        root, _ = TableApiToken.create_token(
            user=self.user,
            name="root-lock",
            scopes=["table:read"],
        )
        child, _ = TableApiToken.create_token(
            user=self.user,
            parent_token=root,
            name="child-lock",
            scopes=["table:read"],
        )

        lock_ancestors_values = []
        original_vpd = TableApiToken.validate_parent_delegation

        def tracking_vpd(self_inst, *, lock_ancestors=False):
            lock_ancestors_values.append(lock_ancestors)
            return original_vpd(self_inst, lock_ancestors=lock_ancestors)

        with patch.object(TableApiToken, 'validate_parent_delegation', tracking_vpd):
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                child_refreshed = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=child.pk)
                child_refreshed.name = "child-lock-renamed"
                child_refreshed.save()

        self.assertTrue(
            any(v is True for v in lock_ancestors_values),
            f"在事务内 save() 应传 lock_ancestors=True，实际: {lock_ancestors_values}",
        )

    def test_save_outside_transaction_no_lock(self):
        """事务外调用 save() 时，不应请求锁（避免无事务 select_for_update 报错）。"""
        root, _ = TableApiToken.create_token(
            user=self.user,
            name="root-nolock",
            scopes=["table:read"],
        )

        lock_ancestors_values = []
        original_vpd = TableApiToken.validate_parent_delegation

        def tracking_vpd(self_inst, *, lock_ancestors=False):
            lock_ancestors_values.append(lock_ancestors)
            return original_vpd(self_inst, lock_ancestors=lock_ancestors)

        with patch.object(TableApiToken, 'validate_parent_delegation', tracking_vpd):
            root_refreshed = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=root.pk)
            root_refreshed.name = "root-nolock-renamed"
            root_refreshed.save()

        self.assertTrue(
            all(v is False for v in lock_ancestors_values),
            f"事务外 save() 应传 lock_ancestors=False，实际: {lock_ancestors_values}",
        )

    def test_deep_chain_validation_with_lock(self):
        """3 层委托链在事务内加锁校验通过。"""
        root, _ = TableApiToken.create_token(
            user=self.user, name="deep-root", scopes=["table:read"],
        )
        mid, _ = TableApiToken.create_token(
            user=self.user, parent_token=root, name="deep-mid", scopes=["table:read"],
        )
        leaf, _ = TableApiToken.create_token(
            user=self.user, parent_token=mid, name="deep-leaf", scopes=["table:read"],
        )

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            leaf_refreshed = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=leaf.pk)
            leaf_refreshed.validate_parent_delegation(lock_ancestors=True)


class CR037ManageableByRequestTransactionTests(TestCase):
    """CR-037: _ensure_token_manageable_by_request 必须在事务内加锁校验委托链。"""

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
        self.user = User.objects.create_user(
            username=f"cr037_{uuid.uuid4().hex[:6]}",
            email=f"cr037_{uuid.uuid4().hex[:6]}@test.com",
            password="pass123",
        )

    def test_descendant_is_manageable(self):
        """父 Token 应能管理其后代 Token。"""
        parent, _ = TableApiToken.create_token(
            user=self.user, name="parent-037", scopes=["table:read", "token:manage"],
        )
        child, _ = TableApiToken.create_token(
            user=self.user, parent_token=parent, name="child-037", scopes=["table:read"],
        )

        request = _make_request(self.factory, self.user, api_token=parent)
        result = _ensure_token_manageable_by_request(request, child)
        self.assertIsNone(result, "父 Token 应能管理后代")

    def test_non_descendant_is_rejected(self):
        """不相关的 Token 不应被管理。"""
        token_a, _ = TableApiToken.create_token(
            user=self.user, name="token-a-037", scopes=["table:read", "token:manage"],
        )
        token_b, _ = TableApiToken.create_token(
            user=self.user, name="token-b-037", scopes=["table:read"],
        )

        request = _make_request(self.factory, self.user, api_token=token_a)
        result = _ensure_token_manageable_by_request(request, token_b)
        self.assertIsNotNone(result, "无关 Token 应被拒绝管理")

    def test_manageable_check_uses_lock_chain(self):
        """权限检查必须使用 lock_chain=True 遍历委托链。"""
        parent, _ = TableApiToken.create_token(
            user=self.user, name="parent-lock-037", scopes=["table:read", "token:manage"],
        )
        child, _ = TableApiToken.create_token(
            user=self.user, parent_token=parent, name="child-lock-037", scopes=["table:read"],
        )

        lock_chain_values = []
        original_method = TableApiToken.is_self_or_descendant_of

        def tracking_method(self_inst, ancestor, *, lock_chain=False):
            lock_chain_values.append(lock_chain)
            return original_method(self_inst, ancestor, lock_chain=lock_chain)

        with patch.object(TableApiToken, 'is_self_or_descendant_of', tracking_method):
            request = _make_request(self.factory, self.user, api_token=parent)
            _ensure_token_manageable_by_request(request, child)

        self.assertTrue(
            any(v is True for v in lock_chain_values),
            f"_ensure_token_manageable_by_request 必须传 lock_chain=True，实际: {lock_chain_values}",
        )

    def test_jwt_caller_bypasses_manageable_check(self):
        """JWT 调用（无 api_token）应跳过管理权检查。"""
        token, _ = TableApiToken.create_token(
            user=self.user, name="jwt-bypass-037", scopes=["table:read"],
        )

        request = _make_request(self.factory, self.user, api_token=None)
        result = _ensure_token_manageable_by_request(request, token)
        self.assertIsNone(result, "JWT 调用应跳过管理权限检查")

    def test_self_token_is_manageable(self):
        """Token 应能管理自身。"""
        token, _ = TableApiToken.create_token(
            user=self.user, name="self-037", scopes=["table:read", "token:manage"],
        )

        request = _make_request(self.factory, self.user, api_token=token)
        result = _ensure_token_manageable_by_request(request, token)
        self.assertIsNone(result, "Token 应能管理自身")

"""后台用户详情钱包摘要挂载回归。

全量 PG TestCase 受 Space 退役后历史 migration（如 skills.0013）阻断，
见  同类问题。本文件用 SimpleTestCase + mock 锁定 UUID/str 键契约。
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.users.auth.admin_api import _build_related_maps, _serialize_user


class AdminUserWalletMapKeyNormalizationTests(SimpleTestCase):
    def test_build_related_maps_hits_wallet_when_organization_id_is_uuid(self):
        """OrganizationWallet.organization_id 为 UUID 时仍能按 str(user_id) 挂上钱包。"""
        user_id = "468a51a7-6e10-4c11-9f22-abcdef08905b"
        org_uuid = uuid4()
        wallet = SimpleNamespace(
            id="wallet-1",
            organization_id=org_uuid,
            credits=208,
            credits_precise="208.0000",
            credits_frozen=0,
            credits_frozen_precise="0.0000",
        )

        org_qs = MagicMock()
        org_qs.filter.return_value.values_list.return_value = [
            (user_id, org_uuid),
        ]

        wallet_qs = MagicMock()
        wallet_qs.filter.return_value = [wallet]

        with patch(
            "apps.tabtinspace.models.Organization"
        ) as organization_model, patch(
            "apps.users.auth.admin_api.OrganizationWallet"
        ) as wallet_model, patch(
            "apps.users.auth.admin_api.UserSession"
        ) as session_model:
            organization_model.objects = MagicMock()
            organization_model.objects.filter.return_value = org_qs.filter.return_value

            wallet_model.objects = MagicMock()
            wallet_model.objects.filter.return_value = wallet_qs.filter.return_value

            session_qs = MagicMock()
            session_qs.filter.return_value.values.return_value.annotate.return_value = []
            session_model.objects = session_qs

            wallet_map, _ = _build_related_maps([user_id])

        self.assertIn(user_id, wallet_map)
        self.assertIs(wallet_map[user_id], wallet)

        user = SimpleNamespace(
            id=user_id,
            username="wang",
            nickname="王旭明",
            email=None,
            phone=None,
            is_staff=False,
            is_superuser=False,
            is_verified_email=False,
            is_verified_phone=False,
            date_joined=datetime(2026, 7, 25, tzinfo=timezone.utc),
            last_login=None,
            login_count=0,
            failed_login_attempts=0,
            get_display_name=lambda: "王旭明",
        )
        with patch(
            "apps.users.auth.admin_api._resolve_user_role", return_value="user"
        ), patch(
            "apps.users.auth.admin_api._resolve_user_status", return_value="active"
        ):
            serialized = _serialize_user(user, wallet_map, {})

        self.assertIsNotNone(serialized.wallet)
        self.assertEqual(serialized.wallet.credits, 208)

    def test_build_related_maps_normalizes_uuid_owner_and_session_user_id(self):
        """owner_id / session.user_id 若以 UUID 返回，映射键仍统一为 str。"""
        owner_uuid = uuid4()
        user_id = str(owner_uuid)
        org_uuid = uuid4()
        wallet = SimpleNamespace(organization_id=org_uuid, id="wallet-2")

        org_filter = MagicMock()
        org_filter.values_list.return_value = [(owner_uuid, org_uuid)]

        session_annotate = MagicMock()
        session_annotate.return_value = [{"user_id": owner_uuid, "count": 3}]
        session_values = MagicMock()
        session_values.annotate = session_annotate
        session_filter = MagicMock()
        session_filter.values.return_value = session_values

        with patch(
            "apps.tabtinspace.models.Organization"
        ) as organization_model, patch(
            "apps.users.auth.admin_api.OrganizationWallet"
        ) as wallet_model, patch(
            "apps.users.auth.admin_api.UserSession"
        ) as session_model:
            organization_model.objects.filter.return_value = org_filter
            wallet_model.objects.filter.return_value = [wallet]
            session_model.objects.filter.return_value = session_filter

            wallet_map, session_count_map = _build_related_maps([user_id])

        self.assertIn(user_id, wallet_map)
        self.assertIs(wallet_map[user_id], wallet)
        self.assertEqual(session_count_map.get(user_id), 3)

    def test_uuid_dict_key_mismatch_reproduces_pre_fix_bug(self):
        """对照：旧写法用 UUID 做 key、用 str 查找会 miss。"""
        org_uuid = uuid4()
        buggy = {org_uuid: "wallet"}
        self.assertIsNone(buggy.get(str(org_uuid)))
        fixed = {str(org_uuid): "wallet"}
        self.assertEqual(fixed.get(str(org_uuid)), "wallet")

"""#5315 / ：邀请协作者使用显式 nickname 搜索模式。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.db.models import Q
from django.test import SimpleTestCase

from apps.tabtinspace.services.organization_service import OrganizationService


def _q_fields(q: Q) -> set[str]:
    fields: set[str] = set()
    for child in q.children:
        if isinstance(child, tuple):
            fields.add(child[0])
        elif isinstance(child, Q):
            fields.update(_q_fields(child))
    return fields


class ListMembersSearchBehaviorTests(SimpleTestCase):
    """验证分享昵称模式与默认宽搜索模式的字段边界。"""

    def _search_q(self, mock_member, search_mode: str) -> Q:
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.order_by.return_value = qs
        qs.count.return_value = 0
        qs.__getitem__.return_value = []
        mock_member.objects.filter.return_value = qs

        service = OrganizationService(user=MagicMock())
        with patch.object(service, "get_member_role", return_value="owner"):
            service.list_members(uuid4(), search="81", search_mode=search_mode, limit=20)

        search_q = qs.filter.call_args_list[0].args[0]
        self.assertIsInstance(search_q, Q)
        return search_q

    @patch.object(OrganizationService, "check_organization_permission", return_value=True)
    @patch("apps.tabtinspace.services.organization_service.OrganizationMember")
    def test_nickname_mode_filters_visible_identity_only(self, mock_member, _mock_perm):
        search_q = self._search_q(mock_member, "nickname")
        self.assertEqual(
            _q_fields(search_q),
            {
                "user__nickname__icontains",
                "user__username__icontains",
                "user__nickname_pinyin__icontains",
                "user__nickname_pinyin_initials__icontains",
            },
        )

    @patch.object(OrganizationService, "check_organization_permission", return_value=True)
    @patch("apps.tabtinspace.services.organization_service.OrganizationMember")
    def test_default_mode_preserves_wide_member_search(self, mock_member, _mock_perm):
        search_q = self._search_q(mock_member, "")
        self.assertEqual(
            _q_fields(search_q),
            {
                "user__nickname__icontains",
                "user__username__icontains",
                "user__nickname_pinyin__icontains",
                "user__nickname_pinyin_initials__icontains",
                "user__email__icontains",
                "user__phone__icontains",
                "user__id__icontains",
            },
        )

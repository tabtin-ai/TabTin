from unittest.mock import Mock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabtinspace.services.organization_service import OrganizationService


class OrganizationMemberPrivacyUnitTests(SimpleTestCase):
    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationMember.objects.filter"
    )
    def test_editor_phone_search_only_builds_public_identity_filter(
        self,
        member_filter,
    ):
        queryset = Mock()
        queryset.filter.return_value = queryset
        queryset.order_by.return_value = queryset
        queryset.count.return_value = 0
        member_filter.return_value = queryset
        service = OrganizationService(user=Mock(id="editor-1"))

        with (
            patch.object(service, "check_organization_permission", return_value=True),
            patch.object(service, "get_member_role", return_value="editor"),
        ):
            service.list_members(uuid4(), search="+8613800000001")

        identity_filter = queryset.filter.call_args.args[0]
        filter_text = str(identity_filter)
        self.assertIn("user__nickname__icontains", filter_text)
        self.assertIn("user__username__icontains", filter_text)
        self.assertNotIn("user__phone__icontains", filter_text)
        self.assertNotIn("user__email__icontains", filter_text)
        self.assertNotIn("user__id__icontains", filter_text)

    @patch(
        "apps.tabtinspace.services.organization_service.OrganizationMember.objects.filter"
    )
    def test_owner_phone_search_keeps_member_management_filter(
        self,
        member_filter,
    ):
        queryset = Mock()
        queryset.filter.return_value = queryset
        queryset.order_by.return_value = queryset
        queryset.count.return_value = 1
        member_filter.return_value = queryset
        service = OrganizationService(user=Mock(id="owner-1"))

        with (
            patch.object(service, "check_organization_permission", return_value=True),
            patch.object(service, "get_member_role", return_value="owner"),
        ):
            service.list_members(uuid4(), search="+8613800000001")

        filter_text = str(queryset.filter.call_args.args[0])
        self.assertIn("user__phone__icontains", filter_text)
        self.assertIn("user__email__icontains", filter_text)
        self.assertIn("user__id__icontains", filter_text)

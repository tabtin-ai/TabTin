"""Sensitive-action list must filter by organization_id on the server."""

from django.test import TestCase

from apps.users.auth.admin_audit import filter_sensitive_actions_by_organization
from apps.users.auth.models import AdminSensitiveActionLog


class AdminSensitiveActionsOrganizationFilterTests(TestCase):
    databases = {"default"}

    ORG_A = "11111111-1111-1111-1111-111111111111"
    ORG_B = "22222222-2222-2222-2222-222222222222"

    def setUp(self):
        self.direct_hit = AdminSensitiveActionLog.objects.create(
            permission_code="organization:disable",
            action="organization.control_policy.update",
            target_type="organization",
            target_id=self.ORG_A,
            reason="suspend org A",
            before_json={"is_suspended": False},
            after_json={"is_suspended": True},
        )
        self.nested_hit = AdminSensitiveActionLog.objects.create(
            permission_code="trash:delete",
            action="trash.resource.delete",
            target_type="context_item",
            target_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            reason="delete trash item in org A",
            before_json={
                "context_item_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "organization_id": self.ORG_A,
            },
            after_json={"permanently_deleted": True},
        )
        self.miss = AdminSensitiveActionLog.objects.create(
            permission_code="organization:disable",
            action="organization.control_policy.update",
            target_type="organization",
            target_id=self.ORG_B,
            reason="suspend org B",
            before_json={"organization_id": self.ORG_B},
            after_json={"organization_id": self.ORG_B, "is_suspended": True},
        )
        self.unrelated = AdminSensitiveActionLog.objects.create(
            permission_code="credit_package:update",
            action="credit_package.delete",
            target_type="credit_package",
            target_id="pkg-1",
            reason="delete package",
            before_json={"name": "starter"},
            after_json={"status": "deleted"},
        )

    def test_filter_matches_target_id_and_nested_json(self):
        qs = filter_sensitive_actions_by_organization(
            AdminSensitiveActionLog.objects.all(),
            self.ORG_A,
        )
        ids = set(qs.values_list("id", flat=True))
        self.assertEqual(ids, {self.direct_hit.id, self.nested_hit.id})

    def test_filter_empty_organization_id_is_noop(self):
        qs = filter_sensitive_actions_by_organization(
            AdminSensitiveActionLog.objects.all(),
            "   ",
        )
        self.assertEqual(qs.count(), 4)

    def test_filter_does_not_return_other_org_rows(self):
        qs = filter_sensitive_actions_by_organization(
            AdminSensitiveActionLog.objects.all(),
            self.ORG_B,
        )
        ids = set(qs.values_list("id", flat=True))
        self.assertEqual(ids, {self.miss.id})

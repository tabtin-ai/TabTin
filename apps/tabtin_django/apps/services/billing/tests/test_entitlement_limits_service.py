from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.services.billing.services.entitlement_limits_service import (
    EntitlementLimitExceeded,
    EntitlementLimitsService,
)
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabdoc.services.document_service import DocumentService
from apps.users.membership.exceptions import MembershipException, QuotaExceededError
from apps.users.membership.services.quota_service import QuotaService
from apps.services.billing.tests.org_test_utils import fake_org_id


class _NoopAtomic:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _mock_organization_lock():
    manager = MagicMock()
    manager.using.return_value.select_for_update.return_value.get.return_value = SimpleNamespace(id="wt-1")
    return manager


class EntitlementQuotaUsageTests(SimpleTestCase):
    def test_max_documents_usage_counts_active_non_trashed_documents(self):
        queryset = MagicMock()
        queryset.count.return_value = 12

        with patch("apps.tabdoc.models.Document.objects.filter", return_value=queryset) as mock_filter:
            usage = QuotaService()._get_current_usage("max_documents", organization_id=fake_org_id("wt-1"))

        self.assertEqual(usage, 12)
        mock_filter.assert_called_once_with(
            organization_id=fake_org_id("wt-1"),
            status__in=("active", "archived"),
            trashed_at__isnull=True,
        )

    def test_max_groups_usage_counts_organization_group_conversations_only(self):
        queryset = MagicMock()
        queryset.count.return_value = 4

        with patch("apps.tabchat.models.Conversation.objects.filter", return_value=queryset) as mock_filter:
            usage = QuotaService()._get_current_usage("max_groups", organization_id=fake_org_id("wt-1"))

        self.assertEqual(usage, 4)
        kwargs = mock_filter.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], fake_org_id("wt-1"))
        self.assertEqual(int(kwargs["type"]), 2)
        # 已归档群组不占用额度，与会话列表可见集合对齐
        self.assertEqual(kwargs["is_archived"], False)

    def test_fail_close_quota_usage_query_error_is_not_treated_as_zero(self):
        with patch(
            "apps.tabdoc.models.Document.objects.filter",
            side_effect=RuntimeError("db unavailable"),
        ):
            with self.assertRaises(RuntimeError):
                QuotaService()._get_current_usage("max_documents", organization_id=fake_org_id("wt-1"))


class EntitlementLimitsServiceTests(SimpleTestCase):
    def test_document_limit_exceeded_uses_standard_code_and_message(self):
        with patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
            side_effect=QuotaExceededError(
                quota_type="max_documents",
                limit=10,
                current=10,
            ),
        ):
            with self.assertRaises(EntitlementLimitExceeded) as raised:
                EntitlementLimitsService.check_document_limit("wt-1")

        self.assertEqual(raised.exception.code, "ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED")
        self.assertEqual(raised.exception.quota_key, "max_documents")
        self.assertEqual(raised.exception.used, 10)
        self.assertEqual(raised.exception.limit, 10)
        self.assertIn("文档额度已用完", str(raised.exception))

    def test_group_limit_passes_through_quota_result(self):
        with patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
            return_value={
                "allowed": True,
                "limit": 30,
                "current": 2,
                "remaining": 28,
                "source": "organization",
            },
        ):
            result = EntitlementLimitsService.check_group_limit("wt-1")

        self.assertTrue(result["allowed"])
        self.assertEqual(result["quota_key"], "max_groups")
        self.assertEqual(result["used"], 2)
        self.assertEqual(result["limit"], 30)

    def test_group_limit_missing_free_tier_fails_open_with_diagnostic_source(self):
        with patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
            side_effect=MembershipException("未找到可用的会员等级"),
        ):
            result = EntitlementLimitsService.check_group_limit("wt-1", actor="user-1")

        self.assertTrue(result["allowed"])
        self.assertEqual(result["quota_key"], "max_groups")
        self.assertEqual(result["limit"], -1)
        self.assertEqual(result["source"], "missing_tier_fail_open")

    def test_group_limit_other_membership_errors_still_raise(self):
        with patch(
            "apps.users.membership.services.quota_service.QuotaService.check_quota",
            side_effect=MembershipException("未定义的配额类型: max_groups"),
        ):
            with self.assertRaises(MembershipException):
                EntitlementLimitsService.check_group_limit("wt-1", actor="user-1")


class EntitlementResourceEntryPointTests(SimpleTestCase):
    def test_document_create_checks_entitlement_before_insert(self):
        organization_id = str(uuid4())
        space_id = str(uuid4())
        user = SimpleNamespace(id=str(uuid4()), is_authenticated=True, is_active=True)
        service = DocumentService(user=user)

        with patch.object(service, "check_space_permission", return_value=True), patch.object(
            service,
            "_ensure_space_context",
            return_value=SimpleNamespace(id=space_id, organization_id=organization_id),
        ), patch(
            "apps.services.billing.services.entitlement_limits_service.EntitlementLimitsService.check_document_limit",
            side_effect=EntitlementLimitExceeded(
                code="ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED",
                message="当前套餐文档额度已用完，请升级套餐或购买文档扩容包。",
                quota_key="max_documents",
                used=10,
                limit=10,
                plan_limit=10,
            ),
        ) as mock_check, patch(
            "apps.tabdoc.services.document_service.transaction.atomic",
            return_value=_NoopAtomic(),
        ), patch(
            "apps.tabtinspace.models.Organization.objects",
            _mock_organization_lock(),
        ), patch(
            "apps.tabdoc.services.document_service.Space.objects",
        ) as space_objects, patch("apps.tabdoc.models.Document.objects.create") as mock_create:
            space_objects.select_for_update.return_value.filter.return_value.first.return_value = SimpleNamespace(
                id=space_id,
            )
            with self.assertRaises(EntitlementLimitExceeded):
                service.create_document(
                    organization_id=organization_id,
                    space_id=space_id,
                    parent_id=None,
                    title="blocked",
                    initial_content_pm_json={},
                    initial_content_markdown="",
                    initial_content_plaintext="",
                )

        mock_check.assert_called_once_with(organization_id, actor=user)
        mock_create.assert_not_called()

    def test_group_create_checks_entitlement_before_insert(self):
        with patch(
            "apps.services.billing.services.entitlement_limits_service.EntitlementLimitsService.check_group_limit",
            side_effect=EntitlementLimitExceeded(
                code="ENTITLEMENT_GROUP_LIMIT_EXCEEDED",
                message="当前套餐群组额度已用完，请升级套餐或购买群组扩容包。",
                quota_key="max_groups",
                used=3,
                limit=3,
                plan_limit=3,
            ),
        ) as mock_check, patch.object(ConversationService, "_validate_organization_members") as mock_validate, patch(
            "apps.tabchat.services.conversation_service.transaction.atomic",
            return_value=_NoopAtomic(),
        ), patch(
            "apps.tabchat.services.conversation_service.Organization.objects",
            _mock_organization_lock(),
        ), patch(
            "apps.tabchat.models.Conversation.objects.create",
        ) as mock_create:
            with self.assertRaises(EntitlementLimitExceeded):
                ConversationService.create_group(
                    organization_id=fake_org_id("wt-1"),
                    creator_id="user-1",
                    name="blocked",
                    member_ids=["user-2"],
                )

        mock_check.assert_called_once_with(fake_org_id("wt-1"), actor="user-1")
        mock_validate.assert_called_once_with(fake_org_id("wt-1"), ["user-2"])
        mock_create.assert_not_called()

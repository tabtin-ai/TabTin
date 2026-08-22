"""Personal organization 补偿与 signal 收口回归测试。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import close_old_connections
from django.test import SimpleTestCase, TransactionTestCase

from apps.tabtinspace.models import Organization, OrganizationProviderCreditClaim
from apps.tabtinspace.services.organization_service import OrganizationService


class PersonalOrganizationCompensationTests(SimpleTestCase):
    @patch("apps.tabtinspace.tasks.logger")
    def test_do_compensate_targets_users_missing_personal_organization(self, mock_logger):
        from apps.tabtinspace.tasks import _do_compensate

        user_without_personal = SimpleNamespace(id="user-missing", get_display_name=lambda: "Missing")
        user_objects = MagicMock()
        user_objects.exclude.return_value.order_by.return_value.values_list.return_value = ["user-missing"]
        user_objects.get.return_value = user_without_personal
        User = SimpleNamespace(objects=user_objects)

        organization_objects = MagicMock()
        organization_objects.filter.return_value.values_list.return_value.distinct.return_value = ["user-has-personal"]
        Organization = SimpleNamespace(
            objects=organization_objects,
            OrganizationType=SimpleNamespace(PERSONAL="personal"),
        )

        ensure_personal_organization = MagicMock(
            return_value=(SimpleNamespace(id="wt-1"), True)
        )
        OrganizationService = SimpleNamespace(ensure_personal_organization=ensure_personal_organization)

        stats = _do_compensate(User, Organization, OrganizationService, transaction=None)

        self.assertEqual(stats, {"checked": 1, "compensated": 1, "failed": 0})
        user_objects.exclude.assert_called_once_with(id__in=["user-has-personal"])
        ensure_personal_organization.assert_called_once_with(
            user_without_personal,
            extra_settings={"compensated": True},
        )
        mock_logger.info.assert_called()

    @patch("apps.tabtinspace.signals.logger")
    @patch("apps.tabtinspace.tasks.compensate_missing_default_organization")
    @patch("apps.tabtinspace.signals.Organization")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.ensure_personal_organization")
    def test_signal_schedules_compensation_when_ensure_fails(
        self,
        mock_ensure_personal_organization,
        mock_organization,
        mock_compensate_task,
        mock_logger,
    ):
        from apps.tabtinspace.signals import create_default_organization

        user = SimpleNamespace(id="user-1", get_display_name=lambda: "User")
        mock_organization.objects.filter.return_value.exists.return_value = False
        mock_ensure_personal_organization.side_effect = RuntimeError("pg unavailable")

        create_default_organization(sender=None, instance=user, created=True)

        mock_compensate_task.delay.assert_called_once_with()
        mock_logger.error.assert_called()

    @patch("apps.tabtinspace.signals.logger")
    @patch("apps.tabtinspace.signals.Organization")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.ensure_personal_organization")
    def test_signal_skips_duplicate_creation_when_personal_organization_exists(
        self,
        mock_ensure_personal_organization,
        mock_organization,
        mock_logger,
    ):
        from apps.tabtinspace.signals import create_default_organization

        user = SimpleNamespace(id="user-1", get_display_name=lambda: "User")
        mock_organization.objects.filter.return_value.exists.return_value = True

        create_default_organization(sender=None, instance=user, created=True)

        mock_ensure_personal_organization.assert_not_called()
        mock_logger.info.assert_called()


class PersonalOrganizationConcurrencyTests(TransactionTestCase):
    databases = {"default"}
    reset_sequences = False

    def test_concurrent_ensure_creates_one_personal_organization_and_claim(self):
        with patch.object(
            OrganizationService,
            "ensure_personal_organization",
            return_value=(None, False),
        ):
            owner = get_user_model().objects.create_user(
                username="personal_org_concurrent_owner",
                email="personal_org_concurrent_owner@test.local",
                password="test-pass-123",
            )
        barrier = Barrier(2)

        def _ensure():
            close_old_connections()
            try:
                thread_owner = get_user_model().objects.get(pk=owner.pk)
                barrier.wait(timeout=10)
                organization, created = (
                    OrganizationService.ensure_personal_organization(
                        thread_owner
                    )
                )
                return str(organization.id), created
            finally:
                close_old_connections()

        with (
            patch.object(OrganizationService, "provision_organization_defaults"),
            patch.object(OrganizationService, "provision_billing"),
            patch.object(OrganizationService, "provision_builtin_extensions"),
            patch.object(
                OrganizationService,
                "_dispatch_new_organization_provider_credits",
            ),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            results = list(executor.map(lambda _: _ensure(), range(2)))

        self.assertEqual(len({organization_id for organization_id, _ in results}), 1)
        self.assertEqual(sum(created for _, created in results), 1)
        self.assertEqual(
            Organization.objects.filter(
                owner=owner,
                type=Organization.OrganizationType.PERSONAL,
            ).count(),
            1,
        )
        claim = OrganizationProviderCreditClaim.objects.get(user_id=owner.id)
        self.assertEqual(claim.eligibility_order, 1)

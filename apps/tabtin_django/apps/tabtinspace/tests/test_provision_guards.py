"""Provision 守卫回归测试。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.core.exceptions import ImproperlyConfigured
from django.db.utils import OperationalError
from django.test import SimpleTestCase, override_settings


class ProvisionGuardTests(SimpleTestCase):
    def test_billing_schema_drift_operational_error_is_non_retriable(self):
        from apps.tabtinspace.services.organization_service import OrganizationService

        self.assertTrue(
            OrganizationService._is_non_retriable_provision_error(
                OperationalError("(1054, \"Unknown column 'users_membership_workspace_membership.organization_id'\")")
            )
        )

    @patch("apps.tabtinspace.tasks.logger")
    @patch("apps.tabtinspace.models.Organization")
    @patch("apps.tabtinspace.services.organization_service.OrganizationService.provision_billing")
    def test_retry_provision_billing_stops_retrying_on_hard_failure(
        self,
        mock_provision_billing,
        mock_organization,
        mock_logger,
    ):
        from apps.tabtinspace.tasks import _do_retry_provision_billing

        mock_organization.objects.filter.return_value.exists.return_value = True
        mock_provision_billing.side_effect = ImproperlyConfigured("schema drift")
        retry_mock = MagicMock(side_effect=AssertionError("retry should not be called"))
        task_self = MagicMock()
        task_self.request.retries = 0
        task_self.retry = retry_mock

        with self.assertRaises(ImproperlyConfigured):
            _do_retry_provision_billing(task_self, "wt-1", MagicMock(provision_billing=mock_provision_billing))

        retry_mock.assert_not_called()
        mock_logger.error.assert_called()

    @override_settings(DEBUG=False, SECRET_KEY="test-secret", CREDENTIAL_ENCRYPTION_KEY="invalid-key")
    def test_invalid_encryption_key_raises_improperly_configured(self):
        from apps.extensions.fields import _get_fernet

        with self.assertRaises(ImproperlyConfigured):
            _get_fernet()

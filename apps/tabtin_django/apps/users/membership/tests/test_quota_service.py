from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.users.membership.services.quota_service import QuotaService, _quota_exceeded_message


class QuotaServiceUsageScopeTests(SimpleTestCase):
    def test_max_tables_usage_requires_organization_scope(self):
        with patch("apps.tabdata.models.Table.objects.filter") as mock_filter:
            usage = QuotaService()._get_current_usage("max_tables")

        self.assertEqual(usage, 0)
        mock_filter.assert_not_called()

    def test_max_tables_usage_counts_organization_tables(self):
        queryset = MagicMock()
        queryset.count.return_value = 7

        with patch("apps.tabdata.models.Table.objects.filter", return_value=queryset) as mock_filter:
            usage = QuotaService()._get_current_usage(
                "max_tables",
                organization_id="wt-1",
            )

        self.assertEqual(usage, 7)
        mock_filter.assert_called_once_with(
            organization_id="wt-1",
            is_archived=False,
            trashed_at__isnull=True,
        )


class QuotaExceededMessageTests(SimpleTestCase):
    def test_max_tables_uses_user_facing_label(self):
        message = _quota_exceeded_message("max_tables", 21, 20)
        self.assertIn("可创建表格数量", message)
        self.assertNotIn("max_tables", message)
        self.assertEqual(message, "组织可创建表格数量已达上限：已用 21 / 上限 20")

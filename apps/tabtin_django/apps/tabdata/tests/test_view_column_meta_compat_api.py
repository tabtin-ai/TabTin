import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'tabtin.settings')

import django

django.setup()

from apps.tabdata import api_view


class ViewColumnMetaCompatApiTestCase(unittest.TestCase):
    def test_get_summary_api_returns_success_payload(self):
        request = SimpleNamespace(auth=SimpleNamespace(id='user-1'))
        snapshot = {
            'process_local': True,
            'prometheus_metric': 'tabtin_view_column_meta_compat_usage_total',
            'warning_throttle': {'warn_first_n': 5, 'warn_checkpoints': [10, 20, 50, 100]},
            'total_legacy_alias_usages': 3,
            'sources': [
                {'source': 'TableViewCreate.columnMeta', 'shape': 'map', 'count': 3},
            ],
        }

        with patch(
            'apps.tabdata.api_view.get_view_column_meta_compat_summary',
            return_value=snapshot,
        ) as mocked_summary:
            response = api_view.get_view_column_meta_compat_summary_api(request)

        mocked_summary.assert_called_once_with()
        self.assertTrue(response['success'])
        self.assertEqual(response['data'], snapshot)


if __name__ == '__main__':
    unittest.main()

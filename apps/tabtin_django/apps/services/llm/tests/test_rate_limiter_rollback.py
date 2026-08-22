"""Provider 限流工具单测。"""
from __future__ import annotations

import os
from unittest.mock import patch

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
if not django.apps.apps.ready:
    django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.llm.services.rate_limiter import check_provider_rate_limit  # noqa: E402


class TestProviderRateLimitRollback(SimpleTestCase):
    def test_rejected_attempt_does_not_inflate_counter(self):
        provider_id = "prov-rollback-test"
        with patch("apps.services.llm.services.rate_limiter.cache") as mock_cache:
            mock_cache.add.return_value = False
            mock_cache.incr.side_effect = [61, 60]

            first = check_provider_rate_limit(
                provider_id,
                rate_limit=60,
                service_tag="llm",
            )
            second = check_provider_rate_limit(
                provider_id,
                rate_limit=60,
                service_tag="llm",
            )

        self.assertIsNotNone(first)
        self.assertEqual(first.get("error_code"), "RATE_LIMIT")
        mock_cache.decr.assert_called_once()
        self.assertIsNone(second)

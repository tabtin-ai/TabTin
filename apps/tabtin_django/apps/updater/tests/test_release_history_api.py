"""GET /updates/releases 客户端版本历史接口回归。

运行方式：
    cd apps/tabtin_django
    ./venv/bin/python manage.py test apps.updater.tests.test_release_history_api \
        --settings=tabtin.settings_updater_progress_test
"""

from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from apps.updater.models import AppRelease


RELEASES_URL = "/api/updates/releases"


class ReleaseHistoryApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()

    def _make_release(self, *, version: str, published_at=None, **overrides) -> AppRelease:
        defaults = dict(
            version=version,
            platform="win",
            arch="x64",
            channel="beta",
            file_url=f"https://cdn.example.com/desktop-updates/beta/win/x64/{version}/TabTin.exe",
            file_size=1024,
            checksum_sha256="a" * 64,
            checksum_sha512="b" * 88,
            is_draft=False,
            published_at=published_at or timezone.now(),
            release_notes=f"{version} 中文更新说明",
            release_notes_en=f"{version} English notes",
            priority="normal",
        )
        defaults.update(overrides)
        return AppRelease.objects.create(**defaults)

    def test_returns_published_history_for_platform_arch_channel(self):
        now = timezone.now()
        latest = self._make_release(version="1.2.0", published_at=now)
        older = self._make_release(version="1.1.0", published_at=now - timedelta(days=1))

        self._make_release(version="9.9.0", platform="mac", published_at=now + timedelta(days=1))
        self._make_release(version="1.3.0", is_draft=True, published_at=None)
        self._make_release(version="1.0.0", deprecated_at=now)

        response = self.client.get(
            RELEASES_URL,
            {
                "platform": "win",
                "arch": "x64",
                "channel": "beta",
                "limit": 10,
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()["data"]
        self.assertEqual([item["version"] for item in payload["items"]], [latest.version, older.version])
        self.assertEqual(payload["items"][0]["release_notes"], "1.2.0 中文更新说明")
        self.assertEqual(payload["items"][0]["release_notes_en"], "1.2.0 English notes")
        self.assertEqual(payload["items"][0]["published_at"], latest.published_at.isoformat())

    def test_history_response_does_not_expose_update_source_fields(self):
        self._make_release(version="1.2.0")

        response = self.client.get(
            RELEASES_URL,
            {
                "platform": "win",
                "arch": "x64",
                "channel": "beta",
            },
        )

        self.assertEqual(response.status_code, 200)
        item = response.json()["data"]["items"][0]
        sensitive_fields = {
            "file_url",
            "feed_url",
            "manifest_url",
            "manifest_file",
            "file_size",
            "checksum",
            "checksum_sha256",
            "checksum_sha512",
        }
        self.assertFalse(sensitive_fields.intersection(item.keys()))

    def test_limit_is_bounded(self):
        now = timezone.now()
        for index in range(3):
            self._make_release(
                version=f"1.{index}.0",
                published_at=now - timedelta(minutes=index),
            )

        response = self.client.get(
            RELEASES_URL,
            {
                "platform": "win",
                "arch": "x64",
                "channel": "beta",
                "limit": 2,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["data"]["items"]), 2)

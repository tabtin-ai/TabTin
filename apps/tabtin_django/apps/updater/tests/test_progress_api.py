"""POST /updates/progress 进度上报回归。

重点覆盖：同一设备同一目标版本存在多条进行中记录时不再 500
（原实现用 get_or_create 触发 MultipleObjectsReturned）。

运行方式（专用最小 settings，见 settings_updater_progress_test 模块说明）：
    cd apps/tabtin_django
    ./venv/bin/python manage.py test apps.updater.tests.test_progress_api \\
        --settings=tabtin.settings_updater_progress_test
"""
import json
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase

from apps.updater.models import UpdateLog
from apps.users.auth.permissions import JWTAuth

User = get_user_model()

PROGRESS_URL = "/api/updates/progress"


class ProgressReportApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.client = Client()
        self.user = User.objects.create_user(
            username="desktop_user",
            email="desktop-user@test.com",
            password="pass123",
        )
        # progress 端点要求 JWT；这里直接旁路 token 校验，聚焦业务逻辑
        self._auth_patcher = patch.object(JWTAuth, "authenticate", return_value=self.user)
        self._auth_patcher.start()
        self.addCleanup(self._auth_patcher.stop)

    def _post_progress(self, payload: dict):
        return self.client.post(
            PROGRESS_URL,
            data=json.dumps(payload),
            content_type="application/json",
            HTTP_AUTHORIZATION="Bearer test-token",
        )

    def _make_log(self, status="available", **overrides) -> UpdateLog:
        defaults = dict(
            device_id="device-1",
            to_version="1.2.0",
            from_version="1.0.0",
            platform="mac",
            arch="arm64",
            channel="stable",
            trigger_source="http_poll",
            status=status,
            progress=0,
        )
        defaults.update(overrides)
        return UpdateLog.objects.create(**defaults)

    def test_multiple_in_flight_logs_do_not_crash(self):
        """同设备同版本多条进行中记录：更新最新一条，不 500。"""
        self._make_log(status="available")
        latest = self._make_log(status="checking")

        response = self._post_progress(
            {
                "version": "1.2.0",
                "status": "downloading",
                "progress": 42,
                "device_id": "device-1",
            }
        )

        self.assertEqual(response.status_code, 200)
        latest.refresh_from_db()
        self.assertEqual(latest.status, "downloading")
        self.assertEqual(latest.progress, 42)
        # 没有凭空新建第三条
        self.assertEqual(
            UpdateLog.objects.filter(device_id="device-1", to_version="1.2.0").count(), 2
        )

    def test_creates_log_when_no_in_flight_record(self):
        response = self._post_progress(
            {
                "version": "1.3.0",
                "status": "downloading",
                "progress": 10,
                "from_version": "1.2.0",
                "device_id": "device-2",
            }
        )

        self.assertEqual(response.status_code, 200)
        log = UpdateLog.objects.get(device_id="device-2", to_version="1.3.0")
        self.assertEqual(log.status, "downloading")
        self.assertEqual(log.from_version, "1.2.0")

    def test_failed_status_marks_existing_log_failed(self):
        log = self._make_log(status="downloading")

        response = self._post_progress(
            {
                "version": "1.2.0",
                "status": "failed",
                "progress": 0,
                "device_id": "device-1",
                "error_code": "DOWNLOAD_ERROR",
                "error_message": "network unreachable",
            }
        )

        self.assertEqual(response.status_code, 200)
        log.refresh_from_db()
        self.assertEqual(log.status, "failed")
        self.assertFalse(log.success)
        self.assertEqual(log.error_code, "DOWNLOAD_ERROR")

    def test_installed_status_marks_existing_log_success(self):
        log = self._make_log(status="downloaded")

        response = self._post_progress(
            {
                "version": "1.2.0",
                "status": "installed",
                "progress": 100,
                "device_id": "device-1",
            }
        )

        self.assertEqual(response.status_code, 200)
        log.refresh_from_db()
        self.assertEqual(log.status, "installed")
        self.assertTrue(log.success)
        self.assertIsNotNone(log.completed_at)

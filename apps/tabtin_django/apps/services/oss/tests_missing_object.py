"""#10907: OSS 对象不存在是预期缺失，不应打 error 进 Sentry。"""

from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.services.oss.services.aliyun_oss import AliyunOSSService


class FakeNoSuchKey(Exception):
    code = "NoSuchKey"
    status = 404


class OSSMissingObjectLoggingTests(SimpleTestCase):
    def _service(self):
        svc = AliyunOSSService.__new__(AliyunOSSService)
        svc.config = {"bucket_name": "test", "endpoint": "oss.example.com"}
        svc.logger = MagicMock()
        return svc

    def test_nosuchkey_is_file_not_found_warning(self):
        svc = self._service()

        result = svc._handle_exception(
            "download_file",
            FakeNoSuchKey("The specified key does not exist."),
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["error_code"], "FILE_NOT_FOUND")
        svc.logger.error.assert_not_called()
        svc.logger.warning.assert_called()

    def test_access_denied_still_logs_error(self):
        svc = self._service()

        result = svc._handle_exception(
            "download_file",
            Exception("AccessDenied: not allowed"),
        )

        self.assertEqual(result["error_code"], "ACCESS_DENIED")
        svc.logger.error.assert_called()
        svc.logger.warning.assert_not_called()

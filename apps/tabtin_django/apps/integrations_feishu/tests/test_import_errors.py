from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuAPIError
from apps.integrations_feishu.import_errors import user_facing_import_error


class UserFacingImportErrorTests(SimpleTestCase):
    def test_deleted_bitable_and_docx_share_one_chinese_message(self):
        cases = (
            FeishuAPIError("note has been deleted", code=1002),
            FeishuAPIError("docs deleted", status_code=403),
        )

        self.assertEqual(
            [user_facing_import_error(exc) for exc in cases],
            ["资源已被删除或无法访问", "资源已被删除或无法访问"],
        )

    def test_api_error_does_not_expose_code_http_or_english(self):
        message = user_facing_import_error(
            FeishuAPIError("internal failure", code=12345, status_code=500),
        )

        self.assertEqual(message, "飞书资源导入失败，请稍后重试")
        self.assertNotIn("12345", message)
        self.assertNotIn("HTTP", message)
        self.assertNotIn("internal", message)

    def test_unexpected_error_uses_generic_chinese_message(self):
        self.assertEqual(
            user_facing_import_error(RuntimeError("permission denied for schema")),
            "资源导入失败，请稍后重试",
        )

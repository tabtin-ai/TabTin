"""：公开表格分享密码头解析（无 DB）。"""

from __future__ import annotations

from django.test import RequestFactory, SimpleTestCase

from apps.tabdata.api_share import _share_password_from_headers


class SharePasswordHeaderParsingTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()

    def test_prefers_canonical_table_share_password_header(self):
        request = self.factory.get(
            "/shared/x/records",
            HTTP_X_TABLE_SHARE_PASSWORD="canon",
            HTTP_X_SHARE_PASSWORD="legacy",
        )
        self.assertEqual(_share_password_from_headers(request), "canon")

    def test_falls_back_to_legacy_x_share_password(self):
        request = self.factory.get(
            "/shared/x/records",
            HTTP_X_SHARE_PASSWORD="legacy",
        )
        self.assertEqual(_share_password_from_headers(request), "legacy")

    def test_empty_when_absent(self):
        request = self.factory.get("/shared/x/records")
        self.assertEqual(_share_password_from_headers(request), "")

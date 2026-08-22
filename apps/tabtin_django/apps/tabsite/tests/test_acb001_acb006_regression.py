"""
ACB-001 / ACB-006 回归测试

ACB-001: 密码保护假安全感 — 设置密码的公开站点不应被 403 拦截，
         因为密码验证页面未实现，拦截只会导致完全无法访问。
ACB-006: Agent 提示词不应误导 Agent 设置密码保护。
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import logging  # noqa: E402
import uuid  # noqa: E402
from unittest.mock import patch, MagicMock  # noqa: E402

from django.test import RequestFactory, SimpleTestCase  # noqa: E402

from apps.tabsite.views import site_access  # noqa: E402
from apps.services.common.app_registry import APP_SECTIONS  # noqa: E402

SECTION_TABSITE = APP_SECTIONS["tabsite"]


def _make_site(**overrides):
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-site",
        "status": "published",
        "dist_oss_url": "https://cdn.example.com/sites/test-site/v1/",
        "is_public": True,
        "password": "",
        "total_views": 0,
        "current_version": 1,
    }
    defaults.update(overrides)

    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)

    site.Status = MagicMock()
    site.Status.PUBLISHED = "published"

    return site


class TestACB001_PasswordBypass(SimpleTestCase):
    """ACB-001: 密码保护功能暂未实现，设置密码不应阻止访问。"""

    def setUp(self):
        self.rf = RequestFactory()

    @patch("apps.tabsite.views.Site")
    def test_public_site_with_password_redirects_not_403(self, mock_site_cls):
        """核心回归：公开站点即使设置了密码，也应正常重定向（302），不返回 403。"""
        site = _make_site(password="pbkdf2_sha256$hashed_value")
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 302, (
            f"ACB-001 回归：密码站点不应返回 403，应正常重定向。实际状态码: {response.status_code}"
        )
        assert response["Location"].endswith("/index.html")

    @patch("apps.tabsite.views.Site")
    def test_password_site_emits_warning_log(self, mock_site_cls):
        """密码站点被放行时应产生 warning 日志（方便追踪）。"""
        site = _make_site(password="pbkdf2_sha256$hashed_value")
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        with self.assertLogs("apps.tabsite.views", level="WARNING") as cm:
            site_access(request, "test-site")

        assert any("密码验证功能未实现" in msg for msg in cm.output), (
            f"ACB-001 回归：密码站点放行时应输出 warning 日志。日志: {cm.output}"
        )

    @patch("apps.tabsite.views.Site")
    def test_non_public_site_still_returns_403(self, mock_site_cls):
        """is_public=False 的拦截行为不受影响。"""
        site = _make_site(is_public=False)
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 403

    @patch("apps.tabsite.views.Site")
    def test_no_password_site_still_redirects(self, mock_site_cls):
        """无密码公开站点行为不变。"""
        site = _make_site(password="")
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 302

    @patch("apps.tabsite.views.Site")
    def test_password_site_increments_view_count(self, mock_site_cls):
        """密码站点放行后，访问量计数器仍应递增。"""
        site = _make_site(password="pbkdf2_sha256$hashed_value")
        mock_filter = MagicMock()
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = mock_filter
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        site_access(request, "test-site")

        mock_site_cls.objects.filter.assert_called_once_with(id=site.id)
        mock_filter.update.assert_called_once()


class TestACB006_PromptNoPasswordMisleading(SimpleTestCase):
    """ACB-006: Agent 提示词不应误导 Agent 设置密码保护。"""

    def test_prompt_does_not_claim_password_protection_works(self):
        """提示词不应说"可通过 update_site 设置密码保护"。"""
        assert "可通过 update_site 设置密码保护" not in SECTION_TABSITE, (
            "ACB-006 回归：提示词仍包含误导性密码保护描述"
        )

    def test_prompt_warns_password_not_available(self):
        """提示词应明确标注密码保护功能暂不可用。"""
        assert "密码保护功能暂不可用" in SECTION_TABSITE, (
            "ACB-006 回归：提示词缺少密码功能不可用的警告"
        )

    def test_prompt_update_site_tool_warns_password(self):
        """update_site 工具描述应标注 password 参数暂不可用。"""
        tool_table_idx = SECTION_TABSITE.find("| 工具 | 风险 |")
        assert tool_table_idx != -1, "提示词缺少工具列表表格"
        tool_table = SECTION_TABSITE[tool_table_idx:]
        update_row_idx = tool_table.find("tabsite.update_site")
        assert update_row_idx != -1, "工具表格缺少 update_site 行"
        row_end = tool_table.find("\n", update_row_idx)
        update_row = tool_table[update_row_idx:row_end]
        assert "password" in update_row.lower() and "暂不可用" in update_row, (
            f"ACB-006 回归：update_site 工具行未标注 password 参数暂不可用。行内容: {update_row}"
        )

    def test_prompt_recommends_is_public_for_access_control(self):
        """提示词应推荐使用 is_public=False 而非密码来控制访问。"""
        assert "is_public=False" in SECTION_TABSITE, (
            "ACB-006 回归：提示词未推荐 is_public=False 作为访问控制手段"
        )

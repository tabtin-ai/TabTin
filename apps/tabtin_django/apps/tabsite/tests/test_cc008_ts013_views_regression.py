"""
CC-008 / TS-013 回归测试：site_access 视图 HTTP 状态码与 body 一致性

CC-008: is_public=False 和 password 非空时应返回 HTTP 403（非 404）
TS-013: HTTP 状态码与 body 内 <h1> 标签的数字必须一致
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import patch, MagicMock  # noqa: E402
from django.test import RequestFactory  # noqa: E402

from apps.tabsite.views import site_access  # noqa: E402


def _make_site(**overrides):
    """构造一个 mock Site 对象，默认为已发布、公开、有 dist URL 的正常站点。"""
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-site",
        "status": "published",
        "dist_oss_url": "https://cdn.example.com/sites/test-site/v1/",
        "is_public": True,
        "password": "",
        "total_views": 0,
    }
    defaults.update(overrides)

    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)

    site.Status = MagicMock()
    site.Status.PUBLISHED = "published"

    return site


class TestCC008_TS013_SiteAccessHTTPSemantics:
    """CC-008 + TS-013: 确保 HTTP 状态码与 body 一致。"""

    def setup_method(self):
        self.rf = RequestFactory()

    @patch("apps.tabsite.views.Site")
    def test_non_public_site_returns_403(self, mock_site_cls):
        """非公开站点应返回 HTTP 403，不是 404。"""
        site = _make_site(is_public=False)
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 403
        assert b"403" in response.content

    @patch("apps.tabsite.views.Site")
    def test_password_protected_public_site_redirects(self, mock_site_cls):
        """ACB-001 修复后：密码保护的公开站点应正常重定向（302），不再返回 403。
        密码验证功能暂未实现，拦截只是假安全感。"""
        site = _make_site(password="hashed_password_value")
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 302
        assert response["Location"].endswith("/index.html")

    @patch("apps.tabsite.views.Site")
    def test_non_public_site_never_returns_404(self, mock_site_cls):
        """回归：非公开站点不应返回 404（旧的错误行为）。"""
        site = _make_site(is_public=False)
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code != 404

    @patch("apps.tabsite.views.Site")
    def test_nonexistent_site_still_returns_404(self, mock_site_cls):
        """不存在的 slug 仍应返回 404。"""
        from apps.tabsite.models import Site as RealSite
        mock_site_cls.DoesNotExist = RealSite.DoesNotExist
        mock_site_cls.objects.get.side_effect = RealSite.DoesNotExist()

        request = self.rf.get("/s/no-such-site/")
        response = site_access(request, "no-such-site")

        assert response.status_code == 404
        assert b"404" in response.content

    @patch("apps.tabsite.views.Site")
    def test_published_public_site_redirects(self, mock_site_cls):
        """正常已发布公开站点应返回 302 重定向。"""
        site = _make_site()
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-site/")
        response = site_access(request, "test-site")

        assert response.status_code == 302
        assert response["Location"].endswith("/index.html")

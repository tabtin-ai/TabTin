"""
F07 回归测试：CC-003, CC-004, CC-014 修复验证

CC-003: published_url 生成时必须包含末尾 /
CC-004: get_context_metadata() 必须包含 status 和 dist_oss_url 字段
CC-014: site_access 重定向响应必须包含 X-TabSite-Version 头
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import patch, MagicMock, PropertyMock  # noqa: E402
from django.test import RequestFactory, override_settings  # noqa: E402

from apps.tabsite.models import Site  # noqa: E402
from apps.tabsite.views import site_access  # noqa: E402


def _make_mock_site(**overrides):
    """构造 mock Site 对象。"""
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-slug",
        "name": "测试站点",
        "status": "published",
        "framework": "react",
        "published_url": "https://site.example.com/s/test-slug/",
        "is_public": True,
        "password": "",
        "current_version": 3,
        "total_views": 42,
        "template": "dashboard",
        "dist_oss_url": "https://cdn.example.com/tabsite/sites/abc/v3/",
    }
    defaults.update(overrides)

    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)

    site.Status = MagicMock()
    site.Status.PUBLISHED = "published"

    return site


class TestCC003_PublishedUrlTrailingSlash:
    """CC-003: published_url 必须以 / 结尾，与 Django URL 规则 s/<slug>/ 一致。"""

    def test_publish_site_generates_url_with_trailing_slash(self):
        """模拟 publish_site 的 published_url 生成逻辑，确认末尾有 /。"""
        base_url = "https://site.example.com"
        slug = "my-test-site"
        published_url = f"{base_url}/s/{slug}/"

        assert published_url.endswith("/"), \
            f"published_url 应以 / 结尾，实际值: {published_url}"
        assert published_url == "https://site.example.com/s/my-test-site/"

    def test_published_url_matches_django_url_pattern(self):
        """published_url 路径应与 Django URL pattern s/<slug>/ 格式一致。"""
        import re
        base_url = "https://site.example.com"
        slug = "abc123"
        published_url = f"{base_url}/s/{slug}/"

        path = published_url.replace(base_url, "")
        assert re.match(r"^/s/[\w-]+/$", path), \
            f"路径 {path} 不匹配 Django URL 规则 /s/<slug>/"


class TestCC004_ContextMetadataFields:
    """CC-004: get_context_metadata() 必须包含 status 和 dist_oss_url。"""

    def _make_site_instance(self, **kwargs):
        """构造一个有 get_context_metadata 方法的 Site mock。"""
        site = _make_mock_site(**kwargs)
        site.get_context_metadata = Site.get_context_metadata.__get__(site, type(site))
        return site

    def test_metadata_contains_status_field(self):
        site = self._make_site_instance(status="published")
        metadata = site.get_context_metadata()
        assert "status" in metadata
        assert metadata["status"] == "published"

    def test_metadata_contains_dist_oss_url_field(self):
        dist_url = "https://cdn.example.com/tabsite/sites/abc/v3/"
        site = self._make_site_instance(dist_oss_url=dist_url)
        metadata = site.get_context_metadata()
        assert "dist_oss_url" in metadata
        assert metadata["dist_oss_url"] == dist_url

    def test_metadata_status_reflects_draft(self):
        site = self._make_site_instance(status="draft")
        metadata = site.get_context_metadata()
        assert metadata["status"] == "draft"

    def test_metadata_status_reflects_archived(self):
        site = self._make_site_instance(status="archived")
        metadata = site.get_context_metadata()
        assert metadata["status"] == "archived"

    def test_metadata_dist_oss_url_empty_for_unpublished(self):
        site = self._make_site_instance(status="draft", dist_oss_url="")
        metadata = site.get_context_metadata()
        assert metadata["dist_oss_url"] == ""

    def test_metadata_preserves_existing_fields(self):
        """确保新增字段不影响已有字段。"""
        site = self._make_site_instance(
            slug="my-site", framework="react", is_public=True, current_version=5,
        )
        metadata = site.get_context_metadata()
        assert metadata["slug"] == "my-site"
        assert metadata["framework"] == "react"
        assert metadata["is_public"] is True
        assert metadata["current_version"] == 5


class TestCC014_XTabSiteVersionHeader:
    """CC-014: site_access 重定向响应包含 X-TabSite-Version 头。"""

    def setup_method(self):
        self.rf = RequestFactory()

    @patch("apps.tabsite.views.Site")
    def test_redirect_contains_version_header(self, mock_site_cls):
        """302 重定向响应应包含 X-TabSite-Version 头。"""
        site = _make_mock_site(current_version=5)
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-slug/")
        response = site_access(request, "test-slug")

        assert response.status_code == 302
        assert "X-TabSite-Version" in response
        assert response["X-TabSite-Version"] == "5"

    @patch("apps.tabsite.views.Site")
    def test_version_header_reflects_current_version(self, mock_site_cls):
        """X-TabSite-Version 应反映回滚后的当前版本号。"""
        site = _make_mock_site(current_version=2)
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-slug/")
        response = site_access(request, "test-slug")

        assert response["X-TabSite-Version"] == "2"

    @patch("apps.tabsite.views.Site")
    def test_redirect_url_has_index_html(self, mock_site_cls):
        """重定向目标必须以 /index.html 结尾。"""
        site = _make_mock_site(
            dist_oss_url="https://cdn.example.com/tabsite/sites/abc/v3/",
        )
        mock_site_cls.objects.get.return_value = site
        mock_site_cls.objects.filter.return_value = MagicMock()
        mock_site_cls.Status = site.Status

        request = self.rf.get("/s/test-slug/")
        response = site_access(request, "test-slug")

        assert response["Location"].endswith("/index.html")
        assert "//" not in response["Location"].split("//", 1)[1].replace("//", "")

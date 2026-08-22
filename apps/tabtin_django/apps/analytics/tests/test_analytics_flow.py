"""analytics app 端到端逻辑回归：ingest 规范化 / 短链解析 / 302 跳转 / Admin 聚合。"""

from __future__ import annotations

from types import SimpleNamespace

from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.analytics import admin_api, api, services
from apps.analytics.models import AnalyticsEvent, EventSource, ShortLink
from apps.analytics.views import download_redirect


class StoreEventTest(TestCase):
    def test_normalizes_source_referrer_and_props(self):
        ev = services.store_event(
            source="not-a-real-source",
            event_name="page_view",
            referrer="https://www.google.com/search?q=tabtin",
            props={"a": "x" * 999, "nested": {"k": 1}},
        )
        assert ev is not None
        self.assertEqual(ev.source, EventSource.OTHER)  # 未知来源归一到 other
        self.assertEqual(ev.referrer_host, "www.google.com")  # 自动抽取来源域名
        self.assertLessEqual(len(ev.props["a"]), 512)  # 长字符串截断
        self.assertEqual(ev.props["nested"], "{'k': 1}")  # 复杂值转字符串

    def test_missing_event_name_returns_none(self):
        self.assertIsNone(services.store_event(source="web", event_name=""))


class ShortLinkResolveTest(TestCase):
    def test_static_target(self):
        link = ShortLink.objects.create(
            slug="static-x", name="s", target_type=ShortLink.TargetType.STATIC,
            target_url="https://cdn.example.com/app.dmg",
        )
        self.assertEqual(services.resolve_short_link_target(link), "https://cdn.example.com/app.dmg")

    def test_latest_release_target(self):
        from apps.updater.models import AppRelease

        AppRelease.objects.create(
            version="1.0.0", platform="mac", arch="arm64", channel="stable",
            file_url="https://cdn.example.com/old.dmg", is_draft=False,
            published_at=timezone.now() - timezone.timedelta(days=5),
        )
        newer = AppRelease.objects.create(
            version="1.1.0", platform="mac", arch="arm64", channel="stable",
            file_url="https://cdn.example.com/new.dmg", is_draft=False,
            published_at=timezone.now(),
        )
        link = ShortLink.objects.create(
            slug="mac-arm64", name="mac", target_type=ShortLink.TargetType.LATEST_RELEASE,
            release_platform="mac", release_arch="arm64", release_channel="stable",
        )
        # 应解析到最新已发布版本
        self.assertEqual(services.resolve_short_link_target(link), newer.file_url)

    def test_latest_release_prefers_website_file_url(self):
        from apps.updater.models import AppRelease

        AppRelease.objects.create(
            version="2.0.0",
            platform="mac",
            arch="arm64",
            channel="stable",
            file_url="https://cdn.example.com/TabTin-2.0.0-arm64-mac.zip",
            website_file_url="https://cdn.example.com/TabTin-2.0.0-arm64.dmg",
            is_draft=False,
            published_at=timezone.now(),
        )
        link = ShortLink.objects.create(
            slug="mac-arm64-website",
            name="mac",
            target_type=ShortLink.TargetType.LATEST_RELEASE,
            release_platform="mac",
            release_arch="arm64",
            release_channel="stable",
        )
        self.assertEqual(
            services.resolve_short_link_target(link),
            "https://cdn.example.com/TabTin-2.0.0-arm64.dmg",
        )

    def test_record_download_increments_and_logs(self):
        link = ShortLink.objects.create(
            slug="win-x64", name="win", target_type=ShortLink.TargetType.STATIC,
            target_url="https://cdn.example.com/setup.exe", release_platform="win", release_arch="x64",
            channel="wechat",
        )
        services.record_download(link, referrer="https://www.example.com/download")
        link.refresh_from_db()
        self.assertEqual(link.click_count, 1)
        self.assertIsNotNone(link.last_clicked_at)
        ev = AnalyticsEvent.objects.get(event_name="download")
        self.assertEqual(ev.short_link_id, link.id)
        self.assertEqual(ev.props["slug"], "win-x64")
        self.assertEqual(ev.props["channel"], "wechat")


class DownloadRedirectViewTest(TestCase):
    def setUp(self):
        self.rf = RequestFactory()

    def test_active_link_redirects_302(self):
        ShortLink.objects.create(
            slug="mac-x64", name="mac", target_type=ShortLink.TargetType.STATIC,
            target_url="https://cdn.example.com/mac.dmg",
        )
        resp = download_redirect(self.rf.get("/dl/mac-x64"), slug="mac-x64")
        self.assertEqual(resp.status_code, 302)
        self.assertEqual(resp["Location"], "https://cdn.example.com/mac.dmg")
        self.assertEqual(AnalyticsEvent.objects.filter(event_name="download").count(), 1)

    def test_missing_link_returns_404(self):
        resp = download_redirect(self.rf.get("/dl/nope"), slug="nope")
        self.assertEqual(resp.status_code, 404)

    def test_inactive_link_returns_404(self):
        ShortLink.objects.create(
            slug="off", name="off", target_type=ShortLink.TargetType.STATIC,
            target_url="https://cdn.example.com/x.dmg", is_active=False,
        )
        resp = download_redirect(self.rf.get("/dl/off"), slug="off")
        self.assertEqual(resp.status_code, 404)


class AdminAggregationTest(TestCase):
    def setUp(self):
        self.request = SimpleNamespace(auth=SimpleNamespace(id=None))
        for _ in range(3):
            services.store_event(source="web", event_name="page_view", path="/", anon_id="v1")
        services.store_event(source="web", event_name="page_view", path="/download", anon_id="v2")
        link = ShortLink.objects.create(
            slug="mac-arm64", name="mac", target_type=ShortLink.TargetType.STATIC,
            target_url="https://cdn.example.com/mac.dmg", release_platform="mac", release_arch="arm64",
        )
        services.record_download(link)

    def test_overview_counts(self):
        data = admin_api.overview(self.request, days=7)
        self.assertEqual(data["page_views"], 4)
        self.assertEqual(data["unique_visitors"], 2)  # v1 + v2
        self.assertEqual(data["downloads"], 1)
        self.assertTrue(any(p["platform"] == "mac" for p in data["platform_breakdown"]))

    def test_trends_series(self):
        data = admin_api.trends(self.request, days=7, event_name="page_view")
        total = sum(p["count"] for p in data["series"])
        self.assertEqual(total, 4)

    def test_create_and_list_short_link(self):
        payload = admin_api.ShortLinkInSchema(
            slug="linux-x64", name="linux", target_type="static",
            target_url="https://cdn.example.com/app.AppImage",
        )
        created = admin_api.create_short_link(self.request, payload)
        self.assertEqual(created["slug"], "linux-x64")
        listing = admin_api.list_short_links(self.request)
        slugs = {x["slug"] for x in listing["items"]}
        self.assertIn("linux-x64", slugs)
        self.assertIn("mac-arm64", slugs)


class SelfReferrerFilterTest(TestCase):
    """站内自我引用不应算作外部来源。"""

    def test_same_host_referrer_stripped(self):
        own = "www.example.com"
        self.assertEqual(api._external_referrer("https://www.example.com/download", own), "")

    def test_external_referrer_kept(self):
        own = "www.example.com"
        self.assertEqual(
            api._external_referrer("https://www.google.com/", own),
            "https://www.google.com/",
        )

    def test_no_own_host_keeps_referrer(self):
        self.assertEqual(
            api._external_referrer("https://www.example.com/x", ""),
            "https://www.example.com/x",
        )

    def test_origin_host_from_origin_then_referer(self):
        from types import SimpleNamespace

        req = SimpleNamespace(META={"HTTP_ORIGIN": "https://www.example.com"})
        self.assertEqual(api._origin_host(req), "www.example.com")
        req2 = SimpleNamespace(META={"HTTP_REFERER": "https://test.example.com/p"})
        self.assertEqual(api._origin_host(req2), "test.example.com")


class ResolveGeoTest(TestCase):
    """离线 IP → 地域解析（依赖 apps/analytics/data/ip2region_v4.xdb）。"""

    def test_public_cn_ip_resolves_province(self):
        country, province = services.resolve_geo("114.114.114.114")
        self.assertEqual(country, "中国")
        self.assertTrue(province)  # 省份非空

    def test_private_and_invalid_ip_return_empty(self):
        self.assertEqual(services.resolve_geo("10.0.0.1"), ("", ""))
        self.assertEqual(services.resolve_geo("127.0.0.1"), ("", ""))
        self.assertEqual(services.resolve_geo(""), ("", ""))
        self.assertEqual(services.resolve_geo("not-an-ip"), ("", ""))


class GeoAndVisitorDistributionTest(TestCase):
    def setUp(self):
        self.request = SimpleNamespace(auth=SimpleNamespace(id=None))
        # 老访客 v_old：窗口前先出现一次，窗口内再访问 → 回访
        old = services.store_event(source="web", event_name="page_view", anon_id="v_old")
        AnalyticsEvent.objects.filter(id=old.id).update(
            occurred_at=timezone.now() - timezone.timedelta(days=30)
        )
        # 地域 + 来源分布数据
        services.store_event(
            source="web", event_name="page_view", anon_id="v_old",
            geo_country="中国", geo_province="浙江省",
            referrer="https://www.google.com/search?q=x",
        )
        services.store_event(
            source="web", event_name="page_view", anon_id="v_new1",
            geo_country="中国", geo_province="浙江省",
            referrer="https://www.google.com/",
        )
        services.store_event(
            source="web", event_name="page_view", anon_id="v_new2",
            geo_country="中国", geo_province="广东省",
        )

    def test_geo_breakdown_ranks_provinces(self):
        data = admin_api.overview(self.request, days=7)
        geo = {f"{g['geo_country']}/{g['geo_province']}": g["count"] for g in data["geo_breakdown"]}
        self.assertEqual(geo.get("中国/浙江省"), 2)
        self.assertEqual(geo.get("中国/广东省"), 1)

    def test_referrer_breakdown(self):
        data = admin_api.overview(self.request, days=7)
        hosts = {r["referrer_host"]: r["count"] for r in data["referrer_breakdown"]}
        self.assertEqual(hosts.get("www.google.com"), 2)

    def test_new_vs_returning_visitors(self):
        data = admin_api.overview(self.request, days=7)
        # 窗口内独立访客：v_old, v_new1, v_new2 = 3
        self.assertEqual(data["unique_visitors"], 3)
        # v_old 在窗口前出现过 → 回访 1，新访客 2
        self.assertEqual(data["returning_visitors"], 1)
        self.assertEqual(data["new_visitors"], 2)

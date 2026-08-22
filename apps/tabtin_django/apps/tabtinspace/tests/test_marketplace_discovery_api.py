"""Marketplace AppDiscovery patterns API 测试（PRD §5.4 B3 / N5）。

覆盖：
- ``build_discovery_patterns`` service 聚合 ``MARKETPLACE_APPS`` 的
  ``embeddedWeb.urlPatterns``（**复用既有字段，不新增 discoveryPatterns**）。
- ``GET /api/marketplace/discovery-patterns`` API endpoint 行为：
  payload shape、空 marketplace、service 异常兜底、未登录可调用。
- 所有测试都用 mock fixture 注入 marketplace App，不依赖任何具体真实 manifest。

**为什么用 unittest.TestCase 而非 django.test.TestCase**：
service 与 router 都是纯 manifest 数据流，零 DB 访问；但 ``django.test.TestCase``
会触发 pytest-django 的 ``setup_databases``，本地 ``DJANGO_SETTINGS_MODULE=
tabtin.settings`` 下需要 MySQL 用户具备 ``CREATE DATABASE test_tabtin_local`` 权限，
开发机普遍缺失。改用 ``unittest.TestCase`` 完全绕过 DB 创建，符合
"测试边界与代码边界对齐"原则。
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from apps.services.common.app_registry import AppDefinition
from apps.services.common.marketplace_discovery import build_discovery_patterns


def _make_app(
    *,
    app_id: str,
    name: str,
    patterns: tuple[str, ...] = (),
    distribution: str = "marketplace",
    order: int = 0,
) -> AppDefinition:
    return AppDefinition(
        id=app_id,
        name=name,
        embedded_web_url_patterns=patterns,
        distribution=distribution,
        order=order,
    )


class BuildDiscoveryPatternsTests(unittest.TestCase):
    """``build_discovery_patterns()`` service 单元测试。"""

    def test_skips_marketplace_apps_without_patterns(self) -> None:
        with_patterns = _make_app(
            app_id="market_with",
            name="Market With",
            patterns=("*.example.com",),
        )
        without_patterns = _make_app(
            app_id="market_without",
            name="Market Without",
            patterns=(),
        )
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"market_with": with_patterns, "market_without": without_patterns},
        ):
            entries = build_discovery_patterns()

        ids = [e["appId"] for e in entries]
        self.assertIn("market_with", ids)
        self.assertNotIn("market_without", ids)

    def test_excludes_core_apps_even_if_they_declare_patterns(self) -> None:
        """CORE_APPS（builtin）即便声明了 ``embeddedWeb.urlPatterns`` 也不参与发现：
        builtin 自动安装，无需"未安装横幅"。

        构造一个 distribution=builtin 但带 patterns 的 App 放进 CORE_APPS，
        marketplace 留一个真正的 marketplace App 做对照。断言：build 结果只
        含 marketplace 那一条，builtin 完全不泄漏（防止未来改动错误把 CORE_APPS
        混入聚合）。"""
        builtin_with_patterns = _make_app(
            app_id="ghost_builtin",
            name="Ghost Builtin",
            patterns=("*.builtin.example",),
            distribution="builtin",
        )
        marketplace_real = _make_app(
            app_id="real_marketplace",
            name="Real Marketplace",
            patterns=("*.real.example",),
            distribution="marketplace",
        )
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"real_marketplace": marketplace_real},
        ), patch(
            "apps.services.common.app_registry.CORE_APPS",
            {"ghost_builtin": builtin_with_patterns},
        ):
            entries = build_discovery_patterns()
        ids = [e["appId"] for e in entries]
        self.assertEqual(ids, ["real_marketplace"])
        self.assertNotIn("ghost_builtin", ids)

    def test_orders_by_catalog_order_then_id(self) -> None:
        a = _make_app(app_id="zzz", name="ZZZ", patterns=("*.zzz",), order=10)
        b = _make_app(app_id="aaa", name="AAA", patterns=("*.aaa",), order=10)
        c = _make_app(app_id="mid", name="MID", patterns=("*.mid",), order=5)
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"zzz": a, "aaa": b, "mid": c},
        ):
            entries = build_discovery_patterns()
        self.assertEqual([e["appId"] for e in entries], ["mid", "aaa", "zzz"])

    def test_appname_falls_back_to_id_when_name_missing(self) -> None:
        nameless = _make_app(app_id="nameless", name="", patterns=("*.x.com",))
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"nameless": nameless},
        ):
            entries = build_discovery_patterns()
        self.assertEqual(entries[0]["appName"], "nameless")

    def test_patterns_emit_as_list_not_tuple(self) -> None:
        """JSON 序列化要求 list；AppDefinition 内部存储是 tuple，
        service 必须转为 list。"""
        sample = _make_app(
            app_id="needs_list",
            name="Needs List",
            patterns=("*.a.com", "*.b.com"),
        )
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"needs_list": sample},
        ):
            entries = build_discovery_patterns()
        self.assertIsInstance(entries[0]["patterns"], list)
        self.assertEqual(entries[0]["patterns"], ["*.a.com", "*.b.com"])


class DiscoveryPatternsAPITests(unittest.TestCase):
    """``GET /api/marketplace/discovery-patterns`` 视图测试。"""

    @staticmethod
    def _request() -> SimpleNamespace:
        return SimpleNamespace(
            auth=None,
            method="GET",
            META={"REMOTE_ADDR": "127.0.0.1", "HTTP_USER_AGENT": "test"},
            GET={},
        )

    def test_payload_shape_matches_renderer_contract(self) -> None:
        """字段名必须与 Electron 主进程 ``UrlPattern`` 接口对齐：
        ``appId`` / ``appName`` / ``patterns``。
        """
        from apps.tabtinspace.marketplace_api import get_discovery_patterns

        sample = _make_app(
            app_id="shape_sample",
            name="Shape Sample",
            patterns=("*.shape.example",),
        )
        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {"shape_sample": sample},
        ):
            response = get_discovery_patterns(self._request())

        patterns = response["data"]["patterns"]
        self.assertGreater(len(patterns), 0, "mock 注入的 App 应被聚合")
        for entry in patterns:
            self.assertEqual(set(entry.keys()), {"appId", "appName", "patterns"})
            self.assertIsInstance(entry["patterns"], list)
            for p in entry["patterns"]:
                self.assertIsInstance(p, str)

    def test_empty_marketplace_returns_empty_list(self) -> None:
        from apps.tabtinspace.marketplace_api import get_discovery_patterns

        with patch(
            "apps.services.common.marketplace_discovery.MARKETPLACE_APPS",
            {},
        ):
            response = get_discovery_patterns(self._request())
        self.assertTrue(response.get("success"))
        self.assertEqual(response["data"]["patterns"], [])

    def test_service_exception_falls_back_to_empty(self) -> None:
        """B3 关键不变量：service 异常时 endpoint 必须返回空 patterns，
        让 AppDiscovery 静默而非误报。"""
        from apps.tabtinspace.marketplace_api import get_discovery_patterns

        with patch(
            "apps.tabtinspace.marketplace_api.build_discovery_patterns",
            side_effect=RuntimeError("synthetic failure"),
        ):
            response = get_discovery_patterns(self._request())

        self.assertTrue(response.get("success"))
        self.assertEqual(response["data"]["patterns"], [])

    def test_endpoint_callable_without_jwt_auth(self) -> None:
        """endpoint 必须能在 ``request.auth is None`` 时返回 200。

        renderer 在登录前就要拉 patterns，而 NinjaAPI 全局默认 ``JWTAuth``，
        若 endpoint 漏写 ``auth=None``，整个 ``GET`` 会直接 401 被网关拦掉。
        本测试确认行为不变（不依赖 ninja 私有内部结构，跨版本稳定）。"""
        from apps.tabtinspace.marketplace_api import get_discovery_patterns

        response = get_discovery_patterns(self._request())
        self.assertIsInstance(response, dict)
        self.assertTrue(response.get("success"))

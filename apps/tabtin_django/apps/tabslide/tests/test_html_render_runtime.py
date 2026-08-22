"""Real-browser contracts for the TabSlide HTML rendering runtime."""

from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, MagicMock, patch

from playwright.async_api import async_playwright

from apps.tabslide.services.html_render_runtime import (
    PLATFORM_HEAD_RESOURCES_HTML,
    RenderDocumentError,
    RenderDocumentValidationError,
    load_render_document,
    wait_for_optional_render_ready,
)
from apps.tabslide.services import html_render_runtime


class HtmlRenderRuntimeTests(IsolatedAsyncioTestCase):
    async def test_missing_platform_asset_fails_before_navigation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing_path = Path(temp_dir) / "missing.js"
            with patch.dict(
                html_render_runtime._PLATFORM_ASSETS,
                {"https://cdn.example.invalid/missing.js": (missing_path, "text/javascript")},
                clear=True,
            ):
                html_render_runtime.validate_platform_assets.cache_clear()
                html_render_runtime._read_platform_asset.cache_clear()
                with self.assertRaises(RenderDocumentError) as captured:
                    html_render_runtime.validate_platform_assets()
                self.assertEqual(captured.exception.failure_kind, "platform_script_error")
        html_render_runtime.validate_platform_assets.cache_clear()
        html_render_runtime._read_platform_asset.cache_clear()

    async def test_preview_html_uses_local_fonts_instead_of_google_fonts(self):
        from apps.tabslide.services.preview_service import build_slide_html

        html = build_slide_html([])

        self.assertIn('id="tabtin-local-fonts"', html)
        self.assertNotIn("fonts.googleapis.com", html)

    async def test_platform_libraries_are_available_offline_before_inline_scripts(self):
        html = f"""<!DOCTYPE html>
        <html>
          <head>
            {PLATFORM_HEAD_RESOURCES_HTML}
            <script>
              window.__tabtinPlatformAssets = {{
                echarts: typeof window.echarts,
                chartjs: typeof window.Chart,
                mathjax: typeof window.MathJax,
              }};
            </script>
          </head>
          <body>
            <div class="ppt-slide">
              <i id="icon" class="fa-solid fa-star"></i>
              <div id="chart" style="width:320px;height:180px"></div>
              <canvas id="chartjs" width="320" height="180"></canvas>
              <div id="formula">\\(x^2 + y^2 = z^2\\)</div>
              <script>
                const chart = echarts.init(document.querySelector('#chart'));
                chart.setOption({{xAxis:{{type:'category',data:['A']}},yAxis:{{}},series:[{{type:'bar',data:[1]}}]}});
                new Chart(document.querySelector('#chartjs'), {{
                  type: 'bar',
                  data: {{labels: ['A'], datasets: [{{data: [3]}}]}},
                }});
              </script>
            </div>
          </body>
        </html>"""

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                context = await browser.new_context(offline=True)
                page = await context.new_page()

                slide_count = await load_render_document(page, html)
                await wait_for_optional_render_ready(page, timeout_seconds=5)
                asset_types = await page.evaluate("window.__tabtinPlatformAssets")
                icon_font = await page.locator("#icon").evaluate(
                    "element => getComputedStyle(element).fontFamily"
                )
                chart_canvas_count = await page.locator("#chart canvas").count()
                rendered = await page.evaluate(
                    """() => ({
                      chartjs: !!Chart.getChart(document.querySelector('#chartjs')),
                      chartPixels: document.querySelector('#chartjs').toDataURL().length,
                      mathSvg: document.querySelectorAll('#formula mjx-container svg').length,
                    })"""
                )
            finally:
                await browser.close()

        self.assertEqual(slide_count, 1)
        self.assertEqual(
            asset_types,
            {"echarts": "object", "chartjs": "function", "mathjax": "object"},
        )
        self.assertIn("Font Awesome", icon_font)
        self.assertGreater(chart_canvas_count, 0)
        self.assertTrue(rendered["chartjs"])
        self.assertGreater(rendered["chartPixels"], 1_000)
        self.assertGreater(rendered["mathSvg"], 0)

    async def test_stalled_external_script_is_aborted_before_parser_budget_expires(self):
        html = """<!DOCTYPE html>
        <html><body>
          <div class="ppt-slide" id="first"></div>
          <script src="https://unpkg.com/tabtin-stalled-fixture.js"></script>
          <div class="ppt-slide" id="second"></div>
        </body></html>"""

        async def _stall_until_route_budget_expires(*_args, **_kwargs):
            await asyncio.sleep(0.05)
            raise asyncio.TimeoutError

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                with patch(
                    "apps.tabslide.services.html_render_runtime._fetch_external_resource",
                    side_effect=_stall_until_route_budget_expires,
                ):
                    slide_count = await load_render_document(page, html)
                body_state = await page.evaluate(
                    "() => ({bodyCount: document.body ? 1 : 0, second: !!document.querySelector('#second')})"
                )
            finally:
                await browser.close()

        self.assertEqual(slide_count, 2)
        self.assertEqual(body_state, {"bodyCount": 1, "second": True})

    async def test_no_slide_is_a_fast_stable_validation_error(self):
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                started = time.monotonic()
                with self.assertRaises(RenderDocumentValidationError) as captured:
                    await load_render_document(
                        page,
                        "<!doctype html><html><body><p>no slides</p></body></html>",
                    )
                elapsed = time.monotonic() - started
            finally:
                await browser.close()

        self.assertEqual(captured.exception.failure_kind, "no_slide")
        self.assertLess(elapsed, 2)

    async def test_inline_script_error_has_a_stable_private_classification(self):
        privacy_sentinel = "PRIVATE_SCRIPT_BODY_10835"
        html = f"""<!doctype html><html><body>
        <div class="ppt-slide"></div>
        <script>throw new Error('{privacy_sentinel}')</script>
        </body></html>"""

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                with self.assertRaises(RenderDocumentError) as captured:
                    await load_render_document(page, html)
            finally:
                await browser.close()

        self.assertEqual(captured.exception.failure_kind, "script_execution_error")
        self.assertNotIn(privacy_sentinel, str(captured.exception))

    async def test_missing_platform_global_is_platform_script_error(self):
        html = f"""<!doctype html><html><head>{PLATFORM_HEAD_RESOURCES_HTML}</head>
        <body><div class="ppt-slide"></div></body></html>"""
        expected_globals = dict(html_render_runtime._PLATFORM_SCRIPT_GLOBALS)
        echarts_url = next(url for url in expected_globals if "echarts" in url)
        expected_globals[echarts_url] = "__tabtin_missing_echarts_global__"

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                with (
                    patch.dict(
                        html_render_runtime._PLATFORM_SCRIPT_GLOBALS,
                        expected_globals,
                        clear=True,
                    ),
                    self.assertRaises(RenderDocumentError) as captured,
                ):
                    await load_render_document(page, html)
            finally:
                await browser.close()

        self.assertEqual(captured.exception.failure_kind, "platform_script_error")

    async def test_legacy_platform_timeout_has_a_stable_classification(self):
        html = f"""<!doctype html><html><head>{PLATFORM_HEAD_RESOURCES_HTML}</head>
        <body><div class="ppt-slide"></div></body></html>"""

        async def _timeout(*_args, **_kwargs):
            raise asyncio.TimeoutError

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                with (
                    patch.dict(
                        "os.environ",
                        {
                            html_render_runtime._ASSET_MODE_ENV: (
                                html_render_runtime._LEGACY_ASSET_MODE
                            )
                        },
                    ),
                    patch.object(
                        html_render_runtime,
                        "_fetch_external_resource",
                        side_effect=_timeout,
                    ),
                    self.assertRaises(RenderDocumentError) as captured,
                ):
                    await load_render_document(page, html)
            finally:
                await browser.close()

        self.assertEqual(captured.exception.failure_kind, "platform_asset_timeout")

    async def test_all_external_resource_types_use_the_bounded_fetch_path(self):
        page = MagicMock()
        page.route = AsyncMock()
        page._tabtin_render_routes_installed = False
        page._tabtin_render_page_error_listener_installed = False
        page._tabtin_render_resource_count = 0
        page._tabtin_render_resource_bytes = 0
        page._tabtin_render_resource_deadline = time.monotonic() + 1
        await html_render_runtime.install_render_routes(page)
        route_handler = page.route.await_args.args[1]

        fetched = html_render_runtime.FetchedExternalResource(
            status=200,
            headers={"content-type": "application/octet-stream"},
            body=b"fixture",
        )
        for resource_type in ("script", "stylesheet", "image", "font"):
            with self.subTest(resource_type=resource_type):
                route = SimpleNamespace(
                    request=SimpleNamespace(
                        url=f"https://unpkg.com/tabtin-{resource_type}-fixture",
                        resource_type=resource_type,
                        method="GET",
                        headers={},
                    ),
                    fulfill=AsyncMock(),
                    abort=AsyncMock(),
                    continue_=AsyncMock(),
                )
                with patch.object(
                    html_render_runtime,
                    "_fetch_external_resource",
                    return_value=fetched,
                ) as fetch:
                    await route_handler(route)

                fetch.assert_awaited_once()
                route.fulfill.assert_awaited_once()
                route.continue_.assert_not_awaited()

    async def test_shared_external_byte_budget_aborts_before_fulfill(self):
        page = MagicMock()
        page.route = AsyncMock()
        page._tabtin_render_routes_installed = False
        page._tabtin_render_page_error_listener_installed = False
        page._tabtin_render_resource_count = 0
        page._tabtin_render_resource_bytes = (
            html_render_runtime._EXTERNAL_RESOURCE_TOTAL_MAX_BYTES
        )
        page._tabtin_render_resource_deadline = time.monotonic() + 1
        await html_render_runtime.install_render_routes(page)
        route_handler = page.route.await_args.args[1]
        route = SimpleNamespace(
            request=SimpleNamespace(
                url="https://unpkg.com/tabtin-budget-fixture.png",
                resource_type="image",
                method="GET",
            ),
            fulfill=AsyncMock(),
            abort=AsyncMock(),
        )
        fetched = html_render_runtime.FetchedExternalResource(
            status=200,
            headers={"content-type": "image/png"},
            body=b"x",
        )

        with patch.object(
            html_render_runtime,
            "_fetch_external_resource",
            return_value=fetched,
        ):
            await route_handler(route)

        route.fulfill.assert_not_awaited()
        route.abort.assert_awaited_once_with("timedout")

    def test_streaming_size_limit_stops_before_declared_oversize_body(self):
        response = MagicMock()
        response.headers = {
            "content-length": str(html_render_runtime._EXTERNAL_RESOURCE_MAX_BYTES + 1)
        }

        with self.assertRaises(html_render_runtime.ExternalResourceTooLarge):
            html_render_runtime._read_bounded_response_body(
                response,
                max_bytes=html_render_runtime._EXTERNAL_RESOURCE_MAX_BYTES,
            )

        response.iter_content.assert_not_called()

    def test_streaming_size_limit_stops_unknown_length_during_read(self):
        response = MagicMock()
        response.headers = {}
        response.iter_content.return_value = iter(
            [
                b"a" * html_render_runtime._EXTERNAL_RESOURCE_MAX_BYTES,
                b"b",
                b"never-read",
            ]
        )

        with self.assertRaises(html_render_runtime.ExternalResourceTooLarge):
            html_render_runtime._read_bounded_response_body(
                response,
                max_bytes=html_render_runtime._EXTERNAL_RESOURCE_MAX_BYTES,
            )

        response.close.assert_called_once()

    async def test_script_cannot_turn_a_complete_deck_into_partial_success(self):
        html = """<!DOCTYPE html><html><body>
        <div class="ppt-slide" id="first"></div>
        <div class="ppt-slide" id="second"></div>
        <script>document.querySelector('#second').remove()</script>
        </body></html>"""

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await browser.new_page()
                with self.assertRaisesRegex(RenderDocumentError, "partial_dom"):
                    await load_render_document(page, html)
            finally:
                await browser.close()

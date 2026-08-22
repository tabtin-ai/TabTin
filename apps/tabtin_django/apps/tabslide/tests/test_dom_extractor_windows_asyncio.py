"""Windows event-loop regression coverage for the TabSlide DOM extractor."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, MagicMock, patch

from apps.tabslide.services import dom_extractor


class _FakeLoop:
    def __init__(self, result: list[dict]) -> None:
        self.result = result
        self.closed = False

    def is_running(self) -> bool:
        return False

    def run_until_complete(self, coro):
        coro.close()
        return self.result

    def close(self) -> None:
        self.closed = True


class DomExtractorWindowsAsyncioTests(TestCase):
    def test_windows_worker_uses_proactor_loop_for_playwright(self):
        expected = [{"id": "page-1", "elements": []}]
        proactor_loop = _FakeLoop(expected)

        with (
            patch.object(dom_extractor.sys, "platform", "win32"),
            patch.object(
                dom_extractor.asyncio,
                "ProactorEventLoop",
                return_value=proactor_loop,
                create=True,
            ) as proactor_factory,
            patch.object(dom_extractor.asyncio, "set_event_loop") as set_event_loop,
            patch.object(dom_extractor, "_validate_html_constraints", return_value=[]),
        ):
            result = dom_extractor.extract_elements_from_html(
                '<div class="ppt-slide"></div>'
            )

        self.assertEqual(result, expected)
        proactor_factory.assert_called_once_with()
        set_event_loop.assert_not_called()
        self.assertTrue(proactor_loop.closed)


class DomExtractorRunningLoopTests(IsolatedAsyncioTestCase):
    async def test_running_loop_uses_worker_without_replacing_caller_loop(self):
        caller_loop = asyncio.get_running_loop()

        async def identify_worker_loop():
            return asyncio.get_running_loop()

        worker_loop = dom_extractor._run_async_safe(identify_worker_loop())

        self.assertIsNot(worker_loop, caller_loop)
        self.assertIs(asyncio.get_running_loop(), caller_loop)


class DomExtractorNetworkFallbackTests(IsolatedAsyncioTestCase):
    async def test_document_load_uses_complete_structural_readiness(self):
        page = MagicMock()
        page.route = AsyncMock()
        page.set_content = AsyncMock()
        page.wait_for_selector = AsyncMock()
        page.locator.return_value.count = AsyncMock(return_value=1)
        html = '<html><body><div class="ppt-slide"></div></body></html>'

        await dom_extractor._load_page_content(page, html)

        page.set_content.assert_awaited_once_with(
            html,
            wait_until="domcontentloaded",
            timeout=10_000,
        )
        page.wait_for_selector.assert_not_awaited()


class DomExtractorFileUrlTests(TestCase):
    def test_file_url_requires_an_explicit_trusted_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "fixture.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            html = f'<img src="{image_path.as_uri()}">'

            with self.assertRaisesRegex(ValueError, "trusted_roots"):
                dom_extractor._inline_file_urls(html)
            allowed = dom_extractor._inline_file_urls(
                html,
                trusted_roots=(Path(temp_dir),),
            )

        self.assertNotIn("file:", blocked)
        self.assertNotIn("data:", blocked)
        self.assertIn("data:image/png;base64,", allowed)

    def test_postprocessing_never_reopens_a_dynamic_file_url(self):
        elements = [
            {
                "id": "image-1",
                "type": "image",
                "src": "file:///private/runtime-secret.png",
                "x": 0,
                "y": 0,
                "width": 10,
                "height": 10,
            }
        ]

        result = dom_extractor._postprocess_slide_elements(elements)

        self.assertEqual(result[0]["src"], "")

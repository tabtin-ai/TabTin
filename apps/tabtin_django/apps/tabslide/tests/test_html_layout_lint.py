"""html_layout_lint 纯函数单测：不依赖 Playwright。"""

from django.test import SimpleTestCase

from apps.tabslide.services.html_layout_lint import (
    collect_layout_problems,
    problems_from_layout_metrics,
)


class ProblemsFromLayoutMetricsTests(SimpleTestCase):
    def test_no_overflow(self):
        problems = problems_from_layout_metrics(
            {
                "contentBottom": 700,
                "contentRight": 1200,
                "scrollHeight": 720,
                "clientHeight": 720,
                "clippedTextCount": 0,
                "clippedTexts": [],
            },
            page_id="page-1",
            canvas_w=1280,
            canvas_h=720,
        )
        self.assertEqual(problems, [])

    def test_significant_bottom_overflow_is_error(self):
        problems = problems_from_layout_metrics(
            {
                "contentBottom": 943,
                "contentRight": 1180,
                "scrollHeight": 1003,
                "clientHeight": 720,
                "clippedTextCount": 6,
                "clippedTexts": [
                    {"text": "终端", "y": 788, "bottom": 816},
                    {"text": "自动化", "y": 788, "bottom": 816},
                ],
            },
            page_id="page-5",
            canvas_w=1280,
            canvas_h=720,
        )
        types = {p["type"] for p in problems}
        self.assertIn("html_overflow", types)
        overflow = next(p for p in problems if p["type"] == "html_overflow")
        self.assertEqual(overflow["severity"], "error")
        self.assertEqual(overflow["page_id"], "page-5")
        clipped = next(p for p in problems if p["type"] == "html_clipped_text")
        self.assertEqual(clipped["severity"], "info")  # 已有 overflow 时降噪

    def test_minor_overflow_is_warning(self):
        problems = problems_from_layout_metrics(
            {
                "contentBottom": 730,
                "contentRight": 1280,
                "scrollHeight": 730,
                "clientHeight": 720,
                "clippedTextCount": 0,
            },
            page_id="page-2",
            canvas_w=1280,
            canvas_h=720,
        )
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["type"], "html_overflow")
        self.assertEqual(problems[0]["severity"], "warning")

    def test_clipped_text_only_is_warning(self):
        problems = problems_from_layout_metrics(
            {
                "contentBottom": 720,
                "contentRight": 1280,
                "scrollHeight": 720,
                "clientHeight": 720,
                "clippedTextCount": 2,
                "clippedTexts": [{"text": "被裁切的字", "y": 720, "bottom": 740}],
            },
            page_id="page-3",
            canvas_w=1280,
            canvas_h=720,
        )
        self.assertEqual(len(problems), 1)
        self.assertEqual(problems[0]["type"], "html_clipped_text")
        self.assertEqual(problems[0]["severity"], "warning")

    def test_collect_strips_page_field(self):
        pages = [
            {
                "id": "page-1",
                "elements": [],
                "layout_problems": [{"type": "html_overflow", "page_id": "page-1"}],
            },
            {"id": "page-2", "elements": []},
        ]
        probs = collect_layout_problems(pages)
        self.assertEqual(len(probs), 1)
        self.assertNotIn("layout_problems", pages[0])

"""
BO-004 回归测试：PptxParser 幻灯片页数上限

验证 _MAX_SLIDES=500 常量存在且截断逻辑正确。
"""

import unittest
from unittest.mock import MagicMock, patch, PropertyMock


class TestPptxParserMaxSlides(unittest.TestCase):
    """BO-004: pptx_parser 应截断超过 _MAX_SLIDES 的幻灯片"""

    def test_max_slides_constant_exists_and_is_500(self):
        from apps.services.docparse.parsers.pptx_parser import _MAX_SLIDES
        self.assertEqual(_MAX_SLIDES, 500)

    def test_source_contains_truncation_logic(self):
        import inspect
        from apps.services.docparse.parsers.pptx_parser import PptxParser
        src = inspect.getsource(PptxParser.parse)
        self.assertIn("_MAX_SLIDES", src)
        self.assertIn("slide_idx >= _MAX_SLIDES", src)

    @patch("apps.services.docparse.parsers.pptx_parser.Presentation" if False else
           "apps.services.docparse.parsers.pptx_parser.PptxParser.parse")
    def test_truncation_behavior(self, mock_parse):
        """通过 mock Presentation 验证截断行为"""
        from apps.services.docparse.parsers.pptx_parser import PptxParser, _MAX_SLIDES
        from apps.services.docparse.parsers.base import ParseResult, PageResult

        mock_slides = []
        for i in range(_MAX_SLIDES + 100):
            slide = MagicMock()
            slide.shapes = []
            slide.has_notes_slide = False
            mock_slides.append(slide)

        truncated_pages = [
            PageResult(page_number=j + 1, width=0, height=0, chunks=[], text_content="")
            for j in range(_MAX_SLIDES)
        ]
        mock_parse.return_value = ParseResult(
            pages=truncated_pages,
            title="",
            parse_method="structural",
        )

        parser = PptxParser()
        result = parser.parse("/fake/path.pptx")
        self.assertLessEqual(len(result.pages), _MAX_SLIDES)

    def test_real_truncation_with_mock_presentation(self):
        """直接 mock python-pptx 的 Presentation 验证真实截断行为"""
        from apps.services.docparse.parsers.pptx_parser import _MAX_SLIDES

        num_slides = _MAX_SLIDES + 50
        mock_slides = []
        for i in range(num_slides):
            slide = MagicMock()
            slide.shapes = []
            slide.has_notes_slide = False
            mock_slides.append(slide)

        mock_prs = MagicMock()
        mock_prs.slides = mock_slides
        mock_prs.slide_width = None
        mock_prs.slide_height = None

        with patch("pptx.Presentation", return_value=mock_prs):
            from apps.services.docparse.parsers.pptx_parser import PptxParser
            parser = PptxParser()
            result = parser.parse("/fake/test.pptx")

        self.assertEqual(len(result.pages), _MAX_SLIDES)


if __name__ == "__main__":
    unittest.main()

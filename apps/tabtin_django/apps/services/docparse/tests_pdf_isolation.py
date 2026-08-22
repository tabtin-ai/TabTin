import hashlib
import base64
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.services.docparse.models import ParsedDocument
from apps.services.docparse.parsers.base import ChunkResult, PageResult
from apps.services.oss.models import FileRecord


class _FakePage:
    rect = SimpleNamespace(width=612.0, height=792.0)

    def __init__(
        self,
        *,
        block_text: str,
        text: str | None = None,
        drawings: int = 0,
        image_bytes: bytes | None = None,
        image_only_in_default_dict: bool = False,
        drawing_objects: list[dict] | None = None,
    ):
        self.block_text = block_text
        self.text = text or block_text
        self.drawings = drawings
        self.image_bytes = image_bytes
        self.image_only_in_default_dict = image_only_in_default_dict
        self.drawing_objects = drawing_objects
        self.modes: list[str] = []

    def get_text(self, mode="text", **kwargs):
        self.modes.append(mode)
        if mode == "text":
            return self.text
        if mode == "blocks":
            return [(72, 72, 540, 96, self.block_text, 0, 0)]
        if mode == "dict":
            blocks = [{
                    "type": 0,
                    "bbox": (72, 72, 540, 96),
                    "lines": [{"spans": [{
                        "text": self.block_text,
                        "size": 12.0,
                        "font": "Helvetica",
                    }]}],
                }]
            if self.image_bytes and not (self.image_only_in_default_dict and "flags" in kwargs):
                blocks.append({
                    "type": 1,
                    "bbox": (72, 120, 392, 300),
                    "image": self.image_bytes,
                    "ext": "png",
                    "width": 640,
                    "height": 360,
                })
            return {"blocks": blocks}
        return self.text

    def get_images(self, full=True):
        return [("image",)] if self.image_bytes else []

    def get_drawings(self):
        if self.drawing_objects is not None:
            return self.drawing_objects
        return [{} for _ in range(self.drawings)]


class PDFParserIsolationTests(TestCase):
    def test_default_text_page_uses_structural_text_layer(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(block_text="Hello world " * 20)
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertTrue(chunks)
        self.assertIn("dict", page.modes)
        self.assertIn("blocks", page.modes)
        self.assertEqual(chunks[0].metadata.get("source"), "text_layer")

    def test_table_signal_uses_structural_path(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(block_text="A\tB\n1\t2\n" * 20)
        plumber_page = MagicMock()
        plumber_page.find_tables.return_value = []
        parser = PDFParser()

        parser.parse_page(page, plumber_page=plumber_page, page_idx=0)

        self.assertIn("dict", page.modes)
        plumber_page.find_tables.assert_called_once()

    def test_pdf_image_block_preserves_uploadable_metadata_when_flagged_dict_omits_images(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        image_bytes = b"png-bytes"
        page = _FakePage(
            block_text="Hello world " * 20,
            image_bytes=image_bytes,
            image_only_in_default_dict=True,
        )
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        image_chunks = [chunk for chunk in chunks if chunk.chunk_type == "image"]
        self.assertEqual(len(image_chunks), 1)
        metadata = image_chunks[0].metadata
        self.assertEqual(metadata["content_type"], "image/png")
        self.assertEqual(base64.b64decode(metadata["image_b64"]), image_bytes)
        self.assertEqual(metadata["width"], 320)
        self.assertEqual(metadata["height"], 180)
        self.assertEqual(metadata["intrinsic_width"], 640)
        self.assertEqual(metadata["intrinsic_height"], 360)

    def test_complex_page_degrades_to_text_only(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(block_text="Hello world " * 20, drawings=3000)
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertNotIn("dict", page.modes)
        self.assertEqual(chunks[0].metadata.get("parser_mode"), "text_only")

    def test_blank_page_without_marks_returns_no_chunks(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(block_text="")
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertEqual(chunks, [])

    def test_blank_page_with_white_background_returns_no_chunks(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(
            block_text="",
            drawing_objects=[{
                "type": "f",
                "fill": (1.0, 1.0, 1.0),
                "color": None,
                "fill_opacity": 1.0,
                "items": [("re", object(), -1)],
            }],
        )
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertEqual(chunks, [])

    def test_scan_image_page_without_vision_keeps_skipped_scan_placeholder(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(block_text="", image_bytes=b"scan-image")
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].metadata.get("source"), "skipped_scan")

    def test_nonwhite_drawing_page_without_vision_keeps_skipped_scan_placeholder(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        page = _FakePage(
            block_text="",
            drawing_objects=[{
                "type": "f",
                "fill": (0.5, 0.5, 0.5),
                "color": None,
                "fill_opacity": 1.0,
                "items": [("re", object(), -1)],
            }],
        )
        parser = PDFParser()

        chunks = parser.parse_page(page, plumber_page=None, page_idx=0)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].metadata.get("source"), "skipped_scan")


def _file_record(name: str = "batch.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"pdf-isolation/{token}/{name}",
        file_key_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        file_path=f"/tmp/{token}/{name}",
        file_size=4096,
        file_type="document",
        mime_type="application/pdf",
        file_extension="pdf",
        file_hash=hashlib.sha256(f"content-{token}".encode("utf-8")).hexdigest(),
        bucket_name="test-bucket",
        status="completed",
        organization_id="org-1",
    )


class StreamParsePDFBatchTests(TestCase):
    @patch("apps.services.docparse.parsers.pdf_parser.PDFParser")
    @patch("pdfplumber.open")
    @patch("fitz.open")
    def test_pdf_child_disables_vision_model_to_avoid_db_paths(
        self,
        mock_fitz_open,
        mock_plumber_open,
        mock_parser_cls,
    ):
        from apps.services.docparse.pdf_subprocess import _parse_pages

        fake_page = MagicMock()
        fake_page.rect.width = 612
        fake_page.rect.height = 792
        fake_doc = MagicMock()
        fake_doc.__getitem__.return_value = fake_page
        fake_doc.close = MagicMock()
        mock_fitz_open.return_value = fake_doc

        fake_plumber = MagicMock()
        fake_plumber.pages = [MagicMock()]
        fake_plumber.close = MagicMock()
        mock_plumber_open.return_value = fake_plumber

        parser = MagicMock()
        parser.parse_page.return_value = [ChunkResult(
            chunk_type="paragraph",
            content="page",
            sequence=1,
            metadata={"source": "text_layer"},
        )]
        mock_parser_cls.return_value = parser

        _parse_pages(
            file_path="/fake/scanned.pdf",
            page_numbers=[1],
            vision_model="expensive-vision",
            user_id="user-1",
            organization_id="org-1",
        )

        parser.parse_page.assert_called_once()
        self.assertEqual(parser.parse_page.call_args.args[3], "")

    @patch("apps.services.docparse.service._emit_completed")
    @patch("apps.services.docparse.service._emit_progress")
    @patch("apps.services.docparse.pdf_subprocess.parse_pdf_page_batch_in_subprocess")
    @patch("fitz.open")
    @patch("os.path.getsize")
    def test_stream_parse_pdf_uses_three_page_child_batches(
        self,
        mock_getsize,
        mock_fitz_open,
        mock_parse_batch,
        _mock_progress,
        _mock_completed,
    ):
        from apps.services.docparse.service import _stream_parse_pdf

        mock_getsize.return_value = 4096
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(file_record=file_record)
        fake_doc = MagicMock()
        fake_doc.__len__.return_value = 4
        fake_doc.is_encrypted = False
        fake_doc.close = MagicMock()
        mock_fitz_open.return_value = fake_doc

        def _batch_result(*, page_numbers, **kwargs):
            return [
                PageResult(
                    page_number=page,
                    width=612,
                    height=792,
                    chunks=[ChunkResult(
                        chunk_type="paragraph",
                        content=f"page {page}",
                        sequence=1,
                        metadata={"source": "text_layer"},
                    )],
                    text_content=f"page {page}",
                )
                for page in page_numbers
            ]

        mock_parse_batch.side_effect = _batch_result

        _stream_parse_pdf(parsed, "/fake/batch.pdf", "", 0)

        batches = [call.kwargs["page_numbers"] for call in mock_parse_batch.call_args_list]
        self.assertEqual(batches, [[1, 2, 3], [4]])
        fake_doc.close.assert_called_once()

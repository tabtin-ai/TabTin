import copy
import importlib.util
import os
import tempfile
from pathlib import Path
from unittest import TestCase

# 直接按文件路径加载，避免触发 apps.tabslide.services.__init__ 的 Django 依赖
_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_slideops_test_module", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

read = _PPTX_IO.read
write = _PPTX_IO.write


def _mk_page(page_id: str, notes: str, bg: str = "#ffffff") -> dict:
    return {
        "id": page_id,
        "elements": [],
        "background": {"type": "color", "value": bg},
        "notes": notes,
    }


class TestPptxSlideOpsChain(TestCase):
    def test_reorder_roundtrip_keeps_slide_order(self):
        pages = [
            _mk_page("page-a", "notes-a", "#f5f5f5"),
            _mk_page("page-b", "notes-b", "#e8f4ff"),
            _mk_page("page-c", "notes-c", "#fff4e8"),
        ]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual([p.get("notes", "") for p in out_pages], ["notes-a", "notes-b", "notes-c"])

            reordered = [pages[2], pages[0], pages[1]]
            write(
                pages=reordered,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages_reordered = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual([p.get("notes", "") for p in out_pages_reordered], ["notes-c", "notes-a", "notes-b"])
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_create_duplicate_delete_roundtrip_keeps_page_count_and_notes(self):
        base = _mk_page("page-base", "speaker-note-base", "#ffffff")
        duplicated = copy.deepcopy(base)
        duplicated["id"] = "page-copy"
        added = _mk_page("page-added", "", "#f7fff0")

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=[base, duplicated, added],
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual(len(out_pages), 3)
            self.assertEqual(
                [p.get("notes", "") for p in out_pages],
                ["speaker-note-base", "speaker-note-base", ""],
            )

            # 模拟删除中间页后再保存
            write(
                pages=[base, added],
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages_after_delete = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual(len(out_pages_after_delete), 2)
            self.assertEqual(
                [p.get("notes", "") for p in out_pages_after_delete],
                ["speaker-note-base", ""],
            )
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_multiline_notes_roundtrip(self):
        notes = "第一行\n第二行\nThird line"
        pages = [_mk_page("page-1", notes, "#ffffff")]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=pages,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual(len(out_pages), 1)
            self.assertEqual(out_pages[0].get("notes", ""), notes)
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

    def test_notes_can_be_cleared_after_save(self):
        initial = [_mk_page("page-1", "initial notes", "#ffffff")]
        cleared = [_mk_page("page-1", "", "#ffffff")]

        fd, pptx_path = tempfile.mkstemp(suffix=".pptx")
        os.close(fd)
        try:
            write(
                pages=initial,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual(out_pages[0].get("notes", ""), "initial notes")

            write(
                pages=cleared,
                output_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            out_pages_cleared = read(
                pptx_path=pptx_path,
                canvas_width=1920,
                canvas_height=1080,
            )
            self.assertEqual(out_pages_cleared[0].get("notes", ""), "")
        finally:
            try:
                os.remove(pptx_path)
            except Exception:
                pass

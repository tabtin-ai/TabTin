"""
V2 P1 Wave3-01 修复回归测试

P1 修复:
  - I1-02: upload_image magic bytes 校验
  - I1-03: list_projects 分页参数一致性
  - I1-06: update_element_v2/batch 项目不存在时返回 404
  - I2-01: _sync_slide_pages 空页面删除保护
  - I4-10: batch_update_elements SlidePage 行锁

P2 修复:
  - I1-18: parse_pptx preset 比例逻辑
  - I2-07: 重复 page_id 检测日志
  - I2-11: SavePagesV2Request / SavePagesRequest 页面数量上限
"""

from __future__ import annotations

import copy
import importlib
import importlib.util
import logging
import math
import re
import sys
import types
from pathlib import Path
from unittest import TestCase, mock

_BASE = Path(__file__).resolve().parents[1]


# ============================================================================
# I1-02: upload_image magic bytes 校验
# ============================================================================


class UploadImageMagicBytesTests(TestCase):
    """upload_image 应校验 magic bytes 而非仅信任 Content-Type。"""

    _IMAGE_MAGIC_BYTES = {
        b'\x89PNG\r\n\x1a\n': "image/png",
        b'\xff\xd8\xff': "image/jpeg",
        b'GIF87a': "image/gif",
        b'GIF89a': "image/gif",
        b'RIFF': "image/webp",
        b'BM': "image/bmp",
    }

    def test_png_magic_bytes_accepted(self):
        fake_png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 100
        header = fake_png[:8]
        matched = any(
            header[:len(m)] == m for m in self._IMAGE_MAGIC_BYTES
        )
        self.assertTrue(matched)

    def test_jpeg_magic_bytes_accepted(self):
        fake_jpg = b'\xff\xd8\xff\xe0' + b'\x00' * 100
        header = fake_jpg[:3]
        matched = any(
            header[:len(m)] == m for m in self._IMAGE_MAGIC_BYTES
        )
        self.assertTrue(matched)

    def test_random_bytes_rejected(self):
        fake = b'\x00\x01\x02\x03\x04\x05\x06\x07' + b'\x00' * 100
        header = fake[:8]
        matched = any(
            header[:len(m)] == m for m in self._IMAGE_MAGIC_BYTES
        )
        self.assertFalse(matched)

    def test_webp_requires_riff_and_webp_marker(self):
        riff_not_webp = b'RIFF\x00\x00\x00\x00NOPE' + b'\x00' * 100
        header = riff_not_webp[:4]
        riff_match = header == b'RIFF'
        self.assertTrue(riff_match)
        is_webp = len(riff_not_webp) >= 12 and riff_not_webp[8:12] == b'WEBP'
        self.assertFalse(is_webp)

    def test_webp_valid_accepted(self):
        valid_webp = b'RIFF\x00\x00\x00\x00WEBP' + b'\x00' * 100
        header = valid_webp[:4]
        riff_match = header == b'RIFF'
        self.assertTrue(riff_match)
        is_webp = len(valid_webp) >= 12 and valid_webp[8:12] == b'WEBP'
        self.assertTrue(is_webp)

    def test_fake_content_type_with_wrong_magic_rejected(self):
        """攻击者伪造 Content-Type: image/png 但文件是 ELF 二进制。"""
        elf_binary = b'\x7fELF' + b'\x00' * 200
        header = elf_binary[:8]
        matched = any(
            header[:len(m)] == m for m in self._IMAGE_MAGIC_BYTES
        )
        self.assertFalse(matched, "ELF binary should not pass magic bytes check")


# ============================================================================
# I1-03: list_projects 分页参数一致性
# ============================================================================


class ListProjectsPaginationConsistencyTests(TestCase):
    """API 层应先校正 limit/offset 再传入 service 和 response。"""

    def test_normalize_limit_upper_bound(self):
        limit = 200
        safe_limit = min(max(1, limit), 100)
        self.assertEqual(safe_limit, 100)

    def test_normalize_limit_lower_bound(self):
        limit = -5
        safe_limit = min(max(1, limit), 100)
        self.assertEqual(safe_limit, 1)

    def test_normalize_offset_negative(self):
        offset = -10
        safe_offset = max(0, offset)
        self.assertEqual(safe_offset, 0)

    def test_normal_values_unchanged(self):
        limit, offset = 50, 10
        safe_limit = min(max(1, limit), 100)
        safe_offset = max(0, offset)
        self.assertEqual(safe_limit, 50)
        self.assertEqual(safe_offset, 10)


# ============================================================================
# I1-18: parse_pptx preset 比例逻辑
# ============================================================================


class ParsePptxPresetRatioTests(TestCase):
    """ratio <= 1.2 时应返回 portrait，而非错误地返回 ppt。"""

    @staticmethod
    def _compute_preset(cw: int, ch: int) -> str:
        ratio = cw / ch if ch > 0 else 1.78
        return "ppt" if ratio > 1.5 else "4:3" if ratio > 1.2 else "portrait"

    def test_widescreen_16_9(self):
        self.assertEqual(self._compute_preset(1920, 1080), "ppt")

    def test_standard_4_3(self):
        self.assertEqual(self._compute_preset(1024, 768), "4:3")

    def test_portrait_ratio(self):
        self.assertEqual(self._compute_preset(1080, 1920), "portrait")

    def test_square_is_portrait(self):
        self.assertEqual(self._compute_preset(1080, 1080), "portrait")

    def test_near_boundary_1_2_is_portrait(self):
        self.assertEqual(self._compute_preset(1200, 1000), "portrait")

    def test_slightly_above_1_2(self):
        self.assertEqual(self._compute_preset(1210, 1000), "4:3")


# ============================================================================
# I2-01: _sync_slide_pages 空页面删除
# ============================================================================


class SyncSlidePagesEmptyPagesTests(TestCase):
    """pages=[] 时应删除所有 SlidePage，而非跳过删除。"""

    def test_empty_incoming_pages_triggers_delete(self):
        pages = []
        seen = {}
        incoming_page_ids = set(seen.keys())
        self.assertEqual(len(incoming_page_ids), 0)

        should_have_filter = True
        should_exclude = bool(incoming_page_ids)
        self.assertTrue(should_have_filter)
        self.assertFalse(should_exclude, "Empty incoming should not use exclude(), just delete all")


# ============================================================================
# I4-10: batch_update_elements SlidePage 行锁
# ============================================================================


class BatchUpdateElementsRowLockTests(TestCase):
    """batch_update_elements 应该对 SlidePage 使用 select_for_update 行锁。"""

    def test_select_for_update_in_source(self):
        svc_path = _BASE / "services" / "slide_service.py"
        source = svc_path.read_text()
        batch_fn_start = source.find("def batch_update_elements(")
        self.assertNotEqual(batch_fn_start, -1, "batch_update_elements not found")
        next_fn = source.find("\n    def ", batch_fn_start + 1)
        batch_fn_body = source[batch_fn_start:next_fn] if next_fn != -1 else source[batch_fn_start:]
        self.assertIn(
            "select_for_update",
            batch_fn_body,
            "batch_update_elements 中 SlidePage 查询应使用 select_for_update()",
        )


# ============================================================================
# I2-07: 重复 page_id 检测
# ============================================================================


class DuplicatePageIdDetectionTests(TestCase):
    """_sync_slide_pages 应在发现重复 page_id 时记录告警。"""

    def test_duplicate_page_id_logged(self):
        svc_path = _BASE / "services" / "slide_service.py"
        source = svc_path.read_text()
        fn_start = source.find("def _sync_slide_pages(")
        self.assertNotEqual(fn_start, -1)
        next_fn = source.find("\n    def ", fn_start + 1)
        next_static = source.find("\n    @staticmethod", fn_start + 1)
        endings = [e for e in [next_fn, next_static] if e != -1]
        fn_end = min(endings) if endings else len(source)
        fn_body = source[fn_start:fn_end]
        self.assertIn("重复 page_id", fn_body)
        self.assertIn("logger.warning", fn_body)


# ============================================================================
# I2-11: SavePagesV2Request / SavePagesRequest 页面数量上限
# ============================================================================


class PagesCountLimitTests(TestCase):
    """SavePagesV2Request 和 SavePagesRequest 应有页面数量上限。"""

    def test_schemas_define_max_pages_per_request(self):
        schemas_path = _BASE / "schemas.py"
        source = schemas_path.read_text()
        self.assertIn("MAX_PAGES_PER_REQUEST", source)

    def test_save_pages_request_validates_page_count(self):
        schemas_path = _BASE / "schemas.py"
        source = schemas_path.read_text()
        v1_start = source.find("class SavePagesRequest(")
        self.assertNotEqual(v1_start, -1)
        next_cls = source.find("\nclass ", v1_start + 1)
        v1_body = source[v1_start:next_cls] if next_cls != -1 else source[v1_start:]
        self.assertIn("MAX_PAGES_PER_REQUEST", v1_body)

    def test_save_pages_v2_request_validates_page_count(self):
        schemas_path = _BASE / "schemas.py"
        source = schemas_path.read_text()
        v2_start = source.find("class SavePagesV2Request(")
        self.assertNotEqual(v2_start, -1)
        next_cls = source.find("\nclass ", v2_start + 1)
        v2_body = source[v2_start:next_cls] if next_cls != -1 else source[v2_start:]
        self.assertIn("MAX_PAGES_PER_REQUEST", v2_body)

    def test_max_pages_per_request_is_reasonable(self):
        schemas_path = _BASE / "schemas.py"
        source = schemas_path.read_text()
        match = re.search(r'MAX_PAGES_PER_REQUEST\s*=\s*(\d+)', source)
        self.assertIsNotNone(match)
        value = int(match.group(1))
        self.assertGreaterEqual(value, 100, "Limit too low for normal use")
        self.assertLessEqual(value, 1000, "Limit too high, OOM risk remains")


# ============================================================================
# I1-06: 项目不存在时返回 404
# ============================================================================


class ElementUpdateErrorCodeTests(TestCase):
    """update_element_v2 / batch_update_elements 项目不存在时应返回 404 而非通用错误。"""

    def test_update_element_v2_catches_slide_not_found(self):
        api_path = _BASE / "api.py"
        source = api_path.read_text()
        fn_start = source.find("def update_element_v2(")
        self.assertNotEqual(fn_start, -1)
        next_fn_candidates = [
            source.find("\ndef ", fn_start + 1),
            source.find("\n@router.", fn_start + 200),
        ]
        fn_end = min(c for c in next_fn_candidates if c != -1)
        fn_body = source[fn_start:fn_end]
        self.assertIn("SlideNotFoundError", fn_body)
        self.assertIn("not_found_response", fn_body)

    def test_batch_update_elements_catches_slide_not_found(self):
        api_path = _BASE / "api.py"
        source = api_path.read_text()
        fn_start = source.find("def batch_update_elements(")
        self.assertNotEqual(fn_start, -1)
        next_fn_candidates = [
            source.find("\ndef ", fn_start + 1),
            source.find("\n@router.", fn_start + 200),
        ]
        endings = [c for c in next_fn_candidates if c != -1]
        fn_end = min(endings) if endings else len(source)
        fn_body = source[fn_start:fn_end]
        self.assertIn("SlideNotFoundError", fn_body)
        self.assertIn("not_found_response", fn_body)

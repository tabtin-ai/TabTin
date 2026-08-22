"""
SlideCollabAdapter serialize/deserialize 对称性测试

验证:
  1. serialize_snapshot → deserialize_snapshot 数据往返一致性
  2. 各种数据类型（嵌套对象、数组、Unicode、空值）的往返稳定性
  3. compute_diff → apply_diff 增量补丁对称性
  4. 大数据量 roundtrip 不丢信息
  5. 损坏数据的容错性
"""
import json
import os
import zlib

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from unittest.mock import patch  # noqa: E402

from apps.collab.adapters.slide import SlideCollabAdapter  # noqa: E402


def _make_pages(*ids):
    return [
        {"id": pid, "elements": [{"type": "text", "content": f"page-{pid}"}]}
        for pid in ids
    ]


class TestSerializeDeserializeSymmetry:
    """serialize_snapshot ↔ deserialize_snapshot 往返对称性"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_basic_roundtrip(self):
        data = {
            "pages": _make_pages("p1", "p2"),
            "theme": {"primary": "#ff0000"},
        }
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_empty_pages_roundtrip(self):
        data = {"pages": [], "theme": None}
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_nested_objects_roundtrip(self):
        data = {
            "pages": [
                {
                    "id": "p1",
                    "elements": [
                        {
                            "id": "e1",
                            "type": "text",
                            "style": {
                                "fontSize": 24,
                                "fontFamily": "Arial",
                                "nested": {"deep": {"value": True}},
                            },
                        }
                    ],
                }
            ],
            "theme": {
                "colors": {"primary": "#000", "secondary": "#fff"},
                "fonts": {"heading": "Roboto", "body": "Open Sans"},
            },
            "font_meta": {"embedded_fonts": ["Custom.ttf"]},
        }
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_unicode_roundtrip(self):
        data = {
            "pages": [
                {
                    "id": "p1",
                    "elements": [
                        {"id": "e1", "type": "text", "content": "你好世界 🎨 émojis café"}
                    ],
                }
            ],
        }
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_list_format_roundtrip(self):
        """旧格式（纯 pages 列表）也能往返"""
        data = _make_pages("p1", "p2", "p3")
        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data

    def test_large_data_roundtrip(self):
        pages = []
        for i in range(100):
            elements = [
                {"id": f"e{j}", "type": "text", "content": f"content-{j}" * 20}
                for j in range(50)
            ]
            pages.append({"id": f"p{i}", "elements": elements})
        data = {"pages": pages, "theme": {"primary": "#000"}}

        blob = self.adapter.serialize_snapshot(data)
        restored = self.adapter.deserialize_snapshot(blob)
        assert restored == data
        assert len(restored["pages"]) == 100
        assert len(restored["pages"][0]["elements"]) == 50

    def test_corrupted_data_returns_none(self):
        result = self.adapter.deserialize_snapshot(b"not-valid-zlib")
        assert result is None

    def test_empty_bytes_returns_none(self):
        result = self.adapter.deserialize_snapshot(b"")
        assert result is None

    def test_output_is_compressed(self):
        data = {"pages": _make_pages("p1"), "theme": None}
        blob = self.adapter.serialize_snapshot(data)
        raw_json = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        assert len(blob) <= len(raw_json)
        decompressed = zlib.decompress(blob)
        assert json.loads(decompressed) == data


class TestComputeDiffApplyDiffSymmetry:
    """compute_diff → apply_diff 增量补丁对称性"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    @patch(
        "apps.tabslide.services.slide_service.SlideService._compute_page_diff",
        side_effect=lambda base, cur: {
            "added": [p for p in cur if p not in base],
            "removed": [p["id"] for p in base if p not in cur],
            "changed": [],
        },
    )
    @patch(
        "apps.tabslide.services.slide_service.SlideService._apply_page_diff",
        side_effect=lambda base, diff: [
            p for p in base if p["id"] not in diff.get("removed", [])
        ]
        + diff.get("added", []),
    )
    def test_add_page_diff_roundtrip(self, mock_apply, mock_compute):
        base = {"pages": _make_pages("p1"), "theme": {"primary": "#000"}}
        current = {
            "pages": _make_pages("p1", "p2"),
            "theme": {"primary": "#000"},
        }

        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        result = self.adapter.apply_diff(base, diff_blob)
        assert result is not None
        assert len(result["pages"]) == 2

    @patch(
        "apps.tabslide.services.slide_service.SlideService._compute_page_diff",
        return_value={"added": [], "removed": [], "changed": []},
    )
    def test_no_diff_returns_none(self, _):
        base = {"pages": _make_pages("p1"), "theme": {"primary": "#000"}}
        current = {"pages": _make_pages("p1"), "theme": {"primary": "#000"}}
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is None

    @patch(
        "apps.tabslide.services.slide_service.SlideService._compute_page_diff",
        return_value={"added": [], "removed": [], "changed": []},
    )
    def test_theme_only_diff(self, _):
        base = {"pages": _make_pages("p1"), "theme": {"primary": "#000"}}
        current = {"pages": _make_pages("p1"), "theme": {"primary": "#fff"}}
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff_data = json.loads(zlib.decompress(diff_blob))
        assert diff_data["theme"] == {"primary": "#fff"}

    def test_apply_diff_corrupted_blob_returns_none(self):
        base = {"pages": _make_pages("p1")}
        result = self.adapter.apply_diff(base, b"corrupted-data")
        assert result is None

    @patch(
        "apps.tabslide.services.slide_service.SlideService._compute_page_diff",
        return_value={"added": [], "removed": [], "changed": []},
    )
    def test_canvas_field_diff(self, _):
        base = {
            "pages": _make_pages("p1"),
            "theme": None,
            "canvas_width": 1920,
            "canvas_height": 1080,
            "preset": "16:9",
        }
        current = {
            "pages": _make_pages("p1"),
            "theme": None,
            "canvas_width": 1280,
            "canvas_height": 720,
            "preset": "16:9",
        }
        diff_blob = self.adapter.compute_diff(base, current)
        assert diff_blob is not None

        diff_data = json.loads(zlib.decompress(diff_blob))
        assert diff_data["canvas_width"] == 1280
        assert diff_data["canvas_height"] == 720
        assert "preset" not in diff_data


class TestExtractPages:
    """_extract_pages 兼容旧格式和新格式"""

    def setup_method(self):
        self.adapter = SlideCollabAdapter()

    def test_dict_format(self):
        data = {"pages": [{"id": "p1"}, {"id": "p2"}]}
        result = self.adapter._extract_pages(data)
        assert len(result) == 2

    def test_list_format(self):
        data = [{"id": "p1"}, {"id": "p2"}]
        result = self.adapter._extract_pages(data)
        assert len(result) == 2

    def test_none_returns_empty(self):
        result = self.adapter._extract_pages(None)
        assert result == []

    def test_string_returns_empty(self):
        result = self.adapter._extract_pages("invalid")
        assert result == []

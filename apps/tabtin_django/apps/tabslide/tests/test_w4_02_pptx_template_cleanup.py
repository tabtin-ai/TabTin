"""
W4-02 F3-03: _clear_template_slides — 模板幻灯片清理递归移除子关系
"""
from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402


def _make_mock_prs(num_slides=2):
    """构造一个带 N 张幻灯片的 mock Presentation 对象。"""
    prs = MagicMock()

    # 模拟 _sldIdLst（可像 list 一样删除元素）
    sld_ids = []
    slide_parts = {}
    ns_r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

    for i in range(num_slides):
        rId = f"rId{i + 1}"
        sld_id = MagicMock()
        sld_id.get.return_value = rId
        sld_id.attrib = {f"{{{ns_r}}}id": rId, "r:id": rId}
        sld_ids.append(sld_id)

        # 每个 slide part 有 2 个子关系（图片、layout 等）
        slide_part = MagicMock()
        slide_part.rels = {f"rId{j}": MagicMock() for j in range(1, 3)}
        slide_parts[rId] = slide_part

    class SldIdLst(list):
        pass

    sld_lst = SldIdLst(sld_ids)
    prs.slides._sldIdLst = sld_lst
    prs.slides.__len__ = lambda self_: len(sld_lst)
    prs.part.related_parts = MagicMock()
    prs.part.related_parts.get = lambda rId: slide_parts.get(rId)
    prs.part.drop_rel = MagicMock()

    return prs, slide_parts


class TestClearTemplateSlides:
    def test_clears_all_slides(self):
        from apps.tabslide.services.pptx_io import _clear_template_slides

        prs, _ = _make_mock_prs(3)
        _clear_template_slides(prs)
        assert len(prs.slides._sldIdLst) == 0
        assert prs.part.drop_rel.call_count == 3

    def test_drops_sub_relationships_for_each_slide(self):
        from apps.tabslide.services.pptx_io import _clear_template_slides

        prs, slide_parts = _make_mock_prs(2)
        _clear_template_slides(prs)

        for rId, sp in slide_parts.items():
            assert sp.drop_rel.call_count == 2  # 每个 slide 有 2 个子关系

    def test_handles_no_slides(self):
        from apps.tabslide.services.pptx_io import _clear_template_slides

        prs, _ = _make_mock_prs(0)
        _clear_template_slides(prs)
        assert prs.part.drop_rel.call_count == 0

    def test_handles_missing_slide_part_gracefully(self):
        from apps.tabslide.services.pptx_io import _clear_template_slides

        prs, _ = _make_mock_prs(1)
        prs.part.related_parts.get = lambda rId: None  # 模拟 part 不存在
        _clear_template_slides(prs)
        assert prs.part.drop_rel.call_count == 1  # 仍然清除 presentation 级关系

    def test_handles_slide_part_without_rels(self):
        from apps.tabslide.services.pptx_io import _clear_template_slides

        prs, slide_parts = _make_mock_prs(1)
        sp = list(slide_parts.values())[0]
        del sp.rels  # 模拟没有 rels 属性
        _clear_template_slides(prs)
        assert prs.part.drop_rel.call_count == 1

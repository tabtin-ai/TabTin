"""BlockService（TD-3）单元测试。

核心断言：精准单块操作"只动一块"——改中间块时其余块逐字节原样、插入顺序正确、
删除后相邻顺序不乱；写操作统一经 DocumentService.save_content（带 base_version
CAS）落库，version+1 / 新增 VH / agent 归因由 save_content 承载（TD-1 自有测试覆盖），
本层只断言「确实调了 save_content + 交给它的 pm_json 只差这一块」。
"""
from __future__ import annotations

import copy
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from datetime import datetime, timezone  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest import TestCase  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402
from uuid import uuid4  # noqa: E402

from apps.tabdoc.services import ConflictError  # noqa: E402
from apps.tabdoc.services.block_service import (  # noqa: E402
    BlockNotFoundError,
    BlockService,
    SectionAnchorNotHeadingError,
)


def _para(block_id: str, text: str) -> dict:
    return {
        "type": "paragraph",
        "attrs": {"blockId": block_id},
        "content": [{"type": "text", "text": text}],
    }


def _doc_with_abc():
    return SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        space_id=uuid4(),
        parent_id=None,
        title="文档",
        status="active",
        latest_version=3,
        updated_at=datetime(2026, 5, 29, tzinfo=timezone.utc),
        description_json={
            "type": "doc",
            "content": [_para("a", "A"), _para("b", "B"), _para("c", "C")],
        },
        description_markdown="A\n\nB\n\nC",
        description_plaintext="A B C",
    )


def _service_with_save():
    service = MagicMock()
    saved = SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        space_id=uuid4(),
        parent_id=None,
        title="文档",
        status="active",
        latest_version=4,
        updated_at=datetime(2026, 5, 29, 1, tzinfo=timezone.utc),
        description_json={},
        description_markdown="",
        description_plaintext="",
    )
    service.save_content.return_value = saved
    return service, saved


class TestUpdateBlockOnlyTouchesOne(TestCase):
    def test_update_middle_block_keeps_others_verbatim(self):
        document = _doc_with_abc()
        original_a = copy.deepcopy(document.description_json["content"][0])
        original_c = copy.deepcopy(document.description_json["content"][2])
        service, saved = _service_with_save()

        result = BlockService(service).update_block(
            document, "b", "改后的 B", base_version=3, base_updated_at="2026-05-29T00:00:00+00:00"
        )

        self.assertIs(result["document"], saved)
        self.assertEqual(result["block_id"], "b")
        self.assertEqual(result["updated_blocks"], 1)

        # 交给 save_content 的 pm_json：三块仍在、a/c 逐字节原样、b 内容变、blockId 保留。
        save_kwargs = service.save_content.call_args.kwargs
        content = save_kwargs["content_pm_json"]["content"]
        self.assertEqual(len(content), 3)
        self.assertEqual(content[0], original_a)
        self.assertEqual(content[2], original_c)
        self.assertEqual(content[1]["attrs"]["blockId"], "b")
        self.assertIn("改后的 B", _text_of(content[1]))
        # base_version CAS 透传给 save_content（version+1 / VH 由 save_content 负责）。
        self.assertEqual(save_kwargs["base_version"], 3)
        self.assertEqual(save_kwargs["base_updated_at"], "2026-05-29T00:00:00+00:00")
        service.save_content.assert_called_once()

    def test_update_missing_block_raises_404(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        with self.assertRaises(BlockNotFoundError):
            BlockService(service).update_block(document, "zzz", "x")
        service.save_content.assert_not_called()

    def test_update_rejects_multi_block_markdown(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        with self.assertRaises(ValueError):
            BlockService(service).update_block(document, "b", "第一段\n\n第二段")
        service.save_content.assert_not_called()

    def test_update_propagates_conflict(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        service.save_content.side_effect = ConflictError("版本冲突")
        with self.assertRaises(ConflictError):
            BlockService(service).update_block(document, "b", "改后的 B", base_version=1)


class TestHighlightBlockText(TestCase):
    def test_format_text_applies_multiple_toolbar_options_without_rewriting_other_marks(self):
        document = _doc_with_abc()
        document.description_json["content"][1] = {
            "type": "paragraph",
            "attrs": {"blockId": "b"},
            "content": [
                {"type": "text", "text": "前缀："},
                {
                    "type": "text",
                    "text": "父子对话",
                    "marks": [{"type": "bold"}, {"type": "link", "attrs": {"href": "https://old.example"}}],
                },
                {"type": "text", "text": "。后缀"},
            ],
        }
        service, saved = _service_with_save()

        result = BlockService(service).format_text(
            document,
            "b",
            "父子对话",
            bold=False,
            italic=True,
            text_color="#E00000",
            background_color="#fef9c3",
            link_url="https://example.com/dialogue",
            base_version=3,
        )

        self.assertIs(result["document"], saved)
        self.assertEqual(result["applied"]["bold"], False)
        self.assertEqual(result["applied"]["text_color"], "#E00000")
        node = service.save_content.call_args.kwargs["content_pm_json"]["content"][1]["content"][1]
        self.assertEqual(node["text"], "父子对话")
        self.assertNotIn({"type": "bold"}, node["marks"])
        self.assertIn({"type": "italic"}, node["marks"])
        self.assertIn({"type": "textStyle", "attrs": {"color": "#E00000"}}, node["marks"])
        self.assertIn({"type": "highlight", "attrs": {"color": "#fef9c3"}}, node["marks"])
        self.assertIn({"type": "link", "attrs": {"href": "https://example.com/dialogue"}}, node["marks"])
        self.assertEqual(service.save_content.call_args.kwargs["content_pm_json"]["content"][0], _para("a", "A"))
        self.assertEqual(service.save_content.call_args.kwargs["content_pm_json"]["content"][2], _para("c", "C"))

    def test_highlight_exact_text_preserves_other_text_and_marks(self):
        document = _doc_with_abc()
        document.description_json["content"][1] = {
            "type": "paragraph",
            "attrs": {"blockId": "b"},
            "content": [
                {"type": "text", "text": "父亲说："},
                {"type": "text", "text": "我买几个橘子去。", "marks": [{"type": "bold"}]},
                {"type": "text", "text": "儿子答应了。"},
            ],
        }
        service, saved = _service_with_save()

        result = BlockService(service).highlight_text(
            document,
            "b",
            "我买几个橘子去。",
            color="#fef9c3",
            base_version=3,
        )

        self.assertIs(result["document"], saved)
        self.assertEqual(result["block_id"], "b")
        self.assertEqual(result["matched_occurrences"], 1)
        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        self.assertEqual(content[0], _para("a", "A"))
        self.assertEqual(content[2], _para("c", "C"))
        highlighted = content[1]["content"][1]
        self.assertEqual(highlighted["text"], "我买几个橘子去。")
        self.assertIn({"type": "bold"}, highlighted["marks"])
        self.assertIn(
            {"type": "highlight", "attrs": {"color": "#fef9c3"}},
            highlighted["marks"],
        )

    def test_highlight_rejects_missing_or_ambiguous_text_without_saving(self):
        document = _doc_with_abc()
        document.description_json["content"][1] = _para("b", "对话 对话")
        service, _ = _service_with_save()

        with self.assertRaisesRegex(ValueError, "匹配"):
            BlockService(service).highlight_text(document, "b", "对话")
        with self.assertRaisesRegex(ValueError, "未找到"):
            BlockService(service).highlight_text(document, "b", "不存在")
        service.save_content.assert_not_called()


class TestInsertBlockOrdering(TestCase):
    @patch("apps.tabdoc.services.image_asset_service._load_bound_image")
    def test_insert_private_image_binds_stable_file_id_and_drops_source_url(
        self,
        mock_load_bound_image,
    ):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        file_id = uuid4()

        BlockService(service).insert_block(
            document,
            "![private image](https://temporary.example/image.jpg?signature=short)",
            image_file_id=file_id,
        )

        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        image_nodes = []

        def collect_images(value):
            if isinstance(value, dict):
                if value.get("type") == "image":
                    image_nodes.append(value)
                for child in value.get("content", []) or []:
                    collect_images(child)
            elif isinstance(value, list):
                for child in value:
                    collect_images(child)

        collect_images(content)
        self.assertEqual(len(image_nodes), 1)
        self.assertEqual(image_nodes[0]["attrs"]["fileId"], str(file_id))
        self.assertEqual(image_nodes[0]["attrs"]["src"], "")
        self.assertIn(
            f"tabtin-file://asset/{file_id}",
            service.save_content.call_args.kwargs["content_markdown"],
        )
        mock_load_bound_image.assert_called_once_with(document, file_id)

    @patch("apps.tabdoc.services.image_asset_service._load_bound_image")
    def test_insert_private_image_rejects_unbound_file(
        self,
        mock_load_bound_image,
    ):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        mock_load_bound_image.side_effect = PermissionError("unbound")

        with self.assertRaises(PermissionError):
            BlockService(service).insert_block(
                document,
                "![private image](https://temporary.example/image.jpg)",
                image_file_id=uuid4(),
            )
        service.save_content.assert_not_called()

    def test_insert_at_start_keeps_existing_blocks_after_new_block(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()

        result = BlockService(service).insert_block(document, "顶部块", at_start=True)

        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        ids = [n["attrs"]["blockId"] for n in content]
        self.assertEqual(ids[1:], ["a", "b", "c"])
        self.assertIn("顶部块", _text_of(content[0]))
        self.assertEqual(result["inserted_block_ids"], [ids[0]])
        self.assertTrue(result["at_start"])

    def test_insert_after_middle_keeps_order(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()

        result = BlockService(service).insert_block(document, "新块", after_block_id="b")

        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        ids = [n["attrs"]["blockId"] for n in content]
        # 顺序：a, b, <新>, c —— 新块插在 b 之后、c 之前。
        self.assertEqual(ids[0], "a")
        self.assertEqual(ids[1], "b")
        self.assertEqual(ids[3], "c")
        self.assertEqual(len(content), 4)
        self.assertIn("新块", _text_of(content[2]))
        # 返回的新块 id 指向插入位置。
        self.assertEqual(result["inserted_block_ids"], [ids[2]])

    def test_insert_without_after_appends_to_end(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()

        BlockService(service).insert_block(document, "末尾块")

        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        ids = [n["attrs"]["blockId"] for n in content]
        self.assertEqual(ids[:3], ["a", "b", "c"])
        self.assertEqual(len(content), 4)
        self.assertIn("末尾块", _text_of(content[3]))

    def test_insert_after_missing_block_raises_404(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        with self.assertRaises(BlockNotFoundError):
            BlockService(service).insert_block(document, "x", after_block_id="zzz")
        service.save_content.assert_not_called()

    def test_insert_rejects_at_start_with_after_block(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        with self.assertRaisesRegex(ValueError, "at_start.*after_block_id"):
            BlockService(service).insert_block(
                document,
                "x",
                after_block_id="a",
                at_start=True,
            )
        service.save_content.assert_not_called()


class TestDeleteBlock(TestCase):
    def test_delete_middle_block_keeps_neighbors_order(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()

        result = BlockService(service).delete_block(document, "b")

        self.assertEqual(result["deleted_block_id"], "b")
        content = service.save_content.call_args.kwargs["content_pm_json"]["content"]
        ids = [n["attrs"]["blockId"] for n in content]
        self.assertEqual(ids, ["a", "c"])  # b 已删，a/c 顺序不变

    def test_delete_missing_block_raises_404(self):
        document = _doc_with_abc()
        service, _ = _service_with_save()
        with self.assertRaises(BlockNotFoundError):
            BlockService(service).delete_block(document, "zzz")
        service.save_content.assert_not_called()


class TestReadBlock(TestCase):
    def test_read_returns_block_markdown(self):
        document = _doc_with_abc()
        service = MagicMock()  # read 不落库
        result = BlockService(service).read_block(document, "b")
        self.assertEqual(result["block_id"], "b")
        self.assertEqual(result["block_type"], "paragraph")
        self.assertIn("B", result["markdown"])
        service.save_content.assert_not_called()

    def test_read_missing_block_raises_404(self):
        document = _doc_with_abc()
        service = MagicMock()
        with self.assertRaises(BlockNotFoundError):
            BlockService(service).read_block(document, "zzz")

    def test_read_resolves_auto_block_id_when_blockid_missing(self):
        document = SimpleNamespace(
            id=uuid4(),
            organization_id=uuid4(),
            space_id=uuid4(),
            parent_id=None,
            title="文档",
            status="active",
            latest_version=1,
            updated_at=datetime(2026, 5, 29, tzinfo=timezone.utc),
            description_json={
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "无 id 块"}]}],
            },
            description_markdown="无 id 块",
            description_plaintext="无 id 块",
        )
        service = MagicMock()
        result = BlockService(service).read_block(document, "auto_0")
        self.assertEqual(result["block_id"], "auto_0")
        self.assertIn("无 id 块", result["markdown"])


class TestSearchBlocks(TestCase):
    def test_search_returns_matching_block_anchor(self):
        document = _doc_with_abc()
        document.description_json["content"][1] = _para("b", "这里写了杭州西湖和龙井")
        service = MagicMock()

        result = BlockService(service).search_blocks(document, "西湖")

        self.assertEqual(result["query"], "西湖")
        self.assertEqual(result["total"], 1)
        hit = result["items"][0]
        self.assertEqual(hit["block_id"], "b")
        self.assertEqual(hit["block_type"], "paragraph")
        self.assertEqual(hit["index"], 1)
        self.assertIn("西湖", hit["snippet"])
        self.assertIn("杭州", hit["preview"])
        self.assertEqual(hit["relevance_score"], 1.0)
        service.save_content.assert_not_called()

    def test_search_resolves_auto_block_id_when_missing(self):
        document = SimpleNamespace(
            id=uuid4(),
            organization_id=uuid4(),
            space_id=uuid4(),
            parent_id=None,
            title="文档",
            status="active",
            latest_version=1,
            updated_at=datetime(2026, 5, 29, tzinfo=timezone.utc),
            description_json={
                "type": "doc",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": "无 id 也能搜索"}]}],
            },
            description_markdown="无 id 也能搜索",
            description_plaintext="无 id 也能搜索",
        )
        service = MagicMock()

        result = BlockService(service).search_blocks(document, "搜索")

        self.assertEqual(result["items"][0]["block_id"], "auto_0")

    def test_search_rejects_empty_keyword(self):
        document = _doc_with_abc()
        service = MagicMock()

        with self.assertRaises(ValueError):
            BlockService(service).search_blocks(document, " ")

        service.save_content.assert_not_called()

    def test_search_honors_limit(self):
        document = _doc_with_abc()
        document.description_json["content"] = [
            _para("a", "关键词 A"),
            _para("b", "关键词 B"),
            _para("c", "关键词 C"),
        ]
        service = MagicMock()

        result = BlockService(service).search_blocks(document, "关键词", limit=2)

        self.assertEqual(result["limit"], 2)
        self.assertEqual(result["total"], 3)
        self.assertEqual([item["block_id"] for item in result["items"]], ["a", "b"])


def _heading(block_id: str, level: int, text: str) -> dict:
    return {
        "type": "heading",
        "attrs": {"level": level, "blockId": block_id},
        "content": [{"type": "text", "text": text}],
    }


def _doc_with_sections():
    """H1 Intro / H2 A（含 H3 A1、H4 A11）/ H2 B —— 覆盖章节边界与嵌套。"""
    return SimpleNamespace(
        id=uuid4(),
        organization_id=uuid4(),
        space_id=uuid4(),
        parent_id=None,
        title="文档",
        status="active",
        latest_version=12,
        updated_at=datetime(2026, 6, 9, tzinfo=timezone.utc),
        description_json={
            "type": "doc",
            "content": [
                _heading("h1", 1, "Intro"), _para("p0", "intro"),
                _heading("h2a", 2, "A"), _para("pa", "a"),
                _heading("h3a1", 3, "A1"), _para("pa1", "a1"),
                _heading("h4a11", 4, "A11"), _para("pa11", "a11"),
                _heading("h2b", 2, "B"), _para("pb", "b"),
            ],
        },
        description_markdown="x",
        description_plaintext="x",
    )


class TestReadSection(TestCase):
    def test_h2_section_stops_before_next_same_level_heading(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h2a")
        # 收到下一个 H2(h2b) 之前为止，含其下 H3/H4 子节，不吞 h2b。
        self.assertEqual(result["block_ids"], ["h2a", "pa", "h3a1", "pa1", "h4a11", "pa11"])
        self.assertEqual(result["block_count"], 6)
        self.assertEqual(result["heading_level"], 2)
        self.assertIn("## A", result["markdown"])
        self.assertEqual(result["base_version"], 12)
        self.assertTrue(result["base_updated_at"].startswith("2026-06-09"))

    def test_h1_section_includes_all_nested_subsections(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h1")
        self.assertEqual(result["block_count"], 10)

    def test_last_section_collects_to_document_end(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h2b")
        self.assertEqual(result["block_ids"], ["h2b", "pb"])

    def test_max_depth_excludes_deeper_subsection(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h2a", max_depth=1)
        # L=2，max_depth=1 → 只到 L3，H4(h4a11) 及其正文被跳过。
        self.assertEqual(result["block_ids"], ["h2a", "pa", "h3a1", "pa1"])

    def test_max_depth_includes_within_limit(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h2a", max_depth=2)
        self.assertEqual(result["block_count"], 6)

    def test_outline_format_returns_per_block_detail(self):
        document = _doc_with_sections()
        result = BlockService(MagicMock()).read_section(document, "h2a", fmt="outline")
        self.assertNotIn("markdown", result)
        self.assertEqual(result["blocks"][0]["block_id"], "h2a")
        self.assertEqual(result["blocks"][0]["block_type"], "heading")
        self.assertEqual(result["blocks"][0]["level"], 2)
        self.assertIn("## A", result["blocks"][0]["markdown"])

    def test_non_heading_anchor_raises_400_error(self):
        document = _doc_with_sections()
        with self.assertRaises(SectionAnchorNotHeadingError):
            BlockService(MagicMock()).read_section(document, "p0")

    def test_missing_anchor_raises_404_error(self):
        document = _doc_with_sections()
        with self.assertRaises(BlockNotFoundError):
            BlockService(MagicMock()).read_section(document, "nope")

    def test_invalid_format_or_max_depth_raises_value_error(self):
        document = _doc_with_sections()
        service = BlockService(MagicMock())
        with self.assertRaises(ValueError):
            service.read_section(document, "h2a", fmt="json")
        for bad in (0, -1):
            with self.assertRaises(ValueError):
                service.read_section(document, "h2a", max_depth=bad)

    def test_empty_section_returns_heading_only(self):
        document = _doc_with_sections()
        document.description_json["content"] = [
            _heading("x", 2, "X"), _heading("y", 2, "Y"), _para("py", "y"),
        ]
        result = BlockService(MagicMock()).read_section(document, "x")
        self.assertEqual(result["block_ids"], ["x"])
        self.assertEqual(result["block_count"], 1)


def _text_of(node: dict) -> str:
    parts = []
    if "text" in node:
        parts.append(node["text"])
    for child in node.get("content", []):
        parts.append(_text_of(child))
    return "".join(parts)

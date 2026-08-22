"""
DV-011 回归测试（TD-3 迁移后版本）

V1 Revision fallback 在 block 写操作（update_block / insert_block / delete_block）中
应被阻止，避免旧数据覆盖 V3 内容。读操作（list_blocks / read_block）仍允许 fallback。

原 FC 工具（document_tools.py 的 block 工具）已删除，单块逻辑迁到
apps/tabdoc/services/block_service.py。本回归改为直接验证 BlockService 与其
内部 _resolve_pm_json 的 fallback 控制；list_blocks 只读大纲仍由保留的
TabdocListBlocksTool 承载，一并回归。
"""
from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from datetime import datetime, timezone  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest import TestCase  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402
from uuid import uuid4  # noqa: E402

from apps.tabdoc.services.block_service import BlockService, _resolve_pm_json  # noqa: E402


def _make_document(**overrides):
    defaults = {
        "id": uuid4(),
        "organization_id": uuid4(),
        "space_id": uuid4(),
        "parent_id": None,
        "title": "测试文档",
        "status": "active",
        "latest_version": 5,
        "updated_at": datetime.now(timezone.utc),
        "description_json": {},
        "description_markdown": "",
        "description_plaintext": "",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _make_v1_revision():
    return SimpleNamespace(
        version=1,
        content_pm_json={
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "attrs": {"blockId": "old-block-1"},
                    "content": [{"type": "text", "text": "V1 旧数据"}],
                }
            ],
        },
        content_markdown="V1 旧数据",
        content_plaintext="V1 旧数据",
    )


class TestDV011ResolvePmJsonFallbackControl(TestCase):
    """_resolve_pm_json 的 allow_v1_fallback 参数测试。"""

    def test_v1_fallback_allowed_for_read_operations(self):
        document = _make_document()
        revision = _make_v1_revision()

        service = MagicMock()
        service.get_latest_revision.return_value = revision

        result = _resolve_pm_json(service, document, allow_v1_fallback=True)
        self.assertEqual(result, revision.content_pm_json)

    def test_v1_fallback_blocked_for_write_operations(self):
        document = _make_document()
        revision = _make_v1_revision()

        service = MagicMock()
        service.get_latest_revision.return_value = revision

        with self.assertRaises(ValueError) as ctx:
            _resolve_pm_json(service, document, allow_v1_fallback=False)

        self.assertIn("V1 Revision", str(ctx.exception))

    def test_no_fallback_needed_when_pm_json_has_content(self):
        """description_json 有内容时，不触发任何 fallback。"""
        pm_json = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "attrs": {"blockId": "b1"}, "content": [{"type": "text", "text": "V3 内容"}]}
            ],
        }
        document = _make_document(description_json=pm_json)

        service = MagicMock()
        result = _resolve_pm_json(service, document, allow_v1_fallback=False)
        self.assertEqual(result, pm_json)
        service.get_latest_revision.assert_not_called()


class TestDV011BlockServiceRejectsV1Fallback(TestCase):
    """BlockService 写操作应在 V1 Revision fallback 时抛 ValueError，且不落库。"""

    def _service_with_v1(self):
        service = MagicMock()
        service.get_latest_revision.return_value = _make_v1_revision()
        return service

    def test_update_block_raises_on_v1_fallback(self):
        document = _make_document()
        service = self._service_with_v1()

        with self.assertRaises(ValueError) as ctx:
            BlockService(service).update_block(document, "old-block-1", "新内容")

        self.assertIn("V1 Revision", str(ctx.exception))
        service.save_content.assert_not_called()

    def test_insert_block_raises_on_v1_fallback(self):
        document = _make_document()
        service = self._service_with_v1()

        with self.assertRaises(ValueError) as ctx:
            BlockService(service).insert_block(document, "插入内容")

        self.assertIn("V1 Revision", str(ctx.exception))
        service.save_content.assert_not_called()

    def test_delete_block_raises_on_v1_fallback(self):
        document = _make_document()
        service = self._service_with_v1()

        with self.assertRaises(ValueError) as ctx:
            BlockService(service).delete_block(document, "old-block-1")

        self.assertIn("V1 Revision", str(ctx.exception))
        service.save_content.assert_not_called()


class TestDV011BlockServiceReadAllowsV1Fallback(TestCase):
    """read_block 读操作应允许 V1 Revision fallback（不报错）。"""

    def test_read_block_succeeds_with_v1_fallback(self):
        document = _make_document()
        service = MagicMock()
        service.get_latest_revision.return_value = _make_v1_revision()

        result = BlockService(service).read_block(document, "old-block-1")
        self.assertEqual(result["block_id"], "old-block-1")
        self.assertIn("V1 旧数据", result["markdown"])


class TestDV011ListOutlineAllowsV1Fallback(TestCase):
    """list_outline_blocks（list-blocks 端点 + 保留的 FC 大纲工具共用）应允许 V1 fallback。

    直接对真实 DocumentService 实例验证：description_json/markdown 都空时回退到 V1
    Revision 的内容并解析出大纲，与 block 读操作的 fallback 口径一致。
    """

    def test_list_outline_succeeds_with_v1_fallback(self):
        from apps.tabdoc.services.document_service import DocumentService

        document = _make_document()
        revision = _make_v1_revision()

        svc = DocumentService(user=None)
        svc.get_latest_revision = MagicMock(return_value=revision)

        blocks = svc.list_outline_blocks(document)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["id"], "old-block-1")

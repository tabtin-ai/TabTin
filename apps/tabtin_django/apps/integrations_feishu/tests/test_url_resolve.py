"""飞书 URL 解析纯函数测试。"""

from __future__ import annotations

from unittest.mock import MagicMock

from django.test import SimpleTestCase

from apps.integrations_feishu.client import FeishuAPIError
from apps.integrations_feishu.url_resolve import (
    enrich_resolved_with_access,
    parse_feishu_resource_url,
    resolve_feishu_urls,
)


class ParseFeishuResourceUrlTests(SimpleTestCase):
    def test_bitable_base_url(self):
        r = parse_feishu_resource_url(
            "https://my.feishu.cn/base/BasexxToken123?table=tblABC&view=vew1",
        )
        self.assertEqual(r["kind"], "bitable")
        self.assertEqual(r["token"], "BasexxToken123")
        self.assertEqual(r["table_id"], "tblABC")
        self.assertIsNone(r["error"])

    def test_docx_url(self):
        r = parse_feishu_resource_url("https://foo.feishu.cn/docx/DoxxxDocToken99")
        self.assertEqual(r["kind"], "docx")
        self.assertEqual(r["token"], "DoxxxDocToken99")
        self.assertIsNone(r["table_id"])

    def test_larksuite_host(self):
        r = parse_feishu_resource_url(
            "https://acme.larksuite.com/base/BaseLarkToken",
        )
        self.assertEqual(r["kind"], "bitable")
        self.assertEqual(r["token"], "BaseLarkToken")

    def test_wiki_parses_as_wiki_kind(self):
        r = parse_feishu_resource_url("https://x.feishu.cn/wiki/WikixxxNode")
        self.assertEqual(r["kind"], "wiki")
        self.assertEqual(r["token"], "WikixxxNode")
        self.assertIsNone(r["error"])

    def test_sheets_unsupported(self):
        r = parse_feishu_resource_url("https://x.feishu.cn/sheets/Shtxxx")
        self.assertEqual(r["kind"], "unsupported")
        self.assertIn("Sheets", r["error"] or "")

    def test_empty(self):
        r = parse_feishu_resource_url("  ")
        self.assertEqual(r["kind"], "unsupported")
        self.assertEqual(r["error"], "空链接")

    def test_bare_token_unsupported(self):
        r = parse_feishu_resource_url("BasexxOnlyToken")
        self.assertEqual(r["kind"], "unsupported")
        self.assertIn("裸 token", r["error"] or "")


class EnrichAccessTests(SimpleTestCase):
    def test_bitable_accessible(self):
        client = MagicMock()
        client.get_bitable_app_name.return_value = "项目库"
        client.list_tables.return_value = [
            {"table_id": "tbl1", "name": "任务"},
        ]
        item = {
            "url": "https://x.feishu.cn/base/Base1",
            "kind": "bitable",
            "token": "Base1",
            "table_id": None,
            "error": None,
        }
        out = enrich_resolved_with_access(client, "tok", item)
        self.assertTrue(out["accessible"])
        self.assertEqual(out["name"], "项目库")
        self.assertEqual(out["table_count"], 1)

    def test_bitable_missing_table(self):
        client = MagicMock()
        client.get_bitable_app_name.return_value = "项目库"
        client.list_tables.return_value = [{"table_id": "tbl1", "name": "任务"}]
        item = {
            "url": "u",
            "kind": "bitable",
            "token": "Base1",
            "table_id": "tblMissing",
            "error": None,
        }
        out = enrich_resolved_with_access(client, "tok", item)
        self.assertFalse(out["accessible"])
        self.assertIn("tblMissing", out["error"] or "")

    def test_docx_api_error(self):
        client = MagicMock()
        client.get_drive_file_name.return_value = None
        client.get_docx_markdown.side_effect = FeishuAPIError("forbidden", code=99991672)
        item = {
            "url": "u",
            "kind": "docx",
            "token": "Doc1",
            "table_id": None,
            "error": None,
        }
        out = enrich_resolved_with_access(client, "tok", item)
        self.assertFalse(out["accessible"])
        self.assertIn("无法访问", out["error"] or "")

    def test_wiki_container_returns_expand_hint(self):
        client = MagicMock()
        client.get_wiki_node.return_value = {
            "name": "产品目录",
            "selectable": False,
            "expandable": True,
            "has_child": True,
            "space_id": "space123",
            "node_token": "WikiNode1",
        }
        item = {
            "url": "https://x.feishu.cn/wiki/WikiNode1",
            "kind": "wiki",
            "token": "WikiNode1",
            "table_id": None,
            "error": None,
        }
        out = enrich_resolved_with_access(client, "tok", item)
        self.assertEqual(out["kind"], "wiki_node")
        self.assertTrue(out["accessible"])
        self.assertEqual(out["space_id"], "space123")
        self.assertEqual(out["node_token"], "WikiNode1")
        self.assertEqual(out["next_action"], "wiki_nodes")
        self.assertIn("wiki nodes", out["hint"] or "")
        self.assertIsNone(out.get("error"))

    def test_wiki_leaf_docx_resolves(self):
        client = MagicMock()
        client.get_wiki_node.return_value = {
            "name": "周报",
            "selectable": True,
            "import_kind": "docx",
            "token": "DocObjToken",
            "space_id": "space1",
            "node_token": "WikiLeaf",
        }
        client.get_drive_file_name.return_value = "周报"
        item = {
            "url": "https://x.feishu.cn/wiki/WikiLeaf",
            "kind": "wiki",
            "token": "WikiLeaf",
            "table_id": None,
            "error": None,
        }
        out = enrich_resolved_with_access(client, "tok", item)
        self.assertEqual(out["kind"], "docx")
        self.assertEqual(out["token"], "DocObjToken")
        self.assertTrue(out["accessible"])
        self.assertEqual(out["next_action"], "import")


class ResolveBatchTests(SimpleTestCase):
    def test_without_client_skips_access(self):
        items = resolve_feishu_urls(
            ["https://x.feishu.cn/docx/DocA"],
        )
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "docx")
        self.assertIsNone(items[0]["accessible"])

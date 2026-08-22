"""导入预览闭包纯函数单测（无 DB）。"""

from django.test import SimpleTestCase

from apps.integrations_feishu.import_preview import build_import_preview, extract_link_targets


class ExtractLinkTargetsTests(SimpleTestCase):
    def test_single_link(self):
        targets, duplex = extract_link_targets(
            {"type": 18, "property": {"table_id": "tblB"}}
        )
        self.assertEqual(targets, ["tblB"])
        self.assertFalse(duplex)

    def test_duplex_link(self):
        targets, duplex = extract_link_targets(
            {"type": 21, "property": {"table_id": "tblA"}}
        )
        self.assertEqual(targets, ["tblA"])
        self.assertTrue(duplex)

    def test_non_link(self):
        targets, duplex = extract_link_targets({"type": 1})
        self.assertEqual(targets, [])
        self.assertFalse(duplex)


class BuildImportPreviewTests(SimpleTestCase):
    def test_closure_includes_linked_table(self):
        preview = build_import_preview(
            selected=[{"app_token": "app1", "table_id": "tblA", "name": "订单"}],
            tables_by_app={
                "app1": [
                    {"table_id": "tblA", "name": "订单"},
                    {"table_id": "tblB", "name": "客户"},
                ]
            },
            fields_by_table={
                ("app1", "tblA"): [
                    {"field_name": "标题", "type": 1},
                    {
                        "field_name": "客户",
                        "type": 18,
                        "property": {"table_id": "tblB"},
                    },
                ],
                ("app1", "tblB"): [
                    {"field_name": "名称", "type": 1},
                ],
            },
        )
        ids = {t["table_id"] for t in preview["tables"]}
        self.assertEqual(ids, {"tblA", "tblB"})
        auto = [t for t in preview["tables"] if t["table_id"] == "tblB"][0]
        self.assertTrue(auto["auto_included"])
        self.assertEqual(len(preview["edges"]), 1)
        self.assertEqual(preview["edges"][0]["to_table_id"], "tblB")
        self.assertFalse(preview["has_attachments"])

    def test_unknown_target_warns(self):
        preview = build_import_preview(
            selected=[{"app_token": "app1", "table_id": "tblA", "name": "订单"}],
            tables_by_app={"app1": [{"table_id": "tblA", "name": "订单"}]},
            fields_by_table={
                ("app1", "tblA"): [
                    {
                        "field_name": "外部",
                        "type": 18,
                        "property": {"table_id": "tblMissing"},
                    },
                ],
            },
        )
        self.assertEqual(len(preview["tables"]), 1)
        self.assertTrue(any("降级" in w for w in preview["warnings"]))
        self.assertFalse(preview["edges"][0]["same_base"])

    def test_has_attachments_flag(self):
        preview = build_import_preview(
            selected=[{"app_token": "app1", "table_id": "tblA", "name": "A"}],
            tables_by_app={"app1": [{"table_id": "tblA", "name": "A"}]},
            fields_by_table={
                ("app1", "tblA"): [
                    {"field_name": "文件", "type": 17},
                ],
            },
        )
        self.assertTrue(preview["has_attachments"])

    def test_preferred_name_equal_table_id_does_not_override(self):
        """客户端用 table_id 冒充 name 时，保留 list_tables 真名。"""
        preview = build_import_preview(
            selected=[{
                "app_token": "app1",
                "table_id": "tblA",
                "name": "tblA",
            }],
            tables_by_app={
                "app1": [{"table_id": "tblA", "name": "订单"}],
            },
            fields_by_table={("app1", "tblA"): [{"field_name": "标题", "type": 1}]},
        )
        self.assertEqual(preview["tables"][0]["name"], "订单")

    def test_empty_preferred_name_keeps_list_tables_name(self):
        preview = build_import_preview(
            selected=[{"app_token": "app1", "table_id": "tblA", "name": ""}],
            tables_by_app={
                "app1": [{"table_id": "tblA", "name": "客户"}],
            },
            fields_by_table={("app1", "tblA"): [{"field_name": "名称", "type": 1}]},
        )
        self.assertEqual(preview["tables"][0]["name"], "客户")

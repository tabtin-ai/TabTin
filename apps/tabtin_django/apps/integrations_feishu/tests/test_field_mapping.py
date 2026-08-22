"""字段映射纯函数单测（无 DB）。"""

from django.test import SimpleTestCase

from apps.integrations_feishu.field_mapping import (
    map_feishu_field_to_tabdata,
    serialize_feishu_cell_value,
)


class MapFeishuFieldTests(SimpleTestCase):
    def test_known_types(self):
        cases = [
            (1, "text"),
            (2, "number"),
            (3, "select"),
            (4, "multi_select"),
            (5, "date"),
            (7, "checkbox"),
            (15, "url"),
            (17, "attachment"),
        ]
        for ftype, expected in cases:
            with self.subTest(ftype=ftype):
                mapped = map_feishu_field_to_tabdata(
                    {"field_name": f"f{ftype}", "type": ftype}
                )
                self.assertEqual(mapped["field_type"], expected)
                self.assertEqual(mapped["name"], f"f{ftype}")

    def test_ui_type_disambiguates_text_and_number_variants(self):
        cases = [
            ({"field_name": "邮箱", "type": 1, "ui_type": "Email"}, "email"),
            ({"field_name": "评分", "type": 2, "ui_type": "Rating"}, "rating"),
            ({"field_name": "进度", "type": 2, "ui_type": "Progress"}, "percent"),
            ({"field_name": "货币", "type": 2, "ui_type": "Currency"}, "currency"),
        ]

        for field, expected in cases:
            with self.subTest(field=field["field_name"]):
                mapped = map_feishu_field_to_tabdata(field)
                self.assertEqual(mapped["field_type"], expected)

    def test_supported_feishu_types_keep_native_semantics(self):
        cases = [
            (11, "user"),
            (13, "phone"),
            (1001, "date"),
            (1002, "date"),
            (1003, "user"),
            (1004, "user"),
            # 飞书自动编号的生成规则无法无损翻译为 TabData 自动编号规则；
            # 先按文本导入，确保已有业务编号不会被目标表重新生成。
            (1005, "text"),
        ]

        for field_type, expected in cases:
            with self.subTest(field_type=field_type):
                mapped = map_feishu_field_to_tabdata(
                    {"field_name": f"f{field_type}", "type": field_type}
                )
                self.assertEqual(mapped["field_type"], expected)

    def test_link_deferred_by_default(self):
        self.assertIsNone(
            map_feishu_field_to_tabdata(
                {"field_name": "关联", "type": 18, "property": {"table_id": "tblX"}}
            )
        )

    def test_link_when_not_deferred(self):
        mapped = map_feishu_field_to_tabdata(
            {"field_name": "关联", "type": 18, "property": {"table_id": "tblX"}},
            defer_link=False,
        )
        self.assertEqual(mapped["field_type"], "link")
        self.assertTrue(mapped["options"]["isOneWay"])

    def test_unknown_type_falls_back_to_text(self):
        mapped = map_feishu_field_to_tabdata({"field_name": "未知", "type": 9999})
        self.assertEqual(mapped["field_type"], "text")

    def test_select_options(self):
        mapped = map_feishu_field_to_tabdata(
            {
                "field_name": "状态",
                "type": 3,
                "property": {
                    "options": [
                        {"name": "待办"},
                        {"name": "完成"},
                    ]
                },
            }
        )
        self.assertEqual(mapped["field_type"], "select")
        self.assertEqual(mapped["options"]["choices"], ["待办", "完成"])

    def test_date_without_time_keeps_date_semantics(self):
        mapped = map_feishu_field_to_tabdata(
            {
                "field_name": "截止日期",
                "type": 5,
                "property": {"date_formatter": "yyyy/MM/dd"},
            }
        )
        self.assertEqual(mapped["field_type"], "date")
        self.assertEqual(
            mapped["options"],
            {"format": "yyyy/MM/dd", "include_time": False},
        )

    def test_supported_field_options_are_preserved(self):
        rating = map_feishu_field_to_tabdata(
            {
                "field_name": "满意度",
                "type": 2,
                "ui_type": "Rating",
                "property": {"max": 5, "rating": {"symbol": "star"}},
            }
        )
        user = map_feishu_field_to_tabdata(
            {
                "field_name": "参与人",
                "type": 11,
                "property": {"multiple": True},
            }
        )
        created_user = map_feishu_field_to_tabdata(
            {"field_name": "创建人", "type": 1003}
        )

        self.assertEqual(rating["options"], {"max": 5, "icon": "star"})
        self.assertEqual(user["options"], {"multiple": True})
        self.assertEqual(created_user["options"], {"multiple": False})

    def test_currency_options_preserve_source_currency_and_precision(self):
        usd = map_feishu_field_to_tabdata(
            {
                "field_name": "美元金额",
                "type": 2,
                "ui_type": "Currency",
                "property": {"currency_code": "USD", "formatter": "0.00"},
            }
        )
        unknown = map_feishu_field_to_tabdata(
            {
                "field_name": "澳门元金额",
                "type": 2,
                "ui_type": "Currency",
                "property": {"currency_code": "MOP", "formatter": "0.000"},
            }
        )

        self.assertEqual(usd["options"], {"symbol": "$", "precision": 2})
        self.assertEqual(unknown["options"], {"symbol": "MOP", "precision": 3})


class SerializeCellTests(SimpleTestCase):
    def test_text_segments(self):
        val = serialize_feishu_cell_value(
            [{"text": "hello", "type": "text"}, {"text": "world", "type": "text"}],
            1,
        )
        self.assertEqual(val, "hello, world")

    def test_number(self):
        self.assertEqual(serialize_feishu_cell_value(3.14, 2), 3.14)

    def test_multi_select(self):
        self.assertEqual(
            serialize_feishu_cell_value([{"name": "A"}, {"name": "B"}], 4),
            ["A", "B"],
        )

    def test_checkbox(self):
        self.assertTrue(serialize_feishu_cell_value(True, 7))

    def test_source_system_timestamps_are_serialized_as_datetimes(self):
        value = serialize_feishu_cell_value(1704067200000, 1001)
        self.assertEqual(value, "2024-01-01T00:00:00+00:00")

    def test_url_dict(self):
        self.assertEqual(
            serialize_feishu_cell_value({"link": "https://a.com", "text": "a"}, 15),
            "https://a.com",
        )

    def test_person_keeps_structured_identity(self):
        source = [{"name": "张三", "id": "ou_x"}]
        val = serialize_feishu_cell_value(source, 11)
        self.assertEqual(val, source)

    def test_link_spill_structure(self):
        from apps.integrations_feishu.field_mapping import extract_link_record_ids

        val = serialize_feishu_cell_value(
            [{"record_id": "rec1"}, {"record_id": "rec2"}],
            18,
        )
        self.assertEqual(val["__feishu_link_ids"], ["rec1", "rec2"])
        self.assertEqual(
            extract_link_record_ids([{"record_id": "recA"}]),
            ["recA"],
        )
        # 飞书 OpenAPI 主形态：link_record_ids 包在对象里
        self.assertEqual(
            extract_link_record_ids({"link_record_ids": ["recX", "recY"]}),
            ["recX", "recY"],
        )
        self.assertEqual(
            extract_link_record_ids([{"link_record_ids": ["recZ"]}]),
            ["recZ"],
        )

    def test_attachment_spill_structure(self):
        from apps.integrations_feishu.field_mapping import extract_attachment_items

        val = serialize_feishu_cell_value(
            [{"file_token": "tok", "name": "a.png", "tmp_url": "https://x"}],
            17,
        )
        self.assertEqual(len(val["__feishu_attachments"]), 1)
        self.assertEqual(val["__feishu_attachments"][0]["file_token"], "tok")
        self.assertEqual(
            extract_attachment_items([{"file_token": "t", "name": "n"}])[0]["name"],
            "n",
        )

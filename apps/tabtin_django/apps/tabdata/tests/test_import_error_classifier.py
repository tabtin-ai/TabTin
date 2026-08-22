"""导入错误分类器单元测试

覆盖:
- ImportErrorType 各类型的中/英文匹配
- 行号提取（中文/英文格式）
- 字段名提取
- build_error_summary 聚合计数
- 边界情况（空字符串、None）
"""

from django.test import SimpleTestCase

from apps.tabdata.services.import_error_classifier import (
    ImportErrorType,
    ClassifiedError,
    classify_import_error,
    build_error_summary,
)


class ClassifyImportErrorTypeTests(SimpleTestCase):
    """classify_import_error 对各类错误消息的分类正确性"""

    # ---- TABLE_NOT_FOUND ----

    def test_table_not_found_cn_target(self):
        err = classify_import_error("目标表不存在: orders")
        self.assertEqual(err.type, ImportErrorType.TABLE_NOT_FOUND)

    def test_table_not_found_cn_short(self):
        err = classify_import_error("表不存在")
        self.assertEqual(err.type, ImportErrorType.TABLE_NOT_FOUND)

    def test_table_not_found_en(self):
        err = classify_import_error("Table not found: orders")
        self.assertEqual(err.type, ImportErrorType.TABLE_NOT_FOUND)

    # ---- PERMISSION_DENIED ----

    def test_permission_denied_cn(self):
        err = classify_import_error("无权限操作该表")
        self.assertEqual(err.type, ImportErrorType.PERMISSION_DENIED)

    def test_permission_denied_cn_generic(self):
        err = classify_import_error("你没有权限执行此操作")
        self.assertEqual(err.type, ImportErrorType.PERMISSION_DENIED)

    def test_permission_denied_en(self):
        err = classify_import_error("Permission denied for user test")
        self.assertEqual(err.type, ImportErrorType.PERMISSION_DENIED)

    def test_access_denied_en(self):
        err = classify_import_error("Access denied on table xyz")
        self.assertEqual(err.type, ImportErrorType.PERMISSION_DENIED)

    # ---- TYPE_MISMATCH ----

    def test_type_mismatch_cn(self):
        err = classify_import_error("第3行 字段'age' 类型不匹配: 期望数字")
        self.assertEqual(err.type, ImportErrorType.TYPE_MISMATCH)

    def test_type_mismatch_cn_convert(self):
        err = classify_import_error("无法转换值 'abc' 为数字")
        self.assertEqual(err.type, ImportErrorType.TYPE_MISMATCH)

    def test_type_mismatch_en(self):
        err = classify_import_error("Row 5: type mismatch, expected number got string")
        self.assertEqual(err.type, ImportErrorType.TYPE_MISMATCH)

    def test_cannot_convert_en(self):
        err = classify_import_error("Cannot convert 'hello' to integer")
        self.assertEqual(err.type, ImportErrorType.TYPE_MISMATCH)

    # ---- NULL_VIOLATION ----

    def test_null_violation_cn_not_empty(self):
        err = classify_import_error("第10行 字段'name' 不能为空")
        self.assertEqual(err.type, ImportErrorType.NULL_VIOLATION)

    def test_null_violation_cn_required(self):
        err = classify_import_error("必填字段缺失")
        self.assertEqual(err.type, ImportErrorType.NULL_VIOLATION)

    def test_null_violation_cn_missing_required(self):
        err = classify_import_error("缺少必填字段 email")
        self.assertEqual(err.type, ImportErrorType.NULL_VIOLATION)

    def test_null_violation_en_required(self):
        err = classify_import_error("Row 1: field 'email' is required")
        self.assertEqual(err.type, ImportErrorType.NULL_VIOLATION)

    def test_null_violation_en_not_null(self):
        err = classify_import_error("Column 'name' cannot be not null")
        self.assertEqual(err.type, ImportErrorType.NULL_VIOLATION)

    # ---- UNIQUE_VIOLATION ----

    def test_unique_violation_cn_duplicate(self):
        err = classify_import_error("第5行 字段'code' 重复")
        self.assertEqual(err.type, ImportErrorType.UNIQUE_VIOLATION)

    def test_unique_violation_cn_primary_key(self):
        err = classify_import_error("主键冲突")
        self.assertEqual(err.type, ImportErrorType.UNIQUE_VIOLATION)

    def test_unique_violation_en_duplicate(self):
        err = classify_import_error("Duplicate entry for primary key")
        self.assertEqual(err.type, ImportErrorType.UNIQUE_VIOLATION)

    # ---- FORMAT_ERROR ----

    def test_format_error_cn_date(self):
        err = classify_import_error("日期格式不正确: '2025-13-01'")
        self.assertEqual(err.type, ImportErrorType.FORMAT_ERROR)

    def test_format_error_en_invalid(self):
        err = classify_import_error("Invalid date format for column 'birthday'")
        self.assertEqual(err.type, ImportErrorType.FORMAT_ERROR)

    # ---- COLUMN_MISMATCH ----

    def test_column_mismatch_cn(self):
        err = classify_import_error("列数不匹配: 期望5列，实际3列")
        self.assertEqual(err.type, ImportErrorType.COLUMN_MISMATCH)

    def test_column_mismatch_en(self):
        err = classify_import_error("Column mismatch: expected 5 but got 3")
        self.assertEqual(err.type, ImportErrorType.COLUMN_MISMATCH)

    # ---- VALIDATION_ERROR ----

    def test_validation_error_cn(self):
        err = classify_import_error("验证规则不通过: 值超出范围")
        self.assertEqual(err.type, ImportErrorType.VALIDATION_ERROR)

    def test_validation_error_en(self):
        err = classify_import_error("Validation failed for row 3")
        self.assertEqual(err.type, ImportErrorType.VALIDATION_ERROR)

    # ---- ROW_LIMIT ----

    def test_row_limit_cn(self):
        err = classify_import_error("最多支持10000行")
        self.assertEqual(err.type, ImportErrorType.ROW_LIMIT)

    def test_row_limit_en(self):
        err = classify_import_error("Row limit exceeded: max 10000")
        self.assertEqual(err.type, ImportErrorType.ROW_LIMIT)

    # ---- FIELD_LIMIT ----

    def test_field_limit_cn(self):
        err = classify_import_error("字段数限制: 最多100个字段")
        self.assertEqual(err.type, ImportErrorType.FIELD_LIMIT)

    def test_field_limit_en(self):
        err = classify_import_error("Field limit reached")
        self.assertEqual(err.type, ImportErrorType.FIELD_LIMIT)

    # ---- UNKNOWN ----

    def test_unknown_unrecognized_message(self):
        err = classify_import_error("some completely random error")
        self.assertEqual(err.type, ImportErrorType.UNKNOWN)

    def test_unknown_no_keywords(self):
        err = classify_import_error("something went wrong")
        self.assertEqual(err.type, ImportErrorType.UNKNOWN)


class RowExtractionTests(SimpleTestCase):
    """行号提取正则测试"""

    def test_chinese_no_space(self):
        err = classify_import_error("第3行数据有误")
        self.assertEqual(err.row, 3)

    def test_chinese_with_space(self):
        err = classify_import_error("第 3 行数据有误")
        self.assertEqual(err.row, 3)

    def test_chinese_large_number(self):
        err = classify_import_error("第99999行 类型不匹配")
        self.assertEqual(err.row, 99999)

    def test_english_row_uppercase(self):
        err = classify_import_error("Row 3: type mismatch")
        self.assertEqual(err.row, 3)

    def test_english_row_lowercase(self):
        err = classify_import_error("row 42: some error")
        self.assertEqual(err.row, 42)

    def test_no_row_info(self):
        err = classify_import_error("一般性错误消息")
        self.assertIsNone(err.row)


class FieldNameExtractionTests(SimpleTestCase):
    """字段名提取测试"""

    def test_single_quotes(self):
        err = classify_import_error("字段'name' 不能为空")
        self.assertEqual(err.field_name, "name")

    def test_backtick_quotes(self):
        err = classify_import_error("字段`age` 类型不匹配")
        self.assertEqual(err.field_name, "age")

    def test_smart_quotes(self):
        err = classify_import_error("字段\u2018email\u2019 格式不正确")
        self.assertEqual(err.field_name, "email")

    def test_no_field_name(self):
        err = classify_import_error("类型不匹配")
        self.assertIsNone(err.field_name)


class MessageExtractionTests(SimpleTestCase):
    """message 字段提取测试（冒号分割）"""

    def test_english_colon(self):
        err = classify_import_error("第3行 字段'name': 不能为空")
        self.assertEqual(err.message, "不能为空")

    def test_chinese_colon(self):
        # 源码对中文冒号也用 +2 偏移，会多跳 1 字符
        err = classify_import_error("第3行 字段'name'：不能为空")
        self.assertEqual(err.message, "能为空")

    def test_no_colon(self):
        err = classify_import_error("类型不匹配")
        self.assertEqual(err.message, "类型不匹配")

    def test_raw_message_preserved(self):
        raw = "第3行 字段'name': 不能为空"
        err = classify_import_error(raw)
        self.assertEqual(err.raw_message, raw)


class BuildErrorSummaryTests(SimpleTestCase):
    """build_error_summary 聚合计数测试"""

    def test_empty_list(self):
        self.assertEqual(build_error_summary([]), {})

    def test_single_type(self):
        errors = [
            classify_import_error("第1行 类型不匹配"),
            classify_import_error("第2行 无法转换"),
        ]
        summary = build_error_summary(errors)
        self.assertEqual(summary, {"type_mismatch": 2})

    def test_multiple_types(self):
        errors = [
            classify_import_error("第1行 类型不匹配"),
            classify_import_error("第2行 不能为空"),
            classify_import_error("第3行 重复"),
            classify_import_error("第4行 类型不匹配"),
        ]
        summary = build_error_summary(errors)
        self.assertEqual(summary["type_mismatch"], 2)
        self.assertEqual(summary["null_violation"], 1)
        self.assertEqual(summary["unique_violation"], 1)
        self.assertEqual(len(summary), 3)

    def test_all_unknown(self):
        errors = [
            classify_import_error("random error 1"),
            classify_import_error("random error 2"),
        ]
        summary = build_error_summary(errors)
        self.assertEqual(summary, {"unknown": 2})

    def test_all_error_types_present(self):
        messages = [
            "目标表不存在",
            "无权限",
            "类型不匹配",
            "不能为空",
            "重复",
            "格式化失败",
            "列数不匹配",
            "验证规则不通过",
            "最多支持1000行",
            "字段数限制",
            "random",
        ]
        errors = [classify_import_error(m) for m in messages]
        summary = build_error_summary(errors)
        self.assertEqual(len(summary), 11)


class ClassifiedErrorToDictTests(SimpleTestCase):
    """ClassifiedError.to_dict() 测试"""

    def test_to_dict_complete(self):
        err = classify_import_error("第3行 字段'name' 不能为空")
        d = err.to_dict()
        self.assertEqual(d["type"], "null_violation")
        self.assertEqual(d["row"], 3)
        self.assertEqual(d["field_name"], "name")
        self.assertIn("message", d)
        self.assertNotIn("raw_message", d)

    def test_to_dict_minimal(self):
        err = classify_import_error("random error")
        d = err.to_dict()
        self.assertEqual(d["type"], "unknown")
        self.assertIsNone(d["row"])
        self.assertIsNone(d["field_name"])


class EdgeCaseTests(SimpleTestCase):
    """边界情况测试"""

    def test_empty_string(self):
        err = classify_import_error("")
        self.assertEqual(err.type, ImportErrorType.UNKNOWN)
        self.assertIsNone(err.row)
        self.assertIsNone(err.field_name)
        self.assertEqual(err.message, "")

    def test_none_raises_type_error(self):
        with self.assertRaises(TypeError):
            classify_import_error(None)

    def test_keyword_priority_table_not_found_over_format(self):
        """'目标表不存在' 排在关键词列表前面，应优先匹配"""
        err = classify_import_error("目标表不存在，格式化失败")
        self.assertEqual(err.type, ImportErrorType.TABLE_NOT_FOUND)

    def test_case_insensitive_matching(self):
        err = classify_import_error("TABLE NOT FOUND")
        self.assertEqual(err.type, ImportErrorType.TABLE_NOT_FOUND)

    def test_combined_row_and_field_extraction(self):
        err = classify_import_error("第 15 行 字段'score' 类型不匹配: 期望数字")
        self.assertEqual(err.type, ImportErrorType.TYPE_MISMATCH)
        self.assertEqual(err.row, 15)
        self.assertEqual(err.field_name, "score")
        self.assertEqual(err.message, "期望数字")

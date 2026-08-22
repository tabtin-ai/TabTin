"""
FH-005 / FH-010 / FH-011 回归测试

覆盖：
- FH-005: create_field / delete_field 乐观锁保护（expected_schema_version 参数 + 校验逻辑）
- FH-010: update_field schema_version 递增覆盖 width/is_hidden 等
- FH-011: convert_field_type 中 _increment_schema_version 在内层事务内

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_fh005_fh010_fh011_schema_version.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import inspect
import ast
import textwrap
import pytest

from apps.tabdata.services.table_service import TableService
from apps.tabdata.exceptions import SchemaVersionMismatchError


# ━━ FH-005: create_field / delete_field 乐观锁 ━━━━━━━━━━━━━━━━━━

class TestFH005CreateFieldOptimisticLock:
    """create_field 必须接受 expected_schema_version 参数并做乐观锁校验。"""

    def test_create_field_accepts_expected_schema_version_param(self):
        """create_field 签名中必须包含 expected_schema_version 参数。"""
        sig = inspect.signature(TableService.create_field)
        assert 'expected_schema_version' in sig.parameters, (
            "create_field 缺少 expected_schema_version 参数，FH-005 修复不完整"
        )
        param = sig.parameters['expected_schema_version']
        assert param.default is None, (
            "expected_schema_version 默认值应为 None（可选参数），向后兼容"
        )

    def test_create_field_has_schema_version_mismatch_check(self):
        """create_field 源码中必须包含 SchemaVersionMismatchError 的抛出逻辑。"""
        source = inspect.getsource(TableService.create_field)
        assert 'SchemaVersionMismatchError' in source, (
            "create_field 中未找到 SchemaVersionMismatchError，乐观锁校验缺失"
        )
        assert 'select_for_update' in source, (
            "create_field 中未找到 select_for_update，行级锁缺失"
        )

    def test_create_field_checks_version_before_business_logic(self):
        """乐观锁校验必须在字段创建逻辑之前执行（在 TableField.create 之前）。"""
        source = inspect.getsource(TableService.create_field)
        lock_pos = source.find('SchemaVersionMismatchError')
        create_pos = source.find('TableField.objects')
        assert lock_pos < create_pos, (
            "SchemaVersionMismatchError 应出现在 TableField.objects 创建调用之前"
        )


class TestFH005DeleteFieldOptimisticLock:
    """delete_field 必须接受 expected_schema_version 参数并做乐观锁校验。"""

    def test_delete_field_accepts_expected_schema_version_param(self):
        """delete_field 签名中必须包含 expected_schema_version 参数。"""
        sig = inspect.signature(TableService.delete_field)
        assert 'expected_schema_version' in sig.parameters, (
            "delete_field 缺少 expected_schema_version 参数，FH-005 修复不完整"
        )
        param = sig.parameters['expected_schema_version']
        assert param.default is None, (
            "expected_schema_version 默认值应为 None（可选参数），向后兼容"
        )

    def test_delete_field_has_schema_version_mismatch_check(self):
        """delete_field 源码中必须包含 SchemaVersionMismatchError 的抛出逻辑。"""
        source = inspect.getsource(TableService.delete_field)
        assert 'SchemaVersionMismatchError' in source, (
            "delete_field 中未找到 SchemaVersionMismatchError，乐观锁校验缺失"
        )
        assert 'select_for_update' in source, (
            "delete_field 中未找到 select_for_update，行级锁缺失"
        )

    def test_delete_field_lock_pattern_matches_reorder(self):
        """delete_field 的乐观锁模式应与 reorder_fields 一致（三层保护）。"""
        source = inspect.getsource(TableService.delete_field)
        assert 'expected_schema_version is not None' in source, (
            "delete_field 中未做 expected_schema_version is not None 判断"
        )
        assert 'schema_version' in source and 'expected_schema_version' in source, (
            "delete_field 中缺少 schema_version 与 expected_schema_version 的比较"
        )
        assert 'current_version' in source and 'expected_version' in source, (
            "SchemaVersionMismatchError 应携带 current_version 和 expected_version 信息"
        )


class TestFH005ConsistencyWithReorderFields:
    """create_field / delete_field 的乐观锁模式应与 reorder_fields 保持一致。"""

    def test_all_three_methods_share_same_lock_pattern(self):
        """reorder_fields / create_field / delete_field 都应包含相同的锁定模式。"""
        for method_name in ('create_field', 'delete_field', 'reorder_fields'):
            method = getattr(TableService, method_name)
            source = inspect.getsource(method)
            assert 'select_for_update' in source, (
                f"{method_name} 中缺少 select_for_update"
            )
            assert 'SchemaVersionMismatchError' in source, (
                f"{method_name} 中缺少 SchemaVersionMismatchError"
            )


# ━━ FH-010: update_field schema_version 递增覆盖范围 ━━━━━━━━━━━━

class TestFH010UpdateFieldSchemaVersionScope:
    """update_field 修改 is_hidden/width 等属性时也应递增 schema_version。"""

    def _get_schema_affecting_block(self):
        """从 update_field 源码中提取 schema_affecting_change 判断块。"""
        source = inspect.getsource(TableService.update_field)
        return source

    def test_is_hidden_triggers_schema_version_increment(self):
        """修改 is_hidden 应触发 schema_version 递增。"""
        source = self._get_schema_affecting_block()
        assert 'is_hidden is not None' in source, (
            "update_field 的 schema_version 递增条件中缺少 is_hidden"
        )

    def test_width_triggers_schema_version_increment(self):
        """修改 width 应触发 schema_version 递增。"""
        source = self._get_schema_affecting_block()
        assert 'width is not None' in source, (
            "update_field 的 schema_version 递增条件中缺少 width"
        )

    def test_validation_rules_triggers_schema_version_increment(self):
        """修改 validation_rules 应触发 schema_version 递增。"""
        source = self._get_schema_affecting_block()
        assert 'validation_rules is not None' in source, (
            "update_field 的 schema_version 递增条件中缺少 validation_rules"
        )

    def test_visibility_roles_triggers_schema_version_increment(self):
        """修改 visibility_roles 应触发 schema_version 递增。"""
        source = self._get_schema_affecting_block()
        assert 'visibility_roles is not None' in source, (
            "update_field 的 schema_version 递增条件中缺少 visibility_roles"
        )

    def test_schema_affecting_change_variable_exists(self):
        """应使用 schema_affecting_change 变量聚合所有触发条件。"""
        source = self._get_schema_affecting_block()
        assert 'schema_affecting_change' in source, (
            "update_field 应定义 schema_affecting_change 变量聚合所有 schema 影响条件"
        )

    def test_only_name_change_not_description_triggers_increment(self):
        """description 变更不应出现在 schema_affecting_change 条件中。"""
        source = self._get_schema_affecting_block()
        # 提取 schema_affecting_change 赋值块
        start = source.find('schema_affecting_change')
        end = source.find('if schema_affecting_change')
        block = source[start:end]
        assert 'description' not in block, (
            "description 变更不应触发 schema_version 递增"
        )


# ━━ FH-011: convert_field_type schema_version 事务边界 ━━━━━━━━━━

class TestFH011ConvertFieldTypeTransactionBoundary:
    """_increment_schema_version 必须在 convert_field_type 的内层事务内调用。"""

    def test_increment_inside_inner_transaction(self):
        """_increment_schema_version 应在 'with transaction.atomic' 块内、'except' 块之前。"""
        source = inspect.getsource(TableService.convert_field_type)
        lines = source.split('\n')

        increment_line_idx = None
        inner_except_line_idx = None

        for i, line in enumerate(lines):
            stripped = line.strip()
            if '_increment_schema_version' in stripped:
                increment_line_idx = i
            if stripped == 'except Exception as e:' and increment_line_idx is None:
                inner_except_line_idx = i

        assert increment_line_idx is not None, (
            "convert_field_type 中未找到 _increment_schema_version 调用"
        )

        if inner_except_line_idx is not None:
            assert increment_line_idx < inner_except_line_idx, (
                "_increment_schema_version 应在内层事务的 except 之前被调用，"
                f"实际在第 {increment_line_idx} 行，except 在第 {inner_except_line_idx} 行"
            )

    def test_no_increment_after_inner_except(self):
        """内层事务的 except 块之后不应再有 _increment_schema_version 调用。"""
        source = inspect.getsource(TableService.convert_field_type)
        lines = source.split('\n')

        found_error_response = False
        for line in lines:
            stripped = line.strip()
            if 'FIELD_CONVERSION_FAILED' in stripped:
                found_error_response = True
            if found_error_response and '_increment_schema_version' in stripped:
                pytest.fail(
                    "_increment_schema_version 在内层事务的 except/error_response 之后仍被调用，"
                    "违反 FH-011 事务边界一致性要求"
                )

    def test_increment_at_same_indentation_as_field_save(self):
        """_increment_schema_version 应与 field.save() 同级缩进（同在内层事务块内）。"""
        source = inspect.getsource(TableService.convert_field_type)
        lines = source.split('\n')

        field_save_indent = None
        increment_indent = None

        for line in lines:
            if 'field.field_type = target_type' in line:
                field_save_indent = len(line) - len(line.lstrip())
            if '_increment_schema_version' in line:
                increment_indent = len(line) - len(line.lstrip())

        assert field_save_indent is not None, "未找到 field.field_type = target_type"
        assert increment_indent is not None, "未找到 _increment_schema_version"
        assert increment_indent == field_save_indent, (
            f"_increment_schema_version 缩进 ({increment_indent}) 应与 "
            f"field.field_type 赋值 ({field_save_indent}) 相同，确保在同一事务块内"
        )

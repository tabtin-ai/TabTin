"""
table-kernel ↔ Django 字段行为对齐测试

从共享 JSON fixtures 中读取测试用例，验证 Python 侧的 validate/format 结果
与 TypeScript 内核保持一致。

fixtures 来源：packages/table-kernel/tests/fixtures/
通过符号链接放置于 shared_fixtures/ 目录。
"""

import json
import os
import pytest
from pathlib import Path

from apps.tabdata.utils.field_types import validate_field_value, format_field_value

FIXTURES_DIR = Path(__file__).parent / "shared_fixtures"


def load_field_validation_fixtures():
    """加载 field-validation.json fixture"""
    fixture_path = FIXTURES_DIR / "field-validation.json"
    if not fixture_path.exists():
        return []

    with open(fixture_path) as f:
        data = json.load(f)

    cases = []
    for field_type, items in data.items():
        for i, item in enumerate(items):
            cases.append((field_type, i, item))
    return cases


def load_filter_evaluation_fixtures():
    """加载 filter-evaluation.json fixture"""
    fixture_path = FIXTURES_DIR / "filter-evaluation.json"
    if not fixture_path.exists():
        return []

    with open(fixture_path) as f:
        data = json.load(f)
    return data


VALIDATION_CASES = load_field_validation_fixtures()

# Django 侧只读类型跳过对齐检查
SKIP_TYPES = {
    "created_time", "last_modified_time", "created_by", "last_modified_by",
}


@pytest.mark.parametrize(
    "field_type,case_idx,case_data",
    VALIDATION_CASES,
    ids=[f"{ft}[{i}]" for ft, i, _ in VALIDATION_CASES],
)
def test_field_validation_alignment(field_type, case_idx, case_data):
    """验证 Python 侧 validate 结果与 TS 内核一致"""
    if field_type in SKIP_TYPES:
        pytest.skip(f"Skip computed/readonly type: {field_type}")

    value = case_data["value"]
    expected_valid = case_data["valid"]
    options = case_data.get("options")

    result = validate_field_value(field_type, value, options)

    assert result == expected_valid, (
        f"[{field_type}] case {case_idx}: validate({value!r}) "
        f"expected {expected_valid}, got {result}"
    )


@pytest.mark.parametrize(
    "field_type,case_idx,case_data",
    [c for c in VALIDATION_CASES if "formatted" in c[2]],
    ids=[f"{ft}[{i}]" for ft, i, d in VALIDATION_CASES if "formatted" in d],
)
def test_field_format_alignment(field_type, case_idx, case_data):
    """验证 Python 侧 format 结果与 TS 内核一致"""
    if field_type in SKIP_TYPES:
        pytest.skip(f"Skip computed/readonly type: {field_type}")

    value = case_data["value"]
    expected_formatted = case_data["formatted"]
    options = case_data.get("options")

    result = format_field_value(field_type, value, options)

    if isinstance(expected_formatted, float):
        assert abs(result - expected_formatted) < 1e-10, (
            f"[{field_type}] case {case_idx}: format({value!r}) "
            f"expected {expected_formatted}, got {result}"
        )
    else:
        assert result == expected_formatted, (
            f"[{field_type}] case {case_idx}: format({value!r}) "
            f"expected {expected_formatted!r}, got {result!r}"
        )

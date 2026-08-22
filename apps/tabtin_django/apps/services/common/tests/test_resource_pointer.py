"""
ResourcePointer Python 镜像 ── 双端字符级对齐测试。

读 `packages/resource-router/test/fixtures/parse-cross-lang.fixtures.json`，
验证 Python `ResourcePointer.parse()` 输出与 fixture 完全一致。

任一端漂移 = D5 双轨双向覆盖失守 = 后端 open_in_space 工具校验跟前端不一致 =
Agent 输出 `tabtin://resource/...` 在 Mobile / Daemon 没法跟 Electron 跑出
同样的派发结果。

W2 北极星之一：`pytest apps/services/common/tests/test_resource_pointer.py`。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.services.common.resource_pointer import (
    ResourcePointer,
    serialize_self_format,
)


# ── Fixture 路径解析 ────────────────────────────────────────────────────

# 项目根目录是 ".../TabTinSheet"，本测试文件在
#   apps/tabtin_django/apps/services/common/tests/test_resource_pointer.py
# parents 从 [0]=tests / [1]=common / [2]=services / [3]=apps / [4]=tabtin_django /
#   [5]=apps（顶层 apps/）/ [6]=TabTinSheet（项目根）
_PROJECT_ROOT = Path(__file__).resolve().parents[6]
_FIXTURE_PATH = (
    _PROJECT_ROOT
    / "packages"
    / "resource-router"
    / "test"
    / "fixtures"
    / "parse-cross-lang.fixtures.json"
)


def _load_fixtures() -> list[dict]:
    """加载 cross-lang fixtures。fixture 文件不存在时返回空列表——单元测试
    层的 `test_fixture_count_at_least_30` 会拦住空 list 让整体 fail，避免
    "假性 PASS"（本测试必须真覆盖到 fixture，缺失就是 W2 接入失败）。"""
    if not _FIXTURE_PATH.exists():
        return []
    data = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
    return data["samples"]


# ── 双端 byte-equal 守门 ────────────────────────────────────────────────


@pytest.mark.parametrize("sample", _load_fixtures(), ids=lambda s: s["name"])
def test_parse_cross_lang(sample: dict) -> None:
    p = ResourcePointer.parse(sample["uri"])
    expected = sample["expected"]

    assert p.scheme == expected["scheme"], (
        f"{sample['name']}: scheme {p.scheme!r} != {expected['scheme']!r}"
    )
    assert p.type == expected["type"], (
        f"{sample['name']}: type {p.type!r} != {expected['type']!r}"
    )
    assert p.id == expected["id"], (
        f"{sample['name']}: id {p.id!r} != {expected['id']!r}"
    )
    assert p.raw == expected["raw"]
    assert p.hint == expected["hint"]

    expected_meta = expected.get("meta")
    if expected_meta is None:
        assert p.meta is None or p.meta == {}, (
            f"{sample['name']}: expected no meta, got {p.meta!r}"
        )
    else:
        assert p.meta == expected_meta, (
            f"{sample['name']}: meta {p.meta!r} != {expected_meta!r}"
        )


def test_fixture_count_at_least_30() -> None:
    """W2 北极星阈值：双端共享 fixtures ≥ 30 条。"""
    samples = _load_fixtures()
    assert len(samples) >= 30, f"expected ≥ 30 cross-lang samples, got {len(samples)}"


# ── 边界场景（不在 fixtures 内但语义重要） ──────────────────────────────


def test_parse_none_returns_unknown_with_empty_raw() -> None:
    p = ResourcePointer.parse(None)
    assert p.scheme == "unknown"
    assert p.raw == ""


def test_parse_baseDir_is_passed_through() -> None:
    p = ResourcePointer.parse("tabtin://resource/file/x", base_dir="/Users/foo")
    assert p.base_dir == "/Users/foo"


def test_industry_format_never_carries_hint() -> None:
    """D5 决策：行业格式 hint 恒为 None，即使 query 里写了 ?hint=..."""
    p = ResourcePointer.parse("https://example.com?hint=tabweb")
    assert p.hint is None
    assert p.scheme == "https"


def test_self_format_double_hint_first_wins() -> None:
    p = ResourcePointer.parse(
        "tabtin://resource/document/doc_xyz?hint=tabdoc&hint=tabweb"
    )
    assert p.hint == "tabdoc"


def test_self_format_meta_multivalue_collected_as_list() -> None:
    p = ResourcePointer.parse("tabtin://resource/table/tbl_x?tag=a&tag=b&tag=c")
    assert p.meta == {"tag": ["a", "b", "c"]}


# ── serialize_self_format round-trip ──────────────────────────────────


def test_serialize_minimal() -> None:
    out = serialize_self_format(type="table", id="tbl_abc", hint=None)
    assert out == "tabtin://resource/table/tbl_abc"


def test_serialize_round_trip() -> None:
    out = serialize_self_format(
        type="document",
        id="doc_xyz",
        hint="tabdoc",
        meta={"title": "项目"},
    )
    p = ResourcePointer.parse(out)
    assert p.type == "document"
    assert p.id == "doc_xyz"
    assert p.hint == "tabdoc"
    assert p.meta == {"title": "项目"}


def test_serialize_environment_scheme_round_trip() -> None:
    out = serialize_self_format(
        type="table",
        id="tbl_abc",
        hint="tabdata",
        meta={"recordIds": "rec_abc"},
        scheme="tabtin-preprod",
    )
    assert out.startswith("tabtin-preprod://resource/table/tbl_abc?")
    p = ResourcePointer.parse(out)
    assert p.scheme == "tabtin"
    assert p.meta == {"recordIds": "rec_abc"}


def test_serialize_path_with_slashes_round_trip() -> None:
    out = serialize_self_format(
        type="code_file",
        id="/Users/x/y.md",
        hint="tabcode",
    )
    p = ResourcePointer.parse(out)
    assert p.id == "/Users/x/y.md"


def test_serialize_throws_on_missing_type() -> None:
    with pytest.raises(ValueError, match="type is required"):
        serialize_self_format(type=None, id="x", hint=None)

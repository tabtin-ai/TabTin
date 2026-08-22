"""Wave 1.1 / B-4 单元测试。

覆盖范围
--------

B-4 ``RecordHandlerBase.should_skip`` / ``_should_publish_event``:
- 已登记的 skip flag 正确返回 True/False
- 未登记的 skip flag 返回 False 并打 warning（不抛）
- ``all_side_effects=True`` 隐式 True 任何已登记 flag
- ``_should_publish_event`` 的便捷形式与 should_skip 语义一致
- ``KNOWN_SKIP_FLAGS`` frozenset 含预期枚举
"""
from __future__ import annotations

import logging
import os
from unittest.mock import patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

from uuid import uuid4  # noqa: E402

from apps.tabdata.domain.value_objects import RecordCommandContext  # noqa: E402
from apps.tabdata.handlers._base import (  # noqa: E402
    KNOWN_SKIP_FLAGS,
    SKIP_ALL_SIDE_EFFECTS,
    SKIP_UNDO_STACK,
    RecordHandlerBase,
)


def _ctx(skip_flags=None) -> RecordCommandContext:
    return RecordCommandContext(table_id=uuid4(), skip_flags=skip_flags)


class TestShouldSkipKnownFlags:
    def test_known_flag_true(self):
        ctx = _ctx({SKIP_UNDO_STACK: True})
        assert RecordHandlerBase.should_skip(ctx, SKIP_UNDO_STACK) is True

    def test_known_flag_false(self):
        ctx = _ctx({SKIP_UNDO_STACK: False})
        assert RecordHandlerBase.should_skip(ctx, SKIP_UNDO_STACK) is False

    def test_no_skip_flags_returns_false(self):
        ctx = _ctx(None)
        assert RecordHandlerBase.should_skip(ctx, SKIP_ALL_SIDE_EFFECTS) is False

    def test_all_side_effects_implies_undo_stack(self):
        """RecordCommandContext.should_skip 的语义：all_side_effects=True → 任何 flag 都 True。"""
        ctx = _ctx({SKIP_ALL_SIDE_EFFECTS: True})
        assert RecordHandlerBase.should_skip(ctx, SKIP_UNDO_STACK) is True


class TestShouldSkipUnknownFlag:
    def test_unknown_flag_returns_false_and_warns(self):
        ctx = _ctx({SKIP_UNDO_STACK: True})
        # 用 patch 直接断言 logger.warning 被调用，避免 caplog 与 Django LOGGING
        # 配置（propagate / filter）的潜在不兼容
        from apps.tabdata.handlers import _base as _base_mod
        with patch.object(_base_mod.logger, "warning") as mock_warn:
            result = _base_mod.RecordHandlerBase.should_skip(ctx, "magic_typo_flag")
        assert result is False
        assert mock_warn.called
        # 第一个位置参数包含 "unknown skip_type"
        args, _kwargs = mock_warn.call_args
        assert any("unknown skip_type" in str(a) for a in args), args

    def test_unknown_flag_does_not_raise(self):
        ctx = _ctx(None)
        # 不抛异常即可
        RecordHandlerBase.should_skip(ctx, "unknown_xxx")


class TestShouldPublishEvent:
    """便捷形式：取反 should_skip(SKIP_ALL_SIDE_EFFECTS)。"""

    def _instance(self) -> RecordHandlerBase:
        # 不需要构造完整 Port 依赖，直接用 __new__ 跳过 __init__
        return RecordHandlerBase.__new__(RecordHandlerBase)

    def test_publish_when_no_skip(self):
        ctx = _ctx(None)
        assert self._instance()._should_publish_event(ctx) is True

    def test_no_publish_when_all_side_effects(self):
        ctx = _ctx({SKIP_ALL_SIDE_EFFECTS: True})
        assert self._instance()._should_publish_event(ctx) is False

    def test_publish_when_only_undo_stack_skipped(self):
        """undo_stack 跳过不影响 publish（不同 flag 互不影响）。"""
        ctx = _ctx({SKIP_UNDO_STACK: True})
        assert self._instance()._should_publish_event(ctx) is True


class TestKnownSkipFlagsRegistry:
    def test_registry_contains_expected_keys(self):
        assert SKIP_ALL_SIDE_EFFECTS in KNOWN_SKIP_FLAGS
        assert SKIP_UNDO_STACK in KNOWN_SKIP_FLAGS

    def test_registry_is_frozenset_immutable(self):
        with __import__("pytest").raises(AttributeError):
            KNOWN_SKIP_FLAGS.add("new_flag")  # type: ignore[attr-defined]

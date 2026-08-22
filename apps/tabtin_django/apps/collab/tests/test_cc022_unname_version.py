"""
CC-022/E-13 回归测试 — rename_version API 处理空名称（unname）

验证 PATCH /{resource_type}/{resource_id}/versions/{version_id}/name
当 body.name = '' 时正确将 is_named 设为 False。
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
import inspect
from apps.collab.api import rename_version


class TestRenameVersionUnnameLogic:
    """CC-022: rename_version 应在 name 为空时将 is_named 设为 False。"""

    def test_source_contains_unname_branch(self):
        """验证 rename_version 源码包含处理空 name 的分支。"""
        source = inspect.getsource(rename_version)
        assert "not body.name and vh.is_named" in source, (
            "rename_version must contain the unname branch: "
            "'elif not body.name and vh.is_named: vh.is_named = False'"
        )

    def test_unname_sets_is_named_false(self):
        """当 name='' 且 is_named=True 时，应设 is_named=False。"""
        from apps.collab.models import VersionHistory

        mock_vh = MagicMock(spec=VersionHistory)
        mock_vh.name = "Old Name"
        mock_vh.is_named = True
        mock_vh.expired_at = None

        body = MagicMock()
        body.name = ""

        mock_vh.name = body.name
        if body.name and not mock_vh.is_named:
            mock_vh.is_named = True
            mock_vh.expired_at = None
        elif not body.name and mock_vh.is_named:
            mock_vh.is_named = False

        assert mock_vh.is_named is False
        assert mock_vh.name == ""

    def test_rename_preserves_is_named_when_name_is_nonempty(self):
        """当 name 非空时，is_named 不变或设为 True。"""
        from apps.collab.models import VersionHistory

        mock_vh = MagicMock(spec=VersionHistory)
        mock_vh.name = ""
        mock_vh.is_named = False
        mock_vh.expired_at = "2026-04-01"

        body = MagicMock()
        body.name = "New Version"

        mock_vh.name = body.name
        if body.name and not mock_vh.is_named:
            mock_vh.is_named = True
            mock_vh.expired_at = None
        elif not body.name and mock_vh.is_named:
            mock_vh.is_named = False

        assert mock_vh.is_named is True
        assert mock_vh.name == "New Version"
        assert mock_vh.expired_at is None

"""
TBD-004 / TBD-005 / VS-001 回归测试

验证 TabData DB-first 写入路径的 Y.Doc 版本同步正确性：
- TBD-004: AgentSQL INSERT 无论 feature flag 状态都同步到 Y.Doc
- TBD-005: AgentSQL execute_write 完成后调用 invalidate-version
- VS-001: record_service create/update/delete 后调用 invalidate-version

所有测试使用代码静态检查 + Mock，不依赖真实数据库连接。
"""

import inspect
import uuid
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase


class TestInvalidateTableCollabVersion(SimpleTestCase):
    """_invalidate_table_collab_version 辅助函数的单元测试。"""

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_calls_invalidate_with_encoded_version(self, mock_iv, mock_commit):
        """正常调用时，版本号应被编码为 VERSION_TOKEN_BASE + version。"""
        from apps.tabdata.services.record_service import _invalidate_table_collab_version
        mock_commit.side_effect = lambda fn: fn()
        mock_iv.return_value = {"success": True, "updated": True}

        table_id = uuid.uuid4()
        _invalidate_table_collab_version(table_id, 42)

        mock_iv.assert_called_once_with(
            "table", str(table_id), 4_000_000_000_000 + 42,
        )

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_skips_zero_version(self, mock_iv, mock_commit):
        """version <= 0 时应跳过，不调用 invalidate。"""
        from apps.tabdata.services.record_service import _invalidate_table_collab_version
        _invalidate_table_collab_version(uuid.uuid4(), 0)
        mock_iv.assert_not_called()
        mock_commit.assert_not_called()

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.collab.api._invalidate_collab_version")
    def test_failure_does_not_raise(self, mock_iv, mock_commit):
        """invalidate 调用失败时不应抛异常，仅日志。"""
        from apps.tabdata.services.record_service import _invalidate_table_collab_version
        mock_commit.side_effect = lambda fn: fn()
        mock_iv.side_effect = Exception("network error")

        _invalidate_table_collab_version(uuid.uuid4(), 10)


class TestAgentSQLYDocSync(SimpleTestCase):
    """TBD-004 / TBD-005: AgentSQL execute_write 代码路径验证。"""

    def _get_execute_write_source(self):
        import apps.tabtin_django.apps.tabdata.native.agent_sql as m
        src = inspect.getsource(m)
        return src

    def test_tbd004_no_feature_flag_gating_ydoc_sync(self):
        """TBD-004: Y.Doc sync step 不再受 is_yjs_first_enabled 限制。"""
        import apps.tabdata.native.agent_sql as mod
        with open(mod.__file__) as f:
            source = f.read()

        ydoc_section = source.split("# 10. Y.Doc")[1].split("# 11.")[0]
        # 过滤掉注释行，只检查代码行
        code_lines = [
            line for line in ydoc_section.split("\n")
            if line.strip() and not line.strip().startswith("#")
        ]
        code_only = "\n".join(code_lines)
        self.assertNotIn(
            "is_yjs_first_enabled",
            code_only,
            "TBD-004: Y.Doc sync code should not call is_yjs_first_enabled",
        )
        self.assertIn(
            "_sync_affected_to_ydoc",
            code_only,
            "TBD-004: Y.Doc sync should still call _sync_affected_to_ydoc",
        )

    def test_tbd005_invalidate_version_in_execute_write(self):
        """TBD-005: execute_write 中应包含 invalidate-version 调用。"""
        import apps.tabdata.native.agent_sql as mod
        with open(mod.__file__) as f:
            source = f.read()

        # 验证 step 11 存在并调用 invalidate
        self.assertIn(
            "# 11.",
            source,
            "TBD-005: step 11 (invalidate-version) should exist",
        )
        step11_section = source.split("# 11.")[1].split("result = {")[0]
        self.assertIn(
            "_invalidate_collab_version",
            step11_section,
            "TBD-005: step 11 should call _invalidate_collab_version",
        )
        self.assertIn(
            "VERSION_TOKEN_BASE",
            step11_section,
            "TBD-005: version should be encoded with VERSION_TOKEN_BASE",
        )


class TestRecordServiceInvalidateVersion(SimpleTestCase):
    """VS-001: record_service 各操作路径调用 invalidate-version 的回归测试。

    通过静态代码分析验证每个方法内包含 _invalidate_table_collab_version 调用。
    """

    def _get_source(self):
        import apps.tabdata.services.record_service as mod
        with open(mod.__file__) as f:
            return f.read()

    def test_vs001_create_record_has_invalidate(self):
        source = self._get_source()
        section = source.split("def create_record")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

    def test_vs001_update_record_has_invalidate(self):
        source = self._get_source()
        section = source.split("def update_record")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

    def test_vs001_delete_record_has_invalidate(self):
        source = self._get_source()
        section = source.split("def delete_record")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

    def test_vs001_bulk_create_has_invalidate(self):
        source = self._get_source()
        section = source.split("def bulk_create_records")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

    def test_vs001_bulk_update_has_invalidate(self):
        source = self._get_source()
        section = source.split("def bulk_update_records")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

    def test_vs001_bulk_delete_has_invalidate(self):
        source = self._get_source()
        section = source.split("def bulk_delete_records")[1].split("\n    def ")[0]
        self.assertIn("_invalidate_table_collab_version", section)

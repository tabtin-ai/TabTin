"""
回归测试：CC-011

CC-011: signals.py 中 Table/Record/Field 相关的 on_commit 调用
        不应携带 using='postgresql' 参数——tabdata 模型写入 MySQL（default），
        使用 using='postgresql' 会导致事务上下文不匹配（MySQL 事务已提交但
        PostgreSQL 事务尚未提交，或反之），信号回调过早或遗漏触发。

测试策略：
  1. 通过 AST/文本检查确认源代码中无遗留的 using='postgresql'（静态回归）
  2. 通过 mock 验证 on_commit 被以正确的方式（无 using 参数）调用（行为回归）
"""

import ast
import inspect
import textwrap
import unittest
from unittest.mock import MagicMock, call, patch


class CC011NoUsingPostgresqlInSignals(unittest.TestCase):
    """静态检查：signals.py 中不得出现 on_commit(..., using='postgresql')"""

    def _load_signals_source(self):
        import apps.rag.signals as signals_mod
        source_file = inspect.getfile(signals_mod)
        with open(source_file, encoding='utf-8') as f:
            return f.read()

    def test_no_on_commit_with_using_postgresql(self):
        """signals.py 中所有 on_commit 调用均不携带 using='postgresql'。"""
        source = self._load_signals_source()
        self.assertNotIn(
            "using='postgresql'",
            source,
            "signals.py 中仍有 on_commit(using='postgresql')，CC-011 修复不完整",
        )

    def test_on_commit_calls_use_default_connection(self):
        """
        通过 AST 解析确认 on_commit 调用均不传 using 关键字参数。
        """
        source = self._load_signals_source()
        tree = ast.parse(source)

        violations = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            # 匹配 transaction.on_commit(...) 或 on_commit(...)
            func = node.func
            is_on_commit = (
                (isinstance(func, ast.Attribute) and func.attr == 'on_commit') or
                (isinstance(func, ast.Name) and func.id == 'on_commit')
            )
            if not is_on_commit:
                continue
            for kw in node.keywords:
                if kw.arg == 'using':
                    violations.append(
                        f"第 {node.lineno} 行 on_commit 携带 using= 参数（值：{ast.unparse(kw.value)}）"
                    )

        self.assertEqual(
            violations, [],
            f"发现 on_commit 使用了 using= 参数（CC-011 回归）:\n" + "\n".join(violations),
        )


class CC011OnCommitCalledWithoutUsingForTableRecord(unittest.TestCase):
    """
    行为测试：auto_index_record 信号处理器调用 on_commit 时不传 using 参数。
    TableRecord 写入 MySQL（default），不应绑定 PostgreSQL 事务。
    """

    # NOTE: 原 ``test_auto_index_record_on_commit_no_using`` 已移除——record 自动索引
    # 的 ``auto_index_record`` post_save signal 已迁出 signals.py 到 DDD 订阅体系
    # （``rag/subscribers/rag_index.py`` 的 RAGIndexSubscriber + ``subscribers/_utils.py``
    # 的 ``notify_record_changed_for_rag``，见 signals.py 顶部注释）。CC-011 对
    # signals.py 的 ``using='postgresql'`` 约束由上面两个静态检查全量覆盖；record
    # 路径不再经由 signals.py，故此处不再单独行为测试。

    def test_auto_index_table_on_commit_no_using(self):
        """auto_index_table 中 transaction.on_commit 不传 using 参数。"""
        from apps.rag import signals

        captured_calls = []

        def mock_on_commit(func, using=None):
            captured_calls.append({'func': func, 'using': using})

        instance = MagicMock()
        instance.id = 'test-table-uuid'

        with patch('apps.rag.signals.transaction') as mock_tx, \
             patch('apps.rag.signals._is_rag_enabled', return_value=True), \
             patch('apps.rag.signals._should_index', return_value=True), \
             patch('apps.rag.signals.settings') as mock_settings:
            mock_settings.RAG_AUTO_EMBED_TABLES = True
            mock_tx.on_commit.side_effect = mock_on_commit

            signals.auto_index_table(
                sender=MagicMock(),
                instance=instance,
                created=True,
                update_fields=None,
            )

        self.assertEqual(len(captured_calls), 1, "应调用一次 on_commit")
        self.assertIsNone(
            captured_calls[0]['using'],
            f"on_commit 不应传 using 参数，实际值: {captured_calls[0]['using']}",
        )

    def test_auto_delete_table_index_on_commit_no_using(self):
        """auto_delete_table_index 中 transaction.on_commit 不传 using 参数。"""
        from apps.rag import signals

        captured_calls = []

        def mock_on_commit(func, using=None):
            captured_calls.append({'func': func, 'using': using})

        instance = MagicMock()
        instance.id = 'test-table-uuid'

        with patch('apps.rag.signals.transaction') as mock_tx, \
             patch('apps.rag.signals._is_rag_enabled', return_value=True):
            mock_tx.on_commit.side_effect = mock_on_commit

            signals.auto_delete_table_index(
                sender=MagicMock(),
                instance=instance,
            )

        self.assertEqual(len(captured_calls), 1, "应调用一次 on_commit")
        self.assertIsNone(
            captured_calls[0]['using'],
            f"on_commit 不应传 using 参数，实际值: {captured_calls[0]['using']}",
        )

    def test_auto_delete_record_index_on_commit_no_using(self):
        """auto_delete_record_index 中 transaction.on_commit 不传 using 参数。"""
        from apps.rag import signals

        captured_calls = []

        def mock_on_commit(func, using=None):
            captured_calls.append({'func': func, 'using': using})

        instance = MagicMock()
        instance.id = 'test-record-uuid'

        with patch('apps.rag.signals.transaction') as mock_tx, \
             patch('apps.rag.signals._is_rag_enabled', return_value=True):
            mock_tx.on_commit.side_effect = mock_on_commit

            signals.auto_delete_record_index(
                sender=MagicMock(),
                instance=instance,
            )

        self.assertEqual(len(captured_calls), 1, "应调用一次 on_commit")
        self.assertIsNone(
            captured_calls[0]['using'],
            f"on_commit 不应传 using 参数，实际值: {captured_calls[0]['using']}",
        )

    def test_auto_index_table_field_on_commit_no_using(self):
        """auto_index_table_field 中 transaction.on_commit 不传 using 参数。"""
        from apps.rag import signals

        captured_calls = []

        def mock_on_commit(func, using=None):
            captured_calls.append({'func': func, 'using': using})

        instance = MagicMock()
        instance.id = 'test-field-uuid'
        instance.table_id = 'test-table-uuid'

        with patch('apps.rag.signals.transaction') as mock_tx, \
             patch('apps.rag.signals._is_rag_enabled', return_value=True), \
             patch('apps.rag.signals._should_index', return_value=True), \
             patch('apps.rag.signals.settings') as mock_settings:
            mock_settings.RAG_AUTO_EMBED_TABLES = True
            mock_tx.on_commit.side_effect = mock_on_commit

            signals.auto_index_table_field(
                sender=MagicMock(),
                instance=instance,
                created=True,
                update_fields=None,
            )

        self.assertEqual(len(captured_calls), 1, "应调用一次 on_commit")
        self.assertIsNone(
            captured_calls[0]['using'],
            f"on_commit 不应传 using 参数，实际值: {captured_calls[0]['using']}",
        )

    def test_auto_delete_table_field_index_on_commit_no_using(self):
        """auto_delete_table_field_index 中 transaction.on_commit 不传 using 参数。"""
        from apps.rag import signals

        captured_calls = []

        def mock_on_commit(func, using=None):
            captured_calls.append({'func': func, 'using': using})

        instance = MagicMock()
        instance.id = 'test-field-uuid'
        instance.table_id = 'test-table-uuid'

        with patch('apps.rag.signals.transaction') as mock_tx, \
             patch('apps.rag.signals._is_rag_enabled', return_value=True), \
             patch('apps.rag.signals._should_index', return_value=True), \
             patch('apps.rag.signals.settings') as mock_settings:
            mock_settings.RAG_AUTO_EMBED_TABLES = True
            mock_tx.on_commit.side_effect = mock_on_commit

            signals.auto_delete_table_field_index(
                sender=MagicMock(),
                instance=instance,
            )

        self.assertEqual(len(captured_calls), 1, "应调用一次 on_commit")
        self.assertIsNone(
            captured_calls[0]['using'],
            f"on_commit 不应传 using 参数，实际值: {captured_calls[0]['using']}",
        )


if __name__ == '__main__':
    unittest.main()

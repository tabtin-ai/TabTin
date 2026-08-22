"""
DA-006 / DA-007 修复回归测试

DA-006: Redis Set TTL 过短（30s）导致 Celery 拥堵时 record_id 静默丢失
        修复：_RECORD_BATCH_SET_TTL 从 30s 延长为 300s

DA-007: auto_index_record 信号触发条件依赖已废弃的 `data` JSONField
        修复：改为系统字段排除策略（update_fields 完全由系统字段构成时才跳过）

纯单元测试（无 DB 依赖），通过 mock 验证修复逻辑。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/rag/tests/test_da006_da007_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
from unittest.mock import MagicMock, patch
import pytest


# ━━ DA-006: Redis Set TTL 回归 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDA006RecordBatchSetTTL:
    """DA-006: _RECORD_BATCH_SET_TTL 必须足够大，以覆盖 Celery 队列拥堵场景。"""

    def test_record_batch_set_ttl_is_at_least_300(self):
        """_RECORD_BATCH_SET_TTL 必须 >= 300s，防止 Celery 拥堵时数据丢失。"""
        from apps.rag import signals
        assert signals._RECORD_BATCH_SET_TTL >= 300, (
            "DA-006: _RECORD_BATCH_SET_TTL 过短（<300s），"
            "Celery 队列拥堵时 record_id 会静默丢失。"
        )

    def test_record_batch_set_ttl_much_larger_than_debounce(self):
        """TTL 必须远大于 _RECORD_DEBOUNCE_SECONDS，确保 flush 任务在过期前完成。"""
        from apps.rag import signals
        assert signals._RECORD_BATCH_SET_TTL > signals._RECORD_DEBOUNCE_SECONDS * 10, (
            "DA-006: TTL 应远大于防抖窗口，避免队列拥堵导致数据丢失。"
        )

    @patch("django_redis.get_redis_connection")
    def test_debounce_record_index_sets_correct_ttl(self, mock_get_redis):
        """_debounce_record_index 调用 redis.expire 时使用更新后的 TTL（>=300s）。"""
        from apps.rag.signals import _debounce_record_index, _RECORD_BATCH_SET_TTL

        mock_redis = MagicMock()
        mock_redis.set.return_value = True
        mock_get_redis.return_value = mock_redis

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        with patch("apps.rag.tasks._flush_record_batch"):
            _debounce_record_index(table_id, record_id)

        mock_redis.expire.assert_called_once_with(
            f"rag:record_batch:{table_id}", _RECORD_BATCH_SET_TTL
        )
        actual_ttl = mock_redis.expire.call_args[0][1]
        assert actual_ttl >= 300, "DA-006: expire 调用使用的 TTL 应 >= 300s"

    @patch("django_redis.get_redis_connection")
    def test_debounce_sadd_then_expire_order(self, mock_get_redis):
        """_debounce_record_index 必须在 sadd 之后立即调用 expire，保证 TTL 正确设置。"""
        from apps.rag.signals import _debounce_record_index

        call_order = []
        mock_redis = MagicMock()
        mock_redis.sadd.side_effect = lambda *a, **kw: call_order.append("sadd")
        mock_redis.expire.side_effect = lambda *a, **kw: call_order.append("expire")
        mock_redis.set.return_value = True
        mock_get_redis.return_value = mock_redis

        table_id = str(uuid.uuid4())
        record_id = str(uuid.uuid4())

        with patch("apps.rag.tasks._flush_record_batch"):
            _debounce_record_index(table_id, record_id)

        assert call_order[:2] == ["sadd", "expire"], (
            "DA-006: expire 必须在 sadd 之后立即调用以保证 TTL 设置"
        )


# ━━ DA-007: auto_index_record 信号触发条件回归 ━━━━━━━━━━━━━━━━━━━━━━━

class TestDA007RecordSignalTrigger:
    """DA-007: auto_index_record 不应依赖已废弃的 data JSONField 判断是否触发索引。"""

    def _make_instance(self):
        inst = MagicMock()
        inst.id = uuid.uuid4()
        inst.table_id = uuid.uuid4()
        return inst

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_update_fields_none_triggers_index(self, mock_settings, mock_txn, mock_debounce):
        """update_fields=None（save() 不带参数）时必须触发索引。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        auto_index_record(sender=None, instance=inst, created=False, update_fields=None)
        mock_debounce.assert_called_once()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_created_triggers_index(self, mock_settings, mock_txn, mock_debounce):
        """created=True（新建记录）时必须触发索引。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        auto_index_record(sender=None, instance=inst, created=True, update_fields=None)
        mock_debounce.assert_called_once()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_data_field_in_update_fields_still_triggers(self, mock_settings, mock_txn, mock_debounce):
        """update_fields 包含 'data'（旧双写路径）时仍应触发索引（向后兼容）。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        auto_index_record(
            sender=None, instance=inst, created=False,
            update_fields=['data', 'version', 'updated_at'],
        )
        mock_debounce.assert_called_once()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_system_only_fields_skips_index(self, mock_settings, mock_txn, mock_debounce):
        """update_fields 只含纯系统字段（is_deleted/version/updated_at）时跳过索引。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        auto_index_record(
            sender=None, instance=inst, created=False,
            update_fields=['is_deleted', 'version', 'updated_at'],
        )
        mock_debounce.assert_not_called()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_native_col_update_fields_triggers_index(self, mock_settings, mock_txn, mock_debounce):
        """DA-007 核心：update_fields 包含原生列（非系统字段）时必须触发索引。
        这是修复前的 bug 场景：新代码不传 'data'，旧条件永远为 False，索引静默跳过。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        native_col_hex = uuid.uuid4().hex
        auto_index_record(
            sender=None, instance=inst, created=False,
            update_fields=[native_col_hex, 'updated_at'],
        )
        mock_debounce.assert_called_once()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_order_only_update_skips_index(self, mock_settings, mock_txn, mock_debounce):
        """update_fields 只含 'order'（排序调整）时跳过索引——内容未变化。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        auto_index_record(
            sender=None, instance=inst, created=False,
            update_fields=['order', 'updated_at'],
        )
        mock_debounce.assert_not_called()

    @patch("apps.rag.signals._debounce_record_index")
    @patch("apps.rag.signals.transaction")
    @patch("apps.rag.signals.settings")
    def test_no_data_field_but_native_col_triggers_index(self, mock_settings, mock_txn, mock_debounce):
        """DA-007 回归保护：纯原生列更新（无 'data'）仍必须触发索引。
        修复前 bug 表现：该场景下 `'data' in update_fields` 为 False，索引被静默跳过。"""
        mock_settings.RAG_ENABLED = True
        mock_settings.RAG_AUTO_EMBED_RECORDS = True
        mock_txn.on_commit.side_effect = lambda fn, **kwargs: fn()

        from apps.rag.signals import auto_index_record
        inst = self._make_instance()
        native_col = uuid.uuid4().hex
        auto_index_record(
            sender=None, instance=inst, created=False,
            update_fields=[native_col],
        )
        assert mock_debounce.called, (
            "DA-007: 包含原生列的 update_fields 应触发索引，"
            "不应因缺少废弃 'data' 字段而静默跳过。"
        )

    def test_system_only_fields_constant_exists(self):
        """_RECORD_SYSTEM_ONLY_FIELDS 常量必须存在且包含核心系统字段。"""
        from apps.rag import signals
        assert hasattr(signals, '_RECORD_SYSTEM_ONLY_FIELDS'), (
            "DA-007: signals.py 应定义 _RECORD_SYSTEM_ONLY_FIELDS 常量"
        )
        required = {'is_deleted', 'version', 'updated_at', 'updated_by_id', 'order'}
        missing = required - signals._RECORD_SYSTEM_ONLY_FIELDS
        assert not missing, f"DA-007: _RECORD_SYSTEM_ONLY_FIELDS 缺少字段: {missing}"

    def test_deprecated_data_condition_removed(self):
        """确认信号处理函数源码中已移除旧 `'data' in update_fields` 条件。"""
        import inspect
        from apps.rag.signals import auto_index_record
        source = inspect.getsource(auto_index_record)
        assert "'data' in update_fields" not in source, (
            "DA-007: auto_index_record 不应再包含 `'data' in update_fields` 条件，"
            "该条件依赖已废弃的 JSONField。"
        )

"""
F16 P0 修复回归测试

覆盖：
- DATA-7:  连接器全量同步流式写入（不再 OOM）
- DATA-10: 连接器任务路由到 heavy 队列
- DATA-11: 历史降采样 N+1 → Window Function 优化
- DATA-13: Webhook 死信队列处理

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/tabdata/tests/test_f16_p0_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

from contextlib import contextmanager, nullcontext
from unittest.mock import Mock, MagicMock, patch, call
import pytest


# ━━ DATA-10: 连接器任务路由到 heavy 队列 ━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA10ConnectorRouting:
    """sync_connector_table 和 sync_all_mirror_tables 必须路由到 heavy 队列。"""

    def test_sync_connector_table_queue_is_heavy(self):
        from apps.tabdata.tasks.connector_tasks import sync_connector_table
        assert sync_connector_table.queue == 'heavy', \
            f"sync_connector_table 应路由到 heavy 队列，实际为 {sync_connector_table.queue!r}"

    def test_sync_all_mirror_tables_queue_is_heavy(self):
        from apps.tabdata.tasks.connector_tasks import sync_all_mirror_tables
        assert sync_all_mirror_tables.queue == 'heavy', \
            f"sync_all_mirror_tables 应路由到 heavy 队列，实际为 {sync_all_mirror_tables.queue!r}"


# ━━ DATA-7: 连接器全量同步流式写入 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA7StreamingFullSync:
    """_full_sync 不再将所有行累积到内存，改为每批拉取后立即写入。"""

    def test_full_sync_writes_in_batches(self):
        """全量同步应分批拉取并立即写入 DB。
        验证 connector.query 被多次调用（流式分批），且每批后立即 bulk_create。
        """
        from apps.tabdata.tasks.connector_tasks import _full_sync
        from apps.tabdata.constants import TABDATA_DB_ALIAS

        mock_table = Mock()
        mock_table.organization_id = None

        mapping = Mock()
        mapping.table_id = 'table-1'
        mapping.connector.created_by = Mock()
        mapping.last_sync_row_count = 0

        connector_instance = Mock()
        batch_1 = ([{'col_a': f'v{i}'} for i in range(500)], 600)
        batch_2 = ([{'col_a': f'v{i}'} for i in range(500, 600)], 600)
        batch_3 = ([], 600)
        connector_instance.query.side_effect = [
            ([], 600),   # 预检调用 (limit=1)
            batch_1,     # offset=0
            batch_2,     # offset=500
            batch_3,     # offset=1000, empty
        ]

        field_mapping = {'col_a': 'field-a'}
        operation_order = []
        versions = iter([101, 102])

        def allocate_version(_table_id):
            version = next(versions)
            operation_order.append(f'allocate:{version}')
            return version

        @contextmanager
        def atomic_context(**_kwargs):
            operation_order.append('atomic:enter')
            try:
                yield
            finally:
                operation_order.append('atomic:exit')

        with patch('apps.tabdata.models.Table.objects') as mock_table_mgr, \
             patch('apps.tabdata.models.TableField.objects') as mock_field_mgr, \
             patch('apps.tabdata.models.TableRecord') as mock_record_cls, \
             patch('apps.tabdata.services.record_service.RecordService') as mock_rs, \
             patch(
                 'apps.tabdata.services.record_service.next_record_version',
                 side_effect=allocate_version,
             ), \
             patch(
                 'apps.tabdata.services.view_version_sync.mark_table_record_delete_version',
                 side_effect=lambda **kwargs: operation_order.append(f'mark:{kwargs["version"]}'),
             ) as mark_delete_version, \
             patch(
                 'apps.tabdata.tasks.connector_tasks._delete_all_records_from_native',
                 side_effect=lambda *_args: operation_order.append('delete'),
             ) as delete_native, \
             patch(
                 'apps.tabdata.tasks.connector_tasks._write_created_records_to_native',
                 side_effect=lambda *_args: operation_order.append('write'),
             ) as write_native, \
             patch('django.db.transaction.atomic', side_effect=atomic_context), \
             patch('apps.tabdata.tasks.connector_tasks.QuotaService'):
            mock_table_mgr.using.return_value.get.return_value = mock_table
            mock_field_mgr.using.return_value.filter.return_value = []
            mock_record_cls.objects.using.return_value.filter.return_value.update = Mock(return_value=1)
            mock_record_cls.objects.using.return_value.bulk_create = Mock()

            _full_sync(connector_instance, mapping, 'public', 'ext_table', field_mapping)

            bulk_create_calls = mock_record_cls.objects.using.return_value.bulk_create.call_count
            assert bulk_create_calls >= 2, \
                f"应至少调用 2 次 bulk_create（分批写入），实际 {bulk_create_calls} 次"
            assert all(call.kwargs['version'] == 101 for call in mock_record_cls.call_args_list)
            assert mark_delete_version.call_args_list == [
                call(table_id='table-1', version=101, db_alias=TABDATA_DB_ALIAS),
                call(table_id='table-1', version=102, db_alias=TABDATA_DB_ALIAS),
            ]
            delete_native.assert_called_once_with(mock_table)
            assert write_native.call_count == 2
            assert operation_order == [
                'atomic:enter',
                'allocate:101',
                'delete',
                'mark:101',
                'atomic:exit',
                'write',
                'write',
                'atomic:enter',
                'allocate:102',
                'mark:102',
                'atomic:exit',
            ]

        assert mapping.last_sync_row_count == 600

    def test_full_sync_empty_table_failure_still_publishes_reload_watermark(self):
        """空表或重试场景也必须发布完成水位，避免同版本分页漏行。"""
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.tasks.connector_tasks import _full_sync

        mapping = Mock()
        mapping.table_id = 'table-1'
        mapping.connector.created_by = Mock()
        connector_instance = Mock()
        connector_instance.query.side_effect = [([], 0), RuntimeError('source failed')]

        with patch('apps.tabdata.models.Table.objects') as table_manager, \
             patch('apps.tabdata.models.TableField.objects') as field_manager, \
             patch('apps.tabdata.models.TableRecord') as record_model, \
             patch('apps.tabdata.tasks.connector_tasks.QuotaService'), \
             patch(
                 'apps.tabdata.services.record_service.next_record_version',
                 side_effect=[201, 202],
             ), \
             patch(
                 'apps.tabdata.services.view_version_sync.mark_table_record_delete_version',
             ) as mark_delete_version, \
             patch('django.db.transaction.atomic', side_effect=lambda **_kwargs: nullcontext()):
            table_manager.using.return_value.get.return_value = Mock(organization_id=None)
            field_manager.using.return_value.filter.return_value = []
            record_model.objects.using.return_value.filter.return_value.update.return_value = 0
            with patch(
                'apps.tabdata.tasks.connector_tasks._delete_all_records_from_native',
            ):
                with pytest.raises(RuntimeError, match='source failed'):
                    _full_sync(connector_instance, mapping, 'public', 'ext_table', {})

        assert mark_delete_version.call_args_list == [
            call(table_id='table-1', version=201, db_alias=TABDATA_DB_ALIAS),
            call(table_id='table-1', version=202, db_alias=TABDATA_DB_ALIAS),
        ]


# ━━ DATA-11: 历史降采样 Window Function 优化 ━━━━━━━━━━━━━━━━━━

class TestDATA11DownsampleOptimization:
    """_downsample_record_history 使用 raw SQL Window Function。"""

    def test_downsample_uses_raw_sql(self):
        """降采样应使用 raw SQL 而非 per-group Python 查询。"""
        from apps.tabdata.tasks.history_tasks import _downsample_record_history
        from datetime import timedelta
        from django.utils import timezone

        now = timezone.now()
        start = now - timedelta(days=7)
        end = now - timedelta(days=1)

        mock_cursor = MagicMock()
        mock_cursor.fetchall.return_value = []

        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = Mock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = Mock(return_value=False)

        mock_rh = MagicMock()
        mock_rh.objects.using.return_value.filter.return_value.exists.return_value = True
        mock_rh._meta.db_table = 'tabdata_recordhistory'

        mock_tnv = MagicMock()
        mock_tnv.objects.using.return_value.filter.return_value.values_list.return_value = []

        with patch('django.db.connections', {'postgresql': mock_conn}), \
             patch('apps.tabdata.models.RecordHistory', mock_rh), \
             patch('apps.tabdata.models.TableNamedVersion', mock_tnv):
            result = _downsample_record_history(start, end, 'hour')

        assert result == 0
        mock_cursor.execute.assert_called_once()
        sql = mock_cursor.execute.call_args[0][0]
        assert 'ROW_NUMBER' in sql, "SQL 应使用 ROW_NUMBER Window Function"
        assert "date_trunc('hour'" in sql, "hour 模式应使用 date_trunc('hour')"


# ━━ DATA-13: Webhook 死信队列 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA13WebhookDeadLetter:
    """deliver_single_webhook 最终失败时写入死信日志。"""

    def test_single_webhook_has_5_retries(self):
        """重试次数应为 5 次（原来为 1 次）。"""
        from apps.tabdata.tasks.webhook_tasks import deliver_single_webhook
        assert deliver_single_webhook.max_retries == 5, \
            f"deliver_single_webhook 应有 5 次重试，实际 {deliver_single_webhook.max_retries}"

    def test_single_webhook_routes_to_heavy(self):
        from apps.tabdata.tasks.webhook_tasks import deliver_single_webhook
        assert deliver_single_webhook.queue == 'heavy'

    def test_dead_letter_function_writes_to_db(self):
        """_record_dead_letter 应尝试写入 WebhookDeliveryFailure 表。"""
        from apps.tabdata.tasks.webhook_tasks import _record_dead_letter

        payload = {'event': 'record.created', 'space_id': 'sp-1'}

        with patch('apps.tabdata.models_webhook.WebhookDeliveryFailure') as mock_model:
            mock_model.objects.using.return_value.create = Mock()
            _record_dead_letter('wh-123', payload, 'Connection refused')
            mock_model.objects.using.return_value.create.assert_called_once()

    def test_webhook_delivery_failure_model_exists(self):
        """WebhookDeliveryFailure 模型应有必要字段。"""
        from apps.tabdata.models_webhook import WebhookDeliveryFailure

        field_names = [f.name for f in WebhookDeliveryFailure._meta.get_fields()]
        assert 'webhook_id' in field_names
        assert 'event_type' in field_names
        assert 'payload' in field_names
        assert 'error' in field_names
        assert 'created_at' in field_names

    def test_deliver_webhook_event_max_retries_is_zero_or_low(self):
        """deliver_webhook_event（分发任务）本身不需要大量重试。"""
        from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event
        assert deliver_webhook_event.max_retries <= 4


# ━━ DATA-1: 类型转换 max_retries=0 ━━━━━━━━━━━━━━━━━━━━━━━━━

class TestDATA1ConversionIdempotent:
    """convert_field_type_task 不应重试（非幂等操作）。"""

    def test_conversion_task_no_retry(self):
        from apps.tabdata.tasks.conversion_tasks import convert_field_type_task
        assert convert_field_type_task.max_retries == 0, \
            f"类型转换应 max_retries=0，实际 {convert_field_type_task.max_retries}"

"""
SR-014 回归测试：record_io DDL 竞争场景的 DatabaseError 友好日志

验证当 DDL 竞争导致列不存在时（drop_column 已执行但 field_map_hex 未刷新），
record_io 的 insert_record / update_record / bulk_insert / bulk_update 能够：
1. 识别 "column does not exist" 类型的 DatabaseError
2. 输出包含 DDL 竞争条件诊断信息的日志
3. 正确 re-raise 原始异常（不吞异常）
"""
from __future__ import annotations

import uuid
from unittest import TestCase
from unittest.mock import patch, MagicMock

from django.db import DatabaseError

from apps.tabdata.native.record_io import (
    NativeRecordIO,
    _handle_database_error,
    _RE_MISSING_COLUMN,
)


class TestMissingColumnRegex(TestCase):
    """_RE_MISSING_COLUMN 正则匹配覆盖"""

    def test_matches_standard_pg_error(self):
        msg = 'column "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" of relation "tbl_xxx" does not exist'
        m = _RE_MISSING_COLUMN.search(msg)
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')

    def test_matches_without_quotes(self):
        msg = 'column a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4 of relation tbl does not exist'
        m = _RE_MISSING_COLUMN.search(msg)
        self.assertIsNotNone(m)

    def test_no_match_for_non_hex_column(self):
        msg = 'column "name" does not exist'
        m = _RE_MISSING_COLUMN.search(msg)
        self.assertIsNone(m)

    def test_no_match_for_unrelated_error(self):
        msg = 'relation "schema"."table" does not exist'
        m = _RE_MISSING_COLUMN.search(msg)
        self.assertIsNone(m)


class TestHandleDatabaseError(TestCase):
    """_handle_database_error 辅助函数行为"""

    def test_reraises_on_missing_column(self):
        exc = DatabaseError(
            'column "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" of relation "tbl" does not exist'
        )
        with self.assertRaises(DatabaseError):
            _handle_database_error(exc, 'insert_record', '"schema"."table"')

    def test_logs_ddl_race_warning_on_missing_column(self):
        exc = DatabaseError(
            'column "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" of relation "tbl" does not exist'
        )
        with patch('apps.tabdata.native.record_io.logger') as mock_logger:
            with self.assertRaises(DatabaseError):
                _handle_database_error(exc, 'update_record', '"s"."t"')
            mock_logger.error.assert_called_once()
            log_msg = mock_logger.error.call_args[0][0]
            self.assertIn('DDL', log_msg)
            self.assertIn('drop_column', log_msg)

    def test_reraises_on_unrelated_error(self):
        exc = DatabaseError('connection refused')
        with self.assertRaises(DatabaseError):
            _handle_database_error(exc, 'insert_record', '"s"."t"')

    def test_no_friendly_log_on_unrelated_error(self):
        exc = DatabaseError('connection refused')
        with patch('apps.tabdata.native.record_io.logger') as mock_logger:
            with self.assertRaises(DatabaseError):
                _handle_database_error(exc, 'insert_record', '"s"."t"')
            mock_logger.error.assert_not_called()


def _make_io():
    """创建 mock NativeRecordIO 实例，不访问真实数据库。"""
    with patch.object(NativeRecordIO, '_qualified_name', return_value='"test_schema"."test_table"'):
        io = NativeRecordIO(
            space_id=uuid.uuid4(),
            table_id=uuid.uuid4(),
        )
    return io


class TestDeleteAllRecords(TestCase):
    @patch('apps.tabdata.native.record_io.connections')
    def test_delete_all_records_clears_native_table_and_invalidates_count(self, mock_conns):
        cursor = MagicMock()
        cursor.__enter__ = MagicMock(return_value=cursor)
        cursor.__exit__ = MagicMock(return_value=False)
        cursor.rowcount = 3
        mock_conns.__getitem__.return_value.cursor.return_value = cursor
        io = _make_io()

        with patch.object(io, 'invalidate_count_cache') as invalidate:
            self.assertEqual(io.delete_all_records(), 3)

        cursor.execute.assert_called_once_with('DELETE FROM "test_schema"."test_table"')
        invalidate.assert_called_once_with('"test_schema"."test_table"')


class TestInsertRecordDDLRace(TestCase):
    """insert_record 在列不存在时的行为"""

    @patch('apps.tabdata.native.record_io.connections')
    def test_insert_logs_and_reraises_on_missing_column(self, mock_conns):
        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.execute.side_effect = DatabaseError(
            'column "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" of relation "test_table" does not exist'
        )
        mock_conns.__getitem__.return_value.cursor.return_value = mock_cursor

        io = _make_io()
        field_hex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'

        with patch('apps.tabdata.native.record_io.logger') as mock_logger:
            with self.assertRaises(DatabaseError):
                io.insert_record(
                    record_id=uuid.uuid4(),
                    field_values={field_hex: 'test_value'},
                )
            mock_logger.error.assert_called_once()
            self.assertIn('DDL', mock_logger.error.call_args[0][0])


class TestUpdateRecordDDLRace(TestCase):
    """update_record 在列不存在时的行为"""

    @patch('apps.tabdata.native.record_io.connections')
    def test_update_logs_and_reraises_on_missing_column(self, mock_conns):
        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_cursor.execute.side_effect = DatabaseError(
            'column "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5" of relation "test_table" does not exist'
        )
        mock_conns.__getitem__.return_value.cursor.return_value = mock_cursor

        io = _make_io()
        field_hex = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5'

        with patch('apps.tabdata.native.record_io.logger') as mock_logger:
            with self.assertRaises(DatabaseError):
                io.update_record(
                    record_id=uuid.uuid4(),
                    field_values={field_hex: 'new_value'},
                )
            mock_logger.error.assert_called_once()
            self.assertIn('DDL', mock_logger.error.call_args[0][0])


class TestBulkInsertDDLRace(TestCase):
    """bulk_insert_records 在列不存在时的行为"""

    @patch('apps.tabdata.native.record_io.transaction')
    @patch('apps.tabdata.native.record_io.connections')
    def test_bulk_insert_logs_and_reraises_on_missing_column(self, mock_conns, mock_tx):
        mock_tx.atomic.return_value.__enter__ = MagicMock()
        mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_cursor

        db_err = DatabaseError(
            'column "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6" of relation "test_table" does not exist'
        )

        def mock_exec_batch(cursor, sql, rows, page_size=200):
            raise db_err

        io = _make_io()
        field_hex = 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6'
        records = [
            {'__id': uuid.uuid4(), field_hex: 'val1'},
            {'__id': uuid.uuid4(), field_hex: 'val2'},
        ]

        with patch('psycopg2.extras.execute_batch', mock_exec_batch):
            with patch('apps.tabdata.native.record_io.logger') as mock_logger:
                with self.assertRaises(DatabaseError):
                    io.bulk_insert_records(records)
                mock_logger.error.assert_called_once()
                self.assertIn('DDL', mock_logger.error.call_args[0][0])


class TestBulkUpdateDDLRace(TestCase):
    """bulk_update_records 在列不存在时的行为"""

    @patch('apps.tabdata.native.record_io.transaction')
    @patch('apps.tabdata.native.record_io.connections')
    def test_bulk_update_logs_and_reraises_on_missing_column(self, mock_conns, mock_tx):
        mock_tx.atomic.return_value.__enter__ = MagicMock()
        mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

        mock_cursor = MagicMock()
        mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
        mock_cursor.__exit__ = MagicMock(return_value=False)
        mock_conns.__getitem__.return_value.cursor.return_value = mock_cursor

        db_err = DatabaseError(
            'column "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1" of relation "test_table" does not exist'
        )

        def mock_exec_batch(cursor, sql, rows, page_size=200):
            raise db_err

        io = _make_io()
        field_hex = 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1'
        records = [
            {'__id': uuid.uuid4(), field_hex: 'val1'},
        ]

        with patch('psycopg2.extras.execute_batch', mock_exec_batch):
            with patch('apps.tabdata.native.record_io.logger') as mock_logger:
                with self.assertRaises(DatabaseError):
                    io.bulk_update_records(records)
                mock_logger.error.assert_called_once()
                self.assertIn('DDL', mock_logger.error.call_args[0][0])

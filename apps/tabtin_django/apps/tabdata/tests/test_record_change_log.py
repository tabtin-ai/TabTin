"""
回归测试: AP-001 / AP-002 / AP-009

AP-001: RecordService CRUD 操作写入 ChangeLog（携带 agent_run_id）
AP-002: AgentSQLExecutor.execute_write 写入 ChangeLog
AP-009: _trigger_field_version_history 写 ChangeLog 时传入 agent_run_id
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from unittest.mock import patch, MagicMock

from django.test import TestCase

from apps.tabdata.services.record_service import (
    RecordService,
    _CHANGE_TYPE_CREATE_RECORD,
    _CHANGE_TYPE_UPDATE_RECORD,
    _CHANGE_TYPE_DELETE_RECORD,
    _CHANGE_TYPE_BATCH_CREATE_RECORDS,
    _CHANGE_TYPE_BATCH_UPDATE_RECORDS,
)


@contextmanager
def _mock_collab_stack():
    """统一 mock collab adapter / VersionHistoryService / ChangeLog / transaction。"""
    with patch("apps.collab.registry.get_adapter") as m_adapter, \
         patch("apps.collab.service.VersionHistoryService") as m_vh_svc, \
         patch("apps.collab.models.ChangeLog") as m_cl, \
         patch("django.db.transaction.atomic", return_value=MagicMock(
             __enter__=MagicMock(return_value=None),
             __exit__=MagicMock(return_value=False),
         )):

        resource = MagicMock()
        resource.id = uuid.uuid4()
        resource.organization_id = uuid.uuid4()

        adapter = MagicMock()
        adapter.get_resource.return_value = resource
        adapter.get_version_data.return_value = b"snapshot"
        m_adapter.return_value = adapter

        vh_instance = MagicMock()
        vh_instance.create_history.return_value = MagicMock()
        m_vh_svc.return_value = vh_instance

        mock_manager = MagicMock()
        m_cl.objects.using.return_value = mock_manager

        yield {
            "adapter": adapter,
            "resource": resource,
            "vh_svc": vh_instance,
            "cl_manager": mock_manager,
        }


class TestRecordChangeLogAP001(TestCase):
    """AP-001: RecordService CRUD 调用 _trigger_record_change_log。"""

    def _make_service(self, user=None):
        svc = MagicMock(spec=RecordService)
        svc.user = user or MagicMock(id=uuid.uuid4())
        svc._trigger_record_change_log = RecordService._trigger_record_change_log.__get__(svc)
        return svc

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-abc-123")
    def test_trigger_record_change_log_captures_agent_run_id(self, mock_run_id, mock_commit):
        """ChangeLog 闭包中应当携带在调用时捕获的 agent_run_id。"""
        svc = self._make_service()
        table_id = uuid.uuid4()

        svc._trigger_record_change_log(
            table_id,
            "create_record",
            change_type=_CHANGE_TYPE_CREATE_RECORD,
            summary="test",
            record_ids=["r1"],
            record_count=1,
        )

        mock_commit.assert_called_once()
        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs is not None, "ChangeLog.objects.create was not called"
            assert create_kwargs[1]["agent_run_id"] == "run-abc-123"
            assert create_kwargs[1]["change_type"] == _CHANGE_TYPE_CREATE_RECORD

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value=None)
    def test_trigger_record_change_log_empty_run_id_when_no_agent(self, mock_run_id, mock_commit):
        """非 Agent 上下文时 agent_run_id 应为空字符串。"""
        svc = self._make_service()
        svc._trigger_record_change_log(
            uuid.uuid4(), "update_record",
            change_type=_CHANGE_TYPE_UPDATE_RECORD,
            summary="test",
        )

        mock_commit.assert_called_once()
        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["agent_run_id"] == ""

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-del-789")
    def test_trigger_record_change_log_delete_action(self, mock_run_id, mock_commit):
        """delete_record 的 ChangeLog 也应携带 agent_run_id。"""
        svc = self._make_service()
        record_id = str(uuid.uuid4())

        svc._trigger_record_change_log(
            uuid.uuid4(), "delete_record",
            change_type=_CHANGE_TYPE_DELETE_RECORD,
            summary=f"删除记录 {record_id}",
            record_ids=[record_id],
        )

        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["agent_run_id"] == "run-del-789"
            assert create_kwargs[1]["change_type"] == _CHANGE_TYPE_DELETE_RECORD

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-batch")
    def test_trigger_record_change_log_batch_with_record_ids(self, mock_run_id, mock_commit):
        """批量操作的 ChangeLog 应包含 record_ids（截断到 50）和 record_count。"""
        svc = self._make_service()
        rids = [str(uuid.uuid4()) for _ in range(60)]

        svc._trigger_record_change_log(
            uuid.uuid4(), "batch_create_records",
            change_type=_CHANGE_TYPE_BATCH_CREATE_RECORDS,
            summary="批量创建 60 条记录",
            record_ids=rids,
            record_count=60,
        )

        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            changes = create_kwargs[1]["changes"]
            assert len(changes["record_ids"]) == 50, "record_ids 应被截断到 50"
            assert changes["record_count"] == 60


class TestAgentSQLChangeLogAP002(TestCase):
    """AP-002: AgentSQLExecutor._write_change_log_for_write 写入 ChangeLog。"""

    def test_write_change_log_for_write_with_agent_run_id(self):
        """SQL 写操作后 ChangeLog 必须携带 agent_run_id。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor = MagicMock(spec=AgentSQLExecutor)
        executor.user = MagicMock(id=uuid.uuid4())
        executor._write_change_log_for_write = (
            AgentSQLExecutor._write_change_log_for_write.__get__(executor)
        )

        table_id = uuid.uuid4()

        with patch("apps.services.common.platform_context.get_current_run_id", return_value="run-sql-001"), \
             _mock_collab_stack() as ctx:

            executor._write_change_log_for_write(
                sql_type="UPDATE",
                affected_table_ids={table_id},
                affected_rows=5,
                inserted_ids=[],
            )

            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs is not None
            assert create_kwargs[1]["agent_run_id"] == "run-sql-001"
            assert create_kwargs[1]["change_type"] == "sql_update"
            assert create_kwargs[1]["editor_type"] == "agent"

    def test_write_change_log_insert_with_ids(self):
        """INSERT 操作的 ChangeLog 应包含 inserted_ids。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor = MagicMock(spec=AgentSQLExecutor)
        executor.user = MagicMock(id=uuid.uuid4())
        executor._write_change_log_for_write = (
            AgentSQLExecutor._write_change_log_for_write.__get__(executor)
        )

        table_id = uuid.uuid4()
        inserted = [str(uuid.uuid4()) for _ in range(3)]

        with patch("apps.services.common.platform_context.get_current_run_id", return_value="run-ins"), \
             _mock_collab_stack() as ctx:

            executor._write_change_log_for_write(
                sql_type="INSERT",
                affected_table_ids={table_id},
                affected_rows=3,
                inserted_ids=inserted,
            )

            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["change_type"] == "sql_insert"
            assert create_kwargs[1]["changes"]["inserted_ids"] == inserted

    def test_write_change_log_no_agent_context(self):
        """非 Agent 上下文时 agent_run_id 应为空字符串。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor = MagicMock(spec=AgentSQLExecutor)
        executor.user = MagicMock(id=uuid.uuid4())
        executor._write_change_log_for_write = (
            AgentSQLExecutor._write_change_log_for_write.__get__(executor)
        )

        with patch("apps.services.common.platform_context.get_current_run_id", return_value=None), \
             _mock_collab_stack() as ctx:

            executor._write_change_log_for_write(
                sql_type="DELETE",
                affected_table_ids={uuid.uuid4()},
                affected_rows=1,
                inserted_ids=[],
            )

            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["agent_run_id"] == ""


class TestFieldVersionHistoryAP009(TestCase):
    """AP-009: _trigger_field_version_history 传入 agent_run_id。"""

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-field-456")
    def test_field_version_history_passes_agent_run_id(self, mock_run_id, mock_commit):
        """字段 CRUD 的 ChangeLog 必须携带 agent_run_id。"""
        from apps.tabdata.services.table_service import TableService

        svc = MagicMock(spec=TableService)
        svc.user = MagicMock(id=uuid.uuid4())
        svc._trigger_field_version_history = (
            TableService._trigger_field_version_history.__get__(svc)
        )

        table_id = uuid.uuid4()
        svc._trigger_field_version_history(
            table_id,
            "create_field",
            change_type="create_field",
            summary="创建字段 '标题'",
            field_details=[{"id": str(uuid.uuid4()), "name": "标题", "field_type": "text"}],
        )

        mock_commit.assert_called_once()
        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs is not None, "ChangeLog.objects.create was not called"
            assert create_kwargs[1]["agent_run_id"] == "run-field-456", (
                f"expected 'run-field-456', got '{create_kwargs[1].get('agent_run_id')}'"
            )

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value=None)
    def test_field_version_history_empty_run_id_without_agent(self, mock_run_id, mock_commit):
        """非 Agent 上下文时 agent_run_id 仍应填入空字符串。"""
        from apps.tabdata.services.table_service import TableService

        svc = MagicMock(spec=TableService)
        svc.user = MagicMock(id=uuid.uuid4())
        svc._trigger_field_version_history = (
            TableService._trigger_field_version_history.__get__(svc)
        )

        svc._trigger_field_version_history(
            uuid.uuid4(), "delete_field",
            change_type="delete_field",
            summary="删除字段",
        )

        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["agent_run_id"] == ""


class TestAP001AdapterShortCircuit(TestCase):
    """AP-001 补充: adapter/resource 不存在时 ChangeLog 静默跳过。"""

    def _make_service(self, user=None):
        svc = MagicMock(spec=RecordService)
        svc.user = user or MagicMock(id=uuid.uuid4())
        svc._trigger_record_change_log = RecordService._trigger_record_change_log.__get__(svc)
        return svc

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-x")
    def test_no_adapter_does_not_raise(self, mock_run_id, mock_commit):
        """get_adapter 返回 None 时不应抛异常。"""
        svc = self._make_service()
        svc._trigger_record_change_log(
            uuid.uuid4(), "create_record",
            change_type=_CHANGE_TYPE_CREATE_RECORD,
            summary="test",
        )

        callback = mock_commit.call_args[0][0]

        with patch("apps.collab.registry.get_adapter", return_value=None), \
             patch("apps.collab.models.ChangeLog") as m_cl:
            callback()
            m_cl.objects.using.return_value.create.assert_not_called()

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-x")
    def test_resource_not_found_does_not_raise(self, mock_run_id, mock_commit):
        """adapter.get_resource 返回 None 时不应抛异常。"""
        svc = self._make_service()
        svc._trigger_record_change_log(
            uuid.uuid4(), "update_record",
            change_type=_CHANGE_TYPE_UPDATE_RECORD,
            summary="test",
        )

        callback = mock_commit.call_args[0][0]

        adapter = MagicMock()
        adapter.get_resource.return_value = None
        with patch("apps.collab.registry.get_adapter", return_value=adapter), \
             patch("apps.collab.service.VersionHistoryService"), \
             patch("apps.collab.models.ChangeLog") as m_cl:
            callback()
            m_cl.objects.using.return_value.create.assert_not_called()


class TestAP002ExplicitRunIdOverride(TestCase):
    """AP-002 补充: execute_write 显式传入 agent_run_id 时优先使用。"""

    def test_explicit_run_id_takes_precedence(self):
        """显式传入的 agent_run_id 应优先于 ContextVar。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor = MagicMock(spec=AgentSQLExecutor)
        executor.user = MagicMock(id=uuid.uuid4())
        executor._write_change_log_for_write = (
            AgentSQLExecutor._write_change_log_for_write.__get__(executor)
        )

        with patch("apps.services.common.platform_context.get_current_run_id", return_value="ctx-run"), \
             _mock_collab_stack() as ctx:

            executor._write_change_log_for_write(
                sql_type="UPDATE",
                affected_table_ids={uuid.uuid4()},
                affected_rows=1,
                inserted_ids=[],
                agent_run_id="explicit-run-123",
            )

            create_kwargs = ctx["cl_manager"].create.call_args
            assert create_kwargs[1]["agent_run_id"] == "explicit-run-123"

    def test_zero_affected_rows_skips_write(self):
        """affected_rows=0 时不应写入 ChangeLog。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor

        executor = MagicMock(spec=AgentSQLExecutor)
        executor.user = MagicMock(id=uuid.uuid4())
        executor._write_change_log_for_write = (
            AgentSQLExecutor._write_change_log_for_write.__get__(executor)
        )

        with patch("apps.services.common.platform_context.get_current_run_id", return_value="run"), \
             _mock_collab_stack() as ctx:

            executor._write_change_log_for_write(
                sql_type="DELETE",
                affected_table_ids={uuid.uuid4()},
                affected_rows=0,
                inserted_ids=[],
            )

            ctx["cl_manager"].create.assert_not_called()


class TestAP009FieldDetailsInChanges(TestCase):
    """AP-009 补充: ChangeLog.changes 中包含 field_details 信息。"""

    @patch("apps.tabdata.services.record_service._run_after_tabdata_commit")
    @patch("apps.services.common.platform_context.get_current_run_id", return_value="run-fd")
    def test_field_details_stored_in_changes(self, mock_run_id, mock_commit):
        """字段 CRUD 的 ChangeLog 应在 changes 中记录 field_details。"""
        from apps.tabdata.services.table_service import TableService

        svc = MagicMock(spec=TableService)
        svc.user = MagicMock(id=uuid.uuid4())
        svc._trigger_field_version_history = (
            TableService._trigger_field_version_history.__get__(svc)
        )

        field_id = str(uuid.uuid4())
        svc._trigger_field_version_history(
            uuid.uuid4(),
            "update_field",
            change_type="update_field",
            summary="修改字段类型",
            field_details=[{"id": field_id, "name": "状态", "field_type": "select"}],
        )

        callback = mock_commit.call_args[0][0]

        with _mock_collab_stack() as ctx:
            callback()
            create_kwargs = ctx["cl_manager"].create.call_args
            changes = create_kwargs[1]["changes"]
            assert "fields" in changes
            assert len(changes["fields"]) == 1
            assert changes["fields"][0]["id"] == field_id

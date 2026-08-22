"""
表格操作工具包

Wave 4a (2026-05-01) 清理：
  原 tabdata 域的 5 类 BaseTool 工具集已按 D4「全删 FC」拆除，Agent 操作多维
  表格统一走 `tabtin table *` CLI（execute_in_terminal 调用）：
    - field_tools (create/update/delete_field)
    - record_tools (create/update/delete_record + 6 件批量)
    - field_transform_tools (batch_transform_field)
    - auto_table_tools (auto_create_table / smart_append_table)
    - sql_tools (sql_catalog / sql_query / sql_execute) → CLI `tabtin table query/execute`
    - task_tracking_tools (create_task_table / create_view) → 对应 CLI 子命令

Wave 3 收敛 (2026-05-02)：
  原 ``goal_tools.py`` (CreateGoalTool / ListGoalsTool) 已删除，charter §6.2
  「创建路径必须只有一条」由 Tracker 模块独立承接。table 域不再注册任何工具——
  但保留空 provider 以满足 manifest ``runtimeBindings.toolProvider:
  django:toolhub.tabdata`` 期望。

Tracker 模块收敛波次 1 (2026-05-20，方案 B)：
  原 ``apps.services.tools.domains.tabtracker.tracker_tools`` 也已整体下线——
  Tracker 域的创建/触发/暂停/恢复能力全部走 CLI（``tabtin tracker *``），
  Agent 通过 ``run_terminal_command`` 调用。charter §3.1 「CLI-first，不是
  FC-first」决策的兑现。
"""


def get_all_table_operation_tools():
    """tabdata 域空 provider — Wave 3 后无任何 BaseTool 工具。

    保留函数符号以避免外部调用方 ImportError；如需为 tabdata 注册新工具，
    在此返回工具列表即可。
    """
    return []


__all__ = ['get_all_table_operation_tools']

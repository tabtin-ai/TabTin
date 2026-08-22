"""Tracker 删除语义。

单库治理后 ``TrackerRun.chat_session`` 已是物理 FK(on_delete=SET_NULL)——
ChatSession 删除时由 Django Collector（同库，正常工作）+ DB 约束把 chat_session_id 置空，
TrackerRun 运行历史（审计资产）不连带删。原跨库 install_softref_cascade(set_null) 信号
随之退役（双库时代因 tracker/conversation 异库、Collector 跨库反查失败才需要它）。
"""

from __future__ import annotations

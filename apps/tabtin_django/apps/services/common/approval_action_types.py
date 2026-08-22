"""
统一审批 · action_type SSoT（W1.2）

action_type 是统一审批服务（``ApprovalRulesService``）+ 用户记忆层
（``UserAgentApprovalMemo.action_type``）+ 跨端审批协议
（``agent.stream.approval_requested``）三处共用的"操作种类"标签。

如果 daemon / runtime / Django 任一端命名漂移（比如一边发
``shell_command``、另一边查 ``execute_in_terminal``），结果会是：
  - ``ApprovalMemoService.find_match`` 永远 miss
  - 用户点了"总是允许"也下次照样问
  - 静默失效，**没有任何报错**

所以本模块做两件事：
  1. 把所有合法 action_type 列在一处，作为唯一真相来源（SSoT）；
  2. 提供 ``ALL`` frozenset 让服务层入参做白名单校验，未知值
     ``raise ValueError``——fail loud 而不是 silent miss。

跨端对齐：本列表与 TypeScript ``packages/security-policy/src/types.ts``
的 ``ActionType`` 联合类型严格一致。**新增 / 删除值时必须两端同改**，
否则跨端会出现"一边能批准、另一边查不到"的 silent miss。

不在本白名单里的 action_type（W1.2 故意不收）：
  - W1.0 任务描述里的 ``network_fetch / device_control / tabdata_write
    / checkpoint_write / mcp_call`` ——TS 端 ``ActionType`` 没定义这些值，
    runtime 端不会用它们做权限决策；W1.2 SSoT 严格跟 TS 对齐，不在 Python
    侧凭空立"未来可能用"的标签。如果未来产品需要新增，先到
    ``packages/security-policy/src/types.ts`` 加联合值，再来同步本文件。
"""

from __future__ import annotations


class ApprovalActionType:
    """统一审批使用的 action_type 常量。

    与 TS ``ActionType`` 联合类型严格 1:1 对齐。
    """

    # 终端
    EXECUTE_IN_TERMINAL = 'execute_in_terminal'
    WRITE_TO_TERMINAL = 'write_to_terminal'

    # 文件
    FILE_READ = 'read_file'
    FILE_WRITE = 'write_file'
    FILE_EDIT = 'edit_file'
    FILE_DELETE = 'delete_file'

    # 代码搜索（无副作用，但读路径敏感所以仍走规则）
    CODE_GLOB = 'glob_search'
    CODE_GREP = 'grep_search'

    # SQL
    SQL_EXECUTE = 'sql_execute'

    # 设备控制（移动 / 桌面操控）
    DEVICE_ACTION = 'device_action'

    # 浏览器 eval（页面 JS 执行）
    EVAL = 'eval'

    ALL: frozenset = frozenset({
        EXECUTE_IN_TERMINAL,
        WRITE_TO_TERMINAL,
        FILE_READ,
        FILE_WRITE,
        FILE_EDIT,
        FILE_DELETE,
        CODE_GLOB,
        CODE_GREP,
        SQL_EXECUTE,
        DEVICE_ACTION,
        EVAL,
    })


# 终端类（命令需走 normalizeCommand）
TERMINAL_ACTION_TYPES: frozenset = frozenset({
    ApprovalActionType.EXECUTE_IN_TERMINAL,
    ApprovalActionType.WRITE_TO_TERMINAL,
})

# 文件类（pattern 是路径）
FILE_ACTION_TYPES: frozenset = frozenset({
    ApprovalActionType.FILE_READ,
    ApprovalActionType.FILE_WRITE,
    ApprovalActionType.FILE_EDIT,
    ApprovalActionType.FILE_DELETE,
})


def assert_known_action_type(action_type: str) -> None:
    """入参校验。未知值 fail loud。

    调用方应在 service / API 边界尽早调用，避免静默 miss。
    """
    if action_type not in ApprovalActionType.ALL:
        raise ValueError(
            f"Unknown action_type {action_type!r}. "
            f"Allowed values (SSoT): {sorted(ApprovalActionType.ALL)}. "
            f"If you need a new value, add it to BOTH "
            f"packages/security-policy/src/types.ts (TS) AND "
            f"apps/services/common/approval_action_types.py (Python) — "
            f"single-side change causes silent cross-end miss."
        )


__all__ = [
    'ApprovalActionType',
    'TERMINAL_ACTION_TYPES',
    'FILE_ACTION_TYPES',
    'assert_known_action_type',
]

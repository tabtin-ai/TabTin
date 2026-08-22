"""
Conversation API 包

将原 api.py（3000+ 行）按职责拆分为子模块：
- _common: 共享基础设施（router, 常量, 辅助函数）
- session: 会话 CRUD / 列表 / 模型切换
- message: 消息发送 / 查询
- fork: Fork 会话
- rollback: 回滚 / 检查点 / 资源恢复
- context: 上下文管理 / 外部 Agent 控制
"""

from ._common import router  # noqa: F401 — urls.py 导入

# 导入子模块以触发路由注册（@router.xxx 装饰器）
from . import session  # noqa: F401
from . import message  # noqa: F401
from . import fork  # noqa: F401
from . import rollback  # noqa: F401
from . import context  # noqa: F401
from . import locate_and_segment  # noqa: F401
from . import pending_interactions  # noqa: F401
from . import session_share  # noqa: F401
from . import session_continuation  # noqa: F401
from . import git  # noqa: F401

# ── 兼容性导出 ──
# 以下符号被外部模块直接 import，必须保留在包级命名空间中。
from ._common import (  # noqa: F401 — orchestration/api/chat_service.py / ws validators
    _get_session_with_shared_access,
    resolve_session_id_for_thread,
    user_can_access_session,
)
from .rollback import _trash_resource, rollback_resources  # noqa: F401 — collab/api.py, 测试文件
from .fork import (  # noqa: F401 — 测试文件
    _fork_copy_messages_sync,
    _fork_copy_context,
    _fork_state_json,
    _resolve_assistant_fork_point,
    _truncate_pg_messages_at_fork_point,
)

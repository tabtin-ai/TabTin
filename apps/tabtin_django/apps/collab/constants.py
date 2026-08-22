"""
Collab 统一常量

继承 version_history 的策略常量，并补充 collab 层特有常量。
"""

from apps.services.common.version_history.constants import (  # noqa: F401
    HISTORY_TTL_FREE,
    HISTORY_TTL_PRO,
    HISTORY_TTL_TEAM,
    TTL_TIERS,
    MEMBERSHIP_TIER_MAP,
    HISTORY_MIN_INTERVAL,
    HISTORY_SNAPSHOT_INTERVAL,
    HISTORY_SNAPSHOT_MAX_AGE,
)

RESOURCE_TYPES = ("docs", "table", "slide", "file")

# 虚拟资源类型：作为 ChangeLog / Checkpoint 的合法 resource_type，
# 但**不需要**注册独立 Collab Adapter（与启动期完整性检查解耦）。
#
# - "file": TabCode 代码文件的虚拟资源类型，resource_id = UUID5(path)
#   （见 collab/services/file_changelog.py 与 collab/api.py conversation-anchors）。
#   权限走 ChatSession 收敛，不通过 adapter.check_permission 校验。
VIRTUAL_RESOURCE_TYPES = ("file",)

# 必须注册 Collab Adapter 的资源类型（启动期 _check_adapter_completeness 校验用）。
# 等价于 RESOURCE_TYPES - VIRTUAL_RESOURCE_TYPES，保留 RESOURCE_TYPES 中的顺序。
ADAPTER_RESOURCE_TYPES = tuple(
    t for t in RESOURCE_TYPES if t not in VIRTUAL_RESOURCE_TYPES
)

EDITOR_TYPE_USER = "user"
EDITOR_TYPE_AGENT = "agent"
EDITOR_TYPE_SYSTEM = "system"
EDITOR_TYPE_SHARE = "share"

CHANGE_TYPE_CREATE = "create"
CHANGE_TYPE_UPDATE = "update"
CHANGE_TYPE_DELETE = "delete"
CHANGE_TYPE_RESTORE = "restore"

# 字段级变更类型（区分字段操作与记录操作，用于审计和回滚）
CHANGE_TYPE_CREATE_FIELD = "create_field"
CHANGE_TYPE_UPDATE_FIELD = "update_field"
CHANGE_TYPE_DELETE_FIELD = "delete_field"
CHANGE_TYPE_CONVERT_FIELD = "convert_field"
CHANGE_TYPE_REORDER_FIELDS = "reorder_fields"

COLLAB_PERSIST_IDEMPOTENCY_TTL = 300  # op_id 幂等去重缓存 5 分钟

"""
TabData 字段角色可见性

单一真源：
1. ``resolve_effective_table_role`` — 有效访问主体（owner/admin/editor/viewer）
2. ``get_visible_fields`` / ``get_visible_field_key_sets`` — 角色可见字段（含派生依赖闭包）
3. ``filter_record_data`` — 按可见 key 过滤记录 data

分享入口下，分享 permission 是字段角色上限，绝不以表格 owner 代读抬权。
本模块可被 REST / CLI / MCP 复用；不耦合 collab 协议层。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Mapping, Optional, Set, Union
from uuid import UUID

from apps.services.common.constants import ROLE_LEVELS
from apps.tabdata.constants import TABDATA_DB_ALIAS

logger = logging.getLogger(__name__)

TABLE_FIELD_ROLES = frozenset({"owner", "admin", "editor", "viewer"})

# TableShare.permission → 字段角色上限（能力封顶，不再抬高）
SHARE_PERMISSION_ROLE_CAP: Dict[str, str] = {
    "view": "viewer",
    "comment": "viewer",
    "edit": "editor",
    # 兼容历史别名（若链路误传角色名）
    "viewer": "viewer",
    "editor": "editor",
}

# 系统字段 / 元数据 filter key：不参与「隐藏字段侧信道」拦截
_PASSTHROUGH_FILTER_KEYS = frozenset(
    {"id", "row_id", "status", "order", "version", "conjunction", "filterSet"}
)

VisibleKeySets = Dict[str, Set[str]]


def _table_id_of(table) -> str:
    if table is None:
        raise ValueError("table is required")
    if hasattr(table, "id"):
        return str(table.id)
    return str(table)


def _normalize_role(role: Optional[str]) -> Optional[str]:
    if role is None:
        return None
    normalized = str(role).strip().lower()
    if normalized not in TABLE_FIELD_ROLES:
        return None
    return normalized


def _role_from_share_permission(permission: Optional[str]) -> Optional[str]:
    if not permission:
        return None
    return SHARE_PERMISSION_ROLE_CAP.get(str(permission).strip().lower())


def resolve_effective_table_role(user, table, *, share=None) -> Optional[str]:
    """解析用户对表格的有效字段角色。

    Args:
        user: 当前用户；公开匿名分享可为 None
        table: Table 实例或 table_id
        share: 可选 TableShare；显式传入时走分享上限语义。
            若未传，则尝试读取 request 上下文中的 table share grant
            （且必须命中同一 table）。

    Returns:
        ``owner|admin|editor|viewer``，无权时 ``None``。

    规则：
    - 正常入口：owner 或显式 TablePermission（复用 ``BaseService.get_table_role``）
    - 分享入口：``view/comment → viewer``；``edit`` 登录用户为 ``editor``，
      匿名读取按 ``viewer`` 投影
    - organization 分享：成员身份只作准入（由 ``verify_share_access`` 完成），
      不抬高字段角色；分享 permission 是上限
    - 通过分享入口访问时，绝不再用 owner 身份抬高字段角色
    """
    table_id = _table_id_of(table)

    effective_share = share
    if effective_share is None:
        try:
            from apps.tabdata.request_context import get_current_table_share_grant

            grant = get_current_table_share_grant()
        except Exception:
            grant = None
        if grant is not None and str(getattr(grant, "table_id", "")) == table_id:
            effective_share = grant

    if effective_share is not None:
        return _resolve_share_capped_role(user, effective_share)

    if not user or not getattr(user, "id", None):
        return None

    from apps.tabdata.services.base import BaseService

    return _normalize_role(BaseService(user=user).get_table_role(table_id))


def _resolve_share_capped_role(user, share) -> Optional[str]:
    """分享路径：permission 映射为字段角色上限，不查 owner/TablePermission。"""
    if not getattr(share, "is_active", True):
        return None
    if getattr(share, "share_type", None) == "form":
        # 表单分享走独立提交链路，不授予数据字段可见角色
        return None

    capped = _role_from_share_permission(getattr(share, "permission", None))
    if capped is None:
        logger.warning(
            "unknown share.permission for field role share_id=%s permission=%s",
            getattr(share, "share_id", None),
            getattr(share, "permission", None),
        )
        return None

    # edit 分享的写入能力由写接口单独要求登录；匿名读取仍按 viewer 投影。
    if capped == "editor" and not getattr(user, "id", None):
        return "viewer"

    return capped


def min_role(role_a: Optional[str], role_b: Optional[str]) -> Optional[str]:
    """取两个角色中较低者（用于能力封顶）。"""
    a = _normalize_role(role_a)
    b = _normalize_role(role_b)
    if a is None or b is None:
        return None
    if ROLE_LEVELS.get(a, 0) <= ROLE_LEVELS.get(b, 0):
        return a
    return b


def field_allows_role(field, role: Optional[str]) -> bool:
    """单字段 ``config.visibility_roles`` 判定；空/缺省 = 全角色可见。

    产品口径（与前端勾选一致）：UI 勾选「管理员」只写入 ``['admin']``，
    **不**自动补 owner。但资源所有者（role=owner）永远可见全部字段，
    避免 owner 因未勾选自己而丢掉协作 / 读权限。
    """
    normalized_role = _normalize_role(role)
    if normalized_role is None:
        return False
    if normalized_role == "owner":
        return True

    config = getattr(field, "config", None) or {}
    visibility_roles = config.get("visibility_roles")
    if not visibility_roles:
        return True

    allowed = {str(item).strip().lower() for item in visibility_roles if item is not None}
    if not allowed or "all" in allowed:
        return True
    return normalized_role in allowed


def _field_db_key(field) -> Optional[str]:
    config = getattr(field, "config", None) or {}
    raw = config.get("db_field_name")
    if raw in (None, ""):
        return None
    return str(raw)


def _load_table_fields(table_id: Union[str, UUID], fields: Optional[Iterable] = None) -> List:
    if fields is not None:
        return list(fields)

    from apps.tabdata.models import TableField

    return list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, is_deleted=False)
        .order_by("order")
    )


def _dependent_field_ids_in_table(
    table_id: Union[str, UUID],
    field_ids: Set[str],
) -> Dict[str, Set[str]]:
    """返回同表内「to_field 依赖哪些 from_field」映射。

    真源：``FieldReference``（from → to 表示 to 依赖 from）。
    不解析公式 AST，避免猜函数安全性。
    """
    if not field_ids:
        return {}

    from apps.tabdata.models import FieldReference

    rows = (
        FieldReference.objects.using(TABDATA_DB_ALIAS)
        .filter(
            to_field_id__in=field_ids,
            to_field__table_id=table_id,
            to_field__is_deleted=False,
            from_field__is_deleted=False,
        )
        .values_list("from_field_id", "to_field_id")
    )

    deps: Dict[str, Set[str]] = {fid: set() for fid in field_ids}
    for from_id, to_id in rows:
        deps.setdefault(str(to_id), set()).add(str(from_id))
    return deps


def apply_dependency_visibility_closure(
    table_id: Union[str, UUID],
    initially_visible_ids: Set[str],
    *,
    all_field_ids: Optional[Set[str]] = None,
) -> Set[str]:
    """派生依赖闭包：若依赖任一不可见字段，则该派生字段也不可见。

    基于 ``FieldReference`` 在同表内迭代收敛。
    """
    visible = set(initially_visible_ids)
    if all_field_ids is None:
        all_field_ids = set(visible)

    deps = _dependent_field_ids_in_table(table_id, set(all_field_ids))
    changed = True
    while changed:
        changed = False
        for field_id in list(visible):
            required = deps.get(field_id) or set()
            # 只关心同表依赖：跨表 from_field 不在 all_field_ids 内则忽略
            same_table_required = {fid for fid in required if fid in all_field_ids}
            if same_table_required and not same_table_required.issubset(visible):
                visible.discard(field_id)
                changed = True
    return visible


def get_visible_fields(
    table_id: Union[str, UUID],
    role: Optional[str],
    *,
    fields: Optional[Iterable] = None,
) -> List:
    """返回对 ``role`` 可见的字段对象列表（已含依赖闭包）。"""
    all_fields = _load_table_fields(table_id, fields)
    normalized_role = _normalize_role(role)
    if normalized_role is None:
        return []

    all_ids = {str(field.id) for field in all_fields}
    initially_visible = {
        str(field.id)
        for field in all_fields
        if field_allows_role(field, normalized_role)
    }
    visible_ids = apply_dependency_visibility_closure(
        table_id,
        initially_visible,
        all_field_ids=all_ids,
    )
    return [field for field in all_fields if str(field.id) in visible_ids]


def get_visible_field_key_sets(
    table_id: Union[str, UUID],
    role: Optional[str],
    *,
    fields: Optional[Iterable] = None,
) -> VisibleKeySets:
    """可见字段的 id / name / dbFieldName 集合。"""
    visible_fields = get_visible_fields(table_id, role, fields=fields)
    ids: Set[str] = set()
    names: Set[str] = set()
    db_names: Set[str] = set()
    for field in visible_fields:
        ids.add(str(field.id))
        if getattr(field, "name", None):
            names.add(field.name)
        db_key = _field_db_key(field)
        if db_key:
            db_names.add(db_key)
    return {"ids": ids, "names": names, "dbFieldNames": db_names}


def flatten_visible_keys(visible_keys: Optional[VisibleKeySets]) -> Set[str]:
    """合并三类 key，便于 ``data`` / filter 引用匹配。"""
    if not visible_keys:
        return set()
    return set(visible_keys.get("ids") or set()) | set(
        visible_keys.get("names") or set()
    ) | set(visible_keys.get("dbFieldNames") or set())


def filter_record_data(
    data: Optional[Mapping[str, Any]],
    visible_keys: Union[VisibleKeySets, Set[str], None],
) -> Dict[str, Any]:
    """按可见 key 过滤记录 data；``visible_keys`` 为空集合时返回空 dict。"""
    if not data:
        return {}
    if visible_keys is None:
        return dict(data)

    if isinstance(visible_keys, Mapping) and (
        "ids" in visible_keys or "names" in visible_keys or "dbFieldNames" in visible_keys
    ):
        allowed = flatten_visible_keys(visible_keys)  # type: ignore[arg-type]
    else:
        allowed = set(visible_keys or set())

    return {key: value for key, value in data.items() if str(key) in allowed}


def is_field_ref_visible(
    field_ref: Optional[str],
    visible_keys: Optional[VisibleKeySets],
) -> bool:
    """判断 filter/sort 引用的字段是否可见。"""
    if not field_ref:
        return False
    if visible_keys is None:
        return True
    key = str(field_ref)
    if key in _PASSTHROUGH_FILTER_KEYS:
        return True
    return key in flatten_visible_keys(visible_keys)


def sanitize_filters_for_visibility(
    filters: Optional[Dict[str, Any]],
    visible_keys: Optional[VisibleKeySets],
) -> Optional[Dict[str, Any]]:
    """剔除引用隐藏字段的 filter，杜绝排序/过滤侧信道。

    - 简单 ``{field: value}``：丢弃隐藏字段条件
    - 嵌套 FilterSet：递归剔除；若某组被掏空则视为 TRUE（不收紧结果）
    """
    if not filters:
        return filters
    if visible_keys is None:
        return filters

    if "filterSet" in filters or "conjunction" in filters:
        return _sanitize_filter_group(filters, visible_keys)

    cleaned: Dict[str, Any] = {}
    for raw_key, value in filters.items():
        key = str(raw_key)
        if key in _PASSTHROUGH_FILTER_KEYS:
            cleaned[key] = value
            continue
        if is_field_ref_visible(key, visible_keys):
            cleaned[key] = value
        else:
            logger.info(
                "strip hidden-field filter key=%s (field visibility)",
                key,
            )
    return cleaned


def _sanitize_filter_group(
    group: Dict[str, Any],
    visible_keys: VisibleKeySets,
) -> Dict[str, Any]:
    conjunction = group.get("conjunction", "and")
    items = group.get("filterSet") or []
    kept: List[Any] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if "filterSet" in item:
            nested = _sanitize_filter_group(item, visible_keys)
            if nested.get("filterSet"):
                kept.append(nested)
            continue
        field_ref = item.get("field_id") or item.get("field")
        if is_field_ref_visible(field_ref, visible_keys):
            kept.append(item)
        else:
            logger.info(
                "strip hidden-field filterSet rule field=%s",
                field_ref,
            )
    return {"conjunction": conjunction, "filterSet": kept}


def resolve_sort_by_for_visibility(
    sort_by: Optional[str],
    visible_keys: Optional[VisibleKeySets],
) -> Optional[str]:
    """隐藏字段不得参与 sort；不可见时回退默认排序（返回 None）。"""
    if not sort_by:
        return None
    if visible_keys is None:
        return sort_by
    if is_field_ref_visible(sort_by, visible_keys):
        return sort_by
    logger.info("ignore sort on hidden field sort_by=%s", sort_by)
    return None


def sanitize_filter_rules_for_visibility(
    filters: Optional[List[Any]],
    visible_keys: Optional[VisibleKeySets],
) -> Optional[List[Any]]:
    """ViewDataService 风格 ``List[rule|FilterSet]`` 的隐藏字段剔除。"""
    if not filters:
        return filters
    if visible_keys is None:
        return filters

    kept: List[Any] = []
    for item in filters:
        if not isinstance(item, dict):
            continue
        if "filterSet" in item:
            nested = _sanitize_filter_group(item, visible_keys)
            if nested.get("filterSet"):
                kept.append(nested)
            continue
        field_ref = item.get("field_id") or item.get("field")
        if is_field_ref_visible(field_ref, visible_keys):
            kept.append(item)
        else:
            logger.info(
                "strip hidden-field view filter rule field=%s",
                field_ref,
            )
    return kept


def sanitize_sorts_for_visibility(
    sorts: Optional[List[Dict[str, Any]]],
    visible_keys: Optional[VisibleKeySets],
) -> Optional[List[Dict[str, Any]]]:
    """剔除引用隐藏字段的 sort 规则。"""
    if not sorts:
        return sorts
    if visible_keys is None:
        return sorts

    kept: List[Dict[str, Any]] = []
    for rule in sorts:
        if not isinstance(rule, dict):
            continue
        field_ref = rule.get("field_id") or rule.get("field")
        if is_field_ref_visible(field_ref, visible_keys):
            kept.append(rule)
        else:
            logger.info(
                "strip hidden-field sort rule field=%s",
                field_ref,
            )
    return kept


def find_invisible_write_keys(
    data: Optional[Mapping[str, Any]],
    visible_keys: Optional[VisibleKeySets],
    fields: Iterable,
) -> List[str]:
    """找出写入 payload 中引用了不可见字段的 key（id/name/dbFieldName）。"""
    if not data:
        return []
    if visible_keys is None:
        return []

    visible_ids = set(visible_keys.get("ids") or set())
    name_map = {field.name: field for field in fields if getattr(field, "name", None)}
    id_map = {str(field.id): field for field in fields}
    db_map: Dict[str, Any] = {}
    for field in fields:
        db_key = _field_db_key(field)
        if db_key:
            db_map[db_key] = field

    blocked: List[str] = []
    for raw_key in data.keys():
        key = str(raw_key)
        if key in _PASSTHROUGH_FILTER_KEYS:
            continue
        field = name_map.get(key) or id_map.get(key) or db_map.get(key)
        if field is None:
            # 未知 key 交给既有校验；此处不抬成隐藏字段错误
            continue
        if str(field.id) not in visible_ids:
            blocked.append(key)
    return blocked


def reject_invisible_field_writes(
    data: Optional[Mapping[str, Any]],
    *,
    user,
    table,
    fields: Optional[Iterable] = None,
    share=None,
) -> Optional[str]:
    """若写入含当前角色不可见字段，返回可诊断错误文案；否则 None。"""
    if not data:
        return None
    role = resolve_effective_table_role(user, table, share=share)
    table_id = _table_id_of(table)
    loaded = _load_table_fields(table_id, fields)
    visible_keys = get_visible_field_key_sets(table_id, role, fields=loaded)
    blocked = find_invisible_write_keys(data, visible_keys, loaded)
    if not blocked:
        return None
    return (
        "无权写入对当前角色不可见的字段: "
        + ", ".join(blocked)
        + " (field_visibility_restricted)"
    )


# ── Collab Y.Doc 全量快照准入（ P0）────────────────────────────

COLLAB_MODE_FULL = "full"
COLLAB_MODE_REST_PROJECTION = "rest_projection"
COLLAB_DENY_REASON_FIELD_VISIBILITY = "field_visibility_restricted"
COLLAB_DENY_REASON_NO_ROLE = "no_table_role"


class FieldVisibilityCollabRestrictedError(PermissionError):
    """访问者不得接收含隐藏字段的全量 Y.Doc 快照。"""

    def __init__(self, decision: Dict[str, Any]):
        self.decision = decision
        super().__init__(
            decision.get("reason") or COLLAB_DENY_REASON_FIELD_VISIBILITY
        )


def evaluate_collab_access(user, table, *, share=None) -> Dict[str, Any]:
    """判定访问者是否可进入全量 Y.Doc 协作房间。

    P0 策略：仅当「可见字段集 == 完整活动字段集」时允许 ``collab_mode=full``；
    否则强制 ``rest_projection``，客户端应走角色过滤后的 REST 投影。

    Y.Doc 房间是共享状态，无法按角色裁剪字段；受限角色必须被挡在 auth/token
    门外，而不能只靠 snapshot 过滤。
    """
    from apps.tabdata.models import TableField

    table_id = _table_id_of(table)
    role = resolve_effective_table_role(user, table, share=share)

    active_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, is_deleted=False)
        .order_by("order")
    )
    total = len(active_fields)
    if role is None:
        return {
            "allowed": False,
            "collab_mode": COLLAB_MODE_REST_PROJECTION,
            "reason": COLLAB_DENY_REASON_NO_ROLE,
            "role": None,
            "visible_field_count": 0,
            "total_field_count": total,
            "hidden_field_count": total,
        }

    visible_fields = get_visible_fields(table_id, role, fields=active_fields)
    visible_count = len(visible_fields)
    hidden_count = max(0, total - visible_count)
    allowed = visible_count == total
    return {
        "allowed": allowed,
        "collab_mode": COLLAB_MODE_FULL if allowed else COLLAB_MODE_REST_PROJECTION,
        "reason": None if allowed else COLLAB_DENY_REASON_FIELD_VISIBILITY,
        "role": role,
        "visible_field_count": visible_count,
        "total_field_count": total,
        "hidden_field_count": hidden_count,
    }


def build_collab_degradation_payload(
    decision: Dict[str, Any],
    *,
    resource_type: str = "table",
    resource_id: Optional[str] = None,
    permission: Optional[str] = None,
) -> Dict[str, Any]:
    """构造前端可识别的 collab 降级契约。"""
    payload: Dict[str, Any] = {
        "authorized": False,
        "collab_mode": decision.get("collab_mode") or COLLAB_MODE_REST_PROJECTION,
        "reason": decision.get("reason") or COLLAB_DENY_REASON_FIELD_VISIBILITY,
        "role": decision.get("role"),
        "visible_field_count": int(decision.get("visible_field_count") or 0),
        "total_field_count": int(decision.get("total_field_count") or 0),
        "hidden_field_count": int(decision.get("hidden_field_count") or 0),
        "resource_type": resource_type,
    }
    if resource_id is not None:
        payload["resource_id"] = str(resource_id)
    if permission is not None:
        payload["permission"] = permission
    return payload

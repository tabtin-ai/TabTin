"""
FocusSnapshot normalizer
========================

统一把客户端 ``app_context``（camel / snake / flat ``current_*``）收敛成
Host 可消费的安全 FocusSnapshot，并给 Django ChatService 保留必要的 flat 字段。

背景（ P0 / P1）
---------------------
1. ``chat.send_message`` 旧白名单只留平铺 ``current_*``，Electron remote 的
   camelCase ``appType/appMeta/openTabs/spaceId`` 被丢光。
2. ``PromptForwardService._project_app_context_for_wire`` 只投影已有 Host
   四件套，**不会**把 ``current_*`` 组装成 ``appType/appMeta/openTabs``。
3. 结果：mobile flat 与 Electron remote camel 经 WS 后都到不了 Agent Host。

本模块是两条路径的唯一 normalizer：
- WS 入口（``chat_send_message``）：完整安全 dict（视觉 Focus camel + flat + 透传）
- PromptForward wire：只输出 Host Focus camelCase（``project_focus_for_wire``）

安全策略（fail-closed）
----------------------
- 危险顶层字段（``billing_precheck_source`` / ``runtime_mode`` 等）一律丢弃。
- **执行身份 / 锚点与视觉 Focus 拆开**：客户端不得提供
  ``collaborationSpaceId`` / ``executionSpaceId`` / ``initiatorUserId`` /
  ``executionOwnerUserId``，也不得在 ``project_task`` appMeta 里伪造
  ``project_id`` / ``task_id`` / ``task_run_id``。服务端权威值经
  ``_server_focus_authority`` 在 normalizer **之后**强制写入。
- ``appMeta`` **禁止**客户端原样上传：只允许当前 ``appType`` 的 manifest
  ``contextFields`` + 结构键（``idField`` / ``titleField``）。
- ``selected_text`` 若保留，只作顶层显式字段，绝不进 ``appMeta``。
- 自动 Focus 只含「在哪」（身份 / 标题 / 修订 hint），不含正文/选区。
- 大小上限：字符串截断、tabs 裁剪、嵌套对象拒绝进 ``appMeta``。
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Mapping, Optional, Set

# ── 限流上限（文档化策略：裁剪而非整包拒绝，避免误伤正常发送）──────────────
MAX_STRING_LEN = 512
MAX_URL_OR_PATH_LEN = 2048
MAX_OPEN_TABS = 20
MAX_APP_META_KEYS = 32
MAX_SELECTED_TEXT_LEN = 2000

# Host Focus 视觉字段（客户端可影响）
_FOCUS_VISUAL_WIRE_KEYS = (
    "appType",
    "appMeta",
    "openTabs",
    "spaceId",
    "userTimeZone",
    "workspaceMode",
)

# Host 用于恢复远程调用来源任务的兼容标记。
_FOCUS_INVOCATION_WIRE_KEYS = ("_invoked_from",)

# Host Focus 执行身份字段（仅服务端权威写入）
_FOCUS_IDENTITY_WIRE_KEYS = (
    "collaborationSpaceId",
    "executionSpaceId",
    "initiatorUserId",
    "executionOwnerUserId",
)

# project_task 锚点——客户端 appMeta 不得携带；服务端经 authority 注入
_PROJECT_TASK_ANCHOR_KEYS = frozenset({"project_id", "task_id", "task_run_id"})

# 服务端权威注入键（仅 Django 内部写入；客户端带入会被剥离）
SERVER_FOCUS_AUTHORITY_KEY = "_server_focus_authority"

# 对齐 @tabtin/contracts WorkspaceModeSchema
_WORKSPACE_MODES = frozenset({"conversation", "desktop", "non-space"})

# openTabs 允许的标量键（对齐 agent-host AppContextTab）
_OPEN_TAB_ALLOWED_KEYS = frozenset({
    "type",
    "id",
    "title",
    "active",
    "group_id",
    "app_key",
    "display_name",
    "is_home",
    "app_home",
    "path",
    "kind",
    "url",
    "session_id",
})

# 非 Focus、但 Django 流水线需要的安全透传键
_PASSTHROUGH_TOP_LEVEL = frozenset({
    "selected_text",
    "_invoked_from",
    "user_intent",
    "workspace_snapshot",
    "display_message",
    "reply_to_message_id",
    "reply_to_preview",
    "current_organization_id",
    "current_project_id",
    "current_record_id",
    "current_field_id",
    "current_url",
    "current_browser_tab_id",
})

# 结构键（Electron appMeta 约定）
_STRUCTURAL_APP_META_KEYS = frozenset({"idField", "titleField"})

# 偏长字段用更大截断（对齐 contracts MAX_URL_OR_PATH_LENGTH）
_LONG_STRING_KEYS = frozenset({
    "path",
    "url",
    "current_url",
    "current_browser_url",
    "current_code_project_path",
    "current_folder_path",
    "sandbox_path",
    "current_file_path",
    "current_code_file",
})


def normalize_focus_snapshot(
    raw: Optional[Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    """入口 / ChatService 用：产出安全视觉 Focus + flat + 透传字段。

    **不**包含执行身份 / project_task 锚点；那些只经
    ``project_focus_for_wire`` + ``_server_focus_authority`` 进入 wire。

    返回 ``None`` 表示无可保留内容。
    """
    if not isinstance(raw, dict) or not raw:
        return None

    app_type = _pick_app_type(raw)
    space_id = _pick_first_str(raw, ("spaceId", "space_id", "current_space_id"))
    user_tz = _pick_first_str(raw, ("userTimeZone", "user_time_zone"))
    workspace_mode = _pick_workspace_mode(raw)

    flat_fields = _collect_flat_context_fields(raw, app_type)
    app_meta = _build_safe_app_meta(raw, app_type, flat_fields)
    open_tabs = _build_safe_open_tabs(raw, app_type, app_meta, flat_fields)

    out: Dict[str, Any] = {}

    if app_type:
        out["appType"] = app_type
        out["current_app_type"] = app_type
    if space_id:
        out["spaceId"] = space_id
        out["current_space_id"] = space_id
    if user_tz:
        out["userTimeZone"] = user_tz
        out["user_time_zone"] = user_tz
    if workspace_mode:
        out["workspaceMode"] = workspace_mode
    if app_meta:
        out["appMeta"] = app_meta
    if open_tabs:
        out["openTabs"] = open_tabs

    # 执行身份字段：客户端提供一律丢弃（不写入 out）

    # flat current_*（供 context_assembler）；已由 Focus 覆盖的键上面写过
    for key, value in flat_fields.items():
        out.setdefault(key, value)

    # 显式透传（selected_text 等）
    for key in _PASSTHROUGH_TOP_LEVEL:
        if key not in raw:
            continue
        value = raw[key]
        if key == "selected_text":
            sanitized = _sanitize_scalar(value, max_len=MAX_SELECTED_TEXT_LEN)
            if sanitized is not None:
                out["selected_text"] = sanitized
            continue
        if key == "workspace_snapshot":
            if isinstance(value, dict) and value:
                out["workspace_snapshot"] = value
            continue
        if key == "reply_to_preview":
            if isinstance(value, dict):
                out["reply_to_preview"] = value
            continue
        sanitized = _sanitize_scalar(value)
        if sanitized is not None:
            out[key] = sanitized

    # 服务端合并的 client metadata（``_client_metadata_*``）原样保留
    for key, value in raw.items():
        if isinstance(key, str) and key.startswith("_client_metadata_"):
            out[key] = value

    return out if out else None


def apply_server_focus_authority(
    focus: Optional[Dict[str, Any]],
    authority: Optional[Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    """在 normalizer 之后强制写入服务端执行身份 / project_task 锚点。

    一律覆盖，不用 ``setdefault``——客户端残留值不得优先。
    """
    if not isinstance(authority, dict) or not authority:
        return focus

    out: Dict[str, Any] = dict(focus) if isinstance(focus, dict) else {}

    for key in _FOCUS_IDENTITY_WIRE_KEYS:
        value = _as_nonempty_str(authority.get(key))
        if value is not None:
            out[key] = value

    meta_extra = authority.get("appMeta")
    if isinstance(meta_extra, dict) and meta_extra:
        meta = dict(out.get("appMeta") or {})
        for key in _PROJECT_TASK_ANCHOR_KEYS:
            value = _sanitize_scalar(meta_extra.get(key))
            if value is not None:
                meta[key] = value
        if meta:
            out["appMeta"] = meta
        # R2-1：执行锚点进 appMeta，但不把视觉 Focus 改回 project_task。
        # 无视觉 appType 时保持空缺，由 Host 凭权威锚点 resolve。

    return out if out else None


def project_focus_for_wire(
    raw: Optional[Mapping[str, Any]],
) -> Optional[Dict[str, Any]]:
    """PromptForward wire 投影：视觉 Focus、调用来源与服务端权威身份。"""
    normalized = normalize_focus_snapshot(raw)
    projected: Dict[str, Any] = {}
    if normalized:
        projected = {
            key: normalized[key]
            for key in _FOCUS_VISUAL_WIRE_KEYS + _FOCUS_INVOCATION_WIRE_KEYS
            if key in normalized
        }

    authority = None
    if isinstance(raw, dict):
        authority = raw.get(SERVER_FOCUS_AUTHORITY_KEY)
    # 服务端权威在 normalizer 之后强制覆盖写入（不用 setdefault）
    return apply_server_focus_authority(projected or None, authority)


def build_server_focus_authority(
    *,
    collaboration_space_id: Optional[str] = None,
    execution_space_id: Optional[str] = None,
    initiator_user_id: Optional[str] = None,
    execution_owner_user_id: Optional[str] = None,
    project_id: Optional[str] = None,
    task_id: Optional[str] = None,
    task_run_id: Optional[str] = None,
) -> Dict[str, Any]:
    """构造 ``_server_focus_authority`` 载荷（Django 内部调用方使用）。"""
    authority: Dict[str, Any] = {}
    mapping = (
        ("collaborationSpaceId", collaboration_space_id),
        ("executionSpaceId", execution_space_id),
        ("initiatorUserId", initiator_user_id),
        ("executionOwnerUserId", execution_owner_user_id),
    )
    for key, value in mapping:
        text = _as_nonempty_str(value)
        if text is not None:
            authority[key] = text

    meta: Dict[str, Any] = {}
    for key, value in (
        ("project_id", project_id),
        ("task_id", task_id),
        ("task_run_id", task_run_id),
    ):
        text = _as_nonempty_str(value)
        if text is not None:
            meta[key] = text
    if meta:
        authority["appMeta"] = meta
    return authority


# ── internals ──────────────────────────────────────────────────────────


def _pick_app_type(raw: Mapping[str, Any]) -> Optional[str]:
    from apps.services.common.app_registry import get_app, normalize_type

    candidate = _pick_first_str(raw, ("appType", "app_type", "current_app_type"))
    if not candidate:
        # 从 openTabs active 推断
        tabs = raw.get("openTabs")
        if tabs is None:
            tabs = raw.get("open_tabs")
        if isinstance(tabs, list):
            for tab in tabs:
                if not isinstance(tab, dict) or not tab.get("active"):
                    continue
                for key in ("app_key", "app_home", "type"):
                    val = tab.get(key)
                    if isinstance(val, str) and val.strip():
                        candidate = val.strip()
                        break
                if candidate:
                    break
    if not candidate:
        return None
    normalized = normalize_type(candidate.strip())
    # chat / apphome 不是具体 App Focus；仍透传给 Host（context-hook 有专门分支）
    if normalized in {"chat", "apphome"}:
        return normalized
    if get_app(normalized) is not None or normalized == "project_task":
        return normalized
    # 未知类型：仍返回归一化字符串（Host 可降级），但不据此放宽 appMeta
    return normalized


def _collect_flat_context_fields(
    raw: Mapping[str, Any],
    app_type: Optional[str],
) -> Dict[str, Any]:
    from apps.services.common.app_registry import (
        get_all_context_field_names,
        get_app,
    )

    # 有明确 appType 时只收该 App 的 contextFields，避免跨 App 资源 id 错配
    if app_type and app_type not in {"chat", "apphome", "project_task"}:
        app = get_app(app_type)
        allowed: Set[str] = set(f.name for f in app.context_fields) if app else set()
    else:
        allowed = set(get_all_context_field_names())

    # 少数非 manifest、但历史白名单允许的通用 flat 键
    allowed.update({
        "current_record_id",
        "current_field_id",
        "current_url",
        "current_browser_tab_id",
        "sandbox_path",
        "current_folder_path",
    })

    out: Dict[str, Any] = {}
    for key in allowed:
        if key in raw:
            sanitized = _sanitize_scalar(
                raw[key],
                max_len=MAX_URL_OR_PATH_LEN if key in _LONG_STRING_KEYS else MAX_STRING_LEN,
            )
            if sanitized is not None:
                out[key] = sanitized

    # 从已有 camel appMeta 回填 flat（仅当前 App 安全键；剥离 project_task 锚点）
    raw_meta = raw.get("appMeta")
    if raw_meta is None:
        raw_meta = raw.get("app_meta")
    if isinstance(raw_meta, dict):
        safe_keys = _safe_app_meta_keys_for(app_type)
        for key, value in raw_meta.items():
            if key in _PROJECT_TASK_ANCHOR_KEYS:
                continue
            if key in safe_keys and key not in _STRUCTURAL_APP_META_KEYS and key not in out:
                sanitized = _sanitize_scalar(
                    value,
                    max_len=MAX_URL_OR_PATH_LEN if key in _LONG_STRING_KEYS else MAX_STRING_LEN,
                )
                if sanitized is not None:
                    out[key] = sanitized

    # 若有 app 定义但 flat 缺主资源，尝试从 **类型匹配** 的 openTabs active 补
    if app_type:
        app = get_app(app_type)
        if app is not None:
            id_field = next((f.name for f in app.context_fields if f.is_resource_id), None)
            if id_field and id_field not in out:
                tab_id = _active_tab_id_for_app(raw, app_type)
                if tab_id:
                    out[id_field] = tab_id

    return out


def _safe_app_meta_keys_for(app_type: Optional[str]) -> Set[str]:
    from apps.services.common.app_registry import get_app

    keys: Set[str] = set(_STRUCTURAL_APP_META_KEYS)
    if app_type:
        app = get_app(app_type)
        if app is not None:
            keys.update(f.name for f in app.context_fields)
    return keys


def _build_safe_app_meta(
    raw: Mapping[str, Any],
    app_type: Optional[str],
    flat_fields: Mapping[str, Any],
) -> Dict[str, Any]:
    from apps.services.common.app_registry import get_app

    safe_keys = _safe_app_meta_keys_for(app_type)
    meta: Dict[str, Any] = {}

    raw_meta = raw.get("appMeta")
    if raw_meta is None:
        raw_meta = raw.get("app_meta")
    if isinstance(raw_meta, dict):
        for key, value in raw_meta.items():
            if key in _PROJECT_TASK_ANCHOR_KEYS:
                continue
            if key not in safe_keys:
                continue
            if isinstance(value, (dict, list)):
                # 嵌套对象 fail-closed：不进自动 Focus appMeta
                continue
            sanitized = _sanitize_scalar(
                value,
                max_len=MAX_URL_OR_PATH_LEN if key in _LONG_STRING_KEYS else MAX_STRING_LEN,
            )
            if sanitized is not None:
                meta[key] = sanitized

    # 用 flat / 派生字段补全
    for key, value in flat_fields.items():
        if key in safe_keys and key not in meta:
            meta[key] = value

    # 结构键：优先客户端合法 idField/titleField，否则从 manifest 派生
    app = get_app(app_type) if app_type else None
    if app is not None:
        id_field = next((f.name for f in app.context_fields if f.is_resource_id), None)
        title_field = next(
            (
                f.name
                for f in app.context_fields
                if (not f.is_resource_id)
                and ("title" in f.name or f.label in {"title", "name"})
            ),
            None,
        )
        if id_field:
            meta.setdefault("idField", id_field)
        if title_field:
            meta.setdefault("titleField", title_field)

    # 限制 key 数量
    if len(meta) > MAX_APP_META_KEYS:
        # 优先保留结构键 + 资源 id / title
        preferred = []
        for key in ("idField", "titleField"):
            if key in meta:
                preferred.append(key)
        if app is not None:
            for f in app.context_fields:
                if f.name in meta and f.name not in preferred:
                    preferred.append(f.name)
        for key in meta:
            if key not in preferred:
                preferred.append(key)
        meta = {k: meta[k] for k in preferred[:MAX_APP_META_KEYS]}

    return meta


def _build_safe_open_tabs(
    raw: Mapping[str, Any],
    app_type: Optional[str],
    app_meta: Mapping[str, Any],
    flat_fields: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    raw_tabs = raw.get("openTabs")
    if raw_tabs is None:
        raw_tabs = raw.get("open_tabs")

    tabs: List[Dict[str, Any]] = []
    if isinstance(raw_tabs, list):
        for item in raw_tabs:
            cleaned = _sanitize_open_tab(item, default_type=app_type)
            if cleaned is not None:
                tabs.append(cleaned)
            if len(tabs) >= MAX_OPEN_TABS:
                break

    if tabs:
        if not any(t.get("active") for t in tabs):
            tabs[0]["active"] = True
        return tabs

    # 无 tabs：有资源时合成一个 active openTab
    resource_id = _resolve_resource_id(app_type, app_meta, flat_fields)
    if not app_type or not resource_id:
        return []

    title = None
    title_field = app_meta.get("titleField")
    if isinstance(title_field, str):
        candidate = app_meta.get(title_field) or flat_fields.get(title_field)
        if isinstance(candidate, str) and candidate.strip():
            title = candidate.strip()[:MAX_STRING_LEN]

    tab: Dict[str, Any] = {
        "type": app_type,
        "id": resource_id,
        "active": True,
        "app_key": app_type,
    }
    if title:
        tab["title"] = title
    return [tab]


def _resolve_resource_id(
    app_type: Optional[str],
    app_meta: Mapping[str, Any],
    flat_fields: Mapping[str, Any],
) -> Optional[str]:
    from apps.services.common.app_registry import get_app, get_resource_field_map

    if not app_type:
        return None
    # project_task 锚点不走客户端 appMeta；合成 openTab 时无资源则跳过
    if app_type == "project_task":
        return None

    field = get_resource_field_map().get(app_type)
    if field:
        value = app_meta.get(field) or flat_fields.get(field)
        as_str = _as_nonempty_str(value)
        if as_str:
            return as_str

    app = get_app(app_type)
    if app is not None:
        for f in app.context_fields:
            if f.is_resource_id:
                value = app_meta.get(f.name) or flat_fields.get(f.name)
                as_str = _as_nonempty_str(value)
                if as_str:
                    return as_str
    return None


def _sanitize_open_tab(
    item: Any,
    *,
    default_type: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    out: Dict[str, Any] = {}
    for key in _OPEN_TAB_ALLOWED_KEYS:
        if key not in item:
            continue
        value = item[key]
        if key == "active" or key == "is_home":
            if isinstance(value, bool):
                out[key] = value
            continue
        max_len = MAX_URL_OR_PATH_LEN if key in {"path", "url"} else MAX_STRING_LEN
        sanitized = _sanitize_scalar(value, max_len=max_len)
        if sanitized is not None:
            out[key] = sanitized

    # Host Zod 要求 type 必填：缺省时用 app_key / 外层 appType 补；仍无则丢弃
    if not out.get("type"):
        fallback = _as_nonempty_str(out.get("app_key")) or _as_nonempty_str(default_type)
        if fallback:
            out["type"] = fallback
        else:
            return None

    # 至少要有 type 或 id，否则丢弃空壳
    if not (out.get("type") or out.get("id")):
        return None
    return out


def _tab_type(tab: Mapping[str, Any]) -> Optional[str]:
    from apps.services.common.app_registry import normalize_type

    for key in ("type", "app_key", "app_home"):
        value = _as_nonempty_str(tab.get(key))
        if value is not None:
            return normalize_type(value)
    return None


def _active_tab_id_for_app(raw: Mapping[str, Any], app_type: str) -> Optional[str]:
    """仅当 active tab 的 type 与 appType 一致时，才用其 id 填资源字段。"""
    from apps.services.common.app_registry import normalize_type

    expected = normalize_type(app_type)
    tabs = raw.get("openTabs")
    if tabs is None:
        tabs = raw.get("open_tabs")
    if not isinstance(tabs, list):
        return None

    active_match = None
    first_match = None
    for tab in tabs:
        if not isinstance(tab, dict):
            continue
        if _tab_type(tab) != expected:
            continue
        tab_id = _as_nonempty_str(tab.get("id"))
        if not tab_id:
            continue
        if first_match is None:
            first_match = tab_id
        if tab.get("active"):
            active_match = tab_id
            break
    return active_match or first_match


def _pick_first_str(raw: Mapping[str, Any], keys: Iterable[str]) -> Optional[str]:
    for key in keys:
        if key in raw:
            value = _as_nonempty_str(raw[key])
            if value is not None:
                return value
    return None


def _pick_workspace_mode(raw: Mapping[str, Any]) -> Optional[str]:
    candidate = _pick_first_str(raw, ("workspaceMode", "workspace_mode"))
    if candidate is None:
        return None
    normalized = candidate.strip().lower()
    if normalized in _WORKSPACE_MODES:
        return normalized
    return None


def _as_nonempty_str(value: Any) -> Optional[str]:
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        text = str(value)
        return text if text else None
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def _sanitize_scalar(value: Any, *, max_len: int = MAX_STRING_LEN) -> Any:
    if value is None or isinstance(value, (dict, list)):
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if len(text) > max_len:
            return text[:max_len]
        return text
    return None


__all__ = [
    "normalize_focus_snapshot",
    "project_focus_for_wire",
    "apply_server_focus_authority",
    "build_server_focus_authority",
    "SERVER_FOCUS_AUTHORITY_KEY",
    "MAX_STRING_LEN",
    "MAX_URL_OR_PATH_LEN",
    "MAX_OPEN_TABS",
    "MAX_APP_META_KEYS",
]

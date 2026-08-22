"""C1 字段 undo（删除可追悔）核心实现。

业务背景
--------

PRD §C1：用户误删字段按 Ctrl+Z 后，需要完整恢复字段结构、native 列、
依赖图、计算值。

本模块支持普通字段与关联字段的恢复。

设计要点
--------

1. **白名单驱动**：仅当前产品仍支持的字段类型可撤销。
2. **简单类型原子 restore 流程**：
   ① ORM ``is_deleted=False``
   ② ``_native_add_column`` 重建 PG 物理列
   ③ ``_increment_schema_version`` + ``_refresh_field_count``
   ④ ``_restore_field_to_views_at_order`` 按删除前位置插入
   ⑤ 写 ``ChangeLog`` 落入 C5 链路
   ⑥ ``_publish_field_event`` 通知前端
3. **关联字段**在简单流程基础上恢复对称字段并重注册依赖。
4. **预检不可跳过**：即使 force=True，缺失依赖也必须返回 409 + 具体缺失信息。
5. **fail-safe 边界**：caller 已做权限校验 + table 存在性校验。
   restore_field 内部捕获非数据库异常按"原子失败 → 字段保持已删除"返回 False；
   数据库异常向上传播触发外层事务回滚。
"""
from __future__ import annotations

import copy
import logging
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from django.db import transaction

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.exceptions import FieldRestoreNotSupportedError

logger = logging.getLogger(__name__)


# ── 简单可恢复类型 ──
SIMPLE_RESTORABLE_FIELD_TYPES: frozenset[str] = frozenset({
    "text",
    "long_text",
    "number",
    "percent",
    "currency",
    "select",
    "multi_select",
    "date",
    "checkbox",
    "rating",
    "url",
    "email",
    "phone",
    "attachment",
})


# ── 关联字段恢复 ───────────────────────────────────────────────────
COMPLEX_RESTORABLE_FIELD_TYPES: frozenset[str] = frozenset({
    "link",
})

# 保留向后兼容别名（W1.3 测试中引用了此名称）
COMPLEX_RESTORE_DEFERRED_FIELD_TYPES = COMPLEX_RESTORABLE_FIELD_TYPES

ALL_RESTORABLE_FIELD_TYPES: frozenset[str] = (
    SIMPLE_RESTORABLE_FIELD_TYPES | COMPLEX_RESTORABLE_FIELD_TYPES
)


# ── 仍不支持 Ctrl+Z 的类型（系统字段 / 跨库引用 / 序列语义不明） ──
#
# 这类字段的 delete 路径走"系统资源回收 + 跨表关联清理"，与简单类型的
# "纯 schema 列 + cell 数据" 模型不同，统一回 409 引导版本时间线 / 回收站。
_OTHER_NON_RESTORABLE_FIELD_TYPES: frozenset[str] = frozenset({
    "created_time",     # 系统字段，删除即丢失
    "last_modified_time",
    "user",             # 跨库引用 User 表
    "created_by",
    "last_modified_by",
})


def _disabled_complex_restore_types() -> frozenset[str]:
    """W3.0c / G4:从 settings 读"按字段类型禁用 restore"清单。

    Settings ``TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES`` 是逗号分隔
    字符串(如 ``'link,attachment'``);空字符串 → 空集合,不禁用任何类型。
    名称含 ``complex`` 是历史命名,实际可禁用 ``ALL_RESTORABLE_FIELD_TYPES``
    中的任一字段类型(单元测试覆盖了 ``attachment`` 等简单类型)。

    每次调用都重新读取 ``django.conf.settings`` 上的属性 —
    ``override_settings`` 在单测中即时生效。但**生产环境仅 export env
    并不会刷新 settings 模块的初值**(``settings.py`` 在进程启动时通过
    ``os.getenv`` 一次性求值),需 ``bash scripts/backend/restart.sh`` 让
    uwsgi/gunicorn worker 全部 fork 新 env 后才能生效(对齐
    ``wave3-rollback-rehearsal.md`` §3.1.5 + §5.2 G7 的 RTO 评估)。

    读取失败(无 Django settings)时返回空集合,保持原有行为(不阻塞
    测试或非 Django 上下文)。
    """
    try:
        from django.conf import settings as _dj_settings
        raw = getattr(_dj_settings, 'TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES', '')
    except Exception:
        return frozenset()
    if not raw:
        return frozenset()
    return frozenset(t.strip() for t in str(raw).split(',') if t.strip())


def can_restore_field_type(field_type: str) -> bool:
    """删除前对话框 / explain 端点 / undo 路径共用的判定。

    W3.0c / G4:被 ``TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES`` 列出的
    字段类型即使在白名单内也返回 False,前端会调 ``explain_field_restore_capability``
    拿到 ``reason_code='temporarily_disabled'`` 引导用户走「版本时间线」。

    :returns: True 表示可走 ``restore_field`` 原子撤销。
    """
    field_type_norm = str(field_type or "").strip()
    if field_type_norm in _disabled_complex_restore_types():
        return False
    return field_type_norm in ALL_RESTORABLE_FIELD_TYPES


def explain_field_restore_capability(field_type: str) -> Dict[str, Any]:
    """对外暴露的"删除前 / undo 前"能力解释。

    输出统一对齐 W0-7 c5 命名规范：
    - ``can_undo``：是否可撤销
    - ``reason_code``：机器可读理由
    - ``reason``：用户可见短句
    - ``deferred_to``：不可撤销时的引导
    """
    field_type_norm = str(field_type or "").strip()

    # W3.0c / G4:运维侧临时禁用某种字段类型 restore(优先级最高,在白名单
    # 检查之前)。前端可识别 ``temporarily_disabled`` reason_code 引导用户
    # 走「版本时间线」面板。
    if field_type_norm in _disabled_complex_restore_types():
        return {
            "can_undo": False,
            "reason_code": "temporarily_disabled",
            "reason": (
                f"「{field_type_norm}」字段的撤销已被运维临时关闭。"
                f"请在「版本时间线」中还原到删除前的版本。"
            ),
            "deferred_to": "version_history",
        }

    if field_type_norm in SIMPLE_RESTORABLE_FIELD_TYPES:
        return {
            "can_undo": True,
            "reason_code": "simple_supported",
            "reason": "支持撤销，可直接 Ctrl+Z 恢复字段及其原生列结构。",
            "deferred_to": None,
        }

    if field_type_norm in COMPLEX_RESTORABLE_FIELD_TYPES:
        return {
            "can_undo": True,
            "reason_code": "complex_supported",
            "reason": (
                "支持撤销。该字段涉及依赖图重建，恢复可能需要几秒；"
                "若依赖的字段已被删除，将提示具体缺失信息。"
            ),
            "deferred_to": None,
        }

    if field_type_norm in _OTHER_NON_RESTORABLE_FIELD_TYPES:
        return {
            "can_undo": False,
            "reason_code": "not_in_wave1",
            "reason": (
                "该字段类型本期暂不在撤销白名单,"
                "请在「版本时间线」中还原到删除前的版本,"
                "或联系组织管理员从备份恢复。"
            ),
            "deferred_to": "version_history",
        }

    return {
        "can_undo": False,
        "reason_code": "unknown_type",
        "reason": "未知字段类型，请联系组织管理员。",
        "deferred_to": "version_history",
    }


def _to_uuid(value: Any) -> Optional[UUID]:
    """字符串 → UUID 安全转换。失败返回 None（与 UndoRedoOperationService 对齐）。"""
    try:
        return UUID(str(value))
    except Exception:
        return None


def restore_field(
    payload: Dict[str, Any],
    *,
    user=None,
    write_changelog: bool = True,
) -> Tuple[bool, Optional[str]]:
    """对单个字段 payload 走原子 restore（C1 字段 undo 入口）。

    :param payload: 由 :class:`UndoRedoOperationService.serialize_field` 序列化的
        字段快照（含 id / table_id / name / field_type / config / order / ...）
    :param user: 操作用户（写 ChangeLog 的 editor_id）
    :param write_changelog: 是否写 ``collab.ChangeLog``（C5 链路）。单元测试可关闭。
    :returns: (success, error_message)。不可恢复字段抛
        :class:`FieldRestoreNotSupportedError`。
    """
    from apps.tabdata.models import TableField

    field_id = _to_uuid(payload.get("id"))
    table_id = _to_uuid(payload.get("table_id"))
    if not field_id or not table_id:
        return False, "字段 ID 或表 ID 无效"

    field_type = str(payload.get("field_type") or "text").strip()
    field_name = str(payload.get("name") or "")

    # ── 预检 1:字段类型白名单 + W3.0c / G4 运维侧禁用 ────────────
    # 同时覆盖两种"不可恢复":
    #   a) field_type 不在 ALL_RESTORABLE_FIELD_TYPES(永久不支持)
    #   b) field_type 被 TABDATA_C1_COMPLEX_RESTORE_DISABLED_TYPES 临时禁用
    # 都走同一个 FieldRestoreNotSupportedError 通道,reason_code 区分,
    # 前端可读 reason_code 给出不同引导(临时禁用 → 走版本时间线)。
    if not can_restore_field_type(field_type):
        explanation = explain_field_restore_capability(field_type)
        raise FieldRestoreNotSupportedError(
            explanation["reason"],
            field_id=str(field_id),
            field_name=field_name,
            field_type=field_type,
            reason_code=explanation["reason_code"],
        )

    # ── 预检 2：字段名重复检测（避免软删期间另建了同名字段） ─────
    duplicate_qs = (
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, name=field_name, is_deleted=False)
        .exclude(id=field_id)
    )
    if duplicate_qs.exists():
        return (
            False,
            (
                f"无法撤销删除「{field_name}」：当前表已存在同名字段。"
                f"请先重命名或删除冲突字段。"
            ),
        )

    # ── 预检 3：字段必须存在且确处于已删除状态 ────────────────────
    field_row = (
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(id=field_id)
        .first()
    )
    if field_row is None:
        return False, "字段不存在或已被永久删除"

    if not field_row.is_deleted:
        logger.info(
            "[FieldRestore] 字段未处于已删除状态，跳过 restore: field=%s",
            field_id,
        )
        return True, None

    # ── 预检 4（复杂类型专属）：依赖字段存在性 ────────────────────
    if field_type in COMPLEX_RESTORABLE_FIELD_TYPES:
        preflight_error = _preflight_complex_field(
            field_type, payload, table_id, field_name,
        )
        if preflight_error:
            return False, preflight_error

    # ── 原子 restore 流程 ────────────────────────────────────────
    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            # 1. ORM 反软删 + 元数据回填
            TableField.objects.using(TABDATA_DB_ALIAS).filter(id=field_id).update(
                is_deleted=False,
                name=payload.get("name") or field_row.name,
                field_type=field_type,
                description=payload.get("description") or field_row.description or "",
                config=copy.deepcopy(payload.get("config") or field_row.config or {}),
                order=int(payload.get("order") or field_row.order or 0),
                width=int(payload.get("width") or field_row.width or 150),
                is_primary=bool(payload.get("is_primary", field_row.is_primary)),
                is_hidden=bool(payload.get("is_hidden", field_row.is_hidden)),
                default_value=copy.deepcopy(payload.get("default_value")),
                validation_rules=copy.deepcopy(
                    payload.get("validation_rules") or field_row.validation_rules or {}
                ),
            )

            # 2. native 列重建（IF NOT EXISTS 幂等）
            field_row.refresh_from_db()
            _restore_native_column_for_field(field_row, table_id)

            # 3. schema_version + field_count 增量
            from apps.tabdata.services.table_service import TableService
            svc = TableService(user=user)
            try:
                svc._refresh_field_count(table_id)  # noqa: SLF001
                svc._increment_schema_version(table_id)  # noqa: SLF001
            except Exception as exc:
                logger.warning(
                    "[FieldRestore] schema_version/field_count 刷新失败 field=%s err=%s",
                    field_id, exc,
                )

            # 4. 把字段重新加入所有 view，按删除前位置插入
            try:
                _restore_field_to_views_at_order(field_row, table_id, payload)
            except Exception as exc:
                logger.warning(
                    "[FieldRestore] view 重新加入失败 field=%s err=%s",
                    field_id, exc,
                )

            # 5. 复杂类型专属：重建依赖图 + 触发重算
            if field_type in COMPLEX_RESTORABLE_FIELD_TYPES:
                _post_restore_complex_field(field_row, field_type, payload, user)

            # 6. 推送 field event
            try:
                svc._publish_field_event(table_id, "restore_field", [field_row])  # noqa: SLF001
            except Exception as exc:
                logger.warning(
                    "[FieldRestore] field event 发布失败 field=%s err=%s",
                    field_id, exc,
                )

            # 7. C5：写 ChangeLog
            if write_changelog:
                _write_field_restore_changelog(
                    table_id=table_id,
                    field_id=field_id,
                    field_name=field_name,
                    field_type=field_type,
                    user=user,
                )

        return True, None

    except FieldRestoreNotSupportedError:
        raise
    except Exception as exc:
        logger.error(
            "[FieldRestore] 原子 restore 失败 field=%s table=%s err=%s",
            field_id, table_id, exc, exc_info=True,
        )
        return False, f"恢复字段失败: {exc}"


def restore_fields(
    payloads: List[Dict[str, Any]],
    *,
    user=None,
    write_changelog: bool = True,
) -> Tuple[List[str], List[Tuple[str, str]]]:
    """批量 restore 入口（被 :class:`UndoRedoOperationService` 调用）。

    遇到复杂字段时**整体抛** :class:`FieldRestoreNotSupportedError`（含首个失败
    payload 的元数据），符合 Wave 1 "全或无" 语义；调用方决定 409 文案。

    简单字段失败：单条记入 errors 列表，其他继续 restore（best-effort）。

    P0 修复（Review B-1）：旧实现只在异常上携带"首个失败"字段元数据，前端无法
    呈现完整分类 UI。新实现先把所有 payload 分两组（restorable / unrestorable），
    在异常上同时携带两个全量列表，前端能告诉用户"X 个简单字段可单独 Ctrl+Z
    恢复 / Y 个复杂字段需走版本历史"。

    :returns: (restored_field_ids, errors)，errors 元素为 ``(field_id, message)``
    """
    restored_ids: List[str] = []
    errors: List[Tuple[str, str]] = []

    valid_payloads = [p for p in payloads if isinstance(p, dict)]
    unrestorable: List[Dict[str, Any]] = []
    restorable: List[Dict[str, Any]] = []
    for payload in valid_payloads:
        field_type = str(payload.get("field_type") or "").strip()
        capability = explain_field_restore_capability(field_type)
        entry = {
            "field_id": str(payload.get("id") or ""),
            "field_name": str(payload.get("name") or ""),
            "field_type": field_type,
            "reason_code": capability["reason_code"],
            "reason": capability["reason"],
        }
        if capability["can_undo"]:
            restorable.append(entry)
        else:
            unrestorable.append(entry)

    if unrestorable:
        first = unrestorable[0]
        raise FieldRestoreNotSupportedError(
            first["reason"],
            field_id=first["field_id"],
            field_name=first["field_name"],
            field_type=first["field_type"],
            reason_code=first["reason_code"],
            unrestorable_fields=unrestorable,
            restorable_fields=restorable,
        )

    for payload in valid_payloads:
        success, err = restore_field(
            payload, user=user, write_changelog=write_changelog,
        )
        if success:
            restored_ids.append(str(payload.get("id") or ""))
        else:
            errors.append((str(payload.get("id") or ""), err or "未知错误"))

    return restored_ids, errors


def _restore_field_to_views_at_order(field, table_id: UUID, payload: Dict[str, Any]) -> None:
    """字段 restore 路径专用：按 ``field.order`` 把字段插入所有 view 的对应位置。

    P1 修复（Review §A-1）：旧实现走 ``_auto_add_field_to_views`` 把字段 append
    到末尾（适合"新建字段"语义），但 restore 场景下用户期望"字段回到删除前的
    第 N 列"。

    算法：
    - ``visible_fields`` / ``field_order``：按 field.order 找到第一个 ORDER >= 自身的
      位置插入,保留删除前的相对位置感
    - ``column_meta``：order 直接复用 field.order

    fail-safe：每个 view 独立 try/except,单个 view 失败不影响其他
    """
    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models import TableField, TableView

    field_id_str = str(field.id)
    field_order = float(field.order or payload.get("order") or 0)

    # 一次拉所有 view + 所有活字段（用于按 order 计算插入位置）
    views = list(TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id))
    if not views:
        return

    active_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS)
        .filter(table_id=table_id, is_deleted=False)
        .only("id", "order")
        .order_by("order")
    )
    field_order_map = {str(f.id): float(f.order or 0) for f in active_fields}

    to_update = []
    update_fields_set = {"visible_fields", "field_order"}
    for view in views:
        changed = False

        # visible_fields：按 order 升序插入第一个 order >= 自身的位置
        vf = view.visible_fields or []
        if vf and field_id_str not in vf:
            insert_idx = len(vf)
            for i, fid in enumerate(vf):
                if field_order_map.get(fid, float("inf")) >= field_order:
                    insert_idx = i
                    break
            view.visible_fields = vf[:insert_idx] + [field_id_str] + vf[insert_idx:]
            changed = True

        # field_order：同样按 order 升序插入
        fo = view.field_order or []
        if fo and field_id_str not in fo:
            insert_idx = len(fo)
            for i, fid in enumerate(fo):
                if field_order_map.get(fid, float("inf")) >= field_order:
                    insert_idx = i
                    break
            view.field_order = fo[:insert_idx] + [field_id_str] + fo[insert_idx:]
            changed = True

        # column_meta：order 直接复用 field.order（如果尚未存在）
        cm = view.column_meta if isinstance(view.column_meta, dict) else {}
        if field_id_str not in cm:
            cm = dict(cm)
            view_type = str(getattr(view, "view_type", "") or "").lower()
            use_hidden = view_type in ("grid", "list", "plugin")
            entry = {"order": field_order}
            if use_hidden:
                entry["hidden"] = bool(payload.get("is_hidden") or False)
            else:
                entry["visible"] = not bool(payload.get("is_hidden") or False)
            cm[field_id_str] = entry
            view.column_meta = cm
            update_fields_set.add("column_meta")
            changed = True

        if changed:
            to_update.append(view)

    if to_update:
        TableView.objects.using(TABDATA_DB_ALIAS).bulk_update(
            to_update, list(update_fields_set),
        )


def _restore_native_column_for_field(field, table_id: UUID) -> None:
    """重建 PG 原生列（与 ``TableService._native_add_column`` 等价但不依赖 service 实例）。

    本函数有意放在事务内：DDL 失败必须回滚 ORM 反软删，否则会出现 "ORM 字段
    is_deleted=False 但 native 列缺失" 的脏状态（与 PRD §C1 "回来一半" 的最坏破口
    完全一致）。

    DB 异常向上传播由外层 ``transaction.atomic`` 触发回滚。
    """
    from apps.tabdata.models import Table
    from apps.tabdata.native.ddl_manager import DDLManager, resolve_schema_partition_id
    from apps.tabdata.native.pg_type_map import is_system_field

    if is_system_field(field.field_type):
        # 系统列由 native 表初始化时已建好，直接跳过
        return

    table = Table.objects.using(TABDATA_DB_ALIAS).only("space_id", "organization_id").get(id=table_id)
    partition_id = resolve_schema_partition_id(table)
    ddl = DDLManager()
    ddl.add_column(
        partition_id, table_id, field.id, field.field_type, field.config,
    )

    # 失效 NameResolver 缓存（与 _native_add_column 行为对齐）
    try:
        from apps.tabdata.native.name_resolver import invalidate_resolver
        invalidate_resolver(partition_id)
    except Exception:
        # NameResolver 缓存失效失败不影响数据正确性，TTL 会自然过期
        pass


# ═══════════════════════════════════════════════════════════════════
# Wave 2 / C1 复杂类型：预检 + 恢复后处理
# ═══════════════════════════════════════════════════════════════════


def _preflight_complex_field(
    field_type: str,
    payload: Dict[str, Any],
    table_id: UUID,
    field_name: str,
) -> Optional[str]:
    """复杂字段恢复前的依赖预检。返回 None 表示通过，否则返回错误信息。"""
    from apps.tabdata.models import Table, TableField

    config = copy.deepcopy(payload.get("config") or {})

    if field_type == "link":
        return _preflight_link(config, table_id, field_name)
    return None


def _preflight_link(
    config: Dict[str, Any], table_id: UUID, field_name: str,
) -> Optional[str]:
    """Link 预检：对侧表必须存在。"""
    from apps.tabdata.models import Table

    foreign_table_id = config.get("foreignTableId")
    if not foreign_table_id:
        return (
            f"无法撤销删除「{field_name}」：关联字段缺少目标表配置。"
            f"请从「版本历史」中还原。"
        )
    if not Table.objects.using(TABDATA_DB_ALIAS).filter(
        id=foreign_table_id, is_archived=False,
    ).exists():
        return (
            f"无法撤销删除「{field_name}」：目标关联表已被删除或归档。"
            f"请先恢复目标表，或从「版本历史」中还原。"
        )
    return None


def _post_restore_complex_field(
    field_row, field_type: str, payload: Dict[str, Any], user=None,
) -> None:
    """关联字段 restore 后重建对称字段和依赖图。"""
    if field_type == "link":
        _post_restore_link(field_row, payload, user)


def _post_restore_link(
    field_row, payload: Dict[str, Any], user=None,
) -> None:
    """Link 恢复后：恢复对称字段并重注册 FieldReference。"""
    from apps.tabdata.models import TableField

    config = field_row.config or {}
    symmetric_field_id = config.get("symmetricFieldId")
    is_one_way = config.get("isOneWay", False)
    foreign_table_id = config.get("foreignTableId")

    # 1. 恢复对称字段（如果被同时软删）
    if not is_one_way and symmetric_field_id:
        try:
            sym_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id=symmetric_field_id,
            ).first()
            if sym_field and sym_field.is_deleted:
                TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    id=symmetric_field_id,
                ).update(is_deleted=False)
                sym_field.refresh_from_db()
                _restore_native_column_for_field(sym_field, sym_field.table_id)
                logger.info(
                    "[FieldRestore] 恢复对称字段 sym=%s (link=%s)",
                    symmetric_field_id, field_row.id,
                )

                # 对称字段也需要恢复到 view
                try:
                    _restore_field_to_views_at_order(
                        sym_field,
                        sym_field.table_id,
                        {"order": sym_field.order, "is_hidden": sym_field.is_hidden},
                    )
                except Exception as exc:
                    logger.warning(
                        "[FieldRestore] 对称字段 view 恢复失败 sym=%s err=%s",
                        symmetric_field_id, exc,
                    )

                # schema_version + field_count for symmetric field's table
                from apps.tabdata.services.table_service import TableService
                try:
                    sym_svc = TableService(user=user)
                    sym_svc._refresh_field_count(sym_field.table_id)  # noqa: SLF001
                    sym_svc._increment_schema_version(sym_field.table_id)  # noqa: SLF001
                except Exception as exc:
                    logger.warning(
                        "[FieldRestore] 对称字段 schema 刷新失败 sym=%s err=%s",
                        symmetric_field_id, exc,
                    )
            elif sym_field is None:
                logger.warning(
                    "[FieldRestore] 对称字段不存在 sym=%s，降级为单向",
                    symmetric_field_id,
                )
        except Exception as exc:
            logger.warning(
                "[FieldRestore] 对称字段恢复失败 sym=%s err=%s",
                symmetric_field_id, exc,
            )

    # 2. 重注册 Link 的 FieldReference
    lookup_field_id = config.get("lookupFieldId")
    if lookup_field_id:
        from apps.tabdata.services.cascade_service import FieldReferenceManager
        try:
            FieldReferenceManager.register_references(
                to_field_id=str(field_row.id),
                from_field_ids=[str(lookup_field_id)],
            )
        except Exception as exc:
            logger.warning(
                "[FieldRestore] Link 依赖注册失败 field=%s err=%s",
                field_row.id, exc,
            )

def _write_field_restore_changelog(
    *,
    table_id: UUID,
    field_id: UUID,
    field_name: str,
    field_type: str,
    user=None,
) -> None:
    """C5 / Wave 1.1：把字段 restore 写进 ChangeLog，让 contributors 反查能定位。

    与 ``api_undo_redo.restore_table`` 中 ChangeLog 写入路径对齐；本函数承担
    "字段级 restore" 的 C5 通路，PRD §C5 "Agent 写入 100% 触发 RH" 的字段维度。

    单元测试可通过 ``write_changelog=False`` 关闭。
    """
    try:
        from apps.collab.models import ChangeLog
        # ContextVar 兜底（与 history_events._resolve_run_context 同源）
        agent_run_id = ""
        session_id = ""
        try:
            from apps.services.common.platform_context import (
                get_current_run_id, get_current_session_id,
            )
            agent_run_id = get_current_run_id() or ""
            session_id = get_current_session_id() or ""
        except Exception:
            pass

        editor_id = ""
        editor_name = ""
        editor_type = "user"
        if user is not None:
            editor_id = str(getattr(user, "id", "") or "")
            editor_name = str(
                getattr(user, "nickname", "")
                or getattr(user, "username", "")
                or ""
            )
            if agent_run_id:
                editor_type = "agent"

        ChangeLog.objects.using("postgresql").create(
            resource_type="table",
            resource_id=table_id,
            change_type="restore_field",
            summary=f"恢复字段「{field_name}」({field_type})",
            changes={
                "field_id": str(field_id),
                "field_name": field_name,
                "field_type": field_type,
                "wave": "2.1",
            },
            editor_type=editor_type,
            editor_id=editor_id,
            editor_name=editor_name,
            agent_run_id=agent_run_id,
            session_id=session_id,
        )
    except Exception:
        # ChangeLog 写入失败不阻塞主流程，与 api_undo_redo.restore_table 一致
        logger.warning(
            "[FieldRestore] ChangeLog 写入失败 field=%s table=%s",
            field_id, table_id, exc_info=True,
        )

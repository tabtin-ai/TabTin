"""记录序列化辅助函数"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Iterable, List, Literal, Optional, Set, Tuple
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableRecord, TableField

logger = logging.getLogger(__name__)

RecordFieldKeyType = Literal['id', 'name', 'dbFieldName']

# created_by / last_modified_by 字段类型集合
_SYSTEM_USER_FIELD_TYPES = frozenset({'created_by', 'last_modified_by'})

# created_time / last_modified_time 字段类型集合
_SYSTEM_TIMESTAMP_FIELD_TYPES = frozenset({'created_time', 'last_modified_time'})

# ── 字段元数据进程级缓存 ──────────────────────────────
# key = f"{table_id}:{schema_version}"，TTL 30 秒。
# schema_version 变更时缓存自动失效，无需手动清理。
_FIELD_MAP_CACHE_TTL = 30  # 秒
_field_map_cache: Dict[str, Tuple[Any, float]] = {}
_field_map_cache_lock = threading.Lock()

_SYS_USER_FIELD_CACHE: Dict[str, Tuple[List[TableField], float]] = {}
_sys_user_field_cache_lock = threading.Lock()

_SYS_TS_FIELD_CACHE: Dict[str, Tuple[List[TableField], float]] = {}
_sys_ts_field_cache_lock = threading.Lock()


def _get_schema_version(table_id: UUID) -> int:
    """获取表的 schema_version，用于缓存 key"""
    try:
        from apps.tabdata.models import Table
        row = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=table_id)
            .values_list('schema_version', flat=True)
            .first()
        )
        return int(row) if row is not None else 0
    except Exception:
        return 0


def invalidate_field_map_cache(table_id: Optional[UUID] = None) -> None:
    """
    手动失效字段元数据缓存。

    schema_version 变更时通常自动失效；在极少数同 version 内需要
    立即刷新的场景下调用。
    """
    with _field_map_cache_lock:
        if table_id is None:
            _field_map_cache.clear()
        else:
            prefix = str(table_id) + ":"
            for k in list(_field_map_cache):
                if k.startswith(prefix):
                    _field_map_cache.pop(k, None)
    with _sys_user_field_cache_lock:
        if table_id is None:
            _SYS_USER_FIELD_CACHE.clear()
        else:
            prefix = str(table_id) + ":"
            for k in list(_SYS_USER_FIELD_CACHE):
                if k.startswith(prefix):
                    _SYS_USER_FIELD_CACHE.pop(k, None)
    with _sys_ts_field_cache_lock:
        if table_id is None:
            _SYS_TS_FIELD_CACHE.clear()
        else:
            prefix = str(table_id) + ":"
            for k in list(_SYS_TS_FIELD_CACHE):
                if k.startswith(prefix):
                    _SYS_TS_FIELD_CACHE.pop(k, None)


def _serialize_datetime(value):
    if value is None:
        return None
    return value.isoformat() if hasattr(value, 'isoformat') else str(value)


def _find_system_user_fields(table_id: UUID) -> List[TableField]:
    """查找表中 created_by / last_modified_by 类型的字段定义（30 秒缓存）"""
    sv = _get_schema_version(table_id)
    cache_key = f"{table_id}:{sv}"
    now = time.monotonic()

    with _sys_user_field_cache_lock:
        cached = _SYS_USER_FIELD_CACHE.get(cache_key)
        if cached is not None:
            val, expiry = cached
            if now < expiry:
                return val

    try:
        result = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
            field_type__in=_SYSTEM_USER_FIELD_TYPES,
        ))
    except Exception:  # noqa: BLE001 — 降级策略：查询失败时不阻塞序列化
        logger.debug("_find_system_user_fields 查询失败", exc_info=True)
        return []

    with _sys_user_field_cache_lock:
        _SYS_USER_FIELD_CACHE[cache_key] = (result, now + _FIELD_MAP_CACHE_TTL)
        if len(_SYS_USER_FIELD_CACHE) > 200:
            expired = [k for k, (_, exp) in _SYS_USER_FIELD_CACHE.items() if now >= exp]
            for k in expired:
                _SYS_USER_FIELD_CACHE.pop(k, None)

    return result


def _find_system_timestamp_fields(table_id: UUID) -> List[TableField]:
    """查找表中 created_time / last_modified_time 类型的字段定义（30 秒缓存）"""
    sv = _get_schema_version(table_id)
    cache_key = f"{table_id}:{sv}"
    now = time.monotonic()

    with _sys_ts_field_cache_lock:
        cached = _SYS_TS_FIELD_CACHE.get(cache_key)
        if cached is not None:
            val, expiry = cached
            if now < expiry:
                return val

    try:
        result = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False,
            field_type__in=_SYSTEM_TIMESTAMP_FIELD_TYPES,
        ))
    except Exception:
        logger.debug("_find_system_timestamp_fields 查询失败", exc_info=True)
        return []

    with _sys_ts_field_cache_lock:
        _SYS_TS_FIELD_CACHE[cache_key] = (result, now + _FIELD_MAP_CACHE_TTL)
        if len(_SYS_TS_FIELD_CACHE) > 200:
            expired = [k for k, (_, exp) in _SYS_TS_FIELD_CACHE.items() if now >= exp]
            for k in expired:
                _SYS_TS_FIELD_CACHE.pop(k, None)

    return result


def _system_fields_allowed_by_visibility(
    system_fields: List[TableField],
    *,
    visibility_filtered: bool,
    visible_keys: Any,
) -> List[TableField]:
    """#4111：visibility 过滤后，系统字段注入也必须消费同一可见 key 集合。"""
    if not visibility_filtered:
        return system_fields
    if not system_fields:
        return []
    if visible_keys is None:
        return []
    from apps.tabdata.services.field_visibility import flatten_visible_keys

    allowed = flatten_visible_keys(visible_keys)
    if not allowed:
        return []
    result: List[TableField] = []
    for field in system_fields:
        db_name = str((getattr(field, "config", None) or {}).get("db_field_name") or "")
        if (
            str(field.id) in allowed
            or field.name in allowed
            or (db_name and db_name in allowed)
        ):
            result.append(field)
    return result


def _inject_system_timestamp_values(
    data: Dict[str, Any],
    output_fields: Dict[str, Any],
    system_ts_fields: List[TableField],
    created_at: Any,
    updated_at: Any,
    field_key_type: RecordFieldKeyType,
) -> None:
    """将 created_time / last_modified_time 的时间戳注入 data 和 output_fields"""
    for stf in system_ts_fields:
        if stf.field_type == 'created_time':
            ts_value = created_at
        elif stf.field_type == 'last_modified_time':
            ts_value = updated_at
        else:
            continue

        serialized_ts = _serialize_datetime(ts_value)
        if serialized_ts is None:
            continue

        data[stf.name] = serialized_ts

        if field_key_type == 'id':
            tf_key = str(stf.id)
        elif field_key_type == 'dbFieldName':
            tf_key = str((stf.config or {}).get('db_field_name') or stf.name)
        else:
            tf_key = stf.name
        output_fields[tf_key] = serialized_ts


def _lookup_user_info(user_ids: Set[str]) -> Dict[str, Dict[str, Any]]:
    """批量查询用户信息，返回 {user_id_str: {id, name, avatar_url}}"""
    if not user_ids:
        return {}
    try:
        from django.contrib.auth import get_user_model
        User = get_user_model()
        users_qs = User.objects.filter(
            id__in=[uid for uid in user_ids if uid]
        ).values('id', 'nickname', 'email', 'avatar')
        result: Dict[str, Dict[str, Any]] = {}
        for u in users_qs:
            uid = str(u['id'])
            name = u['nickname'] or (
                u['email'].split('@')[0] if u['email'] else f'用户{uid[:8]}'
            )
            result[uid] = {
                'id': uid,
                'name': name,
                'avatar_url': u.get('avatar') or '',
            }
        return result
    except Exception:
        logger.debug("_lookup_user_info 查询失败，降级为空", exc_info=True)
        return {}


def _inject_system_user_values(
    data: Dict[str, Any],
    output_fields: Dict[str, Any],
    system_user_fields: List[TableField],
    created_by_id: Optional[str],
    updated_by_id: Optional[str],
    user_info_cache: Dict[str, Dict[str, Any]],
    field_key_type: RecordFieldKeyType,
) -> None:
    """将 created_by / last_modified_by 的用户信息注入 data 和 output_fields"""
    for suf in system_user_fields:
        if suf.field_type == 'created_by':
            uid = created_by_id
        elif suf.field_type == 'last_modified_by':
            uid = updated_by_id
        else:
            continue

        if not uid:
            continue

        uid_str = str(uid)
        user_obj = user_info_cache.get(uid_str, {
            'id': uid_str,
            'name': f'用户{uid_str[:8]}',
            'avatar_url': '',
        })

        data[suf.name] = user_obj

        if field_key_type == 'id':
            tf_key = str(suf.id)
        elif field_key_type == 'dbFieldName':
            tf_key = str((suf.config or {}).get('db_field_name') or suf.name)
        else:
            tf_key = suf.name
        output_fields[tf_key] = user_obj


def _build_field_maps(
    table_id: UUID,
) -> Tuple[Dict[str, str], Dict[str, str]]:
    """
    构建表格字段映射（UUID -> 字段名/DB字段名）。

    结果按 table_id + schema_version 做进程级缓存（TTL 30s），
    避免同一请求内对相同表重复查库。
    """
    sv = _get_schema_version(table_id)
    cache_key = f"{table_id}:{sv}"
    now = time.monotonic()

    with _field_map_cache_lock:
        cached = _field_map_cache.get(cache_key)
        if cached is not None:
            val, expiry = cached
            if now < expiry:
                return val

    fields_qs = TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        is_deleted=False,
    )

    uuid_to_name: Dict[str, str] = {}
    uuid_to_db_field_name: Dict[str, str] = {}
    for field in fields_qs:
        field_id = str(field.id)
        field_config = field.config or {}
        db_field_name = field_config.get('db_field_name') or field.name

        uuid_to_name[field_id] = field.name
        uuid_to_db_field_name[field_id] = str(db_field_name)

    result = (uuid_to_name, uuid_to_db_field_name)

    with _field_map_cache_lock:
        _field_map_cache[cache_key] = (result, now + _FIELD_MAP_CACHE_TTL)
        if len(_field_map_cache) > 200:
            expired = [k for k, (_, exp) in _field_map_cache.items() if now >= exp]
            for k in expired:
                _field_map_cache.pop(k, None)

    return result


def _resolve_storage_field_id(
    raw_key: str,
    uuid_to_name: Dict[str, str],
    uuid_to_db_field_name: Dict[str, str],
    name_to_uuid: Optional[Dict[str, str]] = None,
    db_field_name_to_uuid: Optional[Dict[str, str]] = None,
    hex_to_uuid: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    """
    将记录存储 key（可能是 UUID、hex、字段名、db 字段名）解析为字段 UUID。

    当由 _convert_storage_keys 循环调用时，name_to_uuid / db_field_name_to_uuid / hex_to_uuid
    由调用者预构建并传入，避免每次调用都重建字典。
    """
    if raw_key in uuid_to_name:
        return raw_key

    if hex_to_uuid is None:
        hex_to_uuid = {fid.replace('-', ''): fid for fid in uuid_to_name}
    if raw_key in hex_to_uuid:
        return hex_to_uuid[raw_key]

    if name_to_uuid is None:
        name_to_uuid = {name: field_id for field_id, name in uuid_to_name.items()}
    if raw_key in name_to_uuid:
        return name_to_uuid[raw_key]

    if db_field_name_to_uuid is None:
        db_field_name_to_uuid = {
            db_name: field_id for field_id, db_name in uuid_to_db_field_name.items()
        }
    return db_field_name_to_uuid.get(raw_key)


def _resolve_output_key(
    field_id: str,
    *,
    field_key_type: RecordFieldKeyType,
    uuid_to_name: Dict[str, str],
    uuid_to_db_field_name: Dict[str, str],
) -> str:
    if field_key_type == 'id':
        return field_id

    if field_key_type == 'dbFieldName':
        return uuid_to_db_field_name.get(field_id) or uuid_to_name.get(field_id, field_id)

    return uuid_to_name.get(field_id, field_id)


def _convert_storage_keys(
    table_id: UUID,
    storage_data: Dict[str, Any],
    *,
    field_key_type: RecordFieldKeyType,
    field_name_map: Optional[Dict[str, str]] = None,
    field_db_field_name_map: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    将记录存储 key（UUID/字段名/db字段名混合）转换为目标 key 类型。
    """
    if not storage_data:
        return {}

    if field_name_map is not None:
        uuid_to_name = field_name_map
    else:
        try:
            fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).values('id', 'name')
            uuid_to_name = {str(field['id']): str(field['name']) for field in fields}
        except Exception:
            return dict(storage_data)

    if field_db_field_name_map is not None:
        uuid_to_db_field_name = field_db_field_name_map
    else:
        # 当前 tabdata 没有独立 db_field_name 列，默认回退到字段名。
        uuid_to_db_field_name = {field_id: name for field_id, name in uuid_to_name.items()}

    _name_to_uuid = {name: fid for fid, name in uuid_to_name.items()}
    _db_field_name_to_uuid = {db_name: fid for fid, db_name in uuid_to_db_field_name.items()}
    _hex_to_uuid = {fid.replace('-', ''): fid for fid in uuid_to_name}

    converted: Dict[str, Any] = {}
    for key, value in storage_data.items():
        raw_key = str(key)
        field_id = _resolve_storage_field_id(
            raw_key, uuid_to_name, uuid_to_db_field_name,
            name_to_uuid=_name_to_uuid,
            db_field_name_to_uuid=_db_field_name_to_uuid,
            hex_to_uuid=_hex_to_uuid,
        )
        if not field_id:
            converted[raw_key] = value
            continue

        output_key = _resolve_output_key(
            field_id,
            field_key_type=field_key_type,
            uuid_to_name=uuid_to_name,
            uuid_to_db_field_name=uuid_to_db_field_name,
        )
        converted[output_key] = value

    return converted


def _convert_uuid_keys_to_field_names(
    table_id: UUID,
    uuid_data: Dict[str, Any],
    field_name_map: Optional[Dict[str, str]] = None,
    field_db_field_name_map: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    将 UUID key 转换为字段名称 key（向后兼容）

    Args:
        table_id: 表格 ID
        uuid_data: 使用 UUID 作为 key 的数据

    Returns:
        使用字段名称作为 key 的数据
    """
    return _convert_storage_keys(
        table_id,
        uuid_data,
        field_key_type='name',
        field_name_map=field_name_map,
        field_db_field_name_map=field_db_field_name_map,
    )


def _load_native_data_for_record(record: TableRecord) -> Optional[Dict[str, Any]]:
    """
    从原生列读取记录数据（Phase 3D: record.data 可能为空）。

    返回 UUID-keyed dict（与 record.data 格式一致），供 serialize_record() 使用。
    """
    try:
        from apps.tabdata.models import Table
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import convert_native_row_to_record_data
        from apps.tabdata.native.pg_type_map import is_system_field

        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=record.table_id)
        native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)
        row = native_io.read_single(record.id)
        if not row:
            return None

        user_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table.id, is_deleted=False,
        ))
        user_fields = [f for f in user_fields if not is_system_field(f.field_type)]

        return convert_native_row_to_record_data(row, user_fields)
    except Exception:
        return None


def _load_native_data_for_records(
    records: List[TableRecord],
) -> Dict[str, Optional[Dict[str, Any]]]:
    """
    批量从原生列读取多条记录数据，一次查询替代 N 次 read_single。

    返回 {record_id_str: UUID-keyed dict}，供 serialize_records() 使用。
    """
    if not records:
        return {}

    try:
        from apps.tabdata.models import Table
        from apps.tabdata.native.record_io import NativeRecordIO
        from apps.tabdata.native.value_converter import convert_native_row_to_record_data
        from apps.tabdata.native.pg_type_map import is_system_field

        result: Dict[str, Optional[Dict[str, Any]]] = {}

        groups: Dict[str, list] = {}
        for rec in records:
            groups.setdefault(str(rec.table_id), []).append(rec)

        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

        for table_id_str, group_records in groups.items():
            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id_str)
            native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)

            record_ids = [rec.id for rec in group_records]
            rows_map = native_io.read_batch(record_ids)

            user_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            ))
            user_fields = [f for f in user_fields if not is_system_field(f.field_type)]

            for rec in group_records:
                rid_str = str(rec.id)
                row = rows_map.get(rid_str)
                if row:
                    result[rid_str] = convert_native_row_to_record_data(row, user_fields)
                else:
                    result[rid_str] = None

        return result
    except Exception:
        logger.debug("_load_native_data_for_records 批量查询失败", exc_info=True)
        return {}


def serialize_record(
    record: TableRecord,
    fields: Optional[Iterable[str]] = None,
    field_name_map: Optional[Dict[str, str]] = None,
    field_db_field_name_map: Optional[Dict[str, str]] = None,
    field_key_type: RecordFieldKeyType = 'name',
    _system_user_fields: Optional[List[TableField]] = None,
    _user_info_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    _system_ts_fields: Optional[List[TableField]] = None,
) -> Dict[str, Any]:
    """
    序列化记录，支持字段过滤并返回稳定行ID与排序信息

    ⭐ 自动将 UUID key 转换为字段名称 key（向后兼容前端）

    Args:
        record: 记录对象
        fields: 要包含的字段列表（None 表示包含所有）

    Returns:
        序列化后的记录字典
    """
    field_set: Optional[Set[str]] = set(fields) if fields else None
    # ：角色可见性过滤后即使 data 为空也不回退原生全量
    if getattr(record, "_visibility_filtered", False):
        raw_data = getattr(record, "_filtered_data", None)
        if not isinstance(raw_data, dict):
            raw_data = {}
    else:
        raw_data = getattr(record, "_filtered_data", None)
        if raw_data is None:
            raw_data = record.__dict__.get('data') or {}
        # Phase 3D: record.data 可能为空 {}（数据仅存原生列）
        # 优先使用 _native_formatted_data（create/update 时保留的完整数据）
        if not raw_data:
            native_formatted_data = getattr(record, '_native_formatted_data', None)
            if isinstance(native_formatted_data, dict):
                raw_data = native_formatted_data
            else:
                raw_data = {}
        # 如果仍为空（读取场景），尝试从原生列获取
        if not raw_data:
            raw_data = _load_native_data_for_record(record) or {}

    # 兼容旧协议：data 固定按字段名称输出
    data = _convert_uuid_keys_to_field_names(
        record.table_id,
        raw_data,
        field_name_map=field_name_map,
        field_db_field_name_map=field_db_field_name_map,
    )

    output_fields = _convert_storage_keys(
        record.table_id,
        raw_data,
        field_key_type=field_key_type,
        field_name_map=field_name_map,
        field_db_field_name_map=field_db_field_name_map,
    )

    visibility_filtered = bool(getattr(record, "_visibility_filtered", False))
    visible_keys = getattr(record, "_visible_field_keys", None)

    # 注入 created_by / last_modified_by 系统用户字段值到 data
    if _system_user_fields is None:
        _system_user_fields = _find_system_user_fields(record.table_id)
    _system_user_fields = _system_fields_allowed_by_visibility(
        _system_user_fields or [],
        visibility_filtered=visibility_filtered,
        visible_keys=visible_keys,
    )
    if _system_user_fields:
        rec_created_by = getattr(record, 'created_by_id', None)
        rec_updated_by = getattr(record, 'updated_by_id', None)
        if _user_info_cache is None:
            ids_to_lookup: Set[str] = set()
            if rec_created_by:
                ids_to_lookup.add(str(rec_created_by))
            if rec_updated_by:
                ids_to_lookup.add(str(rec_updated_by))
            _user_info_cache = _lookup_user_info(ids_to_lookup)
        _inject_system_user_values(
            data, output_fields, _system_user_fields,
            str(rec_created_by) if rec_created_by else None,
            str(rec_updated_by) if rec_updated_by else None,
            _user_info_cache, field_key_type,
        )

    # 注入 created_time / last_modified_time 系统时间戳字段值到 data
    if _system_ts_fields is None:
        _system_ts_fields = _find_system_timestamp_fields(record.table_id)
    _system_ts_fields = _system_fields_allowed_by_visibility(
        _system_ts_fields or [],
        visibility_filtered=visibility_filtered,
        visible_keys=visible_keys,
    )
    if _system_ts_fields:
        _inject_system_timestamp_values(
            data, output_fields, _system_ts_fields,
            record.created_at, record.updated_at, field_key_type,
        )

    if field_set is not None:
        field_name_map_resolved = field_name_map or {}
        field_db_map_resolved = field_db_field_name_map or {}
        if not field_name_map_resolved:
            try:
                fields_raw = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=record.table_id,
                    is_deleted=False,
                ).values('id', 'name', 'config')
                field_name_map_resolved = {
                    str(item['id']): str(item['name']) for item in fields_raw
                }
                field_db_map_resolved = {
                    str(item['id']): str((item.get('config') or {}).get('db_field_name') or item['name'])
                    for item in fields_raw
                }
            except Exception:
                field_name_map_resolved = {}
                field_db_map_resolved = {}
        if not field_db_map_resolved:
            field_db_map_resolved = {
                field_id: field_name_map_resolved.get(field_id, field_id)
                for field_id in field_name_map_resolved
            }

        if field_key_type == 'name':
            data_field_set = field_set
        elif field_key_type == 'id':
            data_field_set = {
                field_name_map_resolved.get(field_id, field_id)
                for field_id in field_set
            }
        else:
            db_to_name = {
                db_field_name: field_name_map_resolved.get(field_id, field_id)
                for field_id, db_field_name in field_db_map_resolved.items()
            }
            data_field_set = {
                db_to_name.get(db_key, db_key)
                for db_key in field_set
            }

        data = {k: v for k, v in data.items() if k in data_field_set}
        output_fields = {k: v for k, v in output_fields.items() if k in field_set}

    result = {
        "id": str(record.id),
        "row_id": record.row_id,
        "table_id": str(record.table_id),
        "data": data,
        "fields": output_fields,
        "order": record.order,
        "version": int(getattr(record, "version", 1) or 1),
        "status": record.status,
        "tags": record.tags if getattr(record, 'tags', None) is not None else [],
        "created_by_id": str(record.created_by_id) if record.created_by_id else None,
        "updated_by_id": str(record.updated_by_id) if record.updated_by_id else None,
        "created_at": _serialize_datetime(record.created_at),
        "updated_at": _serialize_datetime(record.updated_at),
    }

    return result


def serialize_records(
    records: Iterable[TableRecord],
    fields: Optional[Iterable[str]] = None,
    field_key_type: RecordFieldKeyType = 'name',
) -> list[Dict[str, Any]]:
    """
    批量序列化记录，按 table_id 复用字段映射，避免逐条查询。

    对 data 为空的记录批量预加载原生列数据（1 次查询 / table），
    避免 serialize_record 内逐条 _load_native_data_for_record。
    """
    records_list = list(records)
    if not records_list:
        return []

    context_by_table_id: Dict[
        str,
        Tuple[Dict[str, str], Dict[str, str]],
    ] = {}
    sys_fields_by_table: Dict[str, List[TableField]] = {}
    sys_ts_fields_by_table: Dict[str, List[TableField]] = {}
    all_user_ids: Set[str] = set()
    serialized: list[Dict[str, Any]] = []

    # 预查询系统用户字段 + 时间戳字段，收集所有需要查询的 user ID
    for record in records_list:
        table_key = str(record.table_id)
        if table_key not in sys_fields_by_table:
            sys_fields_by_table[table_key] = _find_system_user_fields(record.table_id)
            sys_ts_fields_by_table[table_key] = _find_system_timestamp_fields(record.table_id)
        if sys_fields_by_table[table_key]:
            if record.created_by_id:
                all_user_ids.add(str(record.created_by_id))
            if record.updated_by_id:
                all_user_ids.add(str(record.updated_by_id))

    user_info_cache = _lookup_user_info(all_user_ids)

    # 批量预加载原生数据：筛选 data 为空且无 _native_formatted_data 的记录
    # 已做角色可见性过滤的记录不再回源
    needs_native: List[TableRecord] = []
    for record in records_list:
        if getattr(record, "_visibility_filtered", False):
            continue
        raw = getattr(record, "_filtered_data", None) or record.__dict__.get('data') or {}
        if not raw and not getattr(record, '_native_formatted_data', None):
            needs_native.append(record)
    if needs_native:
        native_map = _load_native_data_for_records(needs_native)
        for rec in needs_native:
            nd = native_map.get(str(rec.id))
            if nd:
                rec._native_formatted_data = nd

    for record in records_list:
        table_key = str(record.table_id)
        if table_key not in context_by_table_id:
            context_by_table_id[table_key] = _build_field_maps(record.table_id)

        field_name_map, field_db_field_name_map = context_by_table_id[table_key]
        serialized.append(
            serialize_record(
                record,
                fields=fields,
                field_name_map=field_name_map,
                field_db_field_name_map=field_db_field_name_map,
                field_key_type=field_key_type,
                _system_user_fields=sys_fields_by_table[table_key],
                _user_info_cache=user_info_cache,
                _system_ts_fields=sys_ts_fields_by_table[table_key],
            )
        )

    return serialized


# ══════════════════════════════════════
# 原生列查询结果序列化
# ══════════════════════════════════════

def serialize_native_row(
    row: Dict[str, Any],
    table_id: UUID,
    fields: List[TableField],
    *,
    field_key_type: RecordFieldKeyType = 'name',
    _system_user_fields: Optional[List[TableField]] = None,
    _user_info_cache: Optional[Dict[str, Dict[str, Any]]] = None,
    _system_ts_fields: Optional[List[TableField]] = None,
) -> Dict[str, Any]:
    """
    将原生 SQL 查询返回的行 dict 序列化为与 serialize_record() 完全一致的 API 格式。

    确保前端无感切换（JSON 路径 vs 原生列）。

    Args:
        row: 原生 SQL 查询返回的 dict（{column_name: value, ...}）
              包含系统列（__id, __order, __version, __created_at, 等）
              和字段列（field_uuid_hex: value）
        table_id: 表 ID
        fields: 表字段对象列表
        field_key_type: 输出 key 类型

    Returns:
        与 serialize_record() 格式完全一致的字典
    """
    from apps.tabdata.native.value_converter import pg_to_python

    # 构建字段映射
    uuid_to_name: Dict[str, str] = {}
    uuid_to_db_field_name: Dict[str, str] = {}
    for field in fields:
        fid = str(field.id)
        field_config = field.config or {}
        db_field_name = field_config.get('db_field_name') or field.name

        uuid_to_name[fid] = field.name
        uuid_to_db_field_name[fid] = str(db_field_name)

    # 从原生行提取系统列
    record_id = str(row.get('__id', ''))
    record_order = row.get('__order', 0)
    record_version = int(row.get('__version', 1) or 1)
    created_at = row.get('__created_at')
    updated_at = row.get('__updated_at')
    created_by_id = row.get('__created_by')
    updated_by_id = row.get('__updated_by')

    # 构建字段数据（以 field UUID 为 key）
    uuid_data: Dict[str, Any] = {}
    for field in fields:
        field_hex = field.id.hex
        raw_value = row.get(field_hex)
        if raw_value is None:
            continue
        api_value = pg_to_python(raw_value, field.field_type, field.config)
        uuid_data[str(field.id)] = api_value

    # 按字段名称输出 data（兼容旧协议）
    data: Dict[str, Any] = {}
    for field_id, value in uuid_data.items():
        field_name = uuid_to_name.get(field_id, field_id)
        data[field_name] = value

    # 按请求 key 类型输出 fields
    output_fields: Dict[str, Any] = {}
    for field_id, value in uuid_data.items():
        output_key = _resolve_output_key(
            field_id,
            field_key_type=field_key_type,
            uuid_to_name=uuid_to_name,
            uuid_to_db_field_name=uuid_to_db_field_name,
        )
        output_fields[output_key] = value

    # 注入 created_by / last_modified_by 系统用户字段值到 data
    if _system_user_fields is None:
        _system_user_fields = _find_system_user_fields(table_id)
    if _system_user_fields:
        if _user_info_cache is None:
            ids_to_lookup: Set[str] = set()
            if created_by_id:
                ids_to_lookup.add(str(created_by_id))
            if updated_by_id:
                ids_to_lookup.add(str(updated_by_id))
            _user_info_cache = _lookup_user_info(ids_to_lookup)
        _inject_system_user_values(
            data, output_fields, _system_user_fields,
            str(created_by_id) if created_by_id else None,
            str(updated_by_id) if updated_by_id else None,
            _user_info_cache, field_key_type,
        )

    # 注入 created_time / last_modified_time 系统时间戳字段值到 data
    if _system_ts_fields is None:
        _system_ts_fields = _find_system_timestamp_fields(table_id)
    if _system_ts_fields:
        _inject_system_timestamp_values(
            data, output_fields, _system_ts_fields,
            created_at, updated_at, field_key_type,
        )

    result: Dict[str, Any] = {
        "id": record_id,
        "row_id": record_id,
        "table_id": str(table_id),
        "data": data,
        "fields": output_fields,
        "order": record_order,
        "version": record_version,
        "status": "active",
        "tags": [],
        "created_by_id": str(created_by_id) if created_by_id else None,
        "updated_by_id": str(updated_by_id) if updated_by_id else None,
        "created_at": _serialize_datetime(created_at),
        "updated_at": _serialize_datetime(updated_at),
    }

    return result


def serialize_native_rows(
    rows: List[Dict[str, Any]],
    table_id: UUID,
    fields: List[TableField],
    *,
    field_key_type: RecordFieldKeyType = 'name',
) -> List[Dict[str, Any]]:
    """
    批量序列化原生 SQL 查询结果。

    Args:
        rows: 原生行 dict 列表
        table_id: 表 ID
        fields: 表字段对象列表
        field_key_type: 输出 key 类型

    Returns:
        序列化后的记录列表
    """
    # 预查询系统用户字段，批量收集 user ID
    system_user_fields = _find_system_user_fields(table_id)
    user_info_cache: Optional[Dict[str, Dict[str, Any]]] = None
    if system_user_fields:
        user_ids: Set[str] = set()
        for row in rows:
            cb = row.get('__created_by')
            ub = row.get('__updated_by')
            if cb:
                user_ids.add(str(cb))
            if ub:
                user_ids.add(str(ub))
        user_info_cache = _lookup_user_info(user_ids)

    # 预查询系统时间戳字段
    system_ts_fields = _find_system_timestamp_fields(table_id)

    return [
        serialize_native_row(
            row, table_id, fields,
            field_key_type=field_key_type,
            _system_user_fields=system_user_fields,
            _user_info_cache=user_info_cache,
            _system_ts_fields=system_ts_fields,
        )
        for row in rows
    ]


def build_record_data_field_names(
    fields_set: Set[str],
    *,
    all_fields: Optional[List[TableField]] = None,
    field_key_type: RecordFieldKeyType = 'name',
) -> Set[str]:
    """把按 ``field_key_type`` 给出的可见字段 key 集合映射为「字段名集合」。

    序列化记录的 ``data`` 固定按字段名输出（兼容旧协议），而 ``fields_set`` 在
    ``field_key_type='id'/'dbFieldName'`` 时是 id / dbFieldName key——直接用它过滤
    ``data`` 会把名称 key 全部清空（GitHub  根因）。本函数借 ``all_fields``
    把 key 映射回字段名，使 ``data`` 能按名过滤。``field_key_type='name'`` 时原样返回。
    """
    if field_key_type == 'name' or not all_fields:
        return fields_set
    if field_key_type == 'id':
        key_to_name = {str(f.id): f.name for f in all_fields}
    else:  # dbFieldName
        key_to_name = {
            str((f.config or {}).get('db_field_name') or f.name): f.name
            for f in all_fields
        }
    return {key_to_name.get(k, k) for k in fields_set}


def filter_native_record_fields(
    records: List[Dict[str, Any]],
    fields_set: Set[str],
    *,
    all_fields: Optional[List[TableField]] = None,
    field_key_type: RecordFieldKeyType = 'name',
    data_fields_set: Optional[Set[str]] = None,
) -> List[Dict[str, Any]]:
    """过滤序列化后的记录，仅保留指定字段。

    ``fields_set`` 按 ``field_key_type`` 给出可见字段的 key（id / name / dbFieldName）。
    序列化记录里 ``fields`` 与 ``fields_set`` 同 key 空间，可直接过滤；
    但 ``data`` 固定按字段名输出（兼容旧协议），当 ``field_key_type != 'name'``
    时若仍用 ``fields_set`` 过滤，名称 key 不在 id/dbFieldName 集合内会被整体清空
    ——这正是「编辑记录对话框为空」(GitHub ) 的根因。

    因此 ``data`` 必须用字段名集合过滤：``data_fields_set`` 显式给出时直接用
    （调用方已有字段名映射，如 ``visible_fields``），否则借 ``all_fields`` 由
    ``build_record_data_field_names`` 推导。
    """
    if data_fields_set is None:
        data_fields_set = build_record_data_field_names(
            fields_set, all_fields=all_fields, field_key_type=field_key_type,
        )

    for record in records:
        data = record.get('data')
        if data:
            record['data'] = {k: v for k, v in data.items() if k in data_fields_set}
        output_fields = record.get('fields')
        if output_fields:
            record['fields'] = {k: v for k, v in output_fields.items() if k in fields_set}
    return records

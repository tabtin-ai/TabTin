import json
import logging
import re
from typing import Optional, List
from uuid import UUID

from django.db import connections, transaction
from django.db.utils import OperationalError, ProgrammingError
from django.http import HttpRequest, HttpResponse, JsonResponse

from apps.tabdata.api_helpers import (
    record_version_conflict_response,
    retryable_write_sqlstate,
    success_response,
    write_contention_response,
)
from apps.tabdata.api_open_impl.common import impl_error_handler
from apps.tabdata.api_open_schemas import (
    AggregationBody, BulkCreateBody, BulkDeleteBody, BulkUpdateBody,
    OpenCreateRecordBody, OpenUpdateRecordBody, QueryRecordsBody, UpsertBody,
)
from apps.tabdata.api_utils import (
    normalize_record_field_key_type, parse_int_param,
    _build_valid_field_keys, strip_unknown_fields,
)
from apps.tabdata.constants import DEFAULT_PAGE_SIZE, MAX_BULK_RECORDS, MAX_PAGE_SIZE, TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.native.query_builder import NativeQueryBuilder
from apps.tabdata.services import RecordService
from apps.tabdata.services.rls_service import RLSContext, rls_service
from apps.tabdata.utils.record_serializers import serialize_record, serialize_records
from apps.users.membership.exceptions import MembershipException, QuotaExceededError

logger = logging.getLogger(__name__)

_BATCH_ERR_RE = re.compile(r'^第(\d+)条[：:]\s*(.+)$')


def _structurize_batch_errors(errors: list) -> list:
    """将形如 '第N条: message' 的错误列表转为 [{index, message}]。"""
    result = []
    for err in errors:
        m = _BATCH_ERR_RE.match(err)
        if m:
            result.append({'index': int(m.group(1)) - 1, 'message': m.group(2)})
        else:
            result.append({'index': -1, 'message': err})
    return result


def _resolve_filter_from_request(request: HttpRequest, body: Optional[QueryRecordsBody] = None) -> Optional[dict]:
    """
    从请求体或 query string 解析 filter。

    优先使用 body.filter，如无则尝试解析 ?filter=JSON 参数。
    """
    if body and body.filter:
        return body.filter.dict(exclude_none=True)

    filter_param = request.GET.get('filter')
    if filter_param and filter_param not in ('null', 'undefined', ''):
        try:
            return json.loads(filter_param)
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _resolve_sort_from_request(request: HttpRequest, body: Optional[QueryRecordsBody] = None) -> tuple:
    """
    解析排序参数。

    返回: (sort_by, sort_order)
    - body 模式: 取第一个 sort 条件（后续支持多字段排序在 NativeQueryBuilder 层做）
    - query string: ?sort_by=xxx&sort_order=asc
    """
    if body and body.sort and len(body.sort) > 0:
        first = body.sort[0]
        field_ref = first.field_id or first.field
        return (field_ref, first.order)

    sort_by = request.GET.get('sort_by') or None
    sort_order = request.GET.get('sort_order', 'asc') or 'asc'
    if sort_by in ('null', 'undefined', ''):
        sort_by = None
    return (sort_by, sort_order)


def _execute_record_query(
    *,
    request: HttpRequest,
    table_id: UUID,
    page: int,
    page_size: int,
    search: Optional[str],
    filter_set: Optional[dict],
    sort_by: Optional[str],
    sort_order: str,
    field_key_type: str,
    fields_set: Optional[set],
    since_version: Optional[int] = None,
    only_delta: bool = False,
) -> JsonResponse:
    """统一的记录查询执行逻辑，支持增量同步"""
    try:
        # ETag header 解析（用于 304 判断）
        header_version = request.headers.get('If-None-Match') if hasattr(request, 'headers') else None
        header_version_int = None
        if header_version:
            raw = header_version.strip().strip('"')
            if raw.startswith('W/'):
                raw = raw[2:]
            header_version_int = parse_int_param(raw)

        reference_version_for_query = since_version
        reference_version_for_304 = since_version if since_version is not None else header_version_int

        rls_ctx = RLSContext.from_request(request)

        service = RecordService(user=request.auth)
        result = service.list_records(
            table_id=table_id,
            page=page,
            page_size=page_size,
            search=search,
            filters=filter_set,
            sort_by=sort_by,
            sort_order=sort_order,
            field_key_type=field_key_type,
            since_version=reference_version_for_query,
            only_delta=only_delta,
            rls_context=rls_ctx,
        )

        latest_version = result.get('latest_version', 0)
        has_changes = result.get('has_changes', True)

        # 304 Not Modified 判断
        if reference_version_for_304 is not None and not has_changes:
            response = HttpResponse(status=304)
            response['ETag'] = str(latest_version)
            return response

        records = result.get('records', [])

        # 序列化
        if records and isinstance(records[0], dict):
            serialized_records = records
            if fields_set:
                for rec in serialized_records:
                    if 'fields' in rec:
                        rec['fields'] = {k: v for k, v in rec['fields'].items() if k in fields_set}
                    if 'data' in rec:
                        rec['data'] = {k: v for k, v in rec['data'].items() if k in fields_set}
        else:
            serialized_records = serialize_records(
                records,
                fields=fields_set,
                field_key_type=field_key_type,
            )

        payload = {
            'records': serialized_records,
            'total': result.get('total', 0),
            'matched_total': result.get('matched_total', len(serialized_records)),
            'page': page,
            'page_size': page_size,
            'latest_version': latest_version,
            'delta': bool(only_delta and reference_version_for_query is not None),
            'requires_full_reload': bool(result.get('requires_full_reload', False)),
        }

        response = JsonResponse(success_response(payload), status=200)
        response['ETag'] = str(latest_version)
        return response

    except ValueError as e:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail=str(e)),
            status=400,
        )
    except Exception:
        logger.exception('Open API query_records error')
        return JsonResponse(
            get_error_response(ErrorCode.INTERNAL_ERROR, "查询记录失败，请稍后重试"),
            status=500,
        )


def _execute_upsert(
    *,
    service: RecordService,
    table_id: UUID,
    records_input: list,
    upsert_on: List[str],
    field_key_type: str,
    rls_context=None,
) -> dict:
    """
    Upsert 核心逻辑：按 upsert_on 字段值查重，存在更新，不存在创建。

    采用 Service 层"查询 + 判断 + 写入"事务方式（而非 SQL ON CONFLICT），
    因为 upsert_on 是业务字段不是主键。
    """
    field_key_type = normalize_record_field_key_type(field_key_type)

    # 1. 加载字段映射
    fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
    name_map, id_map, db_map = RecordService._build_field_input_maps(fields)

    def resolve_field(key: str):
        """通过名称/ID/db_field_name 解析到 TableField"""
        return name_map.get(key) or id_map.get(key) or db_map.get(key)

    # 解析 upsert_on 对应的 TableField 对象
    upsert_fields = []
    for key in upsert_on:
        f = resolve_field(key)
        if f is None:
            raise ValueError(f'upsert_on 字段 "{key}" 不存在')
        upsert_fields.append(f)

    # 2. 构建已有记录的索引 — 原生 SQL 只查 upsert 字段 + __id
    try:
        table_obj = Table.objects.using(TABDATA_DB_ALIAS).get(pk=table_id, trashed_at__isnull=True)
    except Table.DoesNotExist:
        raise ValueError(f'表格 {table_id} 不存在')

    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    qb = NativeQueryBuilder(resolve_schema_partition_id(table_obj), table_id, fields)
    upsert_col_refs = []
    for uf in upsert_fields:
        col_ref = qb._resolve_column_ref(str(uf.id))
        if col_ref:
            upsert_col_refs.append((uf, col_ref))

    if not upsert_col_refs:
        raise ValueError('upsert_on 字段无法解析为原生列')

    select_cols = ['"__id"'] + [ref for _, ref in upsert_col_refs]
    sql = f'SELECT {", ".join(select_cols)} FROM {qb.qualified_name}'

    existing_index: dict[tuple, str] = {}
    with connections['postgresql'].cursor() as cursor:
        cursor.execute(sql)
        col_names = [desc[0] for desc in cursor.description]
        for row in cursor:
            row_dict = dict(zip(col_names, row))
            rid = str(row_dict.get('__id', ''))
            vals = []
            for uf, col_ref in upsert_col_refs:
                val = row_dict.get(col_ref.strip('"'))
                if isinstance(val, list):
                    val = tuple(val)
                elif isinstance(val, dict):
                    val = json.dumps(val, sort_keys=True, ensure_ascii=False)
                vals.append(val)
            if rid:
                existing_index[tuple(vals)] = rid

    # 3. 分拣：创建 vs 更新
    to_create = []
    to_update = []  # [(record_id, fields_data)]

    for rec_data in records_input:
        # 提取 upsert_on 字段值（输入格式可能是 name/id/dbFieldName）
        vals = []
        for uf in upsert_fields:
            val = rec_data.get(uf.name)
            if val is None:
                val = rec_data.get(str(uf.id))
            if val is None:
                val = rec_data.get(RecordService._field_db_key(uf) or '')
            if isinstance(val, list):
                val = tuple(val)
            elif isinstance(val, dict):
                val = json.dumps(val, sort_keys=True, ensure_ascii=False)
            vals.append(val)

        match_key = tuple(vals)
        existing_record_id = existing_index.get(match_key)

        if existing_record_id:
            to_update.append((existing_record_id, rec_data))
        else:
            to_create.append(rec_data)

    # 4. 执行
    created_count = 0
    updated_count = 0
    errors = []

    with transaction.atomic(using=TABDATA_DB_ALIAS):
        # 批量创建
        if to_create:
            created_records, create_errors = service.bulk_create_records(
                table_id=table_id,
                records_data=to_create,
                rls_context=rls_context,
            )
            created_count = len(created_records)
            errors.extend(create_errors or [])

        if to_update:
            update_entries = [
                {"record_id": record_id, "data": fields_data}
                for record_id, fields_data in to_update
            ]
            updated_records, update_errors = service.bulk_update_records(
                record_updates=update_entries,
                rls_context=rls_context,
            )
            updated_count = len(updated_records)
            errors.extend(update_errors or [])

    return {
        'created_count': created_count,
        'updated_count': updated_count,
        'errors': errors if errors else None,
    }


def query_records_get_impl(request: HttpRequest, table_id: UUID):
    page = parse_int_param(request.GET.get('page')) or 1
    page_size = min(parse_int_param(request.GET.get('page_size')) or DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    search = request.GET.get('search')
    if search in ('null', 'undefined', ''):
        search = None

    sort_by, sort_order = _resolve_sort_from_request(request)
    filter_set = _resolve_filter_from_request(request)

    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType') or 'name'
    )

    fields_param = request.GET.get('fields')
    fields_set = None
    if fields_param and fields_param not in ('null', 'undefined'):
        fields_set = {f.strip() for f in fields_param.split(',') if f.strip()}

    since_version = parse_int_param(request.GET.get('since_version'))
    only_delta = (request.GET.get('only_delta', 'false') or 'false').lower() in ('true', '1', 'yes')

    return _execute_record_query(
        request=request,
        table_id=table_id,
        page=page,
        page_size=page_size,
        search=search,
        filter_set=filter_set,
        sort_by=sort_by,
        sort_order=sort_order,
        field_key_type=field_key_type,
        fields_set=fields_set,
        since_version=since_version,
        only_delta=only_delta,
    )


def query_records_post_impl(request: HttpRequest, table_id: UUID, body: QueryRecordsBody):
    sort_by, sort_order = _resolve_sort_from_request(request, body)
    filter_set = _resolve_filter_from_request(request, body)

    field_key_type = normalize_record_field_key_type(body.field_key_type)

    fields_set = set(body.fields) if body.fields else None

    return _execute_record_query(
        request=request,
        table_id=table_id,
        page=body.page,
        page_size=body.page_size,
        search=body.search,
        filter_set=filter_set,
        sort_by=sort_by,
        sort_order=sort_order,
        field_key_type=field_key_type,
        fields_set=fields_set,
        since_version=body.since_version,
        only_delta=body.only_delta,
    )


def aggregate_records_impl(request: HttpRequest, table_id: UUID, body: AggregationBody):
    try:
        table = Table.objects.using(TABDATA_DB_ALIAS).get(pk=table_id, trashed_at__isnull=True)
    except Table.DoesNotExist:
        return JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, "表格不存在"),
            status=404,
        )

    all_fields = list(
        TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, is_deleted=False,
        )
    )
    if not all_fields:
        return JsonResponse(
            success_response(data={'results': {}, 'total_records': 0}),
            status=200,
        )

    field_key_type = normalize_record_field_key_type(body.field_key_type)

    # 构建字段名 → field_id 映射（用于按 name 引用时的解析）
    name_to_field = {}
    id_to_field = {}
    for f in all_fields:
        name_to_field[f.name] = f
        id_to_field[str(f.id)] = f

    # 解析 aggregation items → {field_ref: func_name}
    aggregations = {}
    for item in body.aggregations:
        func = item.function

        if item.field_id:
            field_ref = item.field_id
        elif item.field:
            if field_key_type == 'id':
                field_ref = item.field
            else:
                resolved = name_to_field.get(item.field)
                if not resolved:
                    return JsonResponse(
                        get_error_response(
                            ErrorCode.FIELD_NOT_FOUND,
                            f"字段 '{item.field}' 不存在",
                        ),
                        status=400,
                    )
                field_ref = str(resolved.id)
        else:
            # count 不需要字段
            if func == 'count':
                field_ref = '__count__'
            else:
                return JsonResponse(
                    get_error_response(
                        ErrorCode.VALIDATION_ERROR,
                        f"聚合函数 '{func}' 需要指定字段",
                    ),
                    status=400,
                )

        aggregations[field_ref] = func

    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
    qb = NativeQueryBuilder(resolve_schema_partition_id(table), table_id, all_fields)

    # 构建 WHERE 条件
    filter_set = body.filter.dict() if body.filter else None
    where_sql = 'TRUE'
    where_params = []
    if filter_set:
        where = qb.build_where_clause(filter_set)
        if where:
            where_sql, where_params = where

    rls_ctx = RLSContext.from_request(request)
    if table.rls_enabled:
        should_apply = rls_ctx.is_token_auth if not table.rls_force else True
        if should_apply:
            rls_where = rls_service.build_rls_where(
                table_id=table_id,
                operation='SELECT',
                context=rls_ctx,
                query_builder=qb,
            )
            if rls_where:
                rls_sql, rls_params = rls_where
                if where_sql == 'TRUE':
                    where_sql = rls_sql
                    where_params = rls_params
                else:
                    where_sql = f"({where_sql}) AND ({rls_sql})"
                    where_params = where_params + rls_params

    # 构建聚合 SQL（WHERE 通过参数传入，避免调用方字符串拼接）
    agg_where = (where_sql, where_params) if where_sql != 'TRUE' else None
    agg_sql, agg_params = qb.build_aggregate_sql(aggregations, where=agg_where)

    # 执行查询
    with connections['postgresql'].cursor() as cursor:
        cursor.execute(agg_sql, agg_params)
        columns = [col[0] for col in cursor.description]
        row = cursor.fetchone()

    # 构建结果
    results = {}
    if row:
        for col_name, value in zip(columns, row):
            # 将数据库列别名解析回可读 key
            if value is not None:
                # 处理 Decimal 等类型
                if hasattr(value, '__float__'):
                    value = float(value)
            results[col_name] = value

    # 获取总记录数
    count_sql = f"SELECT COUNT(*) FROM {qb.qualified_name}"
    if where_sql != 'TRUE':
        count_sql = f"{count_sql} WHERE {where_sql}"

    with connections['postgresql'].cursor() as cursor:
        cursor.execute(count_sql, where_params)
        total_records = cursor.fetchone()[0]

    return JsonResponse(
        success_response(data={
            'results': results,
            'total_records': total_records,
        }),
        status=200,
    )


@impl_error_handler('Upsert')
def upsert_records_impl(request: HttpRequest, table_id: UUID, body: UpsertBody):
    if not body.upsert_on:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail='upsert_on 不能为空'),
            status=400,
        )

    records_input = []
    for item in body.records[:MAX_BULK_RECORDS]:
        if isinstance(item, dict) and 'fields' in item:
            records_input.append(item['fields'])
        elif isinstance(item, dict):
            records_input.append(item)

    if not records_input:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail='records 不能为空'),
            status=400,
        )

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    result = _execute_upsert(
        service=service,
        table_id=table_id,
        records_input=records_input,
        upsert_on=body.upsert_on,
        field_key_type=body.field_key_type,
        rls_context=rls_ctx,
    )

    return JsonResponse(
        success_response(data=result),
        status=200,
    )


@impl_error_handler('记录创建')
def create_record_impl(request: HttpRequest, table_id: UUID, body: OpenCreateRecordBody):
    field_key_type = normalize_record_field_key_type(body.field_key_type)
    fields_data = body.fields

    valid_keys = _build_valid_field_keys(table_id)
    original_fields = fields_data or {}
    fields_data, unknown_keys = strip_unknown_fields(fields_data, valid_keys)

    # 非空输入被全部剥离后，不得静默建成空行
    if original_fields and not fields_data:
        unknown_preview = ', '.join(unknown_keys[:10])
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail=(
                    f"无有效字段匹配（输入 key 均不在表字段中）。"
                    f"未知: {unknown_preview}"
                ),
            ),
            status=400,
        )

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    result = service.create_record(
        table_id=table_id,
        data=fields_data,
        rls_context=rls_ctx,
    )

    record, error_msg = result
    if error_msg:
        return JsonResponse(get_error_response(ErrorCode.VALIDATION_ERROR, detail=error_msg), status=400)

    resp_data = serialize_record(record, field_key_type=field_key_type)
    warnings = [f'未知字段已忽略: {k}' for k in unknown_keys]
    if warnings:
        resp_data['warnings'] = warnings

    return JsonResponse(
        success_response(data=resp_data, message='记录创建成功'),
        status=201,
    )


@impl_error_handler('批量创建')
def batch_create_records_impl(request: HttpRequest, table_id: UUID, body: BulkCreateBody):
    if not body.records:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail='records 数组不能为空'),
            status=400,
        )

    valid_keys = _build_valid_field_keys(table_id)
    all_unknown: List[str] = []

    records_data = []
    record_ids: list = []
    for item in body.records[:MAX_BULK_RECORDS]:
        if isinstance(item, dict) and 'fields' in item:
            raw_fields = item['fields'] if isinstance(item['fields'], dict) else {}
            cleaned, unknown = strip_unknown_fields(raw_fields, valid_keys)
            # 全部未命中时把原始字段交给校验层失败，避免 strip 成 {} 后静默建空行
            records_data.append(raw_fields if (raw_fields and not cleaned) else cleaned)
            record_ids.append(item.get('id'))
            if cleaned:
                all_unknown.extend(unknown)
        elif isinstance(item, dict):
            flat_id = item.get('id')
            fields_only = {k: v for k, v in item.items() if k != 'id'}
            cleaned, unknown = strip_unknown_fields(fields_only, valid_keys)
            records_data.append(fields_only if (fields_only and not cleaned) else cleaned)
            record_ids.append(flat_id)
            if cleaned:
                all_unknown.extend(unknown)

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    created_records, errors = service.bulk_create_records(
        table_id=table_id,
        records_data=records_data,
        record_ids=record_ids,
        field_key_type=body.field_key_type,
        rls_context=rls_ctx,
    )

    field_key_type = normalize_record_field_key_type(body.field_key_type)
    try:
        serialized = serialize_records(created_records, field_key_type=field_key_type)
    except Exception as exc:
        logger.error(
            "bulk_create_records serialize_records failed: %s", exc, exc_info=True,
        )
        serialized = [
            {'id': str(getattr(r, 'id', '')), '_serialization_error': True}
            for r in created_records
        ]

    resp_data = {
        'created_count': len(created_records),
        'records': serialized,
        'errors': errors,
    }

    unique_unknown = sorted(set(all_unknown))
    if unique_unknown:
        resp_data['warnings'] = [f'未知字段已忽略: {k}' for k in unique_unknown]

    return JsonResponse(success_response(data=resp_data), status=201)


@impl_error_handler('批量更新')
def batch_update_records_impl(request: HttpRequest, table_id: UUID, body: BulkUpdateBody):
    updates = []
    for item in body.records[:MAX_BULK_RECORDS]:
        if isinstance(item, dict) and 'id' in item and 'fields' in item:
            updates.append({
                'record_id': item['id'],
                'data': item['fields'],
            })

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    updated_records, errors = service.bulk_update_records(
        record_updates=updates,
        rls_context=rls_ctx,
    )

    field_key_type = normalize_record_field_key_type(body.field_key_type)
    try:
        serialized = serialize_records(updated_records, field_key_type=field_key_type)
    except Exception as exc:
        logger.error(
            "batch_update_records serialize_records failed: %s", exc, exc_info=True,
        )
        serialized = [
            {'id': str(getattr(r, 'id', '')), '_serialization_error': True}
            for r in updated_records
        ]

    return JsonResponse(
        success_response(data={
            'updated_count': len(updated_records),
            'records': serialized,
            'errors': errors,
        }),
        status=200,
    )


@impl_error_handler('批量删除')
def batch_delete_records_impl(request: HttpRequest, table_id: UUID, body: BulkDeleteBody):
    try:
        raw_ids = [UUID(rid) for rid in body.record_ids[:MAX_BULK_RECORDS]]
        valid_ids = set(
            TableRecord.objects.using(TABDATA_DB_ALIAS)
            .filter(id__in=raw_ids, table_id=table_id, is_deleted=False)
            .values_list('id', flat=True)
        )
        filtered_ids = [rid for rid in raw_ids if rid in valid_ids]

        rls_ctx = RLSContext.from_request(request)

        service = RecordService(user=request.auth)
        deleted_count, errors, deleted_record_ids, failed_record_ids = service.bulk_delete_records(
            record_ids=filtered_ids,
            rls_context=rls_ctx,
        )
        return JsonResponse(
            success_response(data={
                'deleted_count': deleted_count,
                'deleted_record_ids': deleted_record_ids,
                'failed_record_ids': failed_record_ids,
                'errors': errors,
            }),
            status=200,
        )
    except (ProgrammingError, OperationalError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            'Open API batch delete write contention (sqlstate=%s)',
            sqlstate,
        )
        return write_contention_response()


@impl_error_handler('记录更新')
def update_record_impl(request: HttpRequest, table_id: UUID, record_id: UUID, body: OpenUpdateRecordBody):
    field_key_type = normalize_record_field_key_type(body.field_key_type)
    fields_data = body.fields

    # 校验 record 归属于 table_id，防止越表修改
    if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        id=record_id, table_id=table_id, is_deleted=False,
    ).exists():
        return JsonResponse(get_error_response(ErrorCode.NOT_FOUND, '记录不存在或不属于该表'), status=404)

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    result = service.update_record(
        record_id=record_id,
        data=fields_data,
        rls_context=rls_ctx,
    )

    record, error_msg = result
    if error_msg:
        return JsonResponse(get_error_response(ErrorCode.VALIDATION_ERROR, detail=error_msg), status=400)
    if record is None:
        # 与内部 API 保持同一旧客户端兼容 envelope，禁止 serialize_record(None)。
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail="该记录已被其他协作者删除，您刚才的修改未保存",
            ),
            status=400,
        )

    return JsonResponse(
        success_response(
            data=serialize_record(record, field_key_type=field_key_type),
        ),
        status=200,
    )


@impl_error_handler('记录详情')
def get_record_impl(request: HttpRequest, table_id: UUID, record_id: UUID):
    # 校验 record 归属于 table_id，防止越表读取
    if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        id=record_id, table_id=table_id, is_deleted=False,
    ).exists():
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, '记录不存在或不属于该表'),
            status=404,
        )

    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType') or 'name'
    )

    fields_param = request.GET.get('fields')
    fields_set = None
    if fields_param and fields_param not in ('null', 'undefined'):
        fields_set = {f.strip() for f in fields_param.split(',') if f.strip()}

    rls_ctx = RLSContext.from_request(request)

    from apps.tabdata.exceptions import RLSAccessDenied

    service = RecordService(user=request.auth)
    try:
        record_data = service.get_record_data(
            record_id=record_id,
            field_key_type=field_key_type,
            rls_context=rls_ctx,
        )
    except RLSAccessDenied:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, '行级安全策略限制了对此记录的访问'),
            status=403,
        )
    if record_data is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, '记录不存在'),
            status=404,
        )

    if fields_set and isinstance(record_data, dict):
        if 'fields' in record_data:
            record_data['fields'] = {k: v for k, v in record_data['fields'].items() if k in fields_set}
        if 'data' in record_data:
            record_data['data'] = {k: v for k, v in record_data['data'].items() if k in fields_set}

    return JsonResponse(
        success_response(data=record_data),
        status=200,
    )


@impl_error_handler('记录删除')
def delete_record_impl(request: HttpRequest, table_id: UUID, record_id: UUID):
    if not TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        id=record_id, table_id=table_id, is_deleted=False,
    ).exists():
        return JsonResponse(get_error_response(ErrorCode.NOT_FOUND, '记录不存在或不属于该表'), status=404)

    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    try:
        deleted = service.delete_record(record_id=record_id, rls_context=rls_ctx)
    except RecordVersionConflictError as exc:
        logger.warning(
            'Open API record delete version conflict: record=%s expected=%s',
            exc.record_id,
            exc.expected_version,
        )
        return record_version_conflict_response()
    except (ProgrammingError, OperationalError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            'Open API record delete write contention (sqlstate=%s)',
            sqlstate,
        )
        return write_contention_response()
    if not deleted:
        return JsonResponse(get_error_response(ErrorCode.NOT_FOUND, '记录不存在'), status=404)
    return JsonResponse(success_response(message='删除成功'), status=200)

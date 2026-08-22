from typing import Optional, List
from uuid import UUID

from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.api_table import _batch_compute_roles_safe, _compute_user_table_role_safe
from apps.tabdata.auth_open_api import JWT_DEFAULT_RATE_LIMIT, RATE_LIMIT_WINDOW, TOKEN_PREFIX
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.models import Table
from apps.tabdata.schemas import TableOut
from apps.tabdata.services import TableService
from apps.tabdata.api_open_impl.common import (
    _OPEN_API_SCOPE_REFERENCE,
    _organization_data_base_path,
    _space_data_base_path,
    _build_endpoint_entry,
    _filter_tables_for_token,
    impl_error_handler,
)


def _resolve_table_open_api_base_path(
    table,
    space_id: Optional[UUID] = None,
) -> Optional[str]:
    """解析表级 Open API 的 base path。

    ：优先显式 space_id → table.space_id → organization 路径。
    """
    if space_id is not None:
        return _space_data_base_path(space_id)
    if getattr(table, 'space_id', None):
        return _space_data_base_path(table.space_id)
    if getattr(table, 'organization_id', None):
        return _organization_data_base_path(table.organization_id)
    return None


def _coerce_open_api_base_path(
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> str:
    if base_path:
        return base_path
    if space_id is None:
        raise ValueError('space_id 或 base_path 必须提供其一')
    return _space_data_base_path(space_id)


def _build_record_api_endpoints(
    table_id: UUID,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> dict:
    table_path = f'{_coerce_open_api_base_path(space_id, base_path=base_path)}/tables/{table_id}'
    return {
        'list_records': _build_endpoint_entry(
            method='GET',
            path=f'{table_path}/records',
            description='查询记录（支持 filter/sort/search）',
            operation_id='listRecords',
            group='records',
            required_scopes=['record:read'],
            supports_etag=True,
        ),
        'get_record': _build_endpoint_entry(
            method='GET',
            path=f'{table_path}/records/{{record_id}}',
            description='获取单条记录详情',
            operation_id='getRecord',
            group='records',
            required_scopes=['record:read'],
        ),
        'query_records': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records/query',
            description='结构化查询记录（复杂过滤条件）',
            operation_id='queryRecords',
            group='records',
            required_scopes=['record:read'],
        ),
        'create_record': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records',
            description='创建单条记录',
            operation_id='createRecord',
            group='records',
            required_scopes=['record:create'],
            supports_idempotency=True,
        ),
        'upsert_records': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records/upsert',
            description='按业务字段 Upsert，存在则更新，不存在则创建',
            operation_id='upsertRecords',
            group='records',
            required_scopes=['record:create'],
            supports_idempotency=True,
        ),
        'update_record': _build_endpoint_entry(
            method='PATCH',
            path=f'{table_path}/records/{{record_id}}',
            description='更新单条记录',
            operation_id='updateRecord',
            group='records',
            required_scopes=['record:update'],
            supports_idempotency=True,
        ),
        'delete_record': _build_endpoint_entry(
            method='DELETE',
            path=f'{table_path}/records/{{record_id}}',
            description='删除单条记录',
            operation_id='deleteRecord',
            group='records',
            required_scopes=['record:delete'],
            supports_idempotency=True,
        ),
        'batch_create': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records/batch-create',
            description='批量创建记录',
            operation_id='batchCreateRecords',
            group='records',
            required_scopes=['record:create'],
            supports_idempotency=True,
        ),
        'batch_update': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records/batch-update',
            description='批量更新记录',
            operation_id='batchUpdateRecords',
            group='records',
            required_scopes=['record:update'],
            supports_idempotency=True,
        ),
        'batch_delete': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/records/batch-delete',
            description='批量删除记录',
            operation_id='batchDeleteRecords',
            group='records',
            required_scopes=['record:delete'],
            supports_idempotency=True,
        ),
    }


def _build_exchange_api_endpoints(
    table_id: UUID,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> dict:
    table_path = f'{_coerce_open_api_base_path(space_id, base_path=base_path)}/tables/{table_id}'
    return {
        'import_template': _build_endpoint_entry(
            method='GET',
            path=f'{table_path}/import/template',
            description='下载导入模板，让外部系统先对齐字段 contract',
            operation_id='downloadImportTemplate',
            group='imports',
            required_scopes=['import:write', 'table:read'],
        ),
        'import_preview': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/import/preview',
            description='预览 CSV / JSON / Excel 的字段映射、样例数据和验证问题',
            operation_id='previewImport',
            group='imports',
            required_scopes=['import:write'],
        ),
        'import_csv': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/import/csv',
            description='导入 CSV 文本内容',
            operation_id='importCsv',
            group='imports',
            required_scopes=['import:write'],
            supports_idempotency=True,
        ),
        'import_json': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/import/json',
            description='导入对象数组 / structured / table_full JSON',
            operation_id='importJson',
            group='imports',
            required_scopes=['import:write'],
            supports_idempotency=True,
        ),
        'import_excel': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/import/excel',
            description='通过 base64 传输 Excel 文件并导入',
            operation_id='importExcel',
            group='imports',
            required_scopes=['import:write'],
            supports_idempotency=True,
        ),
        'export_csv': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/export/csv',
            description='按视图或记录范围导出 CSV',
            operation_id='exportCsv',
            group='exports',
            required_scopes=['export:read'],
        ),
        'export_json': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/export/json',
            description='导出 array / structured / table_full JSON',
            operation_id='exportJson',
            group='exports',
            required_scopes=['export:read'],
        ),
        'export_excel': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/export/excel',
            description='导出 Excel 文件',
            operation_id='exportExcel',
            group='exports',
            required_scopes=['export:read'],
        ),
        'export_pdf': _build_endpoint_entry(
            method='POST',
            path=f'{table_path}/export/pdf',
            description='导出 PDF 快照',
            operation_id='exportPdf',
            group='exports',
            required_scopes=['export:read'],
        ),
    }


def _normalize_openapi_path(
    path: str,
    table_id: UUID,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> str:
    base = _coerce_open_api_base_path(space_id, base_path=base_path)
    concrete_table_path = f'/tables/{table_id}'
    return path.replace(base, '', 1).replace(
        concrete_table_path,
        '/tables/{table_id}',
        1,
    )


def _build_openapi_path_parameters(normalized_path: str, table_id: UUID) -> list[dict[str, object]]:
    """从已标准化的 OpenAPI 路径中提取 path parameters。"""
    parameters: list[dict[str, object]] = []
    if '{table_id}' in normalized_path:
        parameters.append({
            'name': 'table_id',
            'in': 'path',
            'required': True,
            'description': '目标表 ID。此文档默认面向当前表。',
            'schema': {
                'type': 'string',
                'format': 'uuid',
                'default': str(table_id),
            },
        })
    if '{record_id}' in normalized_path:
        parameters.append({
            'name': 'record_id',
            'in': 'path',
            'required': True,
            'description': '目标记录 ID。',
            'schema': {
                'type': 'string',
                'format': 'uuid',
            },
        })
    return parameters


def _build_openapi_success_response(endpoint: dict[str, object]) -> tuple[str, dict[str, object]]:
    path = str(endpoint['path'])
    operation_id = str(endpoint['operation_id'])

    if path.endswith('/import/template'):
        return '200', {
            'description': 'CSV 导入模板',
            'content': {
                'text/csv': {
                    'schema': {'type': 'string'},
                }
            },
        }
    if path.endswith('/export/csv'):
        return '200', {
            'description': 'CSV 导出文件',
            'content': {
                'text/csv': {
                    'schema': {'type': 'string'},
                }
            },
        }
    if path.endswith('/export/json'):
        return '200', {
            'description': 'JSON 导出文件',
            'content': {
                'application/json': {
                    'schema': {
                        'type': 'object',
                        'additionalProperties': True,
                    },
                }
            },
        }
    if path.endswith('/export/excel'):
        return '200', {
            'description': 'Excel 导出文件',
            'content': {
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                    'schema': {
                        'type': 'string',
                        'format': 'binary',
                    },
                }
            },
        }
    if path.endswith('/export/pdf'):
        return '200', {
            'description': 'PDF 导出文件',
            'content': {
                'application/pdf': {
                    'schema': {
                        'type': 'string',
                        'format': 'binary',
                    },
                }
            },
        }

    success_status = '201' if operation_id in {'createRecord', 'batchCreateRecords'} else '200'
    return success_status, {
        'description': '成功响应',
        'content': {
            'application/json': {
                'schema': {
                    '$ref': '#/components/schemas/SuccessEnvelope',
                },
            }
        },
    }


def _build_openapi_request_body(endpoint: dict[str, object]) -> Optional[dict[str, object]]:
    method = str(endpoint['method']).upper()
    if method not in {'POST', 'PATCH'}:
        return None

    description = str(endpoint['description'])
    return {
        'required': method == 'PATCH' or '导出' not in description,
        'content': {
            'application/json': {
                'schema': {
                    'type': 'object',
                    'additionalProperties': True,
                }
            }
        },
    }


def _build_openapi_operation(
    endpoint: dict[str, object],
    table_id: UUID,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> dict[str, object]:
    success_status, success_response = _build_openapi_success_response(endpoint)
    normalized_path = _normalize_openapi_path(
        str(endpoint['path']), table_id, space_id, base_path=base_path,
    )
    operation: dict[str, object] = {
        'tags': [str(endpoint['group'])],
        'operationId': str(endpoint['operation_id']),
        'summary': str(endpoint['description']),
        'description': str(endpoint['description']),
        'security': [{'BearerAuth': []}],
        'parameters': _build_openapi_path_parameters(normalized_path, table_id),
        'responses': {
            success_status: success_response,
            '400': {
                'description': '请求参数错误',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
            '401': {
                'description': '未认证',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
            '403': {
                'description': '无权限或 scope 不足',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
            '404': {
                'description': '资源不存在',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
            '429': {
                'description': '触发限流',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
            '500': {
                'description': '服务内部错误',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            },
        },
        'x-tabtin-required-scopes': endpoint.get('required_scopes', []),
        'x-tabtin-supports-idempotency': endpoint.get('supports_idempotency', False),
        'x-tabtin-supports-etag': endpoint.get('supports_etag', False),
    }
    if str(endpoint.get('operation_id')) == 'deleteRecord':
        responses = operation['responses']
        if isinstance(responses, dict):
            responses.update({
                '409': {
                    'description': '记录版本冲突，需刷新后重试',
                    'content': {
                        'application/json': {
                            'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                        }
                    },
                },
                '503': {
                    'description': '写入繁忙，可按响应提示重试',
                    'content': {
                        'application/json': {
                            'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                        }
                    },
                },
            })
    if str(endpoint.get('operation_id')) == 'batchDeleteRecords':
        responses = operation['responses']
        if isinstance(responses, dict):
            responses['503'] = {
                'description': 'Write contention; retry after the response delay.',
                'content': {
                    'application/json': {
                        'schema': {'$ref': '#/components/schemas/ErrorEnvelope'},
                    }
                },
            }
    request_body = _build_openapi_request_body(endpoint)
    if request_body:
        operation['requestBody'] = request_body
    return operation


def _build_table_openapi_spec(
    table_id: UUID,
    table_name: str,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> dict[str, object]:
    resolved_base = _coerce_open_api_base_path(space_id, base_path=base_path)
    record_endpoints = list(
        _build_record_api_endpoints(table_id, base_path=resolved_base).values()
    )
    exchange_endpoints = list(
        _build_exchange_api_endpoints(table_id, base_path=resolved_base).values()
    )
    paths: dict[str, dict[str, object]] = {}

    for endpoint in [*record_endpoints, *exchange_endpoints]:
        method = str(endpoint['method']).lower()
        normalized_path = _normalize_openapi_path(
            str(endpoint['path']), table_id, base_path=resolved_base,
        )
        path_item = paths.setdefault(normalized_path, {})
        path_item[method] = _build_openapi_operation(
            endpoint, table_id, base_path=resolved_base,
        )

    server_url = resolved_base
    return {
        'openapi': '3.1.0',
        'info': {
            'title': f'TabData Open API · {table_name}',
            'version': '2026-03-07',
            'description': (
                f'面向表 {table_name} ({table_id}) 的 Open API 导出。'
                '适合 Agent、SDK、脚本和外部服务直接对接。'
            ),
        },
        'servers': [
            {
                'url': server_url,
                'description': 'TabData Open API base path',
            }
        ],
        'tags': [
            {'name': 'records', 'description': '记录查询、写入与批量操作'},
            {'name': 'imports', 'description': '导入预览、模板与导入执行'},
            {'name': 'exports', 'description': 'CSV / JSON / Excel / PDF 导出'},
        ],
        'components': {
            'securitySchemes': {
                'BearerAuth': {
                    'type': 'http',
                    'scheme': 'bearer',
                    'bearerFormat': 'API Token or JWT',
                }
            },
            'schemas': {
                'SuccessEnvelope': {
                    'type': 'object',
                    'properties': {
                        'success': {'type': 'boolean'},
                        'message': {'type': 'string'},
                        'data': {
                            'type': 'object',
                            'additionalProperties': True,
                        },
                    },
                },
                'ErrorEnvelope': {
                    'type': 'object',
                    'properties': {
                        'success': {'type': 'boolean'},
                        'message': {'type': 'string'},
                        'code': {'type': 'string'},
                        'error_code': {'type': 'string'},
                        'detail': {'type': 'string'},
                        'data': {
                            'type': 'object',
                            'additionalProperties': True,
                        },
                    },
                },
            },
        },
        'security': [{'BearerAuth': []}],
        'x-tabtin-table-id': str(table_id),
        'x-tabtin-contract-type': 'tabdata_table_open_api',
        'paths': paths,
    }


def _build_table_developer_contract(
    table_id: UUID,
    table_name: str,
    space_id: Optional[UUID] = None,
    *,
    base_path: Optional[str] = None,
) -> dict:
    resolved_base = _coerce_open_api_base_path(space_id, base_path=base_path)
    record_endpoints = list(
        _build_record_api_endpoints(table_id, base_path=resolved_base).values()
    )
    exchange_endpoints = list(
        _build_exchange_api_endpoints(table_id, base_path=resolved_base).values()
    )
    base_path = resolved_base
    return {
        'contract_version': '2026-03-07',
        'contract_type': 'tabdata_table_open_api',
        'table_id': str(table_id),
        'table_name': table_name,
        'base_path': base_path,
        'auth': {
            'header_name': 'Authorization',
            'scheme': 'Bearer',
            'recommended_credential': 'API Token',
            'supported_credentials': ['API Token', 'JWT'],
            'api_token_prefix': TOKEN_PREFIX,
            'recommended_example': f'Bearer {TOKEN_PREFIX}YOUR_TOKEN',
            'jwt_note': '站内登录态和用户 JWT 也可调用，但更适合产品内流程；外部集成建议使用表级 Token。',
        },
        'field_key_types': [
            {
                'value': 'name',
                'recommended': False,
                'description': '易读但不稳定，适合人工调试，不建议作为长期 contract。',
            },
            {
                'value': 'id',
                'recommended': True,
                'description': '字段 UUID，最稳定，适合长期集成与 Agent 自动化。',
            },
            {
                'value': 'dbFieldName',
                'recommended': True,
                'description': '数据库列名，适合 API 与只读 DB 联调。',
            },
        ],
        'headers': [
            {
                'name': 'Authorization',
                'required': True,
                'description': '所有 open/v1 请求都需要 Bearer Token。',
                'applies_to': ['all'],
            },
            {
                'name': 'Idempotency-Key',
                'required': False,
                'description': '写入类请求支持幂等性，24 小时内相同 key 会复用结果。',
                'applies_to': ['record_writes', 'imports'],
            },
            {
                'name': 'If-None-Match',
                'required': False,
                'description': '配合 GET /records 做增量拉取，无变更时返回 304。',
                'applies_to': ['records.get'],
            },
            {
                'name': 'Retry-After',
                'required': False,
                'description': '当触发 429 限流时返回，单位为秒。',
                'applies_to': ['429 responses'],
            },
        ],
        'rate_limit': {
            'window_seconds': RATE_LIMIT_WINDOW,
            'jwt_default_requests_per_window': JWT_DEFAULT_RATE_LIMIT,
            'api_token_default_requests_per_window': 60,
            'api_token_min_requests_per_window': 1,
            'api_token_max_requests_per_window': 600,
            'retry_after_header': 'Retry-After',
        },
        'error_envelope': {
            'success_field': 'success',
            'message_field': 'message',
            'canonical_code_field': 'code',
            'legacy_code_field': 'error_code',
            'note': '推荐新客户端读取 code；error_code 仅作为兼容别名保留。',
        },
        'error_codes': [
            {
                'code': ErrorCode.RATE_LIMIT_EXCEEDED,
                'http_status': 429,
                'description': '请求频率超过 Token 或 JWT 的分钟额度。',
                'retryable': True,
            },
            {
                'code': 'INSUFFICIENT_SCOPE',
                'http_status': 403,
                'description': 'Token 缺少当前端点所需的 scope。',
                'retryable': False,
            },
            {
                'code': 'TABLE_ACCESS_DENIED',
                'http_status': 403,
                'description': 'Token 无权访问当前表。',
                'retryable': False,
            },
            {
                'code': 'SPACE_ACCESS_DENIED',
                'http_status': 403,
                'description': '当前用户或 Token 无权访问所属 Space。',
                'retryable': False,
            },
            {
                'code': ErrorCode.TABLE_NOT_FOUND,
                'http_status': 404,
                'description': '指定表不存在，或已被删除。',
                'retryable': False,
            },
            {
                'code': ErrorCode.VALIDATION_ERROR,
                'http_status': 400,
                'description': '请求体格式、字段键或字段值不合法。',
                'retryable': False,
            },
            {
                'code': ErrorCode.VERSION_CONFLICT,
                'http_status': 409,
                'description': '记录在删除前已发生变化，需刷新后重新确认。',
                'retryable': False,
                'refresh_required': True,
                'applies_to': ['deleteRecord'],
            },
            {
                'code': ErrorCode.SAVE_BUSY,
                'http_status': 503,
                'description': '删除写入遇到短暂锁竞争，可按提示稍后重试。',
                'retryable': True,
                'retry_after_ms': 500,
                'applies_to': ['deleteRecord', 'batchDeleteRecords'],
            },
            {
                'code': ErrorCode.INTERNAL_ERROR,
                'http_status': 500,
                'description': '服务内部异常，可重试或联系支持排查。',
                'retryable': True,
            },
        ],
        'scope_reference': [
            {
                'scope': scope,
                'description': description,
            }
            for scope, description in _OPEN_API_SCOPE_REFERENCE.items()
        ],
        'artifacts': {
            'openapi_json_path': f'{base_path}/tables/{table_id}/openapi.json',
        },
        'endpoint_catalog': {
            'records': record_endpoints,
            'exchange': exchange_endpoints,
        },
        'integration_notes': [
            '业务写入请优先通过 Open API；只读 DB 连接更适合分析、BI 和排查。',
            '长期集成推荐使用字段 id 或 dbFieldName，避免依赖可变的展示名。',
            '需要最小权限接入时，优先创建当前表范围的 Token，并仅授予所需 scopes。',
        ],
    }


@impl_error_handler('表格')
def get_table_impl(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    table = service.get_table(table_id)
    if table is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, "表格不存在"),
            status=404,
        )
    user_role = _compute_user_table_role_safe(request.auth, table)
    table_data = TableOut.from_orm(table, current_user_role=user_role).dict()
    return JsonResponse(
        success_response(data=table_data),
        status=200,
    )


@impl_error_handler('表格列表')
def list_tables_impl(
    request: HttpRequest,
    space_id: Optional[str] = None,
    organization_id: Optional[str] = None,
):
    resolved_space_id = (space_id or request.GET.get('space_id') or '').strip() or None
    resolved_organization_id = (
        organization_id or request.GET.get('organization_id') or ''
    ).strip() or None
    try:
        parsed_space_id = UUID(resolved_space_id) if resolved_space_id else None
    except ValueError:
        return JsonResponse(
            get_error_response(ErrorCode.VALIDATION_ERROR, detail=f'无效的 space_id: {resolved_space_id}'),
            status=400,
        )
    try:
        parsed_organization_id = (
            UUID(resolved_organization_id) if resolved_organization_id else None
        )
    except ValueError:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail=f'无效的 organization_id: {resolved_organization_id}',
            ),
            status=400,
        )
    service = TableService(user=request.auth)
    # space_id 优先（与 TableService.list_tables 一致）；否则走组织列表（含 org-only）
    tables = service.list_tables(
        space_id=parsed_space_id,
        organization_id=None if parsed_space_id else parsed_organization_id,
    )
    tables = _filter_tables_for_token(request, tables)
    role_map = _batch_compute_roles_safe(request.auth, tables)
    serialized = [
        TableOut.from_orm(t, current_user_role=role_map.get(str(t.id))).dict()
        for t in tables
    ]
    return JsonResponse(
        success_response(data={'tables': serialized, 'total': len(serialized)}),
        status=200,
    )


@impl_error_handler('表格')
def open_update_table_impl(request: HttpRequest, table_id: UUID, body):
    service = TableService(user=request.auth)
    table = service.update_table(
        table_id=table_id,
        name=body.name,
        description=body.description,
        icon=body.icon,
    )
    if not table:
        return JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, "表格不存在"),
            status=404,
        )
    user_role = _compute_user_table_role_safe(request.auth, table)
    return JsonResponse(
        success_response(data=TableOut.from_orm(table, current_user_role=user_role).dict()),
        status=200,
    )


@impl_error_handler('表格')
def open_delete_table_impl(request: HttpRequest, table_id: UUID):
    service = TableService(user=request.auth)
    success = service.delete_table(table_id)
    if not success:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, "删除表格失败，权限不足"),
            status=403,
        )
    return JsonResponse(success_response(message="表格已删除"), status=200)


@impl_error_handler('表格 API 信息')
@impl_error_handler('开发者契约')
def get_table_developer_contract_route_impl(request: HttpRequest, table_id: UUID, space_id: Optional[UUID] = None):
    service = TableService(user=request.auth)
    table = service.get_table(table_id)
    if table is None:
        return JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, "表格不存在"),
            status=404,
        )

    resolved_base = _resolve_table_open_api_base_path(table, space_id=space_id)
    if not resolved_base:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail='表格缺少 space_id / organization_id，无法生成开发者契约',
            ),
            status=400,
        )
    return JsonResponse(
        success_response(
            data=_build_table_developer_contract(
                table_id, table.name, base_path=resolved_base,
            ),
        ),
        status=200,
    )


@impl_error_handler('OpenAPI 规范')
def export_table_openapi_spec_route_impl(request: HttpRequest, table_id: UUID, space_id: Optional[UUID] = None):
    service = TableService(user=request.auth)
    table = service.get_table(table_id)
    if table is None:
        return JsonResponse(
            get_error_response(ErrorCode.TABLE_NOT_FOUND, "表格不存在"),
            status=404,
        )

    resolved_base = _resolve_table_open_api_base_path(table, space_id=space_id)
    if not resolved_base:
        return JsonResponse(
            get_error_response(
                ErrorCode.VALIDATION_ERROR,
                detail='表格缺少 space_id / organization_id，无法导出 OpenAPI 规范',
            ),
            status=400,
        )
    return JsonResponse(
        _build_table_openapi_spec(table_id, table.name, base_path=resolved_base),
        status=200,
    )

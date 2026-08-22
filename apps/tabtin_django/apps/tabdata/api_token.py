"""
API Token 管理接口

提供 Token 的 CRUD 操作，供用户在项目设置中管理自己的 API Token。
支持 JWT 和 API Token（需 token:read / token:manage scope）双重认证。
"""

import logging
from datetime import timedelta
from typing import List, Optional
from uuid import UUID

from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router
from pydantic import BaseModel, Field

from apps.tabdata.auth_open_api import open_api_auth, require_scope
from apps.tabdata.api_helpers import success_response, error_response, api_error_handler
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.schemas import ErrorResponse
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models_token import (
    ANALYZE_UNSET,
    TableApiToken,
    TokenTargetValidationError,
    VALID_SCOPES,
    SCOPE_PRESETS,
)

logger = logging.getLogger(__name__)

router = Router(tags=["API Token"])

SCOPE_GROUPS = [
    {
        'key': 'table',
        'label_key': 'apiToken.scopeGroups.table',
        'default_label': '表格',
        'scopes': ['table:read', 'table:create', 'table:update', 'table:delete'],
    },
    {
        'key': 'record',
        'label_key': 'apiToken.scopeGroups.record',
        'default_label': '记录',
        'scopes': ['record:read', 'record:create', 'record:update', 'record:delete'],
    },
    {
        'key': 'field',
        'label_key': 'apiToken.scopeGroups.field',
        'default_label': '字段',
        'scopes': ['field:read', 'field:create', 'field:update', 'field:delete'],
    },
    {
        'key': 'viewAggregation',
        'label_key': 'apiToken.scopeGroups.viewAggregation',
        'default_label': '视图 & 聚合',
        'scopes': ['view:read', 'view:create', 'view:update', 'view:delete', 'aggregation:read'],
    },
    {
        'key': 'dataTransfer',
        'label_key': 'apiToken.scopeGroups.dataTransfer',
        'default_label': '数据传输',
        'scopes': ['import:write', 'export:read'],
    },
    {
        'key': 'sql',
        'label_key': 'apiToken.scopeGroups.sql',
        'default_label': 'SQL',
        'scopes': ['sql:query', 'sql:execute'],
    },
    {
        'key': 'advanced',
        'label_key': 'apiToken.scopeGroups.advanced',
        'default_label': '高级',
        'scopes': [
            'storage:read',
            'storage:write',
            'webhook:manage',
            'db_connection:manage',
            'policy:read',
            'policy:manage',
            'token:read',
            'token:manage',
            'connector:read',
            'connector:manage',
            'analytics:read',
        ],
    },
]

SCOPE_UI_METADATA = {
    'table:read': {'label_key': 'apiToken.scopeLabels.tableRead', 'default_label': '读取表格'},
    'table:create': {'label_key': 'apiToken.scopeLabels.tableCreate', 'default_label': '创建表格'},
    'table:update': {'label_key': 'apiToken.scopeLabels.tableUpdate', 'default_label': '更新表格'},
    'table:delete': {'label_key': 'apiToken.scopeLabels.tableDelete', 'default_label': '删除表格'},
    'record:read': {'label_key': 'apiToken.scopeLabels.recordRead', 'default_label': '读取记录'},
    'record:create': {'label_key': 'apiToken.scopeLabels.recordCreate', 'default_label': '创建记录'},
    'record:update': {'label_key': 'apiToken.scopeLabels.recordUpdate', 'default_label': '更新记录'},
    'record:delete': {'label_key': 'apiToken.scopeLabels.recordDelete', 'default_label': '删除记录'},
    'field:read': {'label_key': 'apiToken.scopeLabels.fieldRead', 'default_label': '读取字段'},
    'field:create': {'label_key': 'apiToken.scopeLabels.fieldCreate', 'default_label': '创建字段'},
    'field:update': {'label_key': 'apiToken.scopeLabels.fieldUpdate', 'default_label': '更新字段'},
    'field:delete': {'label_key': 'apiToken.scopeLabels.fieldDelete', 'default_label': '删除字段'},
    'view:read': {'label_key': 'apiToken.scopeLabels.viewRead', 'default_label': '读取视图'},
    'view:create': {'label_key': 'apiToken.scopeLabels.viewCreate', 'default_label': '创建视图'},
    'view:update': {'label_key': 'apiToken.scopeLabels.viewUpdate', 'default_label': '更新视图'},
    'view:delete': {'label_key': 'apiToken.scopeLabels.viewDelete', 'default_label': '删除视图'},
    'storage:read': {'label_key': 'apiToken.scopeLabels.storageRead', 'default_label': '读取文件与附件'},
    'storage:write': {'label_key': 'apiToken.scopeLabels.storageWrite', 'default_label': '上传与删除文件'},
    'aggregation:read': {'label_key': 'apiToken.scopeLabels.aggregationRead', 'default_label': '聚合查询'},
    'import:write': {'label_key': 'apiToken.scopeLabels.importWrite', 'default_label': '数据导入'},
    'export:read': {'label_key': 'apiToken.scopeLabels.exportRead', 'default_label': '数据导出'},
    'webhook:manage': {'label_key': 'apiToken.scopeLabels.webhookManage', 'default_label': '管理 Webhook'},
    'db_connection:manage': {'label_key': 'apiToken.scopeLabels.dbConnectionManage', 'default_label': '管理数据库连接'},
    'sql:query': {'label_key': 'apiToken.scopeLabels.sqlQuery', 'default_label': 'SQL 只读查询'},
    'sql:execute': {'label_key': 'apiToken.scopeLabels.sqlExecute', 'default_label': 'SQL 写入执行'},
    'policy:read': {'label_key': 'apiToken.scopeLabels.policyRead', 'default_label': '读取策略'},
    'policy:manage': {'label_key': 'apiToken.scopeLabels.policyManage', 'default_label': '管理策略'},
    'token:read': {'label_key': 'apiToken.scopeLabels.tokenRead', 'default_label': '读取 Token'},
    'token:manage': {'label_key': 'apiToken.scopeLabels.tokenManage', 'default_label': '管理 Token'},
    'connector:read': {'label_key': 'apiToken.scopeLabels.connectorRead', 'default_label': '读取连接器'},
    'connector:manage': {'label_key': 'apiToken.scopeLabels.connectorManage', 'default_label': '管理连接器'},
    'analytics:read': {'label_key': 'apiToken.scopeLabels.analyticsRead', 'default_label': '读取分析数据'},
}

SCOPE_PRESET_METADATA = {
    'readonly': {
        'label_key': 'apiToken.scopePresets.readonly.label',
        'default_label': '只读',
        'description_key': 'apiToken.scopePresets.readonly.description',
        'default_description': '仅读取表格、字段、记录、视图与文件，支持 SQL 只读查询',
    },
    'readwrite': {
        'label_key': 'apiToken.scopePresets.readwrite.label',
        'default_label': '读写',
        'description_key': 'apiToken.scopePresets.readwrite.description',
        'default_description': '读写表格、记录与文件，支持导入导出和 SQL',
    },
    'full': {
        'label_key': 'apiToken.scopePresets.full.label',
        'default_label': '完全访问',
        'description_key': 'apiToken.scopePresets.full.description',
        'default_description': '包含全部权限，包括策略、连接器与 Token 管理',
    },
}


# ── Schema ──────────────────────────────────────────────

class CreateTokenRequest(BaseModel):
    """创建 Token 请求"""
    name: str = Field(..., min_length=1, max_length=100, description="Token 名称")
    description: str = Field('', max_length=500, description="描述")
    scopes: List[str] = Field(..., min_length=1, description="权限范围")
    scope_preset: Optional[str] = Field(
        None,
        description="预设权限组: readonly / readwrite / full（优先于 scopes）",
    )
    space_id: Optional[str] = Field(
        None,
        description="Token 归属的 Space ID（Space-first 创建入口必传）",
    )
    space_ids: Optional[List[str]] = Field(None, description="限定 Space ID 列表（权限范围）")
    table_ids: Optional[List[str]] = Field(None, description="限定表格 ID 列表")
    rate_limit: int = Field(60, ge=1, le=600, description="限流（次/分钟）")
    expires_in_days: Optional[int] = Field(
        None,
        ge=1, le=365,
        description="过期天数（null 永不过期）",
    )


class UpdateTokenRequest(BaseModel):
    """更新 Token 请求"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    scopes: Optional[List[str]] = None
    space_ids: Optional[List[str]] = None
    table_ids: Optional[List[str]] = None
    rate_limit: Optional[int] = Field(None, ge=1, le=600)
    is_active: Optional[bool] = None


class ReparentTokenRequest(BaseModel):
    """重挂父 Token 请求"""
    parent_token_id: UUID = Field(..., description="新的父 Token ID")


class TokenResponse(BaseModel):
    """Token 列表项"""
    id: str
    name: str
    description: str
    token_prefix: str  # ttn_{token_id}
    space_id: Optional[str]
    parent_token_id: Optional[str]
    scopes: List[str]
    space_ids: Optional[List[str]]
    table_ids: Optional[List[str]]
    rate_limit: int
    expired_at: Optional[str]
    last_used_at: Optional[str]
    use_count: int
    is_active: bool
    created_at: str


# ── 辅助函数 ──────────────────────────────────────────────

def _serialize_token_state(token: TableApiToken) -> dict:
    """序列化 Token 的核心状态快照。"""
    return {
        'name': token.name,
        'description': token.description,
        'parent_token_id': str(token.parent_token_id) if token.parent_token_id else None,
        'scopes': token.scopes,
        'space_ids': token.space_ids,
        'table_ids': token.table_ids,
        'rate_limit': token.get_effective_rate_limit(),
        'expired_at': token.expired_at.isoformat() if token.expired_at else None,
        'is_active': token.is_active,
    }


def _serialize_token(token: TableApiToken) -> dict:
    """序列化 Token 为响应格式"""
    return {
        'id': str(token.id),
        'token_prefix': f"ttn_{token.token_id}",
        'space_id': str(token.space_id) if token.space_id else None,
        **_serialize_token_state(token),
        'last_used_at': token.last_used_at.isoformat() if token.last_used_at else None,
        'use_count': token.use_count,
        'created_at': token.created_at.isoformat(),
    }


def _serialize_token_ref(token: TableApiToken) -> dict:
    """序列化 Token 的轻量引用，便于 preview/治理结果展示。"""
    return {
        'id': str(token.id),
        **_serialize_token_state(token),
    }


def _serialize_token_ref_from_state(token_id: str, state: dict) -> dict:
    """把模型层返回的状态快照包装成轻量 Token 引用。"""
    return {
        'id': token_id,
        **state,
    }


def _serialize_token_transition(token: TableApiToken, *, previous_is_active: bool) -> dict:
    """序列化治理动作中的前后状态，便于前端直接渲染结果。"""
    after_state = _serialize_token_state(token)
    before_state = {
        **after_state,
        'is_active': previous_is_active,
    }
    return {
        'token': _serialize_token_ref(token),
        'before_state': before_state,
        'after_state': after_state,
    }


def _has_residual_issues_after_cross_user_repair(health_summary: dict) -> bool:
    """判断 repair 后是否仍存在需要继续治理的残余问题。"""
    if health_summary['same_user_targets_with_issues_count'] > 0:
        return True
    residual_warning_codes = {
        'cycle_requires_detach_repair',
    }
    return any(item.get('reason_code') in residual_warning_codes for item in health_summary['warnings'])


def _validate_scopes(scopes: list) -> tuple:
    """验证 scope 列表，返回 (valid_scopes, error_message)"""
    try:
        return TableApiToken.validate_scope_list(scopes), None
    except TokenTargetValidationError as exc:
        message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
        return None, message


def _validate_token_targets(user, space_ids: Optional[List[str]], table_ids: Optional[List[str]]):
    """校验 Token 作用范围，确保写入即合法。"""
    try:
        return TableApiToken.validate_scope_targets_for_user(
            user,
            space_ids,
            table_ids,
        ), None
    except TokenTargetValidationError as exc:
        return None, _build_token_validation_error(exc)


_DELEGATION_CHAIN_INTERNAL_KEYWORDS = (
    '父链路已损坏',
    '必须属于同一用户',
    '委托链必须属于同一用户',
    '委托链深度超过上限',
    '父子关系存在循环',
    '不能将自己设为父',
    '不能挂载到未激活的',
    '子树存在循环',
)

_GENERIC_DELEGATION_ERROR = '令牌委托链验证失败'


def _build_token_validation_error(exc: TokenTargetValidationError):
    message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
    error_code = getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR)
    status_code = getattr(exc, 'status_code', 400)
    if error_code == ErrorCode.NOT_FOUND and status_code == 404:
        if message.startswith('目标父 Token 不存在') or message.startswith('父 Token 不存在'):
            return _build_parent_token_not_found_response()
        if message.startswith('目标 Token 不存在') or message == 'Token 不存在':
            return _build_token_not_found_response()
    if any(kw in message for kw in _DELEGATION_CHAIN_INTERNAL_KEYWORDS):
        logger.warning('Token 委托链校验失败（内部详情已屏蔽）: %s', message)
        message = _GENERIC_DELEGATION_ERROR
    return error_response(
        error_code,
        message,
        status_code=status_code,
    )


def _build_token_not_found_response(message: str = 'Token 不存在'):
    return error_response(
        ErrorCode.NOT_FOUND,
        message,
        status_code=404,
    )


def _build_parent_token_not_found_response(message: str = '目标父 Token 不存在'):
    return error_response(
        ErrorCode.NOT_FOUND,
        message,
        status_code=404,
    )


def _ordered_scope_keys() -> list[str]:
    ordered: list[str] = []
    seen = set()
    for group in SCOPE_GROUPS:
        for scope in group['scopes']:
            if scope in VALID_SCOPES and scope not in seen:
                ordered.append(scope)
                seen.add(scope)
    for scope in sorted(VALID_SCOPES):
        if scope not in seen:
            ordered.append(scope)
    return ordered


def _serialize_available_scope_catalog() -> dict:
    ordered_scopes = _ordered_scope_keys()
    scope_items = []
    for scope in ordered_scopes:
        meta = SCOPE_UI_METADATA.get(scope, {})
        group_key = next(
            (group['key'] for group in SCOPE_GROUPS if scope in group['scopes']),
            'advanced',
        )
        scope_items.append({
            'key': scope,
            'group_key': group_key,
            'label_key': meta.get('label_key', f'apiToken.scopeLabels.{scope}'),
            'default_label': meta.get('default_label', scope),
        })

    groups = []
    for group in SCOPE_GROUPS:
        group_scopes = [scope for scope in group['scopes'] if scope in VALID_SCOPES]
        if not group_scopes:
            continue
        groups.append({
            'key': group['key'],
            'label_key': group['label_key'],
            'default_label': group['default_label'],
            'scopes': group_scopes,
        })

    presets = {}
    for preset_key, preset_scopes in SCOPE_PRESETS.items():
        meta = SCOPE_PRESET_METADATA.get(preset_key, {})
        presets[preset_key] = {
            'label_key': meta.get('label_key', f'apiToken.scopePresets.{preset_key}.label'),
            'default_label': meta.get('default_label', preset_key),
            'description_key': meta.get('description_key', f'apiToken.scopePresets.{preset_key}.description'),
            'default_description': meta.get('default_description', ''),
            'scopes': preset_scopes,
        }

    return {
        'scopes': scope_items,
        'groups': groups,
        'presets': presets,
    }


def _validate_token_delegation(
    parent_token,
    *,
    scopes: List[str],
    space_ids: Optional[List[str]],
    table_ids: Optional[List[str]],
    rate_limit: Optional[int] = None,
    expired_at=None,
    actor_label='父 Token',
):
    if parent_token is None:
        return None

    try:
        TableApiToken.validate_within_parent_boundary(
            parent_token,
            scopes=scopes,
            space_ids=space_ids,
            table_ids=table_ids,
            rate_limit=rate_limit,
            expired_at=expired_at,
            actor_label=actor_label,
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    return None


def _enforce_current_token_ceiling(
    current_token,
    scopes: List[str],
    space_ids: Optional[List[str]],
    table_ids: Optional[List[str]],
    *,
    rate_limit: Optional[int] = None,
    expired_at=None,
):
    """当调用方本身也是 API Token 时，禁止其越过自身边界扩权。"""
    if current_token is None:
        return None

    return _validate_token_delegation(
        current_token,
        scopes=scopes,
        space_ids=space_ids,
        table_ids=table_ids,
        rate_limit=rate_limit,
        expired_at=expired_at,
        actor_label='当前调用 Token',
    )


def _ensure_token_manageable_by_request(request: HttpRequest, token: TableApiToken):
    """受限 Token 只能查看/修改自身边界内的 Token。"""
    current_token = getattr(request, 'api_token', None)
    if current_token is None:
        return None
    if getattr(current_token, 'pk', None) is None:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            '当前调用 Token 缺少持久化身份，无法校验父子委托关系',
            status_code=403,
        )
    # CR-037: 在事务内加锁遍历委托链，防止并发 reparent 导致 TOCTOU 权限误判
    with transaction.atomic(using=TABDATA_DB_ALIAS):
        if not token.is_self_or_descendant_of(current_token, lock_chain=True):
            return error_response(
                ErrorCode.PERMISSION_DENIED,
                '当前调用 Token 只能管理自身或其派生的 Token',
                status_code=403,
            )
    return _enforce_current_token_ceiling(
        current_token,
        token.scopes,
        token.space_ids,
        token.table_ids,
        rate_limit=token.rate_limit,
        expired_at=token.expired_at,
    )


def _require_jwt_token_governance(request: HttpRequest):
    """父子树治理动作只允许 JWT 所有者发起。"""
    if getattr(request, 'api_token', None) is None:
        return None
    return error_response(
        ErrorCode.PERMISSION_DENIED,
        'Token 树治理操作仅支持使用 JWT 进行所有者治理',
        status_code=403,
    )


def _build_update_transition_inputs(body: UpdateTokenRequest) -> dict:
    """把 PATCH body 转成模型层可识别的显式变更输入。"""
    provided_fields = getattr(body, 'model_fields_set', set())
    return {
        'name': body.name if body.name is not None else ANALYZE_UNSET,
        'description': body.description if body.description is not None else ANALYZE_UNSET,
        'scopes': body.scopes if body.scopes is not None else ANALYZE_UNSET,
        'space_ids': body.space_ids if 'space_ids' in provided_fields else ANALYZE_UNSET,
        'table_ids': body.table_ids if 'table_ids' in provided_fields else ANALYZE_UNSET,
        'rate_limit': body.rate_limit if body.rate_limit is not None else ANALYZE_UNSET,
        'is_active': body.is_active if body.is_active is not None else ANALYZE_UNSET,
    }


# ── 接口 ──────────────────────────────────────────────────

@router.post(
    "/tokens",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="创建 API Token",
)
@require_scope('token:manage')
@api_error_handler
def create_token(request: HttpRequest, body: CreateTokenRequest):
    """
    创建新的 API Token。

    返回的 plain_token 仅此时展示一次，请立即保存。
    """
    from apps.tabtinspace.models import Space

    user = request.auth
    current_token = getattr(request, 'api_token', None)

    # 解析 scope
    if body.scope_preset:
        if body.scope_preset not in SCOPE_PRESETS:
            return error_response(
                ErrorCode.INVALID_SCOPE_PRESET,
                f'无效的预设: {body.scope_preset}，可选: {", ".join(SCOPE_PRESETS.keys())}',
            )
        scopes = SCOPE_PRESETS[body.scope_preset]
    else:
        scopes, err = _validate_scopes(body.scopes)
        if err:
            return error_response(ErrorCode.INVALID_SCOPE, err)

    # 计算过期时间
    expired_at = None
    if body.expires_in_days:
        expired_at = timezone.now() + timedelta(days=body.expires_in_days)

    # ── 解析归属 Space ──
    owning_space = None
    effective_space_ids = body.space_ids
    if body.space_id:
        try:
            from apps.tabtinspace.services.host_resolver import resolve_host
            owning_space = resolve_host(body.space_id)
            if owning_space is None:
                raise Space.DoesNotExist
        except Space.DoesNotExist:
            return error_response(
                ErrorCode.NOT_FOUND,
                f'Space 不存在: {body.space_id}',
                status_code=404,
            )
        # SDI-024: API 层显式校验调用方对归属 Space 的访问权限
        from apps.tabdata.services.base import BaseService as _TabDataBase
        if not _TabDataBase(user=user).check_space_permission(str(owning_space.id), 'viewer'):
            return error_response(
                ErrorCode.PERMISSION_DENIED,
                f'无权访问该 Space，无法创建绑定 Token',
                status_code=403,
            )
        owning_space_id_str = str(owning_space.id)
        if effective_space_ids is None:
            effective_space_ids = [owning_space_id_str]
        elif owning_space_id_str not in effective_space_ids:
            effective_space_ids = [owning_space_id_str] + list(effective_space_ids)

    # ── Token 限额：per-user-per-space（：space FK 已 Drop，改 space_ids JSON）──
    if owning_space is not None:
        limit_message = f'每个用户在单个 Space 下最多创建 20 个活跃 Token'
    else:
        limit_message = '每个用户最多创建 20 个活跃 Token'

    target_scope, err_response = _validate_token_targets(
        user,
        effective_space_ids,
        body.table_ids,
    )
    if err_response is not None:
        return err_response

    try:
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            # CR-035: select_for_update 锁住同组已有 Token，防止并发请求同时通过限额检查
            limit_qs = (
                TableApiToken.objects
                .using(TABDATA_DB_ALIAS)
                .select_for_update()
                .filter(user=user, is_active=True)
            )
            if owning_space is not None:
                # JSON 数组包含该 host id（Django JSONField __contains）
                limit_qs = limit_qs.filter(
                    space_ids__contains=[str(owning_space.id)],
                )
            else:
                limit_qs = limit_qs.filter(space_ids__isnull=True)
            existing_count = limit_qs.count()
            if existing_count >= 20:
                return error_response(ErrorCode.TOKEN_LIMIT_EXCEEDED, limit_message)

            token_instance, plain_token = TableApiToken.create_token(
                user=user,
                parent_token=current_token,
                actor_token=current_token,
                name=body.name,
                description=body.description,
                scopes=scopes,
                space_ids=target_scope['space_ids'],
                table_ids=target_scope['table_ids'],
                rate_limit=body.rate_limit,
                expired_at=expired_at,
            )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    return success_response({
        'token': _serialize_token(token_instance),
        'plain_token': plain_token,
    })


@router.get(
    "/tokens",
    response={200: dict, 401: dict, 403: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="列出用户的 API Token",
)
@require_scope('token:read')
@api_error_handler
def list_tokens(request: HttpRequest):
    """列出当前用户的 API Token；可按 Space 过滤（FK 或 JSON space_ids 均匹配）。"""
    user = request.auth
    space_id = request.GET.get('space_id')
    qs = TableApiToken.objects.using(TABDATA_DB_ALIAS).filter(user=user)
    tokens = list(qs.order_by('-created_at'))
    if space_id:
        tokens = [
            t for t in tokens
            if str(getattr(t, 'space_id', '') or '') == space_id
            or (t.space_ids and space_id in [str(s) for s in t.space_ids])
        ]
    if getattr(request, 'api_token', None) is not None:
        tokens = [token for token in tokens if _ensure_token_manageable_by_request(request, token) is None]
    return success_response([_serialize_token(t) for t in tokens])


@router.get(
    "/tokens/{token_id}",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="获取单个 Token 详情",
)
@require_scope('token:read')
@api_error_handler
def get_token(request: HttpRequest, token_id: UUID):
    """获取指定 Token 的详情"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _ensure_token_manageable_by_request(request, token)
    if err_response is not None:
        return err_response

    return success_response(_serialize_token(token))


@router.patch(
    "/tokens/{token_id}",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="更新 Token",
)
@require_scope('token:manage')
@api_error_handler
def update_token(request: HttpRequest, token_id: UUID, body: UpdateTokenRequest):
    """更新 Token 的名称、描述、scope 等（不能更换签名）"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _ensure_token_manageable_by_request(request, token)
    if err_response is not None:
        return err_response

    # SDI-024: 更新 space_ids 时校验调用方对新 space 的访问权限
    provided_fields = getattr(body, 'model_fields_set', set())
    if 'space_ids' in provided_fields and body.space_ids:
        from apps.tabdata.services.base import BaseService as _TabDataBase
        _svc = _TabDataBase(user=user)
        for sid in body.space_ids:
            if not _svc.check_space_permission(str(sid), 'viewer'):
                return error_response(
                    ErrorCode.PERMISSION_DENIED,
                    f'无权将 Space {sid} 授权给 Token',
                    status_code=403,
                )

    update_inputs = _build_update_transition_inputs(body)
    try:
        token.apply_update(
            actor_token=getattr(request, 'api_token', None),
            **update_inputs,
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    return success_response(_serialize_token(token))


@router.post(
    "/tokens/{token_id}/impact-preview",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="预览 Token 更新对子树的影响",
)
@require_scope('token:manage')
@api_error_handler
def preview_token_impact(request: HttpRequest, token_id: UUID, body: UpdateTokenRequest):
    """在真正更新前，分析当前 Token 修改后会影响哪些派生节点。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    update_inputs = _build_update_transition_inputs(body)
    try:
        preview = token.build_transition_preview(
            action='update',
            **update_inputs,
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    current_parent_token = preview.pop('current_parent_token', None)
    return success_response({
        'target_token': _serialize_token_ref(token),
        'current_parent_token': current_parent_token,
        **preview,
    })


@router.delete(
    "/tokens/{token_id}",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="删除 Token",
)
@require_scope('token:manage')
@api_error_handler
def delete_token(request: HttpRequest, token_id: UUID):
    """永久删除指定 Token"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _ensure_token_manageable_by_request(request, token)
    if err_response is not None:
        return err_response

    try:
        token.delete_with_governance(actor_token=getattr(request, 'api_token', None))
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    return success_response(message='Token 已删除')


@router.post(
    "/tokens/{token_id}/regenerate",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="重新生成 Token 签名",
)
@require_scope('token:manage')
@api_error_handler
def regenerate_token(request: HttpRequest, token_id: UUID):
    """
    重新生成 Token 签名，旧签名立即失效。

    返回的新 plain_token 仅此时展示一次。
    """
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    try:
        new_plain_token = token.regenerate_sign_with_governance(
            actor_token=getattr(request, 'api_token', None),
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    return success_response({
        'token': _serialize_token(token),
        'plain_token': new_plain_token,
    })


@router.post(
    "/tokens/{token_id}/detach/preview",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="预览 detach 后的 Token 树变化",
)
@require_scope('token:manage')
@api_error_handler
def preview_detach_token(request: HttpRequest, token_id: UUID):
    """在 detach 前先看当前节点脱离父链后，整棵子树是否仍然一致。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        preview = token.build_parent_transition_preview(
            action='detach',
            parent_token=None,
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    current_parent_token = preview.pop('current_parent_token', None)
    return success_response({
        'target_token': _serialize_token_ref(token),
        'current_parent_token': current_parent_token,
        **preview,
    })


@router.post(
    "/tokens/{token_id}/detach",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="将 Token 从父链中分离",
)
@require_scope('token:manage')
@api_error_handler
def detach_token(request: HttpRequest, token_id: UUID):
    """把一个子 Token 提升为根 Token。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        token.detach_from_parent()
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    return success_response(_serialize_token(token))


@router.post(
    "/tokens/{token_id}/reparent/preview",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="预览 reparent 后的 Token 树变化",
)
@require_scope('token:manage')
@api_error_handler
def preview_reparent_token(request: HttpRequest, token_id: UUID, body: ReparentTokenRequest):
    """在 reparent 前检查当前 Token 及其子树是否能挂到新父链下。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        new_parent = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=body.parent_token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_parent_token_not_found_response()

    try:
        preview = token.build_parent_transition_preview(
            action='reparent',
            parent_token=new_parent,
        )
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    current_parent_token = preview.pop('current_parent_token', None)
    return success_response({
        'target_token': _serialize_token_ref(token),
        'current_parent_token': current_parent_token,
        'new_parent_token': _serialize_token_ref(new_parent),
        **preview,
    })


@router.post(
    "/tokens/{token_id}/repair-cross-user-links/preview",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="预览跨用户脏委托边修复",
)
@require_scope('token:manage')
@api_error_handler
def preview_repair_cross_user_links(request: HttpRequest, token_id: UUID):
    """预览切断当前父子图中所有跨用户脏委托边后的修复范围。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        plan, changed_count, health_summary, target_transition = token.preview_cross_user_link_repair()
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    same_user_targets = [
        _serialize_token_ref_from_state(item['token_id'], item['token_state'])
        for item in health_summary['same_user_repair_target_health']
    ]
    same_user_target_health = [
        {
            'token': _serialize_token_ref_from_state(item['token_id'], item['token_state']),
            'is_healthy_after_repair': item['is_healthy_after_repair'],
            'issue_count': item['issue_count'],
            'issues': item['issues'],
        }
        for item in health_summary['same_user_repair_target_health']
    ]
    has_residual_issues_after_repair = _has_residual_issues_after_cross_user_repair(health_summary)
    target_current_state = target_transition['before_state']
    target_candidate_state = target_transition['after_state']
    return success_response({
        'target_token': _serialize_token_ref_from_state(str(token.id), target_current_state),
        'target_current_state': target_current_state,
        'target_candidate_state': target_candidate_state,
        'repair_type': 'cross_user_links',
        'can_apply': True,
        'current_token_in_repair_scope': any(str(item.pk) == str(token.pk) for item in plan['repair_target_tokens']),
        'repair_target_count': plan['repair_target_count'],
        'same_user_repair_target_count': plan['same_user_repair_target_count'],
        'foreign_user_repair_target_count': plan['foreign_user_repair_target_count'],
        'estimated_changed_count': changed_count,
        'same_user_repair_targets': same_user_targets,
        'same_user_repair_target_health': same_user_target_health,
        'has_residual_issues_after_repair': has_residual_issues_after_repair,
        'same_user_targets_with_issues_count': health_summary['same_user_targets_with_issues_count'],
        'same_user_residual_issue_count': health_summary['residual_issue_count'],
        'residual_issue_count': health_summary['residual_issue_count'],
        'warnings': health_summary['warnings'],
    })


@router.post(
    "/tokens/{token_id}/reparent",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="重挂 Token 的父链",
)
@require_scope('token:manage')
@api_error_handler
def reparent_token(request: HttpRequest, token_id: UUID, body: ReparentTokenRequest):
    """把一个 Token 迁移到新的父 Token 下。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        new_parent = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=body.parent_token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_parent_token_not_found_response()

    if str(token.pk) == str(new_parent.pk):
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            'Token 不能将自己设为父 Token',
            status_code=400,
        )

    try:
        token.reparent_to(new_parent)
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    return success_response(_serialize_token(token))


@router.post(
    "/tokens/{token_id}/repair-cross-user-links",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="修复跨用户脏委托边",
)
@require_scope('token:manage')
@api_error_handler
def repair_cross_user_links(request: HttpRequest, token_id: UUID):
    """切断当前父子图中所有跨用户脏委托边。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        plan, changed_count, health_summary, target_transition = token.repair_cross_user_links()
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)
    same_user_targets = [
        _serialize_token_ref_from_state(item['token_id'], item['token_state'])
        for item in health_summary['same_user_repair_target_health']
    ]
    same_user_target_health = [
        {
            'token': _serialize_token_ref_from_state(item['token_id'], item['token_state']),
            'is_healthy_after_repair': item['is_healthy_after_repair'],
            'issue_count': item['issue_count'],
            'issues': item['issues'],
        }
        for item in health_summary['same_user_repair_target_health']
    ]
    has_residual_issues_after_repair = _has_residual_issues_after_cross_user_repair(health_summary)
    target_before_state = target_transition['before_state']
    target_after_state = target_transition['after_state']

    return success_response({
        'target_token': _serialize_token_ref_from_state(str(token.id), target_after_state),
        'target_before_state': target_before_state,
        'target_after_state': target_after_state,
        'repair_type': 'cross_user_links',
        'changed_count': changed_count,
        'current_token_in_repair_scope': any(str(item.pk) == str(token.pk) for item in plan['repair_target_tokens']),
        'repair_target_count': plan['repair_target_count'],
        'same_user_repair_target_count': plan['same_user_repair_target_count'],
        'foreign_user_repair_target_count': plan['foreign_user_repair_target_count'],
        'same_user_repair_targets': same_user_targets,
        'same_user_repair_target_health': same_user_target_health,
        'has_residual_issues_after_repair': has_residual_issues_after_repair,
        'same_user_targets_with_issues_count': health_summary['same_user_targets_with_issues_count'],
        'same_user_residual_issue_count': health_summary['residual_issue_count'],
        'residual_issue_count': health_summary['residual_issue_count'],
        'warnings': health_summary['warnings'],
    })


@router.post(
    "/tokens/{token_id}/cascade-deactivate",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="显式停用 Token 子树",
)
@require_scope('token:manage')
@api_error_handler
def cascade_deactivate_token(request: HttpRequest, token_id: UUID):
    """显式停用当前 Token 以及其下所有派生 Token。"""
    user = request.auth
    try:
        token = TableApiToken.objects.using(TABDATA_DB_ALIAS).get(pk=token_id, user=user)
    except TableApiToken.DoesNotExist:
        return _build_token_not_found_response()

    err_response = _require_jwt_token_governance(request)
    if err_response is not None:
        return err_response

    try:
        affected_tokens, changed_tokens, changed_count = token.cascade_deactivate()
    except TokenTargetValidationError as exc:
        return _build_token_validation_error(exc)

    visibility_summary = token.get_graph_visibility_summary()
    warnings = []
    if visibility_summary['foreign_descendant_count']:
        warnings.append({
            'reason_code': 'foreign_descendants_excluded',
            'message': (
                f'当前父子图中还有 {visibility_summary["foreign_descendant_count"]} 个跨用户脏派生 Token '
                '未纳入本次级联停用范围'
            ),
            'affected_subtree_size': visibility_summary['foreign_descendant_count'],
        })
    changed_token_ids = {str(item.pk) for item in changed_tokens if item.pk}
    return success_response({
        'target_token': _serialize_token_ref(token),
        'target_before_state': {
            **_serialize_token_state(token),
            'is_active': str(token.pk) in changed_token_ids,
        },
        'target_after_state': _serialize_token_state(token),
        'ignored_foreign_descendant_count': visibility_summary['foreign_descendant_count'],
        'warnings': warnings,
        'changed_count': changed_count,
        'affected_token_count': len(affected_tokens),
        'changed_tokens': [
            _serialize_token_transition(item, previous_is_active=True)
            for item in changed_tokens
        ],
        'affected_tokens': [
            _serialize_token_transition(
                item,
                previous_is_active=str(item.pk) in changed_token_ids,
            )
            for item in affected_tokens
        ],
    })


@router.get(
    "/tokens/scopes/available",
    response={200: dict, 401: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="获取可用的 Scope 列表",
)
@api_error_handler
def list_available_scopes(request: HttpRequest):
    """返回所有可用的 Scope 和预设组合（静态目录，仅需认证无需特定 scope）"""
    return success_response(_serialize_available_scope_catalog())

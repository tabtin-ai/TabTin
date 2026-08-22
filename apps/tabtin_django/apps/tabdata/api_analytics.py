"""
API Analytics 查询接口

提供 API 调用日志查询、用量统计和错误分析能力。
支持 JWT 和 API Token（需 analytics:read scope）双重认证。

Legacy 路径前缀: /api/tabdata/open/v1/analytics (待迁移至 Space 级路由)
"""

import logging
from datetime import datetime, timezone as dt_timezone
from typing import Optional

from django.db.models import Count, Sum, Max, Q, F
from django.http import HttpRequest
from ninja import Router

from apps.tabdata.auth_open_api import open_api_auth, require_scope
from apps.tabdata.api_helpers import success_response, error_response, api_error_handler
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models_api_log import ApiCallLog, ApiUsageSummary

logger = logging.getLogger(__name__)

router = Router(tags=["analytics"])

MAX_PAGE_SIZE = 200


# ── 多租户隔离 ──────────────────────────────────────────────

def _check_organization_access(request, organization_id: str):
    """
    Verify the authenticated user has access to the requested organization.

    - API Token auth: token.space_ids must include a space belonging to the organization,
      or the token must have been created by a member of the organization.
    - JWT auth: user must be organization owner or member.

    Returns None on success, or an error tuple (status, body) on failure.
    """
    from apps.tabtinspace.services.base import BaseService

    user = request.auth
    if not user:
        return error_response('UNAUTHORIZED', 'Authentication required', status_code=401)

    svc = BaseService(user=user)
    if not svc.check_organization_permission(organization_id, 'viewer'):
        return error_response(
            'ORGANIZATION_ACCESS_DENIED',
            'You do not have access to this organization',
            status_code=403,
        )

    # For token auth, additionally verify token scope covers this organization
    api_token = getattr(request, 'api_token', None)
    if api_token and api_token.space_ids is not None:
        from apps.tabtinspace.services.host_resolver import organization_ids_for_hosts
        token_organization_ids = organization_ids_for_hosts(api_token.space_ids)
        if str(organization_id) not in token_organization_ids:
            return error_response(
                'ORGANIZATION_ACCESS_DENIED',
                'Token does not have access to this organization',
                status_code=403,
            )

    return None


# ── 辅助函数 ──────────────────────────────────────────────

def _parse_iso_datetime(value: str) -> datetime:
    """解析 ISO 8601 时间字符串，保证时区感知。"""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=dt_timezone.utc)
    return dt


def _serialize_log(log) -> dict:
    """序列化单条 ApiCallLog 为响应格式。"""
    return {
        'id': log.id,
        'request_id': log.request_id,
        'timestamp': log.timestamp.isoformat(),
        'organization_id': log.organization_id,
        'space_id': str(log.space_id) if log.space_id else None,
        'token_id': log.token_id,
        'user_id': log.user_id,
        'auth_type': log.auth_type,
        'method': log.method,
        'path': log.path,
        'path_template': log.path_template,
        'status_code': log.status_code,
        'response_size': log.response_size,
        'duration_ms': log.duration_ms,
        'table_id': str(log.table_id) if log.table_id else None,
        'error_code': log.error_code or None,
        'error_message': log.error_message or None,
        'is_rate_limited': log.is_rate_limited,
        'ip_address': log.ip_address,
        'user_agent': log.user_agent,
        'sdk_version': log.sdk_version or None,
    }


# ── 接口 ──────────────────────────────────────────────────

@router.get(
    "/logs",
    response={200: dict, 400: dict, 401: dict, 403: dict, 500: dict},
    auth=open_api_auth,
    summary="查询 API 调用日志",
)
@require_scope('analytics:read')
@api_error_handler
def list_logs(
    request: HttpRequest,
    organization_id: str,
    space_id: str = None,
    token_id: str = None,
    path_template: str = None,
    status_code: str = None,
    start_time: str = None,
    end_time: str = None,
    page: int = 1,
    page_size: int = 50,
):
    """
    查询 API 调用日志，支持按空间、Token、路径模板、状态码和时间范围过滤。

    status_code 支持模糊匹配：
    - "4xx"  → 所有 400-499
    - "5xx"  → 所有 500-599
    - "403"  → 精确匹配
    """
    # 多租户隔离：验证用户对 organization 的访问权限
    access_err = _check_organization_access(request, organization_id)
    if access_err is not None:
        return access_err

    # 参数校验
    page_size = min(max(page_size, 1), MAX_PAGE_SIZE)
    page = max(page, 1)

    qs = ApiCallLog.objects.using(TABDATA_DB_ALIAS).filter(organization_id=organization_id)

    if space_id:
        qs = qs.filter(space_id=space_id)
    if token_id:
        qs = qs.filter(token_id=token_id)
    if path_template:
        qs = qs.filter(path_template=path_template)

    # 状态码过滤
    if status_code:
        if status_code == '4xx':
            qs = qs.filter(status_code__gte=400, status_code__lt=500)
        elif status_code == '5xx':
            qs = qs.filter(status_code__gte=500, status_code__lt=600)
        else:
            try:
                qs = qs.filter(status_code=int(status_code))
            except (ValueError, TypeError):
                return error_response('INVALID_PARAM', f'无效的 status_code: {status_code}')

    # 时间范围
    if start_time:
        qs = qs.filter(timestamp__gte=_parse_iso_datetime(start_time))
    if end_time:
        qs = qs.filter(timestamp__lte=_parse_iso_datetime(end_time))

    total = qs.count()
    offset = (page - 1) * page_size
    logs = qs.order_by('-timestamp')[offset:offset + page_size]

    return success_response({
        'logs': [_serialize_log(log) for log in logs],
        'total': total,
        'page': page,
        'page_size': page_size,
    })


@router.get(
    "/usage",
    response={200: dict, 400: dict, 401: dict, 403: dict, 500: dict},
    auth=open_api_auth,
    summary="查询 API 用量统计",
)
@require_scope('analytics:read')
@api_error_handler
def get_usage(
    request: HttpRequest,
    organization_id: str,
    start_time: str,
    end_time: str,
    space_id: str = None,
    token_id: str = None,
    period: str = 'day',
):
    """
    查询 API 用量统计（来自 ApiUsageSummary 聚合表）。

    period: 'hour' 或 'day'，决定时间线粒度。
    返回汇总指标 + 时间线序列。
    """
    # 多租户隔离：验证用户对 organization 的访问权限
    access_err = _check_organization_access(request, organization_id)
    if access_err is not None:
        return access_err

    if period not in ('hour', 'day'):
        return error_response('INVALID_PARAM', 'period 必须是 hour 或 day')

    start_dt = _parse_iso_datetime(start_time)
    end_dt = _parse_iso_datetime(end_time)

    qs = (
        ApiUsageSummary.objects
        .using(TABDATA_DB_ALIAS)
        .filter(
            organization_id=organization_id,
            period_type=period,
            period_start__gte=start_dt,
            period_start__lte=end_dt,
        )
    )

    if space_id:
        qs = qs.filter(space_id=space_id)
    if token_id:
        qs = qs.filter(token_id=token_id)

    # 汇总指标
    # NOTE: avg_duration_ms uses a weighted average (weighted by total_requests)
    # instead of Avg('avg_duration_ms'), which would incorrectly average averages.
    agg = qs.aggregate(
        total_requests=Sum('total_requests'),
        success_count=Sum('success_count'),
        client_error_count=Sum('client_error_count'),
        server_error_count=Sum('server_error_count'),
        rate_limited_count=Sum('rate_limited_count'),
        _weighted_duration_sum=Sum(F('avg_duration_ms') * F('total_requests')),
        _total_requests_for_avg=Sum('total_requests'),
        max_duration_ms=Max('max_duration_ms'),
        total_response_bytes=Sum('total_response_bytes'),
    )

    total_reqs = agg['_total_requests_for_avg'] or 0
    weighted_sum = agg['_weighted_duration_sum'] or 0
    weighted_avg = round(weighted_sum / total_reqs) if total_reqs > 0 else 0

    summary = {
        'total_requests': agg['total_requests'] or 0,
        'success_count': agg['success_count'] or 0,
        'client_error_count': agg['client_error_count'] or 0,
        'server_error_count': agg['server_error_count'] or 0,
        'rate_limited_count': agg['rate_limited_count'] or 0,
        'avg_duration_ms': weighted_avg,
        'max_duration_ms': agg['max_duration_ms'] or 0,
        'total_response_bytes': agg['total_response_bytes'] or 0,
        # p95_duration_ms: requires PostgreSQL PERCENTILE_CONT for proper implementation.
        # Currently computed during hourly aggregation; see aggregate_api_usage task.
    }

    # 时间线：按 period_start 聚合（合并同一时段不同 path_template / token 的数据）
    # NOTE: avg_duration_ms uses weighted average (weighted by total_requests).
    timeline_qs = (
        qs
        .values('period_start')
        .annotate(
            total_requests=Sum('total_requests'),
            success_count=Sum('success_count'),
            client_error_count=Sum('client_error_count'),
            server_error_count=Sum('server_error_count'),
            rate_limited_count=Sum('rate_limited_count'),
            _weighted_duration_sum=Sum(F('avg_duration_ms') * F('total_requests')),
            max_duration_ms=Max('max_duration_ms'),
            total_response_bytes=Sum('total_response_bytes'),
        )
        .order_by('period_start')
    )

    timeline = []
    for row in timeline_qs:
        t_reqs = row['total_requests'] or 0
        t_weighted = row['_weighted_duration_sum'] or 0
        t_avg = round(t_weighted / t_reqs) if t_reqs > 0 else 0
        timeline.append({
            'period_start': row['period_start'].isoformat(),
            'total_requests': t_reqs,
            'success_count': row['success_count'] or 0,
            'client_error_count': row['client_error_count'] or 0,
            'server_error_count': row['server_error_count'] or 0,
            'rate_limited_count': row['rate_limited_count'] or 0,
            'avg_duration_ms': t_avg,
            'max_duration_ms': row['max_duration_ms'] or 0,
            'total_response_bytes': row['total_response_bytes'] or 0,
            # p95_duration_ms: see note in summary above.
        })

    return success_response({
        'summary': summary,
        'timeline': timeline,
    })


@router.get(
    "/errors",
    response={200: dict, 400: dict, 401: dict, 403: dict, 500: dict},
    auth=open_api_auth,
    summary="查询 API 错误分组",
)
@require_scope('analytics:read')
@api_error_handler
def list_errors(
    request: HttpRequest,
    organization_id: str,
    start_time: str,
    end_time: str,
    space_id: str = None,
    min_status_code: int = 400,
    limit: int = 50,
):
    """
    按 error_code + status_code 分组统计错误，返回计数、最后出现时间和示例路径。
    支持通过 space_id 筛选和 limit 参数控制返回数量。
    """
    # 多租户隔离：验证用户对 organization 的访问权限
    access_err = _check_organization_access(request, organization_id)
    if access_err is not None:
        return access_err

    # 参数校验
    limit = min(max(limit, 1), MAX_PAGE_SIZE)

    start_dt = _parse_iso_datetime(start_time)
    end_dt = _parse_iso_datetime(end_time)

    qs = (
        ApiCallLog.objects
        .using(TABDATA_DB_ALIAS)
        .filter(
            organization_id=organization_id,
            timestamp__gte=start_dt,
            timestamp__lte=end_dt,
            status_code__gte=min_status_code,
        )
    )

    if space_id:
        qs = qs.filter(space_id=space_id)

    error_groups = (
        qs
        .values('error_code', 'status_code')
        .annotate(
            count=Count('id'),
            last_seen=Max('timestamp'),
            sample_path=Max('path_template'),
        )
        .order_by('-count')[:limit]
    )

    return success_response({
        'error_groups': [
            {
                'error_code': row['error_code'] or '',
                'status_code': row['status_code'],
                'count': row['count'],
                'last_seen': row['last_seen'].isoformat() if row['last_seen'] else None,
                'sample_path': row['sample_path'] or '',
            }
            for row in error_groups
        ],
    })

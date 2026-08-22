"""
Open API 请求日志中间件

拦截 Open API 路径的请求，采集请求元数据后通过
Celery 异步写入 ApiCallLog，不阻塞响应链路。
"""

import logging
import re
import time
import uuid

logger = logging.getLogger(__name__)

# 匹配 UUID（含 8-4-4-4-12 格式）
_UUID_RE = re.compile(
    r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
)

# 匹配纯数字路径段（e.g., /records/12345 → /records/{id}）
_NUMERIC_ID_RE = re.compile(r'(?<=/)\d+(?=/|$)')

# 仅拦截 Open API 路由
_OPEN_API_PREFIXES = (
    '/api/open/',
    '/api/tabdata/open/',
)

# path_template 截取前缀
_PATH_TEMPLATE_PREFIXES = (
    '/api/open/v1',
    '/api/tabdata/open/v1',
)


def _normalize_path_template(path: str) -> str:
    """
    将请求路径规范化为模板形式，用于聚合统计。

    例：
        /api/open/v1/spaces/abc-def/data/tables/123-456/records
        → /spaces/{id}/data/tables/{id}/records
    """
    # 去除版本前缀
    template = path
    for prefix in _PATH_TEMPLATE_PREFIXES:
        if template.startswith(prefix):
            template = template[len(prefix):]
            break

    # 替换 UUID 为 {id}
    template = _UUID_RE.sub('{id}', template)

    # 替换纯数字路径段为 {id}（e.g., /records/12345 → /records/{id}）
    template = _NUMERIC_ID_RE.sub('{id}', template)

    # 去掉尾部斜杠
    if template.endswith('/') and len(template) > 1:
        template = template[:-1]

    return template or '/'


def _get_client_ip(request) -> str:
    """从请求中提取客户端 IP 地址（委托给 CA-10 统一实现）。"""
    from apps.users.auth.utils import get_client_ip
    return get_client_ip(request) or ''


class OpenApiLoggingMiddleware:
    """
    Django 中间件：为 Open API 请求生成请求日志。

    职责：
    1. 分配 request_id 并注入到 request 和 response header
    2. 计算请求耗时
    3. 采集认证、业务、客户端等元数据
    4. 通过 Celery 异步写入日志（绝不阻塞响应）
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        # 仅拦截 Open API 路径
        if not any(request.path.startswith(prefix) for prefix in _OPEN_API_PREFIXES):
            return self.get_response(request)

        # ── 请求阶段 ──
        request_id = str(uuid.uuid4())
        request._api_request_id = request_id
        start_time = time.monotonic()

        # ── 执行视图 ──
        response = self.get_response(request)

        # ── 响应阶段 ──
        duration_ms = int((time.monotonic() - start_time) * 1000)

        # 注入 X-Request-Id 到响应头
        response['X-Request-Id'] = request_id

        # 采集日志数据
        try:
            from django.utils import timezone

            status_code = response.status_code

            # Handle StreamingHttpResponse: don't try to read .content
            if getattr(response, 'streaming', False):
                response_size = 0
            elif hasattr(response, 'content'):
                response_size = len(response.content)
            else:
                response_size = 0

            log_data = {
                'request_id': request_id,
                'timestamp': timezone.now().isoformat(),
                'organization_id': getattr(request, '_api_organization_id', ''),
                'space_id': str(getattr(request, '_api_space_id', '')) or '',
                'token_id': getattr(request, '_api_token_id', ''),
                'user_id': getattr(request, '_api_user_id', ''),
                'auth_type': getattr(request, '_api_auth_type', 'jwt'),
                'method': request.method,
                'path': request.path[:500],
                'path_template': _normalize_path_template(request.path),
                'status_code': status_code,
                'response_size': response_size,
                'duration_ms': duration_ms,
                'table_id': str(getattr(request, '_api_table_id', '')) or '',
                'error_code': getattr(request, '_api_error_code', ''),
                'error_message': getattr(request, '_api_error_message', ''),
                'is_rate_limited': status_code == 429,
                'ip_address': _get_client_ip(request),
                'user_agent': request.META.get('HTTP_USER_AGENT', '')[:200],
                'sdk_version': request.META.get('HTTP_X_TABTIN_SDK_VERSION', ''),
            }

            from apps.tabdata.tasks.api_log_tasks import write_api_log
            from apps.maintenance.celery_utils import is_broker_connection_error
            try:
                write_api_log.delay(log_data)
            except Exception as exc:
                if not is_broker_connection_error(exc):
                    logger.warning('API 日志入队失败: %s', exc, exc_info=True)
        except Exception:
            logger.debug('API 日志采集异常（已忽略，不影响响应）', exc_info=True)

        return response

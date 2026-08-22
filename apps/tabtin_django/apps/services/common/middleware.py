"""
Services模块中间件
"""

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
import logging
from typing import Callable, Any
from django.core.exceptions import MiddlewareNotUsed
from django.http import HttpRequest, HttpResponse
from django.utils.deprecation import MiddlewareMixin

from apps.i18n import _
from apps.users.auth.utils import get_client_ip
from .constants import HTTP_STATUS_MAPPING
from .cache import is_rate_limited
from .utils import generate_request_id

logger = logging.getLogger(__name__)

_jwt_secret_bytes: bytes | None = None


def _get_jwt_secret_bytes() -> bytes:
    """懒加载并缓存 JWT 密钥的 bytes 形式，避免每次请求重复编码。"""
    global _jwt_secret_bytes
    if _jwt_secret_bytes is None:
        from django.conf import settings
        key = settings.JWT_SECRET_KEY
        _jwt_secret_bytes = key.encode('utf-8') if isinstance(key, str) else key
    return _jwt_secret_bytes
# ⭐ 轮询请求单独的日志记录器
polling_logger = logging.getLogger('polling')

_CENTRIFUGO_CONNECT_PATH = '/api/im/centrifugo/connect'


def _is_centrifugo_connect_request(request: HttpRequest) -> bool:
    return getattr(request, 'path', '') == _CENTRIFUGO_CONNECT_PATH


def _get_centrifugo_trace_id(request: HttpRequest) -> str:
    trace_id = getattr(request, '_centrifugo_trace_id', '')
    if trace_id:
        return trace_id
    trace_id = uuid.uuid4().hex[:8]
    request._centrifugo_trace_id = trace_id
    return trace_id


def _log_centrifugo_connect_rate_limit(
    request: HttpRequest,
    stage: str,
    level: int = logging.INFO,
    **fields,
) -> None:
    if not _is_centrifugo_connect_request(request):
        return

    trace_id = _get_centrifugo_trace_id(request)
    details = ' '.join(f'{key}={value}' for key, value in fields.items())
    message = (
        f'[CentrifugoConnect:{trace_id}] middleware=rate_limit {stage}'
        if not details
        else f'[CentrifugoConnect:{trace_id}] middleware=rate_limit {stage} {details}'
    )
    logger.log(level, message)


_request_id_access_logger = logging.getLogger('apps.services.common.access')


class DevLatencyMiddleware(MiddlewareMixin):
    """本地开发用：在 ``process_request`` 注入可配置延迟，模拟弱网 / 高延迟。

    仅在 ``settings.DEBUG=True`` 时启用；生产环境 ``__init__`` 抛
    ``MiddlewareNotUsed`` 把自己从中间件链彻底摘除，零开销。延迟时长由
    ``DEV_RESPONSE_LATENCY_MS``（毫秒）配置，具体解析见 ``tabtin.dev_latency``。

    同步 worker 上 sleep 会占住当前 worker，无法像 WS 那样用 create_task 重叠；
    这是 HTTP 同步模型的固有限制，与 WS「并行入站计时」语义刻意不同。
    """

    def __init__(self, get_response: Callable = None):
        super().__init__(get_response)
        from django.conf import settings
        if not settings.DEBUG:
            raise MiddlewareNotUsed()

    def process_request(self, request: HttpRequest) -> None:
        from tabtin.dev_latency import sleep_sync
        sleep_sync()


class RequestIdMiddleware(MiddlewareMixin):
    """X-Request-Id 跨进程透传中间件（Wave 1 D3 / contract 项目）。

    职责单一：从请求头读取 / 生成 ``request.request_id``，并 echo 到
    响应头 ``X-Request-Id``，让 main 端 api-proxy 能反读对齐。**与
    RequestLoggingMiddleware 解耦**——后者由于历史原因尚未启用，但
    本中间件独立保证三端 trace_id 一致：

      - main 端 log：``[trace_id=<x>]``
      - Django log：``[<x>] METHOD /path -> status``（access 一行）
      - 响应 envelope：``trace_id == <x>``

    用户截图含 "操作失败 (req: 末6位)" 时，开发者用同一段字符串能
    grep 三端任一日志直接定位调用链。

    设计要点：
      1. 不覆盖 ``request.request_id``——其他 middleware（如已启用的
         RequestContextMiddleware）若先设过，本中间件保留之，避免
         双源生成出两个不同的 trace_id；
      2. 上游 ``X-Request-Id`` 字符串经过 ``.strip()``，空白当成缺失，
         防御性避免把空串透传到 Django log 破坏关联性；
      3. process_response 无 hasattr 守卫——任何走完正常路径的请求
         (无论 200/4xx/5xx) 都 echo 头；处理 process_request 之前的
         异常分支由 RateLimitMiddleware 等显式带 trace 头返回；
      4. 每个非健康检查请求打一行 access log（``logger='apps.services.common.access'``），
         便于直接 grep ``[<trace>]``；健康检查 (/health, /ping) 已被
         HealthCheckMiddleware 短路，根本不会进到本中间件。
    """

    _ACCESS_LOG_SKIP_PATHS = frozenset({
        '/health', '/health/', '/ping', '/ping/',
        '/health/ready', '/health/ready/',
    })

    def process_request(self, request: HttpRequest) -> None:
        if hasattr(request, 'request_id') and request.request_id:
            return
        upstream_request_id = request.META.get('HTTP_X_REQUEST_ID', '').strip()
        request.request_id = upstream_request_id if upstream_request_id else generate_request_id()

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        request_id = getattr(request, 'request_id', None)
        if request_id:
            response['X-Request-Id'] = request_id
            self._ensure_error_trace_id(response, request_id)
            # Access log — 极简一行，只为 trace 反查；不写 query / body。
            # 跳过健康检查路径以免污染日志；其余无论 2xx/4xx/5xx 都打。
            path = getattr(request, 'path', '')
            if path not in self._ACCESS_LOG_SKIP_PATHS:
                _request_id_access_logger.info(
                    "[%s] %s %s -> %s",
                    request_id,
                    getattr(request, 'method', '?'),
                    path,
                    response.status_code,
                )
        return response

    @staticmethod
    def _ensure_error_trace_id(response: HttpResponse, request_id: str) -> None:
        """Attach ``trace_id`` to JSON error objects without changing successes."""
        if response.status_code < 400:
            return
        content_type = response.get('Content-Type', '')
        if 'application/json' not in content_type:
            return
        if getattr(response, 'streaming', False):
            return

        try:
            payload = json.loads(response.content.decode(response.charset or 'utf-8'))
        except Exception:
            return
        if not isinstance(payload, dict) or payload.get('trace_id'):
            return

        payload['trace_id'] = request_id
        response.content = json.dumps(payload, ensure_ascii=False).encode(response.charset or 'utf-8')
        response['Content-Length'] = str(len(response.content))


class RequestLoggingMiddleware(MiddlewareMixin):
    """请求日志中间件。

    Wave 1 D3 / contract 项目 — 跨进程 trace_id 透传：
    本中间件配合独立的 ``RequestIdMiddleware``，优先采用上游传来的
    ``X-Request-Id`` 作为 ``request.request_id``，统一日志关联。

      - main log 含 ``trace_id=<x>``
      - Django log 含 ``[<x>]``
      - 响应 envelope.trace_id == ``<x>``

    用户截图含 "操作失败 (req: 末6位)" 时，开发者可以用同一段字符串
    grep 三端任一日志直接定位调用链。

    上游没传 ``X-Request-Id`` 时回退到原行为：``generate_request_id()``
    自己产一个，写到响应头供下游使用。
    """

    def process_request(self, request: HttpRequest) -> None:
        """处理请求开始"""
        # Wave 1 D3：与 RequestIdMiddleware 协作。后者跑在前面已经
        # 设置 request.request_id；本中间件保留之不覆盖，单源 trace_id
        # 才能保证 echo 头 / 日志 / envelope 三处完全一致。如果本中间件
        # 单独启用（无 RequestIdMiddleware），则承担生成职责。
        if not hasattr(request, 'request_id') or not request.request_id:
            upstream_request_id = request.META.get('HTTP_X_REQUEST_ID', '').strip()
            request.request_id = upstream_request_id if upstream_request_id else generate_request_id()
        request.start_time = time.time()

        # ⭐ 判断是否是轮询请求（增量同步）
        is_polling = self._is_polling_request(request)
        request.is_polling = is_polling  # 保存标记，供响应处理使用

        # 选择合适的日志记录器
        current_logger = polling_logger if is_polling else logger

        # 记录请求开始日志
        current_logger.info(
            f"[{request.request_id}] API请求开始 {request.method} {request.path}",
            extra={
                'request_id': request.request_id,
                'method': request.method,
                'path': request.path,
                'user_agent': request.META.get('HTTP_USER_AGENT', ''),
                'remote_addr': get_client_ip(request),
            }
        )

        # 记录请求头（仅在 DEBUG 模式下，避免生产环境每请求 I/O 开销）
        if current_logger.isEnabledFor(logging.DEBUG):
            headers = {
                key: value for key, value in request.META.items()
                if key.startswith('HTTP_') or key in ['CONTENT_TYPE', 'CONTENT_LENGTH']
            }
            headers = self._sanitize_headers(headers)
            current_logger.debug(
                f"[{request.request_id}] 请求头: {headers}"
            )

            if is_polling and request.GET:
                query_params = dict(request.GET.lists())
                current_logger.debug(
                    f"[{request.request_id}] 查询参数: {query_params}"
                )

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        """处理响应"""
        if hasattr(request, 'request_id'):
            # Wave 1 D3：把 trace_id echo 到响应头，让 main 端 api-proxy
            # 能反读对齐（即使是这里 generate 出来的）。
            # 写在 hasattr(start_time) 检查外是为了：上游在 process_request
            # 之前抛错时（比如 RateLimitMiddleware 在 process_request 阶段
            # 直接返 429）也保留 trace 头，方便上游 grep。
            response['X-Request-Id'] = request.request_id

        if hasattr(request, 'request_id') and hasattr(request, 'start_time'):
            duration = (time.time() - request.start_time) * 1000  # 转换为毫秒

            # ⭐ 选择合适的日志记录器
            is_polling = getattr(request, 'is_polling', False)
            current_logger = polling_logger if is_polling else logger

            # 记录响应日志
            current_logger.info(
                f"[{request.request_id}] API请求完成 {response.status_code} ({duration:.1f}ms)",
                extra={
                    'request_id': request.request_id,
                    'status_code': response.status_code,
                    'duration_ms': duration,
                }
            )

            # 记录响应头和内容（仅在 DEBUG 模式下，避免生产环境 decode 响应体的开销）
            if current_logger.isEnabledFor(logging.DEBUG):
                response_headers = dict(response.items())
                current_logger.debug(
                    f"[{request.request_id}] 响应头: {', '.join([f'{k}={v}' for k, v in response_headers.items()])}"
                )

                if is_polling:
                    if response.status_code == 304:
                        current_logger.debug(
                            f"[{request.request_id}] 响应: 304 Not Modified (无更新)"
                        )
                    elif response.status_code == 200 and hasattr(response, 'content'):
                        try:
                            import json
                            data = json.loads(response.content.decode('utf-8'))
                            if 'data' in data:
                                record_count = len(data['data'].get('records', []))
                                latest_version = data['data'].get('latest_version', 'N/A')
                                current_logger.debug(
                                    f"[{request.request_id}] 响应: {record_count} 条更新, latest_version={latest_version}"
                                )
                        except Exception:
                            pass
                else:
                    if hasattr(response, 'content') and response.content:
                        content = response.content.decode('utf-8', errors='ignore')
                        if len(content) > 1000:
                            content = content[:1000] + '...'
                        current_logger.debug(
                            f"[{request.request_id}] 响应体: {content}"
                        )

        return response

    def process_exception(self, request: HttpRequest, exception: Exception) -> None:
        """处理异常"""
        if hasattr(request, 'request_id'):
            logger.error(
                f"[{request.request_id}] API请求异常: {str(exception)}",
                exc_info=True,
                extra={
                    'request_id': request.request_id,
                    'exception_type': type(exception).__name__,
                }
            )

    def _sanitize_headers(self, headers: dict) -> dict:
        """清理敏感的请求头信息"""
        sensitive_keys = ['HTTP_AUTHORIZATION', 'HTTP_COOKIE', 'HTTP_X_API_KEY']
        sanitized = {}

        for key, value in headers.items():
            if key in sensitive_keys:
                sanitized[key] = '***'
            else:
                sanitized[key] = value

        return sanitized

    def _is_polling_request(self, request: HttpRequest) -> bool:
        """
        判断是否是轮询请求（增量同步）

        轮询请求的特征：
        1. 路径包含 /records
        2. 包含 since_version 参数
        3. 通常还有 only_delta=true 参数
        """
        # 检查路径
        if '/records' not in request.path:
            return False

        # 检查查询参数
        query_params = request.GET
        has_since_version = 'since_version' in query_params
        has_only_delta = query_params.get('only_delta') == 'true'

        # 轮询请求：GET /records + since_version + only_delta
        return request.method == 'GET' and has_since_version and has_only_delta


class RateLimitMiddleware(MiddlewareMixin):
    """频率限制中间件 — 自动按 API 模块分桶 + 读写分离。

    架构设计：
    1. 自动分桶：从 URL `/api/{module}/...` 自动提取模块名作为桶 key，
       新增 API 模块无需手动添加规则，天然获得独立的限流配额。
    2. 读写分离：GET/HEAD/OPTIONS 使用 read_limit，其余使用 write_limit，
       读操作天然需要更高的配额（页面加载并发请求）。
    3. 路径级覆盖：少数特殊路径（内部管理台、站点访问、文件上传等）
       使用显式规则，覆盖自动分桶的默认配额。
    4. RateLimit Headers：所有响应附带标准限流头，前端可据此做自适应退避。
    """

    _SKIP_PATHS = frozenset({
        '/health', '/health/', '/ping', '/ping/',
        '/health/ready', '/health/ready/',
    })

    _READ_METHODS = frozenset({'GET', 'HEAD', 'OPTIONS'})

    # ── 路径级读写分离：用于天然会高并发读取、但仍需保留写保护的入口 ──
    # AdminDash 只给内部管理员使用，正常浏览会同时拉 workspaces / trash /
    # users / audit / tables / docs / slides 等多个面板；这里按“内部运维工作台”
    # 而不是“公网安全入口”处理，避免正常探索被 20/min 旧桶误伤。
    _PATH_LIMITS: list[tuple[str, int, int, int]] = [
        ('/s/', 1200, 300, 60),
        ('/api/auth/admin/', 2000, 600, 60),
    ]

    # 兼容旧测试 / 文档的只读 tier 清单；实际解析走 _PATH_LIMITS + _OVERRIDES。
    _TIER_RULES: list[tuple[str, int, int]] = [
        ('/s/', 1200, 60),
        ('/api/auth/admin/', 2000, 60),
        ('/api/services/oss/upload', 120, 60),
    ]

    _OVERRIDES: list[tuple[str, int, int]] = [
        ('/api/services/oss/upload', 120, 60),
        ('/api/services/media/generate', 60, 60),
        ('/api/services/speech/submit', 60, 60),
        ('/api/services/speech/tts/synthesize', 120, 60),
        ('/api/tabvideo/projects/', 60, 60),
        # SourceMap 上传是 CI/构建工具的批量调用（一次发版 ~400 个 .map 文件），
        # 与运行时业务共用 client-errors 默认桶（120 写/60s）会立刻撞顶，导致
        # 大半 sourcemap 传不上去，admindash 反混淆失效。
        # X-Sourcemap-Key 鉴权本身已具备 timing-safe 防滥用，可以放更高配额。
        ('/api/client-errors/upload-sourcemap', 2000, 60),
    ]

    # ── 按模块配置：module → (read_limit, write_limit, window) ──
    # 仅需为有特殊需求的模块显式声明，其余自动使用 DEFAULT。
    _MODULE_LIMITS: dict[str, tuple[int, int, int]] = {
        'tabdata':       (1200, 600, 60),
        'context':       (600, 180, 60),
        'collab':        (300, 120, 60),
        'chat':          (300, 120, 60),
        'tabdoc':        (600, 180, 60),
        'tabwhiteboard': (600, 180, 60),
        # Tracker 多视图同时挂载场景（List + Agenda + Kanban + Chat sidebar 同 Space
        # 共享数据流）下，单用户单分钟 GET 估算 4 视图 × ~30 次轮询/视图 = 120 是地板。
        # 读取 900/60 给多视图 + Agent 并行操作留余量；写 180/60 留出"AI 批量打 tag/move"空间。
        # 波次 4 Stage 2 一刀切删除 agenda/goal legacy 路径后，主路径 ``tracker`` 唯一承担。
        # 2026-05-28 收编：``/api/scheduler/*``（ScheduledJob 子系统）整体下线，
        # 事件目录归位到 ``/api/registry/events``（auth=None 公开接口，无需 api_key 限流桶）。
        "tracker":       (900, 180, 60),
        'im':            (300, 120, 60),
        'notifications': (300, 120, 60),
        'membership':    (240, 80, 60),
        'open':          (120, 60, 60),
        'orchestration': (240, 120, 60),
        'rag':           (240, 80, 60),
    }

    _DEFAULT_READ_LIMIT = 600
    _DEFAULT_WRITE_LIMIT = 120
    _DEFAULT_WINDOW = 60
    _DEFAULT_LIMIT = _DEFAULT_READ_LIMIT

    def __init__(self, get_response: Callable = None):
        super().__init__(get_response)
        from django.conf import settings as _cfg
        env_val = os.environ.get("RATE_LIMIT_ENABLED", "true").lower()
        if not _cfg.DEBUG and env_val in ("0", "false", "no"):
            logger.warning("[RateLimit] RATE_LIMIT_ENABLED=%s ignored in production (DEBUG=False)", env_val)
            self.enabled = True
        else:
            self.enabled = env_val not in ("0", "false", "no")

    # ------------------------------------------------------------------ #
    #  核心分桶逻辑
    # ------------------------------------------------------------------ #

    @staticmethod
    def _extract_module(path: str) -> str | None:
        """从 /api/{module}/... 中提取模块名。"""
        if not path.startswith('/api/'):
            return None
        rest = path[5:]
        slash_idx = rest.find('/')
        module = rest[:slash_idx] if slash_idx != -1 else rest
        return module or None

    def _resolve_tier(self, path: str, method: str = 'GET') -> tuple[str, int, int]:
        """返回 (tier_key, limit, window)。

        优先级：路径级读写分离 > 显式覆盖 > 模块配置 > 全局默认。
        """
        is_read = method in self._READ_METHODS

        for prefix, read_limit, write_limit, window in self._PATH_LIMITS:
            if path.startswith(prefix):
                safe_key = prefix.strip('/').replace('/', ':') or 'root'
                rw_tag = 'r' if is_read else 'w'
                limit = read_limit if is_read else write_limit
                return f"path:{safe_key}:{rw_tag}", limit, window

        for prefix, limit, window in self._OVERRIDES:
            if path.startswith(prefix):
                safe_key = prefix.strip('/').replace('/', ':')
                return f"api:{safe_key}", limit, window

        module = self._extract_module(path)

        if module and module in self._MODULE_LIMITS:
            read_limit, write_limit, window = self._MODULE_LIMITS[module]
        elif module:
            read_limit = self._DEFAULT_READ_LIMIT
            write_limit = self._DEFAULT_WRITE_LIMIT
            window = self._DEFAULT_WINDOW
        else:
            return ('api:other',
                    self._DEFAULT_READ_LIMIT if is_read else self._DEFAULT_WRITE_LIMIT,
                    self._DEFAULT_WINDOW)

        rw_tag = 'r' if is_read else 'w'
        limit = read_limit if is_read else write_limit
        return f"api:{module}:{rw_tag}", limit, window

    # ------------------------------------------------------------------ #
    #  请求 / 响应处理
    # ------------------------------------------------------------------ #

    def process_request(self, request: HttpRequest) -> HttpResponse | None:
        if not self.enabled:
            return None

        if request.path in self._SKIP_PATHS:
            return None

        client_id = self._get_client_identifier(request)
        tier_key, limit, window = self._resolve_tier(request.path, request.method)
        if _is_centrifugo_connect_request(request):
            _log_centrifugo_connect_rate_limit(
                request,
                'enter',
                client_id=client_id,
                tier_key=tier_key,
                limit=limit,
                window=window,
            )

        limited, current, ttl = is_rate_limited(tier_key, client_id, limit, window)

        request._ratelimit_limit = limit
        request._ratelimit_remaining = max(limit - current, 0)
        request._ratelimit_reset = ttl

        if limited:
            _log_centrifugo_connect_rate_limit(
                request,
                'limited',
                level=logging.WARNING,
                client_id=client_id,
                tier_key=tier_key,
                current=current,
                limit=limit,
                reset=ttl,
            )
            logger.warning(
                "频率限制触发: %s - %s %s (tier=%s, %d/%d, reset=%ds)",
                client_id, request.method, request.path,
                tier_key, current, limit, ttl,
            )
            # Wave 1 协议规范化（docs/api/rate-limit-protocol.md v1.0）：
            # 1) body 切换到业务统一信封 {success, code, message, data} +
            #    retry_after_seconds 字段，对齐 CredentialVault 样板
            #    (apps/credential_vault/api.py::_rate_limited_response) 与
            #    apps/i18n/response.py::error_response。
            # 2) 头部双发：Retry-After + X-RateLimit-* 全部保留（只加不减），
            #    任一面失守仍可完成协议握手；详见 §5.1-5.3 兼容性章节。
            # 3) cache.py::is_rate_limited 在窗口边界可能返 ttl=0（max(ttl, 0)
            #    而非 max(ttl, 1)），此处用 max(1, ...) 防御性补丁保证
            #    retry_after_seconds 永远是正整数。客户端拿到 0 会立刻重试，
            #    违反协议 §3.2 退避语义并制造雷击群效应；测试见
            #    test_rate_limit_envelope.py::TestRetryAfterMinimum。
            retry_after = max(1, int(ttl))
            body = json.dumps({
                "success": False,
                "code": "RATE_LIMITED",
                "message": _("middleware.rate_limited"),
                "data": None,
                "retry_after_seconds": retry_after,
            })
            response = HttpResponse(
                body,
                status=HTTP_STATUS_MAPPING['TOO_MANY_REQUESTS'],
                content_type='application/json',
            )
            self._set_ratelimit_headers(response, limit, 0, retry_after)
            response['Retry-After'] = str(retry_after)
            return response

        if _is_centrifugo_connect_request(request):
            _log_centrifugo_connect_rate_limit(
                request,
                'pass',
                client_id=client_id,
                tier_key=tier_key,
                current=current,
                remaining=max(limit - current, 0),
                limit=limit,
                reset=ttl,
            )

        return None

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        """为所有 API 响应附加 RateLimit 标准头。"""
        limit = getattr(request, '_ratelimit_limit', None)
        if limit is not None:
            remaining = getattr(request, '_ratelimit_remaining', 0)
            reset = getattr(request, '_ratelimit_reset', 0)
            self._set_ratelimit_headers(response, limit, remaining, reset)
        return response

    @staticmethod
    def _set_ratelimit_headers(response: HttpResponse, limit: int, remaining: int, reset: int):
        response['X-RateLimit-Limit'] = str(limit)
        response['X-RateLimit-Remaining'] = str(remaining)
        response['X-RateLimit-Reset'] = str(reset)

    # ------------------------------------------------------------------ #
    #  客户端标识
    # ------------------------------------------------------------------ #

    def _get_client_identifier(self, request: HttpRequest) -> str:
        user_id = self._extract_user_id_from_jwt(request)
        if user_id:
            return f"user:{user_id}"

        if hasattr(request, 'user') and getattr(request.user, 'is_authenticated', False):
            return f"user:{request.user.id}"

        return f"ip:{get_client_ip(request) or 'unknown'}"

    @staticmethod
    def _extract_user_id_from_jwt(request: HttpRequest):
        """从 Authorization: Bearer <token> 中提取 user_id，带轻量级 HMAC 签名验证。

        签名验证失败时返回 None，让中间件回退到 IP 维度限流，
        防止攻击者构造伪造 JWT 将请求计入受害用户的限流桶（P1-19）。
        """
        auth_header = request.META.get('HTTP_AUTHORIZATION', '')
        if not auth_header.startswith('Bearer '):
            return None
        token = auth_header[7:]
        try:
            parts = token.split('.')
            if len(parts) != 3:
                return None

            signing_input = f"{parts[0]}.{parts[1]}".encode('ascii')
            secret = _get_jwt_secret_bytes()
            expected_sig = hmac.new(secret, signing_input, hashlib.sha256).digest()

            sig_segment = parts[2] + '=' * (-len(parts[2]) % 4)
            actual_sig = base64.urlsafe_b64decode(sig_segment)

            if not hmac.compare_digest(expected_sig, actual_sig):
                return None

            payload_segment = parts[1] + '=' * (-len(parts[1]) % 4)
            data = json.loads(base64.urlsafe_b64decode(payload_segment))
            user_id = data.get('user_id') or data.get('sub')
            if not user_id:
                return None

            uuid.UUID(str(user_id))
            return user_id
        except Exception:
            return None


class CORSMiddleware(MiddlewareMixin):
    """CORS中间件"""

    def __init__(self, get_response: Callable = None):
        super().__init__(get_response)
        from django.conf import settings
        from django.core.exceptions import ImproperlyConfigured

        cors_origins = os.getenv('CORS_ALLOWED_ORIGINS', '*')
        if cors_origins == '*':
            running_tests = getattr(settings, 'RUNNING_TESTS', False)
            if not settings.DEBUG and not running_tests:
                raise ImproperlyConfigured(
                    "[CORS] 生产环境必须显式配置 CORS_ALLOWED_ORIGINS 环境变量。"
                    "示例：CORS_ALLOWED_ORIGINS=https://www.example.com,https://www.example.com,https://site.example.com "
                    "当前未配置会导致所有跨域请求被拒绝，用户站点前端将无法调用 API。"
                )
            else:
                self.allowed_origins: list[str] = ['*']
        else:
            self.allowed_origins = [o.strip() for o in cors_origins.split(',') if o.strip()]
        # PATCH：版本历史置顶/重命名、TabData 字段更新等 renderer 直 fetch 依赖
        self.allowed_methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
        # Wave 1 D3 — 加入 X-Request-Id：当前 main 端 HTTP 走的是 Node.js
        # http 模块（非浏览器，不触发 CORS preflight），但 renderer 未来若
        # 直 fetch（W2 之后通过 preload shim 收口），preflight 会校验本表。
        # 提前预留避免后续遗漏导致跨域 trace 头被剥离。
        self.allowed_headers = ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Window-Id',
                                'x-external-session-id', 'x-event-origin', 'x-frontend-version', 'x-client',
                                'X-Client-Type', 'X-Client-Version', 'X-Client-Source-Sha',
                                'accept', 'X-Request-Id',
                                # 表格公开分享密码头：正典 X-Table-Share-Password；
                                # X-Share-Password 为历史兼容。
                                'X-Table-Share-Id', 'X-Table-Share-Password', 'X-Share-Password',
                                'X-TabTin-Parent-Document-Id']
        # 跨域 fetch 默认只暴露简单响应头；下载类接口（如文档导出 DOCX）从
        # Content-Disposition 解析文件名，必须显式暴露，否则前端读不到、文件名
        # 退化成默认值（：导出 DOCX 命名为 document.docx）。
        self.expose_headers = [
            'Content-Disposition',
            'X-TabTin-Embedded-Access-Unavailable',
        ]
        self.max_age = 86400

    _CUSTOM_DOMAIN_CACHE_KEY = 'tabsite:cors_custom_domains'
    _CUSTOM_DOMAIN_CACHE_TTL = 300  # 5 分钟

    def _origin_allowed(self, origin: str | None) -> bool:
        if not origin:
            return False
        if self.allowed_origins == ['*']:
            return True
        if origin in self.allowed_origins:
            return True
        return self._is_tabsite_custom_domain(origin)

    def _is_tabsite_custom_domain(self, origin: str) -> bool:
        """检查 origin 是否匹配 TabSite 站点的自定义域名（带缓存）。"""
        try:
            from django.core.cache import cache
            custom_domains = cache.get(self._CUSTOM_DOMAIN_CACHE_KEY)
            if custom_domains is None:
                from apps.tabsite.models import Site
                raw_domains = (
                    Site.objects
                    .exclude(custom_domain__isnull=True)
                    .exclude(custom_domain='')
                    .exclude(status=Site.Status.ARCHIVED)
                    .values_list('custom_domain', flat=True)
                )
                custom_domains = set()
                for d in raw_domains:
                    if d:
                        custom_domains.add(f'https://{d}')
                        custom_domains.add(f'http://{d}')
                cache.set(self._CUSTOM_DOMAIN_CACHE_KEY, custom_domains, self._CUSTOM_DOMAIN_CACHE_TTL)
            return origin in custom_domains
        except Exception:
            logger.warning("[CORS] 查询 TabSite 自定义域名失败，跳过动态检查")
            return False

    def _set_cors_headers(self, response: HttpResponse, origin: str | None) -> None:
        if self._origin_allowed(origin):
            response['Access-Control-Allow-Origin'] = origin
            response['Access-Control-Allow-Credentials'] = 'true'
            response['Vary'] = 'Origin'
        elif self.allowed_origins == ['*']:
            response['Access-Control-Allow-Origin'] = '*'
        else:
            if origin:
                logger.warning(
                    "[CORS] Origin 被拒绝: origin=%s, allowed=%s",
                    origin, ','.join(self.allowed_origins[:5]),
                )
        response['Access-Control-Allow-Methods'] = ', '.join(self.allowed_methods)
        response['Access-Control-Allow-Headers'] = ', '.join(self.allowed_headers)
        response['Access-Control-Expose-Headers'] = ', '.join(self.expose_headers)
        response['Access-Control-Max-Age'] = str(self.max_age)

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        origin = request.META.get('HTTP_ORIGIN')
        self._set_cors_headers(response, origin)
        return response

    def process_request(self, request: HttpRequest) -> HttpResponse:
        if request.method == 'OPTIONS':
            origin = request.META.get('HTTP_ORIGIN')
            response = HttpResponse()
            self._set_cors_headers(response, origin)
            return response
        return None


class SecurityHeadersMiddleware(MiddlewareMixin):
    """安全头中间件

    只补**默认值**：视图若已显式声明自己的嵌入 / 内容策略，这里一律让路。
    需要被跨源 iframe 嵌入的响应（如 TabDoc htmlBlock 的 HTML artifact，见
    ``apps.services.oss.api.local_object``）由视图设 ``xframe_options_exempt``
    与 ``csp_override`` 并自带 ``Content-Security-Policy``——策略写在产出响应的
    地方，只有一处，不靠再挂一层中间件把这里写下的头删掉。

    让路的判据是**视图显式设的属性**，不是「响应里碰巧已有该头」：后者是
    fail-open——任何头注入或误拷上游头都会让全局 CSP 静默消失。
    """

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        """添加安全头"""
        # 防止点击劫持。语义与 Django 内置 XFrameOptionsMiddleware 对齐：
        # 视图标了豁免就不写，否则该响应会同时挨 DENY 和 frame-ancestors 两道拦截。
        if not getattr(response, 'xframe_options_exempt', False):
            response['X-Frame-Options'] = 'DENY'

        # 防止MIME类型嗅探
        response['X-Content-Type-Options'] = 'nosniff'

        # 禁用已废弃的 XSS 审计器（现代浏览器已移除，旧值 '1; mode=block' 反而可能被利用）
        response['X-XSS-Protection'] = '0'

        # HSTS 仅在 HTTPS 请求时设置（浏览器会忽略 HTTP 响应中的 HSTS 头）
        # Django SecurityMiddleware 也可能设置此头，此处做去重避免冗余
        if getattr(request, 'is_secure', lambda: False)() and 'Strict-Transport-Security' not in response:
            response['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'

        if not getattr(response, 'csp_override', False):
            response['Content-Security-Policy'] = (
                "default-src 'self'; "
                "script-src 'self'; "
                "style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: https:; "
                "font-src 'self'; "
                "object-src 'none'; "
                "frame-ancestors 'none'; "
                "base-uri 'self'; "
                "form-action 'self'"
            )

        # 引用策略
        response['Referrer-Policy'] = 'strict-origin-when-cross-origin'

        return response


class HealthCheckMiddleware(MiddlewareMixin):
    """健康检查中间件

    - /health, /ping — 进程存活检查（快速，不探测依赖）
    - /health/ready — 深度就绪检查（探测 PostgreSQL、Redis、local 对象卷）
    """

    def process_request(self, request: HttpRequest) -> HttpResponse:
        if request.path in ['/health', '/health/', '/ping', '/ping/']:
            return HttpResponse(
                '{"status": "healthy", "timestamp": "' + str(int(time.time())) + '"}',
                content_type='application/json'
            )

        if request.path in ['/health/ready', '/health/ready/']:
            return self._deep_health_check(request)

        return None

    @staticmethod
    def _deep_health_check(request) -> HttpResponse:
        """BI-42: 认证后返回详细状态，未认证只返回 ok/degraded。"""
        import json
        from django.conf import settings as _settings

        checks = {}
        all_ok = True

        try:
            from django.db import connections
            cursor = connections['default'].cursor()
            cursor.execute("SELECT 1")
            cursor.close()
            checks['postgresql'] = 'ok'
        except Exception as exc:
            checks['postgresql'] = 'error'
            all_ok = False

        try:
            from django_redis import get_redis_connection
            r = get_redis_connection("default")
            r.ping()
            checks['redis'] = 'ok'
        except Exception as exc:
            checks['redis'] = 'error'
            all_ok = False

        if getattr(_settings, 'SERVICES_OSS_PROVIDER', '').lower() == 'local':
            try:
                from apps.services.oss.services.factory import get_oss_service

                if not get_oss_service().validate_config():
                    raise RuntimeError("local object storage health probe failed")
                checks['object_storage'] = 'ok'
            except Exception:
                logger.error("local object storage readiness probe failed", exc_info=True)
                checks['object_storage'] = 'error'
                all_ok = False

        status_code = 200 if all_ok else 503

        is_authorized = False
        health_token = getattr(_settings, 'HEALTH_CHECK_TOKEN', '')
        if health_token:
            auth_header = request.META.get('HTTP_AUTHORIZATION', '')
            if auth_header == f'Bearer {health_token}':
                is_authorized = True

        if is_authorized:
            body = json.dumps({
                'status': 'ready' if all_ok else 'degraded',
                'timestamp': int(time.time()),
                'checks': checks,
            })
        else:
            body = json.dumps({
                'status': 'ready' if all_ok else 'degraded',
                'timestamp': int(time.time()),
            })
        return HttpResponse(body, content_type='application/json', status=status_code)


class APITrailingSlashMiddleware(MiddlewareMixin):
    """
    对 /api/ 路径做双向尾部斜杠容错：
    - 客户端发 /projects 但服务端定义 /projects/  → 内部重写加斜杠
    - 客户端发 /documents/ 但服务端定义 /documents → 内部重写去斜杠

    替代 CommonMiddleware 的 APPEND_SLASH 301 重定向，避免 URLSession / OkHttp
    在跟随重定向时剥离 Authorization 头（RFC 7235 安全策略）。
    此中间件必须放在 CommonMiddleware 之前。
    """

    def process_request(self, request: HttpRequest):
        path = request.path_info
        if not path.startswith('/api/'):
            return None

        from django.urls import is_valid_path
        urlconf = getattr(request, 'urlconf', None)

        if is_valid_path(path, urlconf):
            return None

        alt_path = path[:-1] if path.endswith('/') else path + '/'
        if is_valid_path(alt_path, urlconf):
            request.path_info = alt_path
            request.path = alt_path
        return None


class SensitivePathBlockMiddleware(MiddlewareMixin):
    """拦截对敏感隐藏文件/目录的探测"""

    # 拦截的敏感段落与扩展名（统一小写比较）
    SENSITIVE_SEGMENTS = {
        '.env', '.git', '.svn', '.hg', '.ds_store',
        '.htpasswd', '.htaccess', '.ssh', '.aws',
        '.bash_history', '.docker', '.idea', '.vscode'
    }
    SENSITIVE_EXTENSIONS = ('.bak', '.backup', '.swp', '.sql', '.tar.gz', '.zip')

    def process_request(self, request: HttpRequest) -> HttpResponse:
        path = (request.path or '').lower()
        # 检测路径中包含的敏感段落或危险后缀
        has_sensitive_segment = any(f'/{segment}' in path for segment in self.SENSITIVE_SEGMENTS)
        has_sensitive_ext = path.endswith(self.SENSITIVE_EXTENSIONS)

        if has_sensitive_segment or has_sensitive_ext:
            client_ip = get_client_ip(request)
            logger.warning(
                "拦截可疑文件探测",
                extra={
                    'path': request.path,
                    'method': request.method,
                    'client_ip': client_ip,
                    'user_agent': request.META.get('HTTP_USER_AGENT', ''),
                },
            )
            return HttpResponse(
                '{"detail": "Forbidden"}',
                status=403,
                content_type='application/json'
            )

        return None


def get_request_id(request: HttpRequest) -> str:
    """从请求中获取请求ID"""
    return getattr(request, 'request_id', 'unknown')


def log_api_call(request: HttpRequest, response: HttpResponse = None,
                exception: Exception = None) -> None:
    """记录API调用日志"""
    request_id = get_request_id(request)

    log_data = {
        'request_id': request_id,
        'method': request.method,
        'path': request.path,
        'user_agent': request.META.get('HTTP_USER_AGENT', ''),
        'remote_addr': request.META.get('REMOTE_ADDR', ''),
    }

    if response:
        log_data['status_code'] = response.status_code
        log_data['response_size'] = len(response.content) if hasattr(response, 'content') else 0

    if exception:
        log_data['exception'] = str(exception)
        log_data['exception_type'] = type(exception).__name__
        logger.error(f"API调用异常: {log_data}", exc_info=True)
    else:
        logger.info(f"API调用: {log_data}")


class UnicodeNormalizationMiddleware:
    """Unicode 输入规范化中间件。

    - 对 JSON 请求体的字符串值做 NFC 规范化（Unicode Normal Form Composed）
    - 检测并记录不可见 Unicode 字符（不强制清理——清理的责任在各业务层）
    - 检测 BiDi 方向控制字符并记录 warning
    - 跳过文件上传（multipart/form-data）和二进制内容
    - 跳过超过 1MB 的请求体（避免 OOM）

    通过 settings.UNICODE_NORMALIZATION_ENABLED 控制是否启用（默认 True）。
    """

    MAX_BODY_SIZE = 1 * 1024 * 1024  # 1MB

    def __init__(self, get_response: Callable):
        self.get_response = get_response
        from django.conf import settings as django_settings
        self.enabled = getattr(django_settings, 'UNICODE_NORMALIZATION_ENABLED', True)

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if self.enabled and self._should_process(request):
            self._process_json_body(request)
        return self.get_response(request)

    def _should_process(self, request: HttpRequest) -> bool:
        content_type = getattr(request, 'content_type', '') or ''
        if 'json' not in content_type:
            return False
        content_length = int(request.META.get('CONTENT_LENGTH') or 0)
        if content_length > self.MAX_BODY_SIZE:
            logger.debug(
                "[UnicodeNormalization] 跳过大请求体: %s %s (%d bytes)",
                request.method, request.path, content_length,
            )
            return False
        return True

    def _process_json_body(self, request: HttpRequest) -> None:
        try:
            body_bytes = request.body
        except Exception:
            return
        if not body_bytes:
            return

        try:
            data = json.loads(body_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return

        import unicodedata
        from .unicode_security import (
            contains_invisible_unicode,
            detect_bidi_controls,
        )

        changed = False
        invisible_fields: list[str] = []
        bidi_fields: list[str] = []

        def _normalize_value(value: Any, path: str) -> Any:
            nonlocal changed
            if isinstance(value, str):
                normalized = unicodedata.normalize("NFC", value)
                if normalized != value:
                    changed = True
                if contains_invisible_unicode(normalized, preserve_emoji=True):
                    invisible_fields.append(path)
                if detect_bidi_controls(normalized):
                    bidi_fields.append(path)
                return normalized
            elif isinstance(value, dict):
                return {
                    k: _normalize_value(v, f"{path}.{k}" if path else k)
                    for k, v in value.items()
                }
            elif isinstance(value, list):
                return [
                    _normalize_value(item, f"{path}[{i}]")
                    for i, item in enumerate(value)
                ]
            return value

        normalized_data = _normalize_value(data, "")

        if invisible_fields:
            logger.warning(
                "[UnicodeNormalization] %s %s: 检测到不可见字符 fields=%s",
                request.method, request.path, invisible_fields[:20],
            )

        if bidi_fields:
            logger.warning(
                "[UnicodeNormalization] %s %s: 检测到BiDi方向控制字符 fields=%s",
                request.method, request.path, bidi_fields[:20],
            )

        if changed:
            new_body = json.dumps(normalized_data, ensure_ascii=False).encode('utf-8')
            # Django 的 request.body 是只读属性，通过替换底层流来注入规范化后的数据
            request._body = new_body
            request._stream = __import__('io').BytesIO(new_body)
            request.META['CONTENT_LENGTH'] = str(len(new_body))


class RequestContextMiddleware(MiddlewareMixin):
    """请求上下文中间件"""

    def process_request(self, request: HttpRequest) -> None:
        """设置请求上下文"""
        # 设置请求开始时间
        request.start_time = time.time()

        # 设置请求ID — Wave 1 D3 行为对齐 RequestLoggingMiddleware：
        # 优先采用上游 X-Request-Id；没有再 generate。
        if not hasattr(request, 'request_id'):
            upstream_request_id = request.META.get('HTTP_X_REQUEST_ID', '').strip()
            request.request_id = (
                upstream_request_id if upstream_request_id else generate_request_id()
            )

        # 设置客户端信息
        request.client_ip = get_client_ip(request)
        request.user_agent = request.META.get('HTTP_USER_AGENT', '')

        # 设置请求大小
        request.content_length = int(request.META.get('CONTENT_LENGTH', 0))


class AgentRunContextMiddleware(MiddlewareMixin):
    """
    TD-1 / H-2：把 Agent 经 CLI 发起的请求所携带的 run/session 上下文还原到
    平台 ContextVar，供 tabdoc / tabdata / collab 等模块的 VersionHistory /
    ChangeLog 写入路径读取（`get_current_run_id()` / `get_current_session_id()`）。

    数据流：agent-runtime 注入 TABTIN_AGENT_RUN_ID / TABTIN_THREAD_ID env →
    CLI 子进程透成 `X-Tabtin-Agent-Run-Id` / `X-Tabtin-Session-Id` 请求头 →
    本中间件还原 ContextVar。run id 是 per-turn 资源归因锚点，session id 是
    业务对话维度。

    安全说明（MVP 取舍）：这两个头只影响**归因**（editor_type / agent_run_id），
    不影响**鉴权**，且永远搭在一个已通过 JWT 认证的请求上，故 MVP 阶段不做
    HMAC / 内部密钥校验。后续如需多租户对抗再加签名。
    """

    def process_request(self, request: HttpRequest) -> None:
        run_id = (
            request.headers.get("X-Tabtin-Agent-Run-Id")
            or request.META.get("HTTP_X_TABTIN_AGENT_RUN_ID")
        )
        session_id = (
            request.headers.get("X-Tabtin-Session-Id")
            or request.META.get("HTTP_X_TABTIN_SESSION_ID")
        )
        if not run_id and not session_id:
            return
        try:
            from apps.services.common.platform_context import (
                set_current_run_id,
                set_current_session_id,
            )
            if run_id:
                request._agent_run_id_token = set_current_run_id(run_id)
            if session_id:
                request._agent_session_id_token = set_current_session_id(session_id)
        except Exception:
            logger.warning("AgentRunContextMiddleware: 还原 run/session 上下文失败", exc_info=True)

    def _reset(self, request: HttpRequest) -> None:
        try:
            from apps.services.common.platform_context import (
                reset_current_run_id,
                reset_current_session_id,
            )
            run_token = getattr(request, "_agent_run_id_token", None)
            if run_token is not None:
                reset_current_run_id(run_token)
                request._agent_run_id_token = None
            session_token = getattr(request, "_agent_session_id_token", None)
            if session_token is not None:
                reset_current_session_id(session_token)
                request._agent_session_id_token = None
        except Exception:
            logger.debug("AgentRunContextMiddleware: 重置上下文失败", exc_info=True)

    def process_response(self, request: HttpRequest, response: HttpResponse) -> HttpResponse:
        self._reset(request)
        return response

    def process_exception(self, request: HttpRequest, exception: Exception) -> None:
        self._reset(request)

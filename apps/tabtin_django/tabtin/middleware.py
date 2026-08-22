"""Tabtin 项目级中间件。"""

import logging
import time
import uuid

logger = logging.getLogger(__name__)

_CENTRIFUGO_CONNECT_PATH = "/api/im/centrifugo/connect"


def _is_centrifugo_connect_request(request) -> bool:
    return getattr(request, "path", "") == _CENTRIFUGO_CONNECT_PATH


def _get_centrifugo_trace_id(request) -> str:
    trace_id = getattr(request, "_centrifugo_trace_id", "")
    if trace_id:
        return trace_id
    trace_id = uuid.uuid4().hex[:8]
    request._centrifugo_trace_id = trace_id
    return trace_id


class DeferredRouterMiddleware:
    """Deferred router 轻量兜底。

    非核心 router 的真实注册必须在启动阶段完成，不能在真实请求线程里触发
    大规模 import；否则高并发首包会堆在 import lock 前，表现为 API /
    Centrifugo connect 超时。

    本 middleware 仅保留诊断日志与防御性告警，不再在请求中调用
    ``register_deferred_routers()``。
    """

    _registered = True

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        trace_enabled = _is_centrifugo_connect_request(request)
        trace_id = _get_centrifugo_trace_id(request) if trace_enabled else ""
        started_at = time.perf_counter() if trace_enabled else 0.0

        if trace_enabled:
            logger.info(
                "[CentrifugoConnect:%s] middleware=deferred_router enter registered=%s",
                trace_id,
                DeferredRouterMiddleware._registered,
            )

        if not DeferredRouterMiddleware._registered:
            logger.warning(
                "[CentrifugoConnect:%s] middleware=deferred_router unexpected_unregistered_state",
                trace_id or "-",
            )

        response = self.get_response(request)

        if trace_enabled:
            logger.info(
                "[CentrifugoConnect:%s] middleware=deferred_router exit total_ms=%.1f",
                trace_id,
                (time.perf_counter() - started_at) * 1000,
            )

        return response

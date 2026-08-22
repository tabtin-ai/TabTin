"""Centrifugo HTTP API 封装。

通过 Centrifugo Server API 发布消息、获取在线状态等。

publish/broadcast 为 fire-and-forget（非关键事件）；
关键 IM 事件由持久 Outbox 调用 publish_sync/broadcast_sync；
presence/presence_stats 保持同步（需要返回值）。
文档：https://centrifugal.dev/docs/server/server_api
"""

from __future__ import annotations

import atexit
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests
from django.conf import settings

from apps.services.common.ws.circuit_breaker import CircuitBreaker
from apps.tabchat.services.centrifugo_runtime_sample import (
    build_publish_context,
    error_signature,
    record_publish_event,
)

logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(
    max_workers=getattr(settings, 'CENTRIFUGO_POOL_SIZE', 16),
    thread_name_prefix="centrifugo",
)
atexit.register(_executor.shutdown, wait=False)

_publish_semaphore = threading.Semaphore(64)

_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout=30.0, name="centrifugo")

# ── Prometheus 指标 ──

try:
    from prometheus_client import Counter, Gauge

    centrifugo_publish_total = Counter(
        'tabchat_centrifugo_publish_total',
        'Centrifugo publish attempts by method and outcome',
        ['method', 'status'],
    )
    centrifugo_backpressure_total = Counter(
        'tabchat_centrifugo_backpressure_total',
        'Centrifugo publishes dropped due to semaphore or circuit breaker',
        ['reason'],
    )
    centrifugo_pool_active = Gauge(
        'tabchat_centrifugo_pool_active_threads',
        'Number of active Centrifugo worker threads',
    )
    _metrics_available = True
except ImportError:
    _metrics_available = False
    centrifugo_publish_total = None
    centrifugo_backpressure_total = None
    centrifugo_pool_active = None


def _inc_metric(counter, **labels) -> None:
    if _metrics_available:
        counter.labels(**labels).inc()


class CentrifugoService:
    """Centrifugo HTTP API 客户端。"""

    def __init__(self):
        self.api_url = settings.CENTRIFUGO_API_URL
        self.api_key = settings.CENTRIFUGO_API_KEY
        self._headers = {
            "Content-Type": "application/json",
            "X-API-Key": self.api_key,
        }
        self._local = threading.local()

    def _get_session(self) -> requests.Session:
        """每个线程独立的 Session，避免 requests.Session 跨线程竞争。"""
        session = getattr(self._local, "session", None)
        if session is None:
            session = requests.Session()
            session.headers.update(self._headers)
            self._local.session = session
        return session

    def _sample_contexts(self, method: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        if method == "publish":
            return [build_publish_context(str(params.get("channel") or ""), params.get("data"))]
        if method == "broadcast":
            data = params.get("data")
            return [
                build_publish_context(str(channel), data)
                for channel in (params.get("channels") or [])
            ]
        return []

    def _record_samples(self, contexts: list[dict[str, Any]], **fields: Any) -> None:
        for context in contexts:
            try:
                record_publish_event(context, **fields)
            except Exception:
                logger.debug("[centrifugo] publish event sample skipped", exc_info=True)

    def _call(
        self,
        method: str,
        params: dict[str, Any],
        sample_contexts: list[dict[str, Any]] | None = None,
        *,
        raise_on_error: bool = False,
    ) -> dict:
        sample_contexts = sample_contexts or []
        started_at = time.perf_counter()
        if not _breaker.allow_request():
            logger.warning("[centrifugo] 断路器开启，跳过 API 调用: method=%s", method)
            _inc_metric(centrifugo_backpressure_total, reason="circuit_breaker")
            self._record_samples(
                sample_contexts,
                publish_failed=True,
                circuit_open=True,
                error_type="circuit_open",
                error_signature="circuit_open",
            )
            if raise_on_error:
                raise RuntimeError("Centrifugo circuit breaker is open")
            return {}
        if _metrics_available:
            centrifugo_pool_active.inc()
        try:
            resp = self._get_session().post(
                self.api_url,
                json={"method": method, "params": params},
                timeout=5,
            )
            resp.raise_for_status()
            result = resp.json()
            if "error" in result:
                logger.error("Centrifugo API error: %s", result["error"])
                _inc_metric(centrifugo_publish_total, method=method, status="api_error")
                self._record_samples(
                    sample_contexts,
                    publish_failed=True,
                    latency_ms=round((time.perf_counter() - started_at) * 1000, 2),
                    error_type="api_error",
                    error_signature=error_signature(json.dumps(result["error"], ensure_ascii=False)),
                )
                if raise_on_error:
                    raise RuntimeError(
                        f"Centrifugo API error: {json.dumps(result['error'], ensure_ascii=False)}"
                    )
            else:
                _inc_metric(centrifugo_publish_total, method=method, status="success")
                self._record_samples(
                    sample_contexts,
                    publish_accepted=True,
                    latency_ms=round((time.perf_counter() - started_at) * 1000, 2),
                )
            _breaker.record_success()
            return result
        except requests.RequestException as exc:
            logger.exception("Centrifugo API call failed: method=%s", method)
            _breaker.record_failure()
            _inc_metric(centrifugo_publish_total, method=method, status="failed")
            self._record_samples(
                sample_contexts,
                publish_failed=True,
                latency_ms=round((time.perf_counter() - started_at) * 1000, 2),
                error_type=exc.__class__.__name__,
                error_signature=error_signature(str(exc)),
            )
            if raise_on_error:
                raise
            return {}
        finally:
            if _metrics_available:
                centrifugo_pool_active.dec()

    def _fire_and_forget(self, method: str, params: dict[str, Any]) -> None:
        """提交到线程池异步执行，不阻塞调用线程。

        仅检查 state 做 OPEN 快速拒绝，不消耗 HALF_OPEN 探针权限。
        实际的 allow_request 判断完全由 _call 在线程池中执行，
        避免外层 + 内层双重 allow_request 导致 HALF_OPEN 永久卡死。
        """
        sample_contexts = self._sample_contexts(method, params)
        self._record_samples(sample_contexts, publish_attempted=True)
        if _breaker.state == CircuitBreaker.OPEN:
            logger.warning("[centrifugo] 断路器开启，丢弃异步调用: method=%s", method)
            _inc_metric(centrifugo_backpressure_total, reason="circuit_breaker")
            self._record_samples(
                sample_contexts,
                publish_failed=True,
                circuit_open=True,
                error_type="circuit_open",
                error_signature="circuit_open",
            )
            return

        if not _publish_semaphore.acquire(blocking=False):
            logger.warning("[centrifugo] 并发发布已满，丢弃: method=%s", method)
            _inc_metric(centrifugo_backpressure_total, reason="semaphore_full")
            self._record_samples(
                sample_contexts,
                publish_failed=True,
                backpressure=True,
                error_type="backpressure",
                error_signature="semaphore_full",
            )
            return

        try:
            future = _executor.submit(self._call, method, params, sample_contexts)
            future.add_done_callback(_on_future_done)
        except RuntimeError:
            _publish_semaphore.release()
            logger.warning("[centrifugo] 线程池已关闭，丢弃: method=%s", method)
            self._record_samples(
                sample_contexts,
                publish_failed=True,
                backpressure=True,
                error_type="executor_closed",
                error_signature="executor_closed",
            )

    def publish(self, channel: str, data: dict) -> None:
        """向指定频道发布消息（异步，不阻塞，不重试）。"""
        self._fire_and_forget("publish", {"channel": channel, "data": data})

    def broadcast(self, channels: list[str], data: dict) -> None:
        """向多个频道广播相同消息（异步，不阻塞，不重试）。"""
        self._fire_and_forget("broadcast", {"channels": channels, "data": data})

    def publish_sync(self, channel: str, data: dict) -> dict:
        """同步发布（需等待结果时使用）。"""
        params = {"channel": channel, "data": data}
        sample_contexts = self._sample_contexts("publish", params)
        self._record_samples(sample_contexts, publish_attempted=True)
        return self._call(
            "publish",
            params,
            sample_contexts,
            raise_on_error=True,
        )

    def broadcast_sync(self, channels: list[str], data: dict) -> dict:
        """同步批量发布；供持久 Outbox Worker 判定成功或失败。"""
        params = {"channels": channels, "data": data}
        sample_contexts = self._sample_contexts("broadcast", params)
        self._record_samples(sample_contexts, publish_attempted=True)
        return self._call(
            "broadcast",
            params,
            sample_contexts,
            raise_on_error=True,
        )

    def presence(self, channel: str) -> dict:
        """获取频道在线用户列表（同步，需要返回值）。"""
        result = self._call("presence", {"channel": channel})
        return result.get("result", {}).get("presence", {})

    def presence_stats(self, channel: str) -> dict:
        """获取频道在线统计（同步，需要返回值）。"""
        result = self._call("presence_stats", {"channel": channel})
        return result.get("result", {})

    def unsubscribe(self, user: str, channel: str) -> None:
        """强制取消用户对频道的订阅（异步）。"""
        self._fire_and_forget("unsubscribe", {"user": user, "channel": channel})

    def unsubscribe_sync(self, user: str, channel: str) -> dict:
        """同步取消订阅；组织权限撤销必须在后续事件发布前完成。"""
        return self._call("unsubscribe", {"user": user, "channel": channel}, raise_on_error=True)

    def disconnect(self, user: str) -> None:
        """强制断开用户所有连接（异步）。"""
        self._fire_and_forget("disconnect", {"user": user})


def _on_future_done(future) -> None:
    """Future 完成回调，释放 semaphore 并捕获未处理异常。"""
    _publish_semaphore.release()
    exc = future.exception()
    if exc is not None:
        logger.warning("[centrifugo] 异步调用未预期异常: %s", exc)
        _breaker.record_failure()


_centrifugo_service: CentrifugoService | None = None
_centrifugo_service_lock = threading.Lock()


def get_centrifugo_service() -> CentrifugoService:
    global _centrifugo_service
    if _centrifugo_service is None:
        with _centrifugo_service_lock:
            if _centrifugo_service is None:
                _centrifugo_service = CentrifugoService()
    return _centrifugo_service

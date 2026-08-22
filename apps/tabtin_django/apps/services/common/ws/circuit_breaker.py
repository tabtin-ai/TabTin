"""Shared circuit breaker for downstream service protection.

CLOSED →(连续失败 ≥ threshold)→ OPEN →(等待 recovery_timeout)→ HALF_OPEN
HALF_OPEN → 试探成功 → CLOSED / 试探失败 → OPEN

HALF_OPEN 状态下仅放行一个试探请求（CAS 控制），避免多线程同时进入。
"""

from __future__ import annotations

import logging
import threading
import time

from prometheus_client import Counter, Gauge

logger = logging.getLogger(__name__)

_STATE_VALUE = {"closed": 0, "open": 1, "half_open": 2}

_cb_state_gauge = Gauge(
    "ws_circuit_breaker_state",
    "Current circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)",
    ["name"],
)

_cb_transitions_total = Counter(
    "ws_circuit_breaker_transitions_total",
    "Circuit breaker state transitions",
    ["name", "from_state", "to_state"],
)

_cb_rejected_total = Counter(
    "ws_circuit_breaker_requests_rejected_total",
    "Requests rejected by circuit breaker",
    ["name"],
)


class CircuitBreaker:
    """线程安全断路器，防止下游服务故障时持续无意义重试。"""

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: float = 30.0,
        name: str = "circuit_breaker",
        on_recovery=None,
    ):
        self._failure_threshold = failure_threshold
        self._recovery_timeout = recovery_timeout
        self._name = name
        self._on_recovery = on_recovery
        self._failure_count = 0
        self._last_failure_time = 0.0
        self._state = self.CLOSED
        self._half_open_permitted = False
        self._lock = threading.Lock()
        _cb_state_gauge.labels(name=self._name).set(_STATE_VALUE[self.CLOSED])

    @property
    def state(self) -> str:
        """只读属性：获取当前状态（含 OPEN→HALF_OPEN 超时转换）。

        不消耗 HALF_OPEN 探针权限，适用于外层快速拒绝判断。
        """
        with self._lock:
            return self._evaluate_state()

    def _evaluate_state(self) -> str:
        """持锁情况下评估状态转换（OPEN 超时 → HALF_OPEN）。"""
        if self._state == self.OPEN:
            if time.monotonic() - self._last_failure_time >= self._recovery_timeout:
                old_state = self._state
                self._state = self.HALF_OPEN
                self._half_open_permitted = False
                self._record_transition(old_state, self._state)
                logger.warning("[%s] OPEN → HALF_OPEN，允许试探调用", self._name)
        return self._state

    def allow_request(self) -> bool:
        with self._lock:
            state = self._evaluate_state()
            if state == self.CLOSED:
                return True
            if state == self.OPEN:
                _cb_rejected_total.labels(name=self._name).inc()
                return False
            # HALF_OPEN: CAS — 仅第一个线程获得试探权
            if not self._half_open_permitted:
                self._half_open_permitted = True
                return True
            _cb_rejected_total.labels(name=self._name).inc()
            return False

    def record_success(self) -> None:
        should_notify = False
        with self._lock:
            old_state = self._state
            if self._state == self.HALF_OPEN:
                logger.warning("[%s] 试探成功，HALF_OPEN → CLOSED", self._name)
            self._failure_count = 0
            self._state = self.CLOSED
            self._half_open_permitted = False
            if old_state != self.CLOSED:
                self._record_transition(old_state, self.CLOSED)
                should_notify = True
        # RV-02: 回调在锁释放后执行，防止阻塞
        if should_notify and self._on_recovery:
            try:
                self._on_recovery()
            except Exception:
                logger.warning("[%s] on_recovery callback failed", self._name)

    def record_failure(self) -> None:
        with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.monotonic()
            if self._state == self.HALF_OPEN:
                old_state = self._state
                self._state = self.OPEN
                self._half_open_permitted = False
                self._record_transition(old_state, self.OPEN)
                logger.warning(
                    "[%s] 试探失败，HALF_OPEN → OPEN (冷却 %ds)",
                    self._name, self._recovery_timeout,
                )
            elif self._failure_count >= self._failure_threshold:
                old_state = self._state
                self._state = self.OPEN
                self._record_transition(old_state, self.OPEN)
                logger.warning(
                    "[%s] 连续失败 %d 次，CLOSED → OPEN (冷却 %ds)",
                    self._name, self._failure_count, self._recovery_timeout,
                )

    def _record_transition(self, from_state: str, to_state: str) -> None:
        """记录状态转换指标（调用时必须持有 _lock）。"""
        _cb_state_gauge.labels(name=self._name).set(_STATE_VALUE[to_state])
        _cb_transitions_total.labels(
            name=self._name, from_state=from_state, to_state=to_state,
        ).inc()

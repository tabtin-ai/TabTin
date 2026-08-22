from __future__ import annotations

import json
import logging
import warnings
from typing import Any, Dict, Optional

import redis
from django.conf import settings

from apps.services.common.agent_protocol.namespace import device_action_topic, redis_key
from apps.services.common.ws.bus import publish_ws_event
from apps.services.common.ws.protocol import build_envelope

logger = logging.getLogger(__name__)

REFRESH_REQUEST_TYPE = "device.capabilities.refresh.request"
REFRESH_ACK_TYPE = "device.capabilities.refresh.ack"
REFRESH_RESULT_TYPE = "device.capabilities.refresh.result"

DEFAULT_RESULT_TTL = 120


class CapabilityRefreshTransport:
    def __init__(self) -> None:
        self._redis_client: Optional[redis.Redis] = None

    @property
    def redis_client(self) -> redis.Redis:
        """Lazy-init Redis client.

        G-075: 移除每次访问时的 ping()，避免高频 refresh 场景多余网络往返。
        G-076: 任何连接异常时重置 _redis_client 为 None，允许下次自动恢复。
        """
        if self._redis_client is None:
            try:
                from django_redis import get_redis_connection
                self._redis_client = get_redis_connection("default")
            except Exception:
                self._redis_client = redis.Redis(
                    host=getattr(settings, "REDIS_HOST", "localhost"),
                    port=getattr(settings, "REDIS_PORT", 6379),
                    db=getattr(settings, "REDIS_DB", 0),
                    decode_responses=True,
                )
        return self._redis_client

    def _reset_redis(self) -> None:
        """G-076: 连接异常时重置，允许下次 redis_client 访问重新初始化。"""
        self._redis_client = None

    @staticmethod
    def ack_key(refresh_request_id: str) -> str:
        return redis_key(["capability_refresh_ack", refresh_request_id])

    @staticmethod
    def result_key(refresh_request_id: str) -> str:
        return redis_key(["capability_refresh_result", refresh_request_id])

    def publish_refresh_request(
        self,
        *,
        refresh_request_id: str,
        organization_id: str,
        device_fingerprint: str,
        payload: Dict[str, Any],
    ) -> bool:
        envelope = build_envelope(
            REFRESH_REQUEST_TYPE,
            refresh_request_id,
            {
                "refresh_request_id": refresh_request_id,
                **payload,
            },
            organization_id=organization_id,
        )
        topic = device_action_topic(device_fingerprint)
        return publish_ws_event(topic, envelope)

    def publish_refresh_request_async(
        self,
        *,
        refresh_request_id: str,
        organization_id: str,
        device_fingerprint: str,
        payload: Dict[str, Any],
    ) -> bool:
        """G-034: 非阻塞发布 refresh request，不等待 ack/result。

        仅发布请求到设备 WS topic，设备响应通过 WS callback 路径回传。
        """
        return self.publish_refresh_request(
            refresh_request_id=refresh_request_id,
            organization_id=organization_id,
            device_fingerprint=device_fingerprint,
            payload=payload,
        )

    def wait_for_ack(self, refresh_request_id: str, timeout_seconds: int) -> Optional[Dict[str, Any]]:
        """.. deprecated:: G-034 同步阻塞等待 ack，新代码请使用 WS callback 路径。"""
        warnings.warn(
            "wait_for_ack() is deprecated (G-034). Use WS callback path instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self._wait_for_payload(self.ack_key(refresh_request_id), timeout_seconds)

    def wait_for_result(self, refresh_request_id: str, timeout_seconds: int) -> Optional[Dict[str, Any]]:
        """.. deprecated:: G-034 同步阻塞等待 result，新代码请使用 WS callback 路径。"""
        warnings.warn(
            "wait_for_result() is deprecated (G-034). Use WS callback path instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self._wait_for_payload(self.result_key(refresh_request_id), timeout_seconds)

    def store_ack(self, refresh_request_id: str, payload: Dict[str, Any], ttl: int = DEFAULT_RESULT_TTL) -> None:
        self._store_payload(self.ack_key(refresh_request_id), payload, ttl=ttl)

    def store_result(self, refresh_request_id: str, payload: Dict[str, Any], ttl: int = DEFAULT_RESULT_TTL) -> None:
        self._store_payload(self.result_key(refresh_request_id), payload, ttl=ttl)

    def _store_payload(self, key: str, payload: Dict[str, Any], ttl: int = DEFAULT_RESULT_TTL) -> None:
        body = json.dumps(payload, ensure_ascii=False)
        try:
            self.redis_client.lpush(key, body)
            self.redis_client.expire(key, ttl)
        except (redis.ConnectionError, redis.TimeoutError, ConnectionError, OSError) as exc:
            self._reset_redis()
            raise exc

    def _wait_for_payload(self, key: str, timeout_seconds: int) -> Optional[Dict[str, Any]]:
        try:
            result = self.redis_client.brpop([key], timeout=timeout_seconds)
        except (redis.ConnectionError, redis.TimeoutError, ConnectionError, OSError) as exc:
            self._reset_redis()
            logger.warning("[CapabilityRefreshTransport] Redis connection error during brpop: %s", exc)
            return None
        if result is None:
            return None
        _, raw = result
        try:
            return json.loads(raw)
        except Exception as exc:
            logger.warning("[CapabilityRefreshTransport] invalid payload at %s: %s", key, exc)
            return None


__all__ = [
    "CapabilityRefreshTransport",
    "DEFAULT_RESULT_TTL",
    "REFRESH_ACK_TYPE",
    "REFRESH_REQUEST_TYPE",
    "REFRESH_RESULT_TYPE",
]

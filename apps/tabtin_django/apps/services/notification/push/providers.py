"""原生 Apple Push Notification service provider。

iOS 客户端直接上报 APNs device token；服务端使用 Apple `.p8` key 生成
ES256 provider token，并通过 APNs HTTP/2 API 投递。推送是尽力而为的叫醒
通道，业务数据仍由 App 打开后从主链路读取。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx
import jwt
from django.conf import settings

logger = logging.getLogger(__name__)


@dataclass
class PushMessage:
    title: str
    body: str
    ext: dict[str, Any] = field(default_factory=dict)
    """透传给客户端的深链数据（scene / organization_id / session_id …）。"""


@dataclass
class PushSendResult:
    ok: bool
    invalid_registration_ids: list[str] = field(default_factory=list)
    """APNs 明确判定失效的 device token，调用方应置 inactive。"""
    error: str = ""


class PushProvider(Protocol):
    provider_name: str

    def send(self, registration_ids: list[str], message: PushMessage) -> PushSendResult: ...


class APNsPushProvider:
    """使用 token-based authentication 直连 APNs HTTP/2 API。"""

    provider_name = "apns"
    _INVALID_REASONS = frozenset({
        "BadDeviceToken",
        "DeviceTokenNotForTopic",
        "Unregistered",
    })
    _TOKEN_REFRESH_SECONDS = 50 * 60
    _MAX_CONCURRENT_REQUESTS = 10

    def __init__(
        self,
        *,
        team_id: str | None = None,
        key_id: str | None = None,
        private_key: str | None = None,
        bundle_id: str | None = None,
        environment: str = "production",
        client: httpx.Client | Any | None = None,
    ):
        self.team_id = team_id if team_id is not None else getattr(settings, "APNS_TEAM_ID", "")
        self.key_id = key_id if key_id is not None else getattr(settings, "APNS_KEY_ID", "")
        self.private_key = (
            private_key if private_key is not None else self._private_key_from_settings()
        )
        self.bundle_id = (
            bundle_id if bundle_id is not None else getattr(settings, "APNS_BUNDLE_ID", "")
        )
        self.environment = "sandbox" if environment == "sandbox" else "production"
        # 延迟创建 HTTP/2 client：未配置环境仍需能安全启动并降级为 WS-only。
        self.client = client
        self._cached_token = ""
        self._cached_token_issued_at = 0
        self._token_lock = threading.Lock()

    @staticmethod
    def _private_key_from_settings() -> str:
        inline = str(getattr(settings, "APNS_PRIVATE_KEY", "") or "")
        if inline:
            return inline.replace("\\n", "\n")
        path = str(getattr(settings, "APNS_PRIVATE_KEY_PATH", "") or "").strip()
        if not path:
            return ""
        try:
            return Path(path).expanduser().read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning("[Push] APNs private key unreadable: %s", exc)
            return ""

    @property
    def configured(self) -> bool:
        return bool(self.team_id and self.key_id and self.private_key and self.bundle_id)

    @property
    def api_base(self) -> str:
        if self.environment == "sandbox":
            return "https://api.sandbox.push.apple.com"
        return "https://api.push.apple.com"

    def _provider_token(self) -> str:
        now = int(time.time())
        with self._token_lock:
            if (
                self._cached_token
                and now - self._cached_token_issued_at < self._TOKEN_REFRESH_SECONDS
            ):
                return self._cached_token
            self._cached_token = jwt.encode(
                {"iss": self.team_id, "iat": now},
                self.private_key,
                algorithm="ES256",
                headers={"kid": self.key_id},
            )
            self._cached_token_issued_at = now
            return self._cached_token

    def send(self, registration_ids: list[str], message: PushMessage) -> PushSendResult:
        if not registration_ids:
            return PushSendResult(ok=True)
        if not self.configured:
            return PushSendResult(ok=False, error="APNs not configured")

        if self.client is None:
            self.client = httpx.Client(http2=True, timeout=10.0)

        try:
            provider_token = self._provider_token()
        except Exception as exc:
            logger.warning("[Push] APNs provider token generation failed: %s", exc)
            return PushSendResult(ok=False, error=f"APNs authentication failed: {exc}")

        headers = {
            "authorization": f"bearer {provider_token}",
            "apns-topic": self.bundle_id,
            "apns-push-type": "alert",
            "apns-priority": "10",
        }
        payload = {
            "aps": {
                "alert": {
                    "title": message.title[:64],
                    "body": message.body[:256],
                },
                "sound": "default",
            },
            # 保持客户端现有路由解析契约；系统字段之外的 ext 会原样交给 App。
            "ext": json.dumps(message.ext, ensure_ascii=False, separators=(",", ":")),
        }
        invalid: list[str] = []
        errors: list[str] = []
        sent = 0

        executor = ThreadPoolExecutor(
            max_workers=min(self._MAX_CONCURRENT_REQUESTS, len(registration_ids)),
            thread_name_prefix="apns",
        )
        futures = {
            executor.submit(
                self.client.post,
                f"{self.api_base}/3/device/{quote(registration_id, safe='')}",
                headers=headers,
                json=payload,
            ): registration_id
            for registration_id in registration_ids
        }
        try:
            completed = as_completed(futures)
            for future in completed:
                registration_id = futures[future]
                try:
                    response = future.result()
                except httpx.HTTPError as exc:
                    logger.warning("[Push] APNs request failed: %s", exc)
                    errors.append(str(exc))
                    continue

                if response.status_code == 200:
                    sent += 1
                    continue

                try:
                    reason = str(response.json().get("reason") or f"HTTP {response.status_code}")
                except (ValueError, AttributeError):
                    reason = f"HTTP {response.status_code}"
                if response.status_code == 410 or reason in self._INVALID_REASONS:
                    invalid.append(registration_id)
                else:
                    errors.append(reason)
                logger.warning(
                    "[Push] APNs rejected token: status=%s reason=%s environment=%s",
                    response.status_code,
                    reason,
                    self.environment,
                )
        finally:
            # Celery SoftTimeLimitExceeded 等控制流必须立即上抛，不能在 context
            # manager 退出时继续等待仍在运行的网络线程直到 hard time limit。
            executor.shutdown(wait=False, cancel_futures=True)

        return PushSendResult(
            ok=sent > 0,
            invalid_registration_ids=invalid,
            error="; ".join(dict.fromkeys(errors))[:500],
        )


@lru_cache(maxsize=2)
def get_push_provider(environment: str = "production") -> APNsPushProvider:
    return APNsPushProvider(environment=environment)


def is_push_enabled() -> bool:
    return get_push_provider("production").configured

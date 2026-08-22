"""Slack Bot API adapter.

使用 httpx 直接调用 Slack Web API，无需引入 slack_sdk。
Slack 适配器实现设计说明。

支持：
- Webhook 事件回调解析（event_callback → message）
- URL verification challenge
- 请求签名验证（HMAC-SHA256）
- 时间戳防重放（5分钟容忍度）
- 发送文本消息（chat.postMessage，支持 thread_ts + 长文本分片）
- 发送媒体文件（files.upload v2 或降级为链接文本）
- 连通性 Probe（auth.test）
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any, Dict, List, Optional

import httpx
from django.core.cache import cache
from django.http import HttpRequest

from apps.channel_gateway.models import ChannelAccount
from apps.channel_gateway.schemas import (
    CHANNEL_PROTOCOL_VERSION,
    ChannelInboundMessage,
    ChannelMedia,
)

from .base import (
    ChannelAdapter,
    ChannelCapabilities,
    ProbeResult,
    SendResult,
    WebhookChallengeResponse,
)

logger = logging.getLogger(__name__)

SLACK_API_BASE = "https://slack.com/api"
TEXT_CHUNK_LIMIT = 4000  # Slack 单条消息最大约 40k 字符，保守分片
TIMESTAMP_TOLERANCE_SECONDS = 300  # 5 分钟 — 超出则视为重放


def _extract_bot_token(account: ChannelAccount) -> str:
    """从 account.config 读取 bot_token。"""
    config = account.config or {}
    token = (config.get("bot_token") or "").strip()
    if not token:
        raise ValueError("bot_token 未配置")
    return token


def _check_timestamp_freshness(ts: str) -> bool:
    """拒绝超过 TIMESTAMP_TOLERANCE_SECONDS 的请求（防重放）。"""
    if not ts:
        return False
    try:
        request_ts = int(ts)
    except (ValueError, TypeError):
        return False
    return abs(int(time.time()) - request_ts) <= TIMESTAMP_TOLERANCE_SECONDS


def _verify_slack_signature(
    signing_secret: str,
    timestamp: str,
    body: bytes,
    expected_signature: str,
) -> bool:
    """Slack 请求签名校验（HMAC-SHA256）。

    格式: v0=hmac(signing_secret, "v0:{timestamp}:{body}")
    使用 hmac.compare_digest 做恒定时间比较，防时序侧信道。
    """
    try:
        body_str = body.decode("utf-8")
    except UnicodeDecodeError:
        return False

    sig_basestring = f"v0:{timestamp}:{body_str}"
    computed = "v0=" + hmac.new(
        signing_secret.encode("utf-8"),
        sig_basestring.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(computed, expected_signature)


def _determine_peer_kind(channel_type: str) -> str:
    """将 Slack channel_type 映射为我们的 peer_kind。"""
    if channel_type == "im":
        return "dm"
    return "group"


def _extract_media_from_files(files: list) -> Optional[List[ChannelMedia]]:
    """从 Slack message 的 files 数组提取媒体附件。"""
    if not files:
        return None

    items: List[ChannelMedia] = []
    for f in files:
        if not isinstance(f, dict):
            continue

        mimetype = f.get("mimetype", "")
        if mimetype.startswith("image/"):
            kind = "image"
        elif mimetype.startswith("video/"):
            kind = "video"
        elif mimetype.startswith("audio/"):
            kind = "audio"
        else:
            kind = "file"

        url = (
            f.get("url_private_download")
            or f.get("url_private")
            or f.get("permalink")
            or ""
        )
        items.append(ChannelMedia(
            kind=kind,
            url=url or None,
            file_id=f.get("id"),
            mime_type=mimetype or None,
            filename=f.get("name"),
            size=f.get("size"),
        ))

    return items if items else None


class SlackAdapter(ChannelAdapter):
    """Slack Bot API channel adapter。"""

    @property
    def id(self) -> str:
        return "slack"

    @property
    def name(self) -> str:
        return "Slack"

    @property
    def description(self) -> str:
        return "通过 Slack Bot 收发消息，将 Slack 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "slack"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group", "channel"],
            media=True,
            threads=True,
            reactions=True,
        )

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="bot_token",
                label="Bot Token",
                field_type="password",
                required=True,
                help_text="Slack Bot User OAuth Token（以 xoxb- 开头）",
            ),
            ConfigField(
                key="signing_secret",
                label="Signing Secret",
                field_type="password",
                help_text="Slack App 的 Signing Secret（Webhook 签名验证用，可选）",
            ),
        ]

    def get_event_types(self) -> list:
        from apps.extensions.base import EventDescriptor, PayloadField
        return [
            EventDescriptor(
                event_type="slack.message_received",
                description="收到 Slack 消息",
                payload_fields=[
                    PayloadField(key="channel_id", label="频道 ID", example="C01ABC23DEF"),
                    PayloadField(key="sender_id", label="发送者 User ID", example="U01ABC23DEF"),
                    PayloadField(key="text", label="消息内容", example="你好"),
                    PayloadField(key="channel_type", label="频道类型", example="im"),
                    PayloadField(key="peer_kind", label="会话类型", example="dm"),
                    PayloadField(key="message_ts", label="消息时间戳", example="1234567890.123456"),
                    PayloadField(key="thread_ts", label="线程时间戳", example="1234567890.000001"),
                ],
            ),
            EventDescriptor(
                event_type="slack.command_received",
                description="收到 Slack 斜杠命令或以 / 开头的消息",
                payload_fields=[
                    PayloadField(key="text", label="命令内容", example="/help"),
                    PayloadField(key="channel_id", label="频道 ID", example="C01ABC23DEF"),
                    PayloadField(key="sender_id", label="发送者 User ID", example="U01ABC23DEF"),
                ],
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        bot_token = (config.get("bot_token") or "").strip()
        if not bot_token:
            errors.append("bot_token is required")
        elif not bot_token.startswith("xoxb-"):
            errors.append("bot_token must start with 'xoxb-'")
        if not (config.get("signing_secret") or "").strip():
            errors.append("signing_secret is required")
        return errors

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = _extract_bot_token(account)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    f"{SLACK_API_BASE}/auth.test",
                    headers={"Authorization": f"Bearer {token}"},
                )
                data = resp.json()

            if not data.get("ok"):
                return ProbeResult(
                    ok=False,
                    error=data.get("error", "unknown error"),
                )

            return ProbeResult(
                ok=True,
                display_name=data.get("user", ""),
                bot_username=data.get("user_id", ""),
                raw={
                    "team": data.get("team", ""),
                    "team_id": data.get("team_id", ""),
                    "user": data.get("user", ""),
                    "user_id": data.get("user_id", ""),
                    "bot_id": data.get("bot_id", ""),
                    "url": data.get("url", ""),
                },
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        # Slack webhook URL 在 Slack App 后台手动配置 Event Subscriptions
        return True

    # ------------------------------------------------------------------
    # 入站
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        try:
            body_bytes = request.body
            body = json.loads(body_bytes)
        except (json.JSONDecodeError, ValueError):
            logger.warning("[SlackAdapter] 无效的 JSON body")
            return None

        config = account.config or {}
        signing_secret = (config.get("signing_secret") or "").strip()

        if not signing_secret:
            logger.warning("[SlackAdapter] signing_secret 未配置，拒绝处理 webhook")
            return None

        timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
        signature = request.headers.get("X-Slack-Signature", "")

        if not timestamp or not signature:
            logger.warning("[SlackAdapter] 缺少签名头 X-Slack-Request-Timestamp 或 X-Slack-Signature")
            return None

        if not _check_timestamp_freshness(timestamp):
            logger.warning("[SlackAdapter] 请求时间戳过旧或无效，可能为重放攻击")
            return None

        if not _verify_slack_signature(signing_secret, timestamp, body_bytes, signature):
            logger.warning("[SlackAdapter] 签名验证失败")
            return None

        nonce_key = f"cg:slack_nonce:{signature}"
        if not cache.add(nonce_key, "1", TIMESTAMP_TOLERANCE_SECONDS):
            logger.warning("[SlackAdapter] duplicate request detected, possible replay")
            return None

        # URL verification challenge — now after signature verification (DE-10)
        if body.get("type") == "url_verification" and "challenge" in body:
            raise WebhookChallengeResponse(body["challenge"])

        # 只处理 event_callback 类型
        if body.get("type") != "event_callback":
            return None

        event = body.get("event")
        if not event or not isinstance(event, dict):
            return None

        event_type = event.get("type", "")
        if event_type != "message":
            return None

        # 忽略 message 子类型（如 message_changed, message_deleted, bot_message 等）
        subtype = event.get("subtype")
        if subtype is not None:
            return None

        # 忽略 bot 自己的消息
        if event.get("bot_id"):
            return None

        return self._parse_message_event(event, body, account)

    def _parse_message_event(
        self,
        event: dict,
        body: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析 Slack message 事件为标准入站消息。"""
        text = event.get("text", "")
        files = event.get("files")
        media = _extract_media_from_files(files) if files else None

        if not text and not media:
            return None

        channel_id = event.get("channel", "")
        if not channel_id:
            return None

        sender_id = event.get("user", "")
        if not sender_id:
            return None

        channel_type = event.get("channel_type", "")
        peer_kind = _determine_peer_kind(channel_type)

        thread_ts = event.get("thread_ts")
        message_ts = event.get("ts", "")

        metadata: Dict[str, Any] = {
            "channel_type": channel_type,
            "team_id": body.get("team_id", ""),
            "event_id": body.get("event_id", ""),
        }

        if thread_ts:
            metadata["thread_ts"] = thread_ts

        timestamp = int(float(message_ts)) if message_ts else int(time.time())

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=channel_id,
            sender_id=sender_id,
            message_id=message_ts,
            thread_id=thread_ts,
            reply_to=thread_ts if thread_ts and thread_ts != message_ts else None,
            text=text or None,
            media=media,
            timestamp=timestamp,
            metadata=metadata,
        )

    # ------------------------------------------------------------------
    # 出站
    # ------------------------------------------------------------------

    async def send_text(
        self,
        account: ChannelAccount,
        to: str,
        text: str,
        *,
        reply_to: Optional[str] = None,
        thread_id: Optional[str] = None,
    ) -> SendResult:
        token = _extract_bot_token(account)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_ts: Optional[str] = None

        # reply_to 和 thread_id 都可以作为 thread_ts
        effective_thread_ts = reply_to or thread_id

        for chunk in chunks:
            payload: Dict[str, Any] = {
                "channel": to,
                "text": chunk,
            }
            if effective_thread_ts:
                payload["thread_ts"] = effective_thread_ts

            result = await self._call_api(token, "chat.postMessage", payload)

            if not result.ok:
                return result
            last_ts = result.provider_message_id

            # 后续分片回复到同一 thread
            if last_ts and not effective_thread_ts:
                effective_thread_ts = last_ts

        return SendResult(ok=True, provider_message_id=last_ts)

    async def send_media(
        self,
        account: ChannelAccount,
        to: str,
        media_url: str,
        *,
        caption: Optional[str] = None,
        mime_type: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        token = _extract_bot_token(account)

        # 尝试 files.upload v2: 先下载外部文件再上传到 Slack
        try:
            return await self._upload_and_send_file(
                token, to, media_url, caption=caption, thread_ts=reply_to,
            )
        except Exception as exc:
            logger.warning("[SlackAdapter] 文件上传失败，降级为链接文本: %s", exc)
            fallback_text = caption or media_url
            if caption and media_url:
                fallback_text = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback_text, reply_to=reply_to)

    # ------------------------------------------------------------------
    # 内部 API 方法
    # ------------------------------------------------------------------

    @staticmethod
    async def _call_api(
        token: str,
        method: str,
        payload: Dict[str, Any],
    ) -> SendResult:
        """调用 Slack Web API 并返回 SendResult。"""
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{SLACK_API_BASE}/{method}",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json; charset=utf-8",
                    },
                    json=payload,
                )
                data = resp.json()

            if data.get("ok"):
                return SendResult(
                    ok=True,
                    provider_message_id=data.get("ts", ""),
                )

            error = data.get("error", "unknown")
            logger.warning("[SlackAdapter] %s 失败: %s", method, error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[SlackAdapter] %s 异常: %s", method, exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _upload_and_send_file(
        token: str,
        channel: str,
        media_url: str,
        *,
        caption: Optional[str] = None,
        thread_ts: Optional[str] = None,
    ) -> SendResult:
        """下载外部 media_url 并通过 files.uploadV2 上传到 Slack。

        files.uploadV2 流程:
        1. files.getUploadURLExternal 获取上传 URL
        2. PUT 文件到上传 URL
        3. files.completeUploadExternal 完成上传并分享到频道
        """
        async with httpx.AsyncClient(timeout=60) as client:
            dl_resp = await client.get(media_url)
            dl_resp.raise_for_status()
            file_bytes = dl_resp.content
            content_type = dl_resp.headers.get("content-type", "application/octet-stream")

        filename = media_url.rsplit("/", 1)[-1].split("?")[0][:100] or "file"
        file_length = len(file_bytes)

        # Step 1: 获取上传 URL
        async with httpx.AsyncClient(timeout=30) as client:
            url_resp = await client.post(
                f"{SLACK_API_BASE}/files.getUploadURLExternal",
                headers={"Authorization": f"Bearer {token}"},
                data={
                    "filename": filename,
                    "length": str(file_length),
                },
            )
            url_data = url_resp.json()

        if not url_data.get("ok"):
            raise ValueError(f"files.getUploadURLExternal 失败: {url_data.get('error', 'unknown')}")

        upload_url = url_data["upload_url"]
        file_id = url_data["file_id"]

        # Step 2: 上传文件到上传 URL
        async with httpx.AsyncClient(timeout=60) as client:
            put_resp = await client.put(
                upload_url,
                content=file_bytes,
                headers={"Content-Type": content_type},
            )
            put_resp.raise_for_status()

        # Step 3: 完成上传并分享
        complete_payload: Dict[str, Any] = {
            "files": [{"id": file_id, "title": caption or filename}],
            "channel_id": channel,
        }
        if caption:
            complete_payload["initial_comment"] = caption
        if thread_ts:
            complete_payload["thread_ts"] = thread_ts

        async with httpx.AsyncClient(timeout=30) as client:
            complete_resp = await client.post(
                f"{SLACK_API_BASE}/files.completeUploadExternal",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json=complete_payload,
            )
            complete_data = complete_resp.json()

        if not complete_data.get("ok"):
            raise ValueError(
                f"files.completeUploadExternal 失败: {complete_data.get('error', 'unknown')}"
            )

        return SendResult(ok=True, provider_message_id=file_id)

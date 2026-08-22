"""Discord Bot API adapter.

使用 httpx 直接调用 Discord REST API v10，不引入 discord.py 库。
Discord 适配器实现设计说明。

支持：
- Webhook 事件回调解析（Interactions endpoint + Gateway events）
- Ed25519 签名验证（使用 nacl 库，不可用时优雅降级）
- 发送文本消息（自动 2000 字符分片）
- 发送媒体附件
- PING interaction（type=1）自动 pong
- 忽略 Bot 自身消息
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

import httpx
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

DISCORD_API_BASE = "https://discord.com/api/v10"
TEXT_CHUNK_LIMIT = 2000

# Ed25519 签名验证：nacl 必须安装
_nacl_available = False
_nacl_import_error: str | None = None
try:
    from nacl.signing import VerifyKey
    from nacl.exceptions import BadSignatureError
    _nacl_available = True
except ImportError:
    VerifyKey = None  # type: ignore[assignment,misc]
    BadSignatureError = Exception  # type: ignore[assignment,misc]
    _nacl_import_error = (
        "PyNaCl 未安装，Discord Ed25519 签名验证不可用。"
        "请安装：pip install PyNaCl"
    )
    logger.error("[DiscordAdapter] %s", _nacl_import_error)


def _auth_headers(bot_token: str) -> Dict[str, str]:
    """构建 Discord Bot 认证 header。"""
    return {
        "Authorization": f"Bot {bot_token}",
        "Content-Type": "application/json",
    }


def _extract_bot_token(account: ChannelAccount) -> str:
    """从 account config 中提取 bot_token。"""
    config = account.config or {}
    token = (config.get("bot_token") or "").strip()
    if not token:
        raise ValueError("bot_token is required")
    return token


def _verify_ed25519(public_key: str, signature: str, timestamp: str, body: bytes) -> bool:
    """验证 Discord Ed25519 签名。

    PyNaCl 未安装时抛出 RuntimeError 拒绝请求，而非静默放行。
    """
    if not _nacl_available:
        raise RuntimeError(
            "[DiscordAdapter] PyNaCl 未安装，无法验证 Ed25519 签名。"
            "请安装：pip install PyNaCl"
        )

    try:
        vk = VerifyKey(bytes.fromhex(public_key))
        message = timestamp.encode("utf-8") + body
        vk.verify(message, bytes.fromhex(signature))
        return True
    except BadSignatureError:
        return False
    except Exception as exc:
        logger.warning("[DiscordAdapter] Ed25519 验证异常: %s", exc)
        return False


def _parse_attachments(attachments: List[Dict[str, Any]]) -> Optional[List[ChannelMedia]]:
    """从 Discord 消息附件列表解析媒体。"""
    if not attachments:
        return None

    items: List[ChannelMedia] = []
    for att in attachments:
        url = att.get("url", "")
        if not url:
            continue

        content_type = att.get("content_type", "")
        if content_type.startswith("image/"):
            kind = "image"
        elif content_type.startswith("video/"):
            kind = "video"
        elif content_type.startswith("audio/"):
            kind = "audio"
        else:
            kind = "file"

        items.append(ChannelMedia(
            kind=kind,
            url=url,
            file_id=str(att.get("id", "")),
            filename=att.get("filename"),
            mime_type=content_type or None,
            size=att.get("size"),
        ))

    return items if items else None


class DiscordAdapter(ChannelAdapter):
    """Discord Bot API channel adapter。"""

    @property
    def id(self) -> str:
        return "discord"

    @property
    def name(self) -> str:
        return "Discord"

    @property
    def description(self) -> str:
        return "通过 Discord Bot 收发消息，将 Discord 频道/DM 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "discord"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group", "channel", "thread"],
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
                help_text="Discord Developer Portal 中的 Bot Token",
            ),
            ConfigField(
                key="public_key",
                label="Public Key",
                help_text="应用的 Ed25519 Public Key，用于 Webhook 签名验证（可选）",
            ),
            ConfigField(
                key="application_id",
                label="Application ID",
                help_text="Discord 应用 ID（可选）",
            ),
        ]

    def get_event_types(self) -> list:
        from apps.extensions.base import EventDescriptor, PayloadField
        return [
            EventDescriptor(
                event_type="discord.message_received",
                description="收到 Discord 消息",
                payload_fields=[
                    PayloadField(key="channel_id", label="频道 ID", example="123456789"),
                    PayloadField(key="sender_id", label="发送者 ID", example="987654321"),
                    PayloadField(key="text", label="消息内容", example="Hello"),
                    PayloadField(key="peer_kind", label="会话类型", example="group"),
                    PayloadField(key="message_id", label="消息 ID", example="111222333"),
                    PayloadField(key="guild_id", label="服务器 ID", example="444555666"),
                ],
            ),
            EventDescriptor(
                event_type="discord.command_received",
                description="收到 Discord Slash Command（/ 命令）",
                payload_fields=[
                    PayloadField(key="text", label="命令内容", example="/help"),
                    PayloadField(key="channel_id", label="频道 ID", example="123456789"),
                    PayloadField(key="sender_id", label="发送者 ID", example="987654321"),
                    PayloadField(key="command_name", label="命令名", example="help"),
                ],
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("bot_token") or "").strip():
            errors.append("bot_token is required")
        if not (config.get("public_key") or "").strip():
            errors.append("public_key is required")
        if not _nacl_available:
            errors.append(
                "PyNaCl is required for Discord Ed25519 signature verification "
                "(pip install PyNaCl)"
            )
        return errors

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = _extract_bot_token(account)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{DISCORD_API_BASE}/users/@me",
                    headers=_auth_headers(token),
                )

            if resp.status_code != 200:
                return ProbeResult(
                    ok=False,
                    error=f"HTTP {resp.status_code}: {resp.text[:200]}",
                )

            data = resp.json()
            return ProbeResult(
                ok=True,
                display_name=data.get("username"),
                bot_username=f"{data.get('username', '')}#{data.get('discriminator', '0')}",
                raw=data,
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        # Discord Interactions Endpoint 在 Developer Portal 手动配置
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
            logger.warning("[DiscordAdapter] 无效的 JSON body")
            return None

        config = account.config or {}
        public_key = (config.get("public_key") or "").strip()

        # Ed25519 签名验证（强制）
        if not public_key:
            logger.warning("[DiscordAdapter] public_key 未配置，拒绝处理 webhook")
            return None

        signature = request.headers.get("X-Signature-Ed25519", "")
        timestamp = request.headers.get("X-Signature-Timestamp", "")
        if not signature or not timestamp:
            logger.warning("[DiscordAdapter] 缺少签名 header")
            return None
        try:
            if not _verify_ed25519(public_key, signature, timestamp, body_bytes):
                logger.warning("[DiscordAdapter] Ed25519 签名验证失败")
                return None
        except RuntimeError:
            logger.error("[DiscordAdapter] PyNaCl 不可用，拒绝处理 webhook")
            return None

        # 处理 Interaction 类型
        interaction_type = body.get("type")

        # PING interaction (type=1) — 返回 pong
        if interaction_type == 1:
            raise WebhookChallengeResponse(json.dumps({"type": 1}), raw_json=True)

        # APPLICATION_COMMAND (type=2) 和 MESSAGE_COMPONENT (type=3)
        if interaction_type in (2, 3):
            return self._parse_interaction(body, account)

        # Gateway event 格式（通过 webhook relay 转发的 MESSAGE_CREATE）
        event_type = body.get("t")
        if event_type == "MESSAGE_CREATE":
            return self._parse_message_create(body.get("d", body), account)

        # 直接的消息对象（无 t 字段，但有 content + author）
        if "content" in body and "author" in body:
            return self._parse_message_create(body, account)

        return None

    def _parse_message_create(
        self,
        data: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析 MESSAGE_CREATE 事件。"""
        author = data.get("author", {})

        # 忽略 bot 自己的消息
        if author.get("bot", False):
            return None

        content = (data.get("content") or "").strip()
        attachments = data.get("attachments", [])
        media = _parse_attachments(attachments)

        if not content and not media:
            return None

        channel_id = data.get("channel_id", "")
        if not channel_id:
            return None

        # 判断会话类型：DM channel type=1, Guild text=0, Thread=11/12
        channel_type = data.get("channel_type", -1)
        # 如果 channel_type 不在消息中，尝试从顶层获取
        if channel_type == -1:
            channel_type = data.get("type", -1)

        if channel_type == 1:
            peer_kind = "dm"
        elif channel_type in (11, 12):
            peer_kind = "thread"
        else:
            peer_kind = "group"

        guild_id = data.get("guild_id", "")
        sender_id = author.get("id", "unknown")
        message_id = data.get("id", "")

        # 回复消息处理
        referenced = data.get("referenced_message")
        reply_to = referenced.get("id") if isinstance(referenced, dict) else None
        if not reply_to:
            ref = data.get("message_reference", {})
            reply_to = ref.get("message_id") if ref else None

        # 构建 metadata
        metadata: Dict[str, Any] = {
            "channel_type": channel_type,
            "author_username": author.get("username", ""),
        }
        if guild_id:
            metadata["guild_id"] = guild_id

        thread_id = None
        if channel_type in (11, 12):
            thread_id = channel_id

        # 提取 mentions
        mentions = data.get("mentions", [])
        if mentions:
            metadata["mentions"] = [
                {"id": m.get("id"), "username": m.get("username")}
                for m in mentions
                if isinstance(m, dict)
            ]

        timestamp_str = data.get("timestamp", "")
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            ts = int(dt.timestamp())
        except Exception:
            ts = int(time.time())

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=channel_id,
            sender_id=sender_id,
            message_id=message_id or str(int(time.time() * 1000)),
            reply_to=reply_to,
            text=content or None,
            media=media,
            thread_id=thread_id,
            timestamp=ts,
            metadata=metadata,
        )

    def _parse_interaction(
        self,
        data: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析 Interaction（Slash Command / Message Component）。"""
        interaction_data = data.get("data", {})
        user = data.get("member", {}).get("user") or data.get("user", {})

        if not user:
            return None

        command_name = interaction_data.get("name", "")
        options = interaction_data.get("options", [])
        options_text = " ".join(
            str(opt.get("value", "")) for opt in options if isinstance(opt, dict)
        )
        text = f"/{command_name} {options_text}".strip() if command_name else None

        if not text:
            return None

        channel_id = data.get("channel_id", "")
        guild_id = data.get("guild_id")
        peer_kind = "dm" if not guild_id else "group"

        metadata: Dict[str, Any] = {
            "interaction_type": data.get("type"),
            "interaction_id": data.get("id", ""),
            "command_name": command_name,
        }
        if guild_id:
            metadata["guild_id"] = guild_id

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=channel_id,
            sender_id=user.get("id", "unknown"),
            message_id=data.get("id", str(int(time.time() * 1000))),
            text=text,
            timestamp=int(time.time()),
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
        last_message_id: Optional[str] = None

        for chunk in chunks:
            result = await self._send_message(
                token,
                channel_id=to,
                content=chunk,
                reply_to=reply_to if last_message_id is None else None,
            )
            if not result.ok:
                return result
            last_message_id = result.provider_message_id

        return SendResult(ok=True, provider_message_id=last_message_id)

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

        try:
            async with httpx.AsyncClient(timeout=60) as client:
                dl_resp = await client.get(media_url)
                dl_resp.raise_for_status()
                file_bytes = dl_resp.content
                content_type = dl_resp.headers.get("content-type", "application/octet-stream")

            filename = media_url.rsplit("/", 1)[-1][:100] or "file"

            return await self._send_attachment(
                token,
                channel_id=to,
                file_bytes=file_bytes,
                filename=filename,
                content_type=content_type,
                content=caption,
                reply_to=reply_to,
            )
        except Exception as exc:
            logger.error("[DiscordAdapter] 媒体发送失败，回退到文本链接: %s", exc)
            fallback = caption or media_url
            if caption and media_url:
                fallback = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback, reply_to=reply_to)

    # ------------------------------------------------------------------
    # 内部 API 调用
    # ------------------------------------------------------------------

    @staticmethod
    async def _send_message(
        token: str,
        channel_id: str,
        content: str,
        *,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """发送文本消息到指定 channel。"""
        payload: Dict[str, Any] = {"content": content}
        if reply_to:
            payload["message_reference"] = {"message_id": reply_to}

        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{DISCORD_API_BASE}/channels/{channel_id}/messages",
                    headers=_auth_headers(token),
                    json=payload,
                )

            if resp.status_code in (200, 201):
                data = resp.json()
                return SendResult(ok=True, provider_message_id=data.get("id"))

            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            logger.warning("[DiscordAdapter] send_message 失败: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[DiscordAdapter] send_message 异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _send_attachment(
        token: str,
        channel_id: str,
        file_bytes: bytes,
        filename: str,
        content_type: str,
        *,
        content: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:
        """以 multipart/form-data 方式发送文件附件。"""
        payload: Dict[str, Any] = {}
        if content:
            payload["content"] = content
        if reply_to:
            payload["message_reference"] = {"message_id": reply_to}

        try:
            files = {"file": (filename, file_bytes, content_type)}
            data = {}
            if payload:
                data["payload_json"] = json.dumps(payload)

            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    f"{DISCORD_API_BASE}/channels/{channel_id}/messages",
                    headers={"Authorization": f"Bot {token}"},
                    data=data,
                    files=files,
                )

            if resp.status_code in (200, 201):
                resp_data = resp.json()
                return SendResult(ok=True, provider_message_id=resp_data.get("id"))

            error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            logger.warning("[DiscordAdapter] send_attachment 失败: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[DiscordAdapter] send_attachment 异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

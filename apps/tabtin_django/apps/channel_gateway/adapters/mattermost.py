"""Mattermost Bot API adapter.

使用 httpx 调用 Mattermost REST API v4。
支持 Outgoing Webhook 和 Slash Command 两种入站格式。

支持：
- Outgoing Webhook / Slash Command 解析
- Token 校验（恒定时间比较）
- 发送文本消息（支持 thread + 长文本分片）
- 发送媒体文件（上传文件并创建 post，降级为链接文本）
- 连通性 Probe（/api/v4/users/me）
"""

from __future__ import annotations

import hmac
import json
import logging
import time
import uuid
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
    WebhookRejectError,
)

logger = logging.getLogger(__name__)

TEXT_CHUNK_LIMIT = 16383


def _api_url(config: Dict[str, Any], path: str) -> str:
    server_url = (config.get("server_url") or "").rstrip("/")
    return f"{server_url}/api/v4{path}"


def _headers(config: Dict[str, Any]) -> Dict[str, str]:
    token = (config.get("bot_token") or "").strip()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _extract_config(account: ChannelAccount) -> Dict[str, Any]:
    config = account.config or {}
    if not (config.get("server_url") or "").strip():
        raise ValueError("server_url 未配置")
    if not (config.get("bot_token") or "").strip():
        raise ValueError("bot_token 未配置")
    return config


def _parse_body(request: HttpRequest) -> Dict[str, Any]:
    content_type = request.content_type or ""
    body_bytes = request.body

    if "application/json" in content_type:
        return json.loads(body_bytes)

    if "application/x-www-form-urlencoded" in content_type:
        result: Dict[str, Any] = {}
        for key, value in request.POST.items():
            result[key] = value
        return result

    try:
        return json.loads(body_bytes)
    except (json.JSONDecodeError, ValueError):
        raise WebhookRejectError("无法解析请求体")


class MattermostAdapter(ChannelAdapter):
    """Mattermost Bot API channel adapter."""

    @property
    def id(self) -> str:
        return "mattermost"

    @property
    def name(self) -> str:
        return "Mattermost"

    @property
    def description(self) -> str:
        return "通过 Mattermost Bot API 收发消息，将 Mattermost 对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "mattermost"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            reactions=True,
            threads=True,
            supports_webhook=True,
        )

    # ------------------------------------------------------------------
    # 配置
    # ------------------------------------------------------------------

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="server_url",
                label="Server URL",
                field_type="url",
                required=True,
                help_text="Mattermost 服务器 URL（如 https://mattermost.example.com）",
            ),
            ConfigField(
                key="bot_token",
                label="Bot Access Token",
                field_type="password",
                required=True,
                help_text="Mattermost Bot Account 的 Access Token",
            ),
            ConfigField(
                key="webhook_secret",
                label="Webhook Secret",
                field_type="password",
                required=True,
                help_text="Outgoing Webhook 的 Secret Token（用于验证回调请求）",
            ),
            ConfigField(
                key="team_id",
                label="Team ID",
                help_text="默认 Team ID（选填）",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        server_url = (config.get("server_url") or "").strip()
        if not server_url:
            errors.append("server_url is required")
        elif not server_url.startswith(("http://", "https://")):
            errors.append("server_url must start with http:// or https://")

        bot_token = (config.get("bot_token") or "").strip()
        if not bot_token:
            errors.append("bot_token is required")

        if not (config.get("webhook_secret") or "").strip():
            errors.append("webhook_secret is required")

        return errors

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            config = _extract_config(account)
            url = _api_url(config, "/users/me")
            headers = _headers(config)

            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=headers)

            if resp.status_code != 200:
                return ProbeResult(
                    ok=False,
                    error=f"HTTP {resp.status_code}: {resp.text[:200]}",
                )

            data = resp.json()
            username = data.get("username", "")
            display_name = (
                f"{data.get('first_name', '')} {data.get('last_name', '')}".strip()
                or username
            )

            return ProbeResult(
                ok=True,
                bot_username=username,
                display_name=display_name,
                raw={
                    "id": data.get("id", ""),
                    "username": username,
                    "email": data.get("email", ""),
                    "roles": data.get("roles", ""),
                },
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
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
            body = _parse_body(request)
        except WebhookRejectError:
            logger.warning("[MattermostAdapter] 无法解析请求体")
            return None

        config = account.config or {}
        webhook_secret = (config.get("webhook_secret") or "").strip()

        if not webhook_secret:
            logger.warning("[MattermostAdapter] webhook_secret 未配置，拒绝处理 webhook")
            return None
        incoming_token = (body.get("token") or "").strip()
        if not incoming_token:
            logger.warning("[MattermostAdapter] 缺少 token 字段")
            return None
        if not hmac.compare_digest(webhook_secret, incoming_token):
            logger.warning("[MattermostAdapter] token 校验失败")
            return None

        channel_id = (body.get("channel_id") or "").strip()
        user_id = (body.get("user_id") or "").strip()
        if not channel_id or not user_id:
            logger.debug("[MattermostAdapter] 缺少 channel_id 或 user_id，跳过")
            return None

        text = body.get("text") or ""

        trigger_word = body.get("trigger_word") or ""
        if trigger_word and text.startswith(trigger_word):
            text = text[len(trigger_word):].lstrip()

        command = body.get("command") or ""
        if command and not text.strip():
            text = command

        if not text.strip():
            return None

        channel_name = body.get("channel_name") or ""
        peer_kind = "dm" if channel_name.startswith("__") else "group"

        post_id = body.get("post_id") or str(uuid.uuid4())

        ts_raw = body.get("timestamp")
        if ts_raw:
            try:
                timestamp = int(ts_raw)
            except (ValueError, TypeError):
                timestamp = int(time.time())
        else:
            timestamp = int(time.time())

        metadata: Dict[str, Any] = {
            "team_id": body.get("team_id", ""),
            "team_domain": body.get("team_domain", ""),
            "channel_name": channel_name,
            "user_name": body.get("user_name", ""),
        }
        if trigger_word:
            metadata["trigger_word"] = trigger_word
        if command:
            metadata["command"] = command

        file_ids = body.get("file_ids")
        media = self._resolve_file_ids(config, file_ids) if file_ids else None

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=channel_id,
            sender_id=user_id,
            message_id=post_id,
            text=text or None,
            media=media,
            timestamp=timestamp,
            metadata=metadata,
        )

    @staticmethod
    def _resolve_file_ids(
        config: Dict[str, Any],
        file_ids: Any,
    ) -> Optional[List[ChannelMedia]]:
        if not isinstance(file_ids, list) or not file_ids:
            return None

        server_url = (config.get("server_url") or "").rstrip("/")
        items: List[ChannelMedia] = []

        for fid in file_ids:
            if not isinstance(fid, str) or not fid.strip():
                continue
            url = f"{server_url}/api/v4/files/{fid}"
            items.append(ChannelMedia(
                kind="file",
                url=url,
                file_id=fid,
            ))

        return items if items else None

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
        config = _extract_config(account)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_id: Optional[str] = None

        effective_root_id = reply_to or thread_id

        for chunk in chunks:
            payload: Dict[str, Any] = {
                "channel_id": to,
                "message": chunk,
            }
            if effective_root_id:
                payload["root_id"] = effective_root_id

            result = await self._create_post(config, payload)
            if not result.ok:
                return result
            last_id = result.provider_message_id

            if last_id and not effective_root_id:
                effective_root_id = last_id

        return SendResult(ok=True, provider_message_id=last_id)

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
        config = _extract_config(account)

        try:
            return await self._upload_and_send_file(
                config, to, media_url, caption=caption, root_id=reply_to,
            )
        except Exception as exc:
            logger.warning("[MattermostAdapter] 文件上传失败，降级为链接文本: %s", exc)
            fallback_text = caption or media_url
            if caption and media_url:
                fallback_text = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback_text, reply_to=reply_to)

    # ------------------------------------------------------------------
    # 内部 API 方法
    # ------------------------------------------------------------------

    @staticmethod
    async def _create_post(
        config: Dict[str, Any],
        payload: Dict[str, Any],
    ) -> SendResult:
        try:
            url = _api_url(config, "/posts")
            headers = _headers(config)

            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(url, headers=headers, json=payload)

            if resp.status_code in (200, 201):
                data = resp.json()
                return SendResult(
                    ok=True,
                    provider_message_id=data.get("id", ""),
                )

            logger.warning(
                "[MattermostAdapter] 创建 post 失败: HTTP %d — %s",
                resp.status_code,
                resp.text[:300],
            )
            return SendResult(ok=False, error=f"HTTP {resp.status_code}")
        except Exception as exc:
            logger.error("[MattermostAdapter] 创建 post 异常: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _upload_and_send_file(
        config: Dict[str, Any],
        channel_id: str,
        media_url: str,
        *,
        caption: Optional[str] = None,
        root_id: Optional[str] = None,
    ) -> SendResult:
        async with httpx.AsyncClient(timeout=60) as client:
            dl_resp = await client.get(media_url)
            dl_resp.raise_for_status()
            file_bytes = dl_resp.content

        filename = media_url.rsplit("/", 1)[-1].split("?")[0][:100] or "file"
        token = (config.get("bot_token") or "").strip()
        upload_url = _api_url(config, "/files")

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                upload_url,
                headers={"Authorization": f"Bearer {token}"},
                params={"channel_id": channel_id, "filename": filename},
                files={"files": (filename, file_bytes)},
            )

        if resp.status_code not in (200, 201):
            raise ValueError(f"文件上传失败: HTTP {resp.status_code}")

        upload_data = resp.json()
        file_infos = upload_data.get("file_infos", [])
        if not file_infos:
            raise ValueError("文件上传返回空 file_infos")

        uploaded_file_ids = [fi["id"] for fi in file_infos if fi.get("id")]

        post_payload: Dict[str, Any] = {
            "channel_id": channel_id,
            "message": caption or "",
            "file_ids": uploaded_file_ids,
        }
        if root_id:
            post_payload["root_id"] = root_id

        post_url = _api_url(config, "/posts")
        headers = _headers(config)

        async with httpx.AsyncClient(timeout=30) as client:
            post_resp = await client.post(post_url, headers=headers, json=post_payload)

        if post_resp.status_code not in (200, 201):
            raise ValueError(f"创建带附件 post 失败: HTTP {post_resp.status_code}")

        post_data = post_resp.json()
        return SendResult(ok=True, provider_message_id=post_data.get("id", ""))

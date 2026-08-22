"""飞书 / Lark Bot API adapter.

使用 httpx 直接调用飞书 Open API，无需引入飞书 SDK。
飞书适配器实现设计说明。

支持：
- Webhook 事件回调解析（im.message.receive_v1）
- 发送文本消息（post 富文本格式）
- 发送媒体文件（图片/文件）
- URL 验证 challenge
- 连通性 Probe
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
from base64 import b64decode
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

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

FEISHU_API_BASE = "https://open.feishu.cn/open-apis"
LARK_API_BASE = "https://open.larksuite.com/open-apis"
TOKEN_CACHE_TTL = 7000  # ~1h56m，留 4 分钟余量 (飞书 token 有效期 2h)
TEXT_CHUNK_LIMIT = 4000
TIMESTAMP_TOLERANCE_SECONDS = 300  # 5 min — 超出则视为重放
_CUSTOM_BOT_WEBHOOK_PATH = re.compile(r"^/open-apis/bot/v2/hook/[A-Za-z0-9-]+$")
_CUSTOM_BOT_WEBHOOK_HOSTS = frozenset({"open.feishu.cn", "open.larksuite.com"})


def is_feishu_custom_bot_webhook_url(value: str) -> bool:
    """只接受飞书/Lark 官方域名的群自定义机器人 webhook。"""
    try:
        parsed = urlparse((value or "").strip())
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in _CUSTOM_BOT_WEBHOOK_HOSTS
        and parsed.username is None
        and parsed.password is None
        and parsed.port is None
        and not parsed.query
        and not parsed.fragment
        and bool(_CUSTOM_BOT_WEBHOOK_PATH.fullmatch(parsed.path))
    )


def _api_base(account: ChannelAccount) -> str:
    """根据 account 配置选择飞书或 Lark 域名。"""
    config = account.config or {}
    domain = config.get("domain", "feishu")
    if domain == "lark":
        return LARK_API_BASE
    if domain and domain.startswith("https://"):
        return f"{domain.rstrip('/')}/open-apis"
    return FEISHU_API_BASE


def _extract_credentials(account: ChannelAccount) -> tuple[str, str]:
    config = account.config or {}
    app_id = (config.get("app_id") or "").strip()
    app_secret = (config.get("app_secret") or "").strip()
    if not app_id or not app_secret:
        raise ValueError("app_id and app_secret are required")
    return app_id, app_secret


async def _get_tenant_access_token(account: ChannelAccount) -> str:
    """获取并缓存 tenant_access_token。

    使用短 TTL 的 refresh lock 防止并发 token 刷新（thundering herd）。
    等待者超时后直接 fall through 获取 token，不清除他人持有的锁。
    """
    app_id, app_secret = _extract_credentials(account)
    cache_key = f"feishu:tat:{app_id}"
    lock_key = f"feishu:tat_lock:{app_id}"

    token = cache.get(cache_key)
    if token:
        return token

    acquired = cache.add(lock_key, "1", timeout=10)
    if not acquired:
        import asyncio
        for _ in range(5):
            await asyncio.sleep(0.5)
            token = cache.get(cache_key)
            if token:
                return token

    try:
        api_base = _api_base(account)
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{api_base}/auth/v3/tenant_access_token/internal",
                json={"app_id": app_id, "app_secret": app_secret},
            )
            data = resp.json()

        if data.get("code") != 0:
            raise ValueError(f"获取 tenant_access_token 失败: {data.get('msg', 'unknown')}")

        token = data["tenant_access_token"]
        cache.set(cache_key, token, TOKEN_CACHE_TTL)
        return token
    finally:
        if acquired:
            cache.delete(lock_key)


def _check_timestamp_freshness(ts: str) -> bool:
    """拒绝超过 TIMESTAMP_TOLERANCE_SECONDS 的请求（防重放）。"""
    if not ts:
        return False
    try:
        request_ts = int(ts)
    except (ValueError, TypeError):
        return False
    return abs(int(time.time()) - request_ts) <= TIMESTAMP_TOLERANCE_SECONDS


def _verify_signature(timestamp: str, nonce: str, encrypt_key: str, body: bytes, signature: str) -> bool:
    """飞书事件签名校验。"""
    try:
        body_str = body.decode("utf-8")
    except UnicodeDecodeError:
        return False
    content = timestamp + nonce + encrypt_key + body_str
    computed = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return hmac.compare_digest(computed, signature)


def _decrypt_event(encrypt_key: str, encrypted: str) -> dict:
    """飞书加密事件解密 (AES-256-CBC)。"""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding as sym_padding

    key = hashlib.sha256(encrypt_key.encode("utf-8")).digest()
    data = b64decode(encrypted)
    iv = data[:16]
    cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data[16:]) + decryptor.finalize()
    unpadder = sym_padding.PKCS7(128).unpadder()
    unpadded = unpadder.update(decrypted) + unpadder.finalize()
    return json.loads(unpadded)


def _parse_text_content(content_str: str, msg_type: str) -> Optional[str]:
    """从飞书消息 content JSON 提取纯文本。"""
    try:
        parsed = json.loads(content_str)
    except (json.JSONDecodeError, TypeError):
        return content_str if content_str else None

    if msg_type == "text":
        return parsed.get("text", "")

    if msg_type == "post":
        return _extract_post_text(parsed)

    if msg_type == "interactive":
        return _extract_interactive_text(parsed)

    return parsed.get("text", content_str)


def _extract_post_text(parsed: dict) -> str:
    """从 post 富文本提取纯文本。"""
    lines: list[str] = []
    for lang_key in ("zh_cn", "en_us", "ja_jp"):
        lang = parsed.get(lang_key)
        if lang:
            title = lang.get("title", "")
            if title:
                lines.append(title)
            for row in lang.get("content", []):
                for elem in row:
                    tag = elem.get("tag", "")
                    if tag == "text":
                        lines.append(elem.get("text", ""))
                    elif tag == "a":
                        lines.append(elem.get("text", elem.get("href", "")))
                    elif tag == "at":
                        lines.append(f"@{elem.get('user_name', elem.get('user_id', ''))}")
                    elif tag == "md":
                        lines.append(elem.get("text", ""))
                    elif tag == "img":
                        lines.append("[图片]")
                    elif tag == "media":
                        lines.append("[媒体]")
            break
    return "\n".join(lines).strip()


def _extract_interactive_text(parsed: dict) -> str:
    """从 interactive card 提取纯文本。"""
    elements = parsed.get("elements") or parsed.get("body", {}).get("elements", [])
    texts: list[str] = []
    for elem in elements:
        if not isinstance(elem, dict):
            continue
        tag = elem.get("tag", "")
        if tag == "div" and isinstance(elem.get("text"), dict):
            texts.append(elem["text"].get("content", ""))
        elif tag == "markdown":
            texts.append(elem.get("content", ""))
    return "\n".join(texts).strip() or "[Interactive Card]"


def _parse_media(content_str: str, msg_type: str) -> Optional[List[ChannelMedia]]:
    """从飞书消息提取媒体附件。"""
    try:
        parsed = json.loads(content_str)
    except (json.JSONDecodeError, TypeError):
        return None

    items: List[ChannelMedia] = []

    if msg_type == "image":
        image_key = parsed.get("image_key", "")
        if image_key:
            items.append(ChannelMedia(kind="image", file_id=image_key))

    elif msg_type == "file":
        file_key = parsed.get("file_key", "")
        if file_key:
            items.append(ChannelMedia(
                kind="file",
                file_id=file_key,
                filename=parsed.get("file_name"),
            ))

    elif msg_type in ("audio", "media"):
        file_key = parsed.get("file_key", "")
        if file_key:
            kind = "audio" if msg_type == "audio" else "video"
            items.append(ChannelMedia(kind=kind, file_id=file_key))

    elif msg_type == "sticker":
        file_key = parsed.get("file_key", "")
        if file_key:
            items.append(ChannelMedia(kind="sticker", file_id=file_key))

    return items if items else None


def _build_post_message(text: str) -> str:
    """将纯文本构建为飞书 post 富文本格式 JSON。"""
    return json.dumps({
        "zh_cn": {
            "content": [[{"tag": "md", "text": text}]],
        },
    })


class FeishuAdapter(ChannelAdapter):
    """飞书 / Lark Bot API channel adapter."""

    @property
    def id(self) -> str:
        return "feishu"

    @property
    def name(self) -> str:
        return "飞书 / Lark"

    @property
    def description(self) -> str:
        return "通过飞书 Bot 收发消息、创建文档，将飞书对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "feishu"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            threads=True,
        )

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="app_id",
                label="App ID",
                required=True,
                help_text="飞书开发者后台的应用 App ID",
            ),
            ConfigField(
                key="app_secret",
                label="App Secret",
                field_type="password",
                required=True,
                help_text="飞书开发者后台的应用 App Secret",
            ),
            ConfigField(
                key="verification_token",
                label="Verification Token",
                field_type="password",
                help_text="事件订阅的 Verification Token（Webhook 模式必填）",
            ),
            ConfigField(
                key="encrypt_key",
                label="Encrypt Key",
                field_type="password",
                help_text="事件订阅的 Encrypt Key（可选，启用加密时填写）",
            ),
            ConfigField(
                key="domain",
                label="API 域名",
                field_type="select",
                default="feishu",
                options=[
                    {"label": "飞书 (feishu.cn)", "value": "feishu"},
                    {"label": "Lark (larksuite.com)", "value": "lark"},
                ],
                help_text="海外用户选择 Lark",
            ),
        ]

    def get_event_types(self) -> list:
        from apps.extensions.base import EventDescriptor, PayloadField
        return [
            EventDescriptor(
                event_type="feishu.message_received",
                description="收到飞书消息",
                payload_fields=[
                    PayloadField(key="chat_id", label="群聊 ID", example="oc_abc123"),
                    PayloadField(key="sender_id", label="发送者 OpenID", example="ou_xxx"),
                    PayloadField(key="text", label="消息内容", example="你好"),
                    PayloadField(key="msg_type", label="消息类型", example="text"),
                    PayloadField(key="peer_kind", label="会话类型", example="group"),
                    PayloadField(key="message_id", label="消息 ID", example="om_xxx"),
                ],
            ),
            EventDescriptor(
                event_type="feishu.command_received",
                description="收到飞书 Bot 命令（以 / 开头的消息）",
                payload_fields=[
                    PayloadField(key="text", label="命令内容", example="/help"),
                    PayloadField(key="chat_id", label="群聊 ID", example="oc_abc123"),
                    PayloadField(key="sender_id", label="发送者 OpenID", example="ou_xxx"),
                ],
            ),
            EventDescriptor(
                event_type="feishu.bot_added",
                description="Bot 被添加到群组",
                payload_fields=[
                    PayloadField(key="chat_id", label="群聊 ID", example="oc_abc123"),
                ],
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        webhook_url = (config.get("webhook_url") or "").strip()
        if webhook_url:
            if not is_feishu_custom_bot_webhook_url(webhook_url):
                errors.append("webhook_url must be an official Feishu/Lark custom bot URL")
            return errors
        if not (config.get("app_id") or "").strip():
            errors.append("app_id is required")
        if not (config.get("app_secret") or "").strip():
            errors.append("app_secret is required")
        if not (config.get("verification_token") or "").strip():
            errors.append("verification_token is required")

        if (config.get("encrypt_key") or "").strip():
            try:
                from cryptography.hazmat.primitives.ciphers import (  # noqa: F401
                    Cipher,
                    algorithms,
                    modes,
                )
            except ImportError:
                errors.append(
                    "cryptography is not installed — encrypted event decryption "
                    "will fail. Install with: pip install cryptography"
                )

        return errors

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        webhook_url = str((account.config or {}).get("webhook_url") or "").strip()
        if webhook_url:
            if not is_feishu_custom_bot_webhook_url(webhook_url):
                return ProbeResult(ok=False, error="飞书自定义机器人 Webhook 地址无效")
            return ProbeResult(ok=True, display_name=account.name or "飞书群自定义机器人")
        try:
            token = await _get_tenant_access_token(account)
            api_base = _api_base(account)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    f"{api_base}/bot/v3/info",
                    headers={"Authorization": f"Bearer {token}"},
                )
                data = resp.json()

            if data.get("code") != 0:
                return ProbeResult(
                    ok=False,
                    error=data.get("msg", f"code {data.get('code')}"),
                )

            bot = data.get("bot") or data.get("data", {}).get("bot", {})
            return ProbeResult(
                ok=True,
                display_name=bot.get("bot_name"),
                bot_username=bot.get("open_id"),
                raw=bot,
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self,
        account: ChannelAccount,
        webhook_url: str,
    ) -> bool:
        # 飞书 webhook URL 在开发者后台手动配置，无需 API 调用
        return True

    # ------------------------------------------------------------------
    # Inbound
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
            logger.warning("[FeishuAdapter] invalid JSON body")
            return None

        config = account.config or {}
        encrypt_key = (config.get("encrypt_key") or "").strip()
        verification_token = (config.get("verification_token") or "").strip()

        # 处理加密事件
        if "encrypt" in body:
            if not encrypt_key:
                logger.warning("[FeishuAdapter] received encrypted event but no encrypt_key configured")
                return None
            try:
                body = _decrypt_event(encrypt_key, body["encrypt"])
            except Exception:
                logger.exception("[FeishuAdapter] event decryption failed")
                return None

        # 签名校验（强制：至少需要 verification_token 或 encrypt_key）
        if not verification_token and not encrypt_key:
            logger.warning(
                "[FeishuAdapter] verification_token 与 encrypt_key 均未配置，拒绝处理 webhook"
            )
            return None

        signature = request.headers.get("X-Lark-Signature", "")
        ts = request.headers.get("X-Lark-Request-Timestamp", "")
        nonce = request.headers.get("X-Lark-Request-Nonce", "")

        # TDP-021: 签名校验只使用 encrypt_key。verification_token 出现在 webhook body 中，
        # 若回退到它作为签名密钥，攻击者可直接伪造签名。
        if encrypt_key:
            if not signature:
                logger.warning("[FeishuAdapter] signature required but missing in request")
                return None
            if not _check_timestamp_freshness(ts):
                logger.warning("[FeishuAdapter] request timestamp too old or invalid, possible replay")
                return None
            if not _verify_signature(ts, nonce, encrypt_key, body_bytes, signature):
                logger.warning("[FeishuAdapter] signature verification failed")
                return None
        else:
            logger.warning(
                "[FeishuAdapter] encrypt_key 未配置，无法进行 HMAC 签名校验，"
                "仅依赖 verification_token 比对（安全性降低，建议配置 encrypt_key）"
            )

        if nonce:
            nonce_cache_key = f"cg:feishu_nonce:{nonce}"
            if not cache.add(nonce_cache_key, "1", TIMESTAMP_TOLERANCE_SECONDS):
                logger.warning("[FeishuAdapter] duplicate nonce detected, possible replay")
                return None

        # URL 验证 challenge（飞书开发者后台添加 webhook 时发送，含加密场景）
        if body.get("type") == "url_verification" and "challenge" in body:
            raise WebhookChallengeResponse(body["challenge"])

        # Token 验证（飞书 v1 事件格式）— 恒定时间比较防时序侧信道
        if body.get("token") and verification_token:
            if not hmac.compare_digest(body["token"], verification_token):
                logger.warning("[FeishuAdapter] verification token mismatch")
                return None

        # 解析事件
        schema = body.get("schema")
        if schema == "2.0":
            return self._parse_v2_event(body, account)

        # v1 事件格式 (兼容)
        event = body.get("event")
        if event and body.get("type") == "event_callback":
            return self._parse_v1_event(event, account)

        return None

    def _parse_v2_event(
        self,
        body: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析飞书 v2.0 事件格式 (im.message.receive_v1)。"""
        header = body.get("header", {})
        event_type = header.get("event_type", "")

        if event_type != "im.message.receive_v1":
            return None

        event = body.get("event", {})
        sender = event.get("sender", {})
        message = event.get("message", {})

        chat_id = message.get("chat_id", "")
        if not chat_id:
            return None

        msg_type = message.get("message_type", "text")
        content_str = message.get("content", "")

        text = _parse_text_content(content_str, msg_type)
        media = _parse_media(content_str, msg_type)

        if not text and not media:
            return None

        chat_type = message.get("chat_type", "p2p")
        peer_kind = "group" if chat_type == "group" else "dm"

        sender_id_obj = sender.get("sender_id", {})
        sender_open_id = sender_id_obj.get("open_id", "")
        sender_user_id = sender_id_obj.get("user_id", "")

        metadata: Dict[str, Any] = {
            "msg_type": msg_type,
            "sender_type": sender.get("sender_type", ""),
            "tenant_key": sender.get("tenant_key", ""),
        }
        if sender_user_id:
            metadata["sender_user_id"] = sender_user_id

        mentions = message.get("mentions")
        if mentions:
            metadata["mentions"] = mentions

        parent_id = message.get("parent_id", "")
        root_id = message.get("root_id", "")
        if parent_id:
            metadata["parent_id"] = parent_id
        if root_id:
            metadata["root_id"] = root_id

        create_time = message.get("create_time", "")
        timestamp = int(create_time) // 1000 if create_time else int(time.time())

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=chat_id,
            sender_id=sender_open_id or sender_user_id or "unknown",
            message_id=message.get("message_id", ""),
            reply_to=parent_id or None,
            text=text,
            media=media,
            timestamp=timestamp,
            metadata=metadata,
        )

    def _parse_v1_event(
        self,
        event: dict,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        """解析飞书 v1 事件格式（兼容旧事件订阅）。"""
        msg_type = event.get("msg_type", "text")

        if msg_type == "text":
            text = event.get("text", "")
        else:
            text = event.get("text") or event.get("title", "")

        chat_id = event.get("open_chat_id", "")
        if not chat_id:
            return None

        if not text:
            return None

        peer_kind = "group" if event.get("chat_type") == "group" else "dm"
        sender_id = event.get("open_id") or event.get("user_open_id", "unknown")

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=chat_id,
            sender_id=sender_id,
            message_id=event.get("open_message_id", str(int(time.time() * 1000))),
            text=text,
            timestamp=int(event.get("create_time", time.time())),
            metadata={"msg_type": msg_type, "v1": True},
        )

    # ------------------------------------------------------------------
    # Outbound
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
        webhook_url = str((account.config or {}).get("webhook_url") or "").strip()
        if webhook_url:
            if not is_feishu_custom_bot_webhook_url(webhook_url):
                return SendResult(ok=False, error="飞书自定义机器人 Webhook 地址无效")
            try:
                from apps.services.common.url_security import ssrf_safe_request_async

                response = await ssrf_safe_request_async(
                    "POST",
                    webhook_url,
                    json={"msg_type": "text", "content": {"text": text}},
                    timeout=10,
                    trusted_hosts=_CUSTOM_BOT_WEBHOOK_HOSTS,
                )
                data = response.json()
                code = data.get("code", data.get("StatusCode")) if isinstance(data, dict) else None
                if response.status_code >= 400 or code != 0:
                    error = data.get("msg") or data.get("StatusMessage") if isinstance(data, dict) else None
                    return SendResult(
                        ok=False,
                        error=error or f"飞书 Webhook 返回 HTTP {response.status_code}",
                    )
                return SendResult(ok=True)
            except Exception as exc:
                logger.warning("[FeishuAdapter] custom bot webhook send failed", exc_info=True)
                return SendResult(ok=False, error=str(exc))

        token = await _get_tenant_access_token(account)
        api_base = _api_base(account)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_message_id: Optional[str] = None

        for chunk in chunks:
            content = _build_post_message(chunk)

            if reply_to and last_message_id is None:
                result = await self._reply_message(
                    token, api_base, reply_to, content, "post",
                )
            else:
                result = await self._create_message(
                    token, api_base, to, content, "post",
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
        token = await _get_tenant_access_token(account)
        api_base = _api_base(account)

        is_image = (mime_type or "").startswith("image/") or any(
            media_url.lower().endswith(ext)
            for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")
        )

        try:
            image_key_or_file_key = await self._upload_media(
                token, api_base, media_url, is_image,
            )
        except Exception as exc:
            logger.error("[FeishuAdapter] media upload failed: %s", exc)
            fallback_text = caption or media_url
            if caption and media_url:
                fallback_text = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback_text, reply_to=reply_to)

        if is_image:
            content = json.dumps({"image_key": image_key_or_file_key})
            msg_type = "image"
        else:
            content = json.dumps({"file_key": image_key_or_file_key})
            msg_type = "file"

        if reply_to:
            return await self._reply_message(token, api_base, reply_to, content, msg_type)
        return await self._create_message(token, api_base, to, content, msg_type)

    # ------------------------------------------------------------------
    # Internal API helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _create_message(
        token: str,
        api_base: str,
        chat_id: str,
        content: str,
        msg_type: str,
    ) -> SendResult:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{api_base}/im/v1/messages",
                    params={"receive_id_type": "chat_id"},
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "receive_id": chat_id,
                        "content": content,
                        "msg_type": msg_type,
                    },
                )
                data = resp.json()

            if data.get("code") == 0:
                msg_data = data.get("data", {})
                return SendResult(
                    ok=True,
                    provider_message_id=msg_data.get("message_id", ""),
                )

            error = data.get("msg", f"code {data.get('code')}")
            logger.warning("[FeishuAdapter] create_message failed: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[FeishuAdapter] create_message error: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _reply_message(
        token: str,
        api_base: str,
        message_id: str,
        content: str,
        msg_type: str,
    ) -> SendResult:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{api_base}/im/v1/messages/{message_id}/reply",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "content": content,
                        "msg_type": msg_type,
                    },
                )
                data = resp.json()

            if data.get("code") == 0:
                msg_data = data.get("data", {})
                return SendResult(
                    ok=True,
                    provider_message_id=msg_data.get("message_id", ""),
                )

            error = data.get("msg", f"code {data.get('code')}")
            logger.warning("[FeishuAdapter] reply_message failed: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[FeishuAdapter] reply_message error: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _upload_media(
        token: str,
        api_base: str,
        media_url: str,
        is_image: bool,
    ) -> str:
        """下载外部 media_url 并上传到飞书，返回 image_key 或 file_key。"""
        async with httpx.AsyncClient(timeout=60) as client:
            dl_resp = await client.get(media_url)
            dl_resp.raise_for_status()
            file_bytes = dl_resp.content
            content_type = dl_resp.headers.get("content-type", "application/octet-stream")

        if is_image:
            url = f"{api_base}/im/v1/images"
            files = {"image": ("image", file_bytes, content_type)}
            data = {"image_type": "message"}
        else:
            url = f"{api_base}/im/v1/files"
            filename = media_url.rsplit("/", 1)[-1][:100] or "file"
            files = {"file": (filename, file_bytes, content_type)}
            data = {"file_type": "stream", "file_name": filename}

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}"},
                data=data,
                files=files,
            )
            result = resp.json()

        if result.get("code") != 0:
            raise ValueError(f"upload failed: {result.get('msg', 'unknown')}")

        result_data = result.get("data", {})
        return result_data.get("image_key") or result_data.get("file_key") or ""

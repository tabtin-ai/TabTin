"""企业微信 (WeChat Work) channel adapter.

使用 httpx 直接调用企业微信 Open API，无需引入企业微信 SDK。

支持：
- Webhook 事件回调解析（文本、图片、语音、视频、位置、链接消息）
- URL 验证 (echostr AES 解密)
- 发送文本（Markdown 格式）/ 图片 / 文件消息
- 消息加解密 (AES-256-CBC + PKCS#7)
- 连通性 Probe
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import struct
import time
from typing import Any, Dict, List, Optional
from xml.etree import ElementTree as ET

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
    WebhookRejectError,
)

logger = logging.getLogger(__name__)

QYAPI_BASE = "https://qyapi.weixin.qq.com/cgi-bin"
TOKEN_CACHE_TTL = 7000  # ~1h56m，留 4 分钟余量 (企业微信 token 有效期 2h)
TEXT_CHUNK_LIMIT = 2048
PEER_KIND_CACHE_TTL = 86400  # 24h


def _cache_peer_kind(account_id: str, peer_id: str, peer_kind: str) -> None:
    cache.set(f"wechat_work:peer_kind:{account_id}:{peer_id}", peer_kind, PEER_KIND_CACHE_TTL)


def _get_peer_kind(account_id: str, peer_id: str) -> Optional[str]:
    return cache.get(f"wechat_work:peer_kind:{account_id}:{peer_id}")


# ------------------------------------------------------------------
# Crypto helpers
# ------------------------------------------------------------------

def _derive_aes_key(encoding_aes_key: str) -> bytes:
    """将 EncodingAESKey (base64 编码) 转换为 32 字节 AES 密钥。"""
    return base64.b64decode(encoding_aes_key + "=")


def _verify_signature(
    token: str, timestamp: str, nonce: str, encrypted: str, msg_signature: str,
) -> bool:
    """校验企业微信回调签名: sha1(sort([token, timestamp, nonce, encrypt]))。

    SECURITY NOTE (DE-14): SHA-1 已于 2017 年被 Google 实际碰撞攻击（SHAttered），
    但此处使用 SHA-1 是企业微信官方回调协议的强制要求，无法单方面升级为 SHA-256。
    截至 2026-03 企业微信未提供 SHA-256 签名方案。风险由以下因素缓解：
    - 回调消息体始终经过 AES-256-CBC 加密（encoding_aes_key 已设为必填）
    - 签名输入包含服务端 token 秘钥，攻击者无法构造有效碰撞
    - SHA-1 碰撞攻击需要控制两个输入，而此场景中 token 为服务端机密
    若企业微信未来升级签名算法，应立即跟进迁移。
    """
    items = sorted([token, timestamp, nonce, encrypted])
    computed = hashlib.sha1("".join(items).encode("utf-8")).hexdigest()  # noqa: S324
    return hmac.compare_digest(computed, msg_signature)


def _pkcs7_unpad(data: bytes, block_size: int = 32) -> bytes:
    pad_len = data[-1]
    if pad_len < 1 or pad_len > block_size:
        raise ValueError("invalid PKCS#7 padding")
    return data[:-pad_len]


def _decrypt_message(encoding_aes_key: str, encrypted: str) -> tuple[str, str]:
    """AES-CBC 解密企业微信加密消息。

    返回 (xml_content, corp_id)。
    密文布局: random(16) + msg_len(4, big-endian) + msg + corp_id
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    aes_key = _derive_aes_key(encoding_aes_key)
    data = base64.b64decode(encrypted)
    iv = aes_key[:16]

    cipher = Cipher(algorithms.AES(aes_key), modes.CBC(iv))
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data) + decryptor.finalize()
    decrypted = _pkcs7_unpad(decrypted)

    msg_len = struct.unpack("!I", decrypted[16:20])[0]
    msg = decrypted[20 : 20 + msg_len].decode("utf-8")
    corp_id = decrypted[20 + msg_len :].decode("utf-8")
    return msg, corp_id


def decrypt_echostr(
    encoding_aes_key: str,
    token: str,
    msg_signature: str,
    timestamp: str,
    nonce: str,
    echostr: str,
) -> str:
    """URL 验证: 校验签名 + 解密 echostr 返回明文。

    此函数导出供 webhook view 的 GET 处理使用。
    """
    if not _verify_signature(token, timestamp, nonce, echostr, msg_signature):
        raise ValueError("signature verification failed")
    content, _ = _decrypt_message(encoding_aes_key, echostr)
    return content


# ------------------------------------------------------------------
# XML helpers
# ------------------------------------------------------------------

def _parse_xml(xml_str: str) -> Dict[str, str]:
    """将企业微信 XML 消息解析为扁平字典。"""
    root = ET.fromstring(xml_str)
    return {child.tag: (child.text or "") for child in root}


# ------------------------------------------------------------------
# Token management
# ------------------------------------------------------------------

def _extract_credentials(account: ChannelAccount) -> tuple[str, str]:
    config = account.config or {}
    corp_id = (config.get("corp_id") or "").strip()
    secret = (config.get("secret") or "").strip()
    if not corp_id or not secret:
        raise ValueError("corp_id and secret are required")
    return corp_id, secret


async def _get_access_token(account: ChannelAccount) -> str:
    """获取并缓存 access_token，带 thundering-herd 保护。"""
    corp_id, secret = _extract_credentials(account)
    cache_key = f"wechat_work:token:{corp_id}"
    lock_key = f"wechat_work:token_lock:{corp_id}"

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
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{QYAPI_BASE}/gettoken",
                params={"corpid": corp_id, "corpsecret": secret},
            )
            data = resp.json()

        if data.get("errcode") != 0:
            raise ValueError(
                f"failed to obtain access_token: {data.get('errmsg', 'unknown')}"
            )

        token = data["access_token"]
        cache.set(cache_key, token, TOKEN_CACHE_TTL)
        return token
    finally:
        if acquired:
            cache.delete(lock_key)


# ------------------------------------------------------------------
# Adapter
# ------------------------------------------------------------------


class WeChatWorkAdapter(ChannelAdapter):
    """企业微信 (WeChat Work) channel adapter."""

    @property
    def id(self) -> str:
        return "wechat_work"

    @property
    def name(self) -> str:
        return "企业微信"

    @property
    def description(self) -> str:
        return "通过企业微信 Bot API 收发消息，将企业微信对话桥接到 Agent"

    @property
    def icon(self) -> str:
        return "wechat_work"

    @property
    def capabilities(self) -> ChannelCapabilities:
        return ChannelCapabilities(
            chat_types=["direct", "group"],
            media=True,
            supports_webhook=True,
        )

    def get_config_fields(self) -> list:
        from apps.extensions.base import ConfigField
        return [
            ConfigField(
                key="corp_id",
                label="Corp ID",
                required=True,
                help_text="企业微信的企业 ID (CorpID)",
            ),
            ConfigField(
                key="agent_id",
                label="Agent ID",
                required=True,
                help_text="企业微信应用的 AgentId",
            ),
            ConfigField(
                key="secret",
                label="Secret",
                field_type="password",
                required=True,
                help_text="企业微信应用的 Secret",
            ),
            ConfigField(
                key="token",
                label="Token",
                required=True,
                help_text="接收消息回调的 Token（用于 webhook 签名校验）",
            ),
            ConfigField(
                key="encoding_aes_key",
                label="EncodingAESKey",
                field_type="password",
                required=True,
                help_text="消息加密密钥（接收消息回调的 EncodingAESKey）",
            ),
        ]

    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        errors: List[str] = []
        if not (config.get("corp_id") or "").strip():
            errors.append("corp_id is required")
        if not config.get("agent_id"):
            errors.append("agent_id is required")
        if not (config.get("secret") or "").strip():
            errors.append("secret is required")
        if not (config.get("token") or "").strip():
            errors.append("token is required")
        if not (config.get("encoding_aes_key") or "").strip():
            errors.append("encoding_aes_key is required")

        encoding_aes_key = (config.get("encoding_aes_key") or "").strip()
        if encoding_aes_key:
            try:
                from cryptography.hazmat.primitives.ciphers import Cipher  # noqa: F401
            except ImportError:
                errors.append(
                    "cryptography package is required for message encryption "
                    "(pip install cryptography)"
                )

        return errors

    def extract_routing_context(self, data) -> dict | None:
        return {"peer_kind": data.peer_kind} if data.peer_kind else None

    # ------------------------------------------------------------------
    # Connectivity
    # ------------------------------------------------------------------

    async def probe(self, account: ChannelAccount) -> ProbeResult:
        try:
            token = await _get_access_token(account)
            return ProbeResult(
                ok=True,
                raw={"access_token_prefix": token[:8] + "..."},
            )
        except Exception as exc:
            return ProbeResult(ok=False, error=str(exc))

    async def setup_webhook(
        self, account: ChannelAccount, webhook_url: str,
    ) -> bool:
        return True

    # ------------------------------------------------------------------
    # Inbound
    # ------------------------------------------------------------------

    def parse_webhook(
        self,
        request: HttpRequest,
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        config = account.config or {}
        cb_token = (config.get("token") or "").strip()
        encoding_aes_key = (config.get("encoding_aes_key") or "").strip()

        if not cb_token or not encoding_aes_key:
            logger.warning(
                "[WeChatWorkAdapter] token 或 encoding_aes_key 未配置，拒绝处理 webhook"
            )
            return None

        # GET = URL 验证（主要由 webhook view 的 _handle_get_challenge 处理，此处作为兜底）
        if request.method == "GET":
            echostr = request.GET.get("echostr", "")
            if echostr:
                msg_sig = request.GET.get("msg_signature", "")
                ts = request.GET.get("timestamp", "")
                nonce = request.GET.get("nonce", "")
                try:
                    decrypted = decrypt_echostr(
                        encoding_aes_key, cb_token, msg_sig, ts, nonce, echostr,
                    )
                    raise WebhookChallengeResponse(decrypted)
                except WebhookChallengeResponse:
                    raise
                except Exception:
                    logger.exception("[WeChatWorkAdapter] URL verification failed")
            return None

        # POST = 消息回调
        try:
            xml_str = request.body.decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            logger.warning("[WeChatWorkAdapter] invalid body encoding")
            return None

        try:
            xml_data = _parse_xml(xml_str)
        except ET.ParseError:
            logger.warning("[WeChatWorkAdapter] invalid XML body")
            return None

        msg_sig = request.GET.get("msg_signature", "")
        ts = request.GET.get("timestamp", "")
        nonce = request.GET.get("nonce", "")

        if "Encrypt" in xml_data:
            # 加密模式: 验签 + 解密
            encrypt = xml_data["Encrypt"]

            if not _verify_signature(cb_token, ts, nonce, encrypt, msg_sig):
                logger.warning("[WeChatWorkAdapter] message signature verification failed")
                return None

            try:
                decrypted_xml, corp_id = _decrypt_message(encoding_aes_key, encrypt)
                expected_corp_id = (config.get("corp_id") or "").strip()
                if expected_corp_id and corp_id != expected_corp_id:
                    logger.warning(
                        "[WeChatWorkAdapter] corp_id mismatch: got %s, expected %s",
                        corp_id,
                        expected_corp_id,
                    )
                    return None
                xml_data = _parse_xml(decrypted_xml)
            except Exception:
                logger.exception("[WeChatWorkAdapter] message decryption failed")
                return None
        else:
            # 非加密模式: 仍然必须验证签名 (msg_signature)
            body_for_sig = xml_str
            if not _verify_signature(cb_token, ts, nonce, body_for_sig, msg_sig):
                logger.warning(
                    "[WeChatWorkAdapter] plaintext message signature verification failed"
                )
                return None

        return self._parse_message(xml_data, account)

    def _parse_message(
        self,
        xml_data: Dict[str, str],
        account: ChannelAccount,
    ) -> Optional[ChannelInboundMessage]:
        msg_type = xml_data.get("MsgType", "")

        if msg_type == "event":
            return None

        sender_id = xml_data.get("FromUserName", "")
        if not sender_id:
            return None

        to_user = xml_data.get("ToUserName", "")
        agent_id = xml_data.get("AgentID", "")
        msg_id = xml_data.get("MsgId", "")
        create_time = xml_data.get("CreateTime", "")

        text: Optional[str] = None
        media: Optional[List[ChannelMedia]] = None

        if msg_type == "text":
            text = xml_data.get("Content", "")

        elif msg_type == "image":
            pic_url = xml_data.get("PicUrl", "")
            media_id = xml_data.get("MediaId", "")
            if media_id:
                media = [ChannelMedia(kind="image", file_id=media_id, url=pic_url or None)]
            elif pic_url:
                media = [ChannelMedia(kind="image", url=pic_url)]
            else:
                text = "[图片]"

        elif msg_type == "voice":
            media_id = xml_data.get("MediaId", "")
            recognition = xml_data.get("Recognition", "")
            if media_id:
                media = [ChannelMedia(kind="audio", file_id=media_id)]
            text = recognition or "[语音]"

        elif msg_type in ("video", "shortvideo"):
            media_id = xml_data.get("MediaId", "")
            if media_id:
                media = [ChannelMedia(kind="video", file_id=media_id)]
            text = "[视频]"

        elif msg_type == "location":
            label = xml_data.get("Label", "")
            lat = xml_data.get("Location_X", "")
            lng = xml_data.get("Location_Y", "")
            text = f"[位置] {label} ({lat}, {lng})".strip()

        elif msg_type == "link":
            title = xml_data.get("Title", "")
            desc = xml_data.get("Description", "")
            url = xml_data.get("Url", "")
            text = f"{title}\n{desc}\n{url}".strip()

        else:
            text = f"[{msg_type}]"

        if not text and not media:
            return None

        # peer_kind / peer_id resolution:
        # - Application messages (user→app): peer_id = sender's userId, peer_kind = dm
        # - Group chat bot messages (if ChatId present): peer_id = ChatId, peer_kind = group
        chat_id = xml_data.get("ChatId", "")
        if chat_id:
            peer_kind = "group"
            peer_id = chat_id
        else:
            peer_kind = "dm"
            peer_id = sender_id

        _cache_peer_kind(account.account_id, peer_id, peer_kind)

        try:
            timestamp = int(create_time) if create_time else int(time.time())
        except (ValueError, TypeError):
            timestamp = int(time.time())

        metadata: Dict[str, Any] = {"msg_type": msg_type}
        if agent_id:
            metadata["agent_id"] = agent_id
        if to_user:
            metadata["corp_id"] = to_user

        return ChannelInboundMessage(
            schema_version=CHANNEL_PROTOCOL_VERSION,
            type="channel.inbound",
            channel=self.id,
            account_id=account.account_id,
            organization_id=str(account.organization_id),
            peer_kind=peer_kind,
            peer_id=peer_id,
            sender_id=sender_id,
            message_id=msg_id or str(int(time.time() * 1000)),
            text=text,
            media=media,
            timestamp=timestamp,
            metadata=metadata,
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
        token = await _get_access_token(account)
        config = account.config or {}
        agent_id = config.get("agent_id", 1)
        is_group = self._resolve_is_group(account, to)
        chunks = self.chunk_text(text, TEXT_CHUNK_LIMIT)
        last_msg_id: Optional[str] = None

        for chunk in chunks:
            if is_group:
                payload: Dict[str, Any] = {
                    "chatid": to,
                    "msgtype": "markdown",
                    "markdown": {"content": chunk},
                }
            else:
                payload = {
                    "touser": to,
                    "msgtype": "markdown",
                    "agentid": agent_id,
                    "markdown": {"content": chunk},
                }
            result = await self._send_message(token, payload, group=is_group)
            if not result.ok:
                return result
            last_msg_id = result.provider_message_id

        return SendResult(ok=True, provider_message_id=last_msg_id)

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
        token = await _get_access_token(account)
        config = account.config or {}
        agent_id = config.get("agent_id", 1)
        is_group = self._resolve_is_group(account, to)

        is_image = (mime_type or "").startswith("image/") or any(
            media_url.lower().endswith(ext)
            for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")
        )

        try:
            media_id = await self._upload_media(
                token, media_url, "image" if is_image else "file",
            )
        except Exception as exc:
            logger.error("[WeChatWorkAdapter] media upload failed: %s", exc)
            fallback = caption or media_url
            if caption and media_url:
                fallback = f"{caption}\n{media_url}"
            return await self.send_text(account, to, fallback, reply_to=reply_to)

        media_type = "image" if is_image else "file"
        media_body = {"media_id": media_id}
        if is_group:
            payload: Dict[str, Any] = {
                "chatid": to,
                "msgtype": media_type,
                media_type: media_body,
            }
        else:
            payload = {
                "touser": to,
                "msgtype": media_type,
                "agentid": agent_id,
                media_type: media_body,
            }

        result = await self._send_message(token, payload, group=is_group)

        if result.ok and caption:
            await self.send_text(account, to, caption, reply_to=reply_to)

        return result

    def _resolve_is_group(self, account: ChannelAccount, to: str) -> bool:
        """Determine if `to` is a group chat. Cache first, then DB fallback."""
        cached = _get_peer_kind(account.account_id, to)
        if cached:
            return cached == "group"
        from apps.channel_gateway.services.binding_service import ChannelBindingService
        routing = ChannelBindingService.get_binding_routing(
            "wechat_work", account.account_id, to, str(account.organization_id),
        )
        if routing:
            pk = routing.get("peer_kind", "dm")
            _cache_peer_kind(account.account_id, to, pk)
            return pk == "group"
        return False

    # ------------------------------------------------------------------
    # Internal API helpers
    # ------------------------------------------------------------------

    @staticmethod
    async def _send_message(
        token: str, payload: Dict[str, Any], *, group: bool = False,
    ) -> SendResult:
        api_path = "/appchat/send" if group else "/message/send"
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    f"{QYAPI_BASE}{api_path}",
                    params={"access_token": token},
                    json=payload,
                )
                data = resp.json()

            if data.get("errcode") == 0:
                return SendResult(
                    ok=True,
                    provider_message_id=data.get("msgid", ""),
                )

            error = data.get("errmsg", f"errcode {data.get('errcode')}")
            logger.warning("[WeChatWorkAdapter] send_message failed: %s", error)
            return SendResult(ok=False, error=error)
        except Exception as exc:
            logger.error("[WeChatWorkAdapter] send_message error: %s", exc)
            return SendResult(ok=False, error=str(exc))

    @staticmethod
    async def _upload_media(token: str, media_url: str, media_type: str) -> str:
        """下载外部 media_url 并上传到企业微信，返回 media_id。"""
        async with httpx.AsyncClient(timeout=60) as client:
            dl_resp = await client.get(media_url)
            dl_resp.raise_for_status()
            file_bytes = dl_resp.content
            content_type = dl_resp.headers.get(
                "content-type", "application/octet-stream",
            )

        filename = media_url.rsplit("/", 1)[-1][:100] or "file"

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{QYAPI_BASE}/media/upload",
                params={"access_token": token, "type": media_type},
                files={"media": (filename, file_bytes, content_type)},
            )
            result = resp.json()

        if result.get("errcode") != 0:
            raise ValueError(f"upload failed: {result.get('errmsg', 'unknown')}")

        return result.get("media_id", "")

"""iLink Bot API client for WeChat personal account integration.

Implements the Tencent iLink protocol (https://ilinkai.weixin.qq.com)
for QR-code login, long-poll message retrieval, message sending,
typing indicators, and CDN media upload/download with AES-128-ECB encryption.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import struct
import time
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
ILINK_CHANNEL_VERSION = "2.0.0"

DEFAULT_API_TIMEOUT_S = 15
DEFAULT_LONGPOLL_TIMEOUT_S = 35
DEFAULT_CONFIG_TIMEOUT_S = 10

SESSION_EXPIRED_ERRCODE = -14


# ---------------------------------------------------------------------------
# Header construction
# ---------------------------------------------------------------------------

def _random_wechat_uin() -> str:
    """X-WECHAT-UIN: random uint32 → decimal string → base64."""
    uint32 = int.from_bytes(os.urandom(4), "big")
    return base64.b64encode(str(uint32).encode()).decode()


def _build_headers(token: Optional[str] = None) -> Dict[str, str]:
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": _random_wechat_uin(),
    }
    if token and token.strip():
        headers["Authorization"] = f"Bearer {token.strip()}"
    return headers


def _build_base_info() -> Dict[str, str]:
    return {"channel_version": ILINK_CHANNEL_VERSION}


# ---------------------------------------------------------------------------
# Low-level API fetch
# ---------------------------------------------------------------------------

async def _api_fetch(
    *,
    base_url: str,
    endpoint: str,
    body: Dict[str, Any],
    token: Optional[str] = None,
    timeout_s: float = DEFAULT_API_TIMEOUT_S,
    label: str = "ilink",
) -> Dict[str, Any]:
    """POST JSON to an iLink endpoint and return parsed response."""
    import json as _json

    url = f"{base_url.rstrip('/')}/{endpoint.lstrip('/')}"
    headers = _build_headers(token)
    raw_body = _json.dumps(body, ensure_ascii=False)

    async with httpx.AsyncClient(timeout=timeout_s + 5) as client:
        resp = await client.post(
            url,
            content=raw_body.encode("utf-8"),
            headers=headers,
        )
        if not resp.is_success:
            raise ILinkApiError(f"{label} HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()


class ILinkApiError(Exception):
    """Non-retryable iLink API error."""


class ILinkSessionExpiredError(ILinkApiError):
    """errcode -14: bot_token session expired, user must re-scan QR."""


# ---------------------------------------------------------------------------
# Public API functions
# ---------------------------------------------------------------------------

async def get_updates(
    *,
    base_url: str,
    token: str,
    get_updates_buf: str = "",
    timeout_s: float = DEFAULT_LONGPOLL_TIMEOUT_S,
) -> Dict[str, Any]:
    """Long-poll for new messages. Server holds up to ``timeout_s`` seconds.

    Returns ``{"ret": 0, "msgs": [...], "get_updates_buf": "..."}``
    """
    body: Dict[str, Any] = {
        "get_updates_buf": get_updates_buf,
        "base_info": _build_base_info(),
    }
    try:
        result = await _api_fetch(
            base_url=base_url,
            endpoint="ilink/bot/getupdates",
            body=body,
            token=token,
            timeout_s=timeout_s,
            label="getUpdates",
        )
    except httpx.ReadTimeout:
        logger.debug("[ilink] getUpdates long-poll timeout, returning empty")
        return {"ret": 0, "msgs": [], "get_updates_buf": get_updates_buf}

    errcode = result.get("ret", 0)
    if errcode == SESSION_EXPIRED_ERRCODE:
        raise ILinkSessionExpiredError("bot_token session expired (errcode -14)")
    if errcode != 0:
        raise ILinkApiError(f"getUpdates errcode={errcode}: {result}")

    return result


async def send_message(
    *,
    base_url: str,
    token: str,
    msg: Dict[str, Any],
) -> Dict[str, Any]:
    """Send a message (text, image, video, file, voice)."""
    body: Dict[str, Any] = {
        "msg": msg,
        "base_info": _build_base_info(),
    }
    result = await _api_fetch(
        base_url=base_url,
        endpoint="ilink/bot/sendmessage",
        body=body,
        token=token,
        timeout_s=DEFAULT_API_TIMEOUT_S,
        label="sendMessage",
    )
    errcode = result.get("ret", 0)
    if errcode == SESSION_EXPIRED_ERRCODE:
        raise ILinkSessionExpiredError("bot_token session expired (errcode -14)")
    if errcode != 0:
        logger.warning("[ilink] sendMessage errcode=%d: %s", errcode, result)
    return result


async def get_config(
    *,
    base_url: str,
    token: str,
) -> Dict[str, Any]:
    """Get account config (typing_ticket etc.)."""
    body: Dict[str, Any] = {"base_info": _build_base_info()}
    result = await _api_fetch(
        base_url=base_url,
        endpoint="ilink/bot/getconfig",
        body=body,
        token=token,
        timeout_s=DEFAULT_CONFIG_TIMEOUT_S,
        label="getConfig",
    )
    errcode = result.get("ret", 0)
    if errcode == SESSION_EXPIRED_ERRCODE:
        raise ILinkSessionExpiredError("bot_token session expired (errcode -14)")
    return result


async def send_typing(
    *,
    base_url: str,
    token: str,
    typing_ticket: str,
    to_user_id: str,
    action: str = "typing",
) -> Dict[str, Any]:
    """Send or cancel typing indicator.

    action: "typing" to start, "cancel" to stop.
    """
    body: Dict[str, Any] = {
        "typing_ticket": typing_ticket,
        "to_user_id": to_user_id,
        "action": action,
        "base_info": _build_base_info(),
    }
    return await _api_fetch(
        base_url=base_url,
        endpoint="ilink/bot/sendtyping",
        body=body,
        token=token,
        timeout_s=DEFAULT_API_TIMEOUT_S,
        label="sendTyping",
    )


async def get_upload_url(
    *,
    base_url: str,
    token: str,
    file_name: str,
    file_size: int,
    file_type: str = "image",
) -> Dict[str, Any]:
    """Get a presigned CDN upload URL for media."""
    body: Dict[str, Any] = {
        "file_name": file_name,
        "file_size": file_size,
        "file_type": file_type,
        "base_info": _build_base_info(),
    }
    return await _api_fetch(
        base_url=base_url,
        endpoint="ilink/bot/getuploadurl",
        body=body,
        token=token,
        timeout_s=DEFAULT_API_TIMEOUT_S,
        label="getUploadUrl",
    )


# ---------------------------------------------------------------------------
# QR Login
# ---------------------------------------------------------------------------

async def get_qr_code(*, base_url: str = ILINK_DEFAULT_BASE_URL) -> Dict[str, Any]:
    """Request a new login QR code."""
    url = f"{base_url.rstrip('/')}/ilink/bot/get_bot_qrcode?bot_type=3"
    headers = _build_headers()
    async with httpx.AsyncClient(timeout=DEFAULT_API_TIMEOUT_S + 5) as client:
        resp = await client.get(url, headers=headers)
        if not resp.is_success:
            raise ILinkApiError(f"get_bot_qrcode HTTP {resp.status_code}")
        return resp.json()


async def poll_qr_status(
    *,
    base_url: str = ILINK_DEFAULT_BASE_URL,
    qrcode: str,
) -> Dict[str, Any]:
    """Poll QR scan status. Returns state: wait/scanned/confirmed/expired."""
    url = f"{base_url.rstrip('/')}/ilink/bot/get_qrcode_status?qrcode={qrcode}"
    headers = _build_headers()
    async with httpx.AsyncClient(timeout=DEFAULT_API_TIMEOUT_S + 5) as client:
        resp = await client.get(url, headers=headers)
        if not resp.is_success:
            raise ILinkApiError(f"get_qrcode_status HTTP {resp.status_code}")
        return resp.json()


# ---------------------------------------------------------------------------
# AES-128-ECB media crypto
# ---------------------------------------------------------------------------

def _parse_aes_key(raw_key: str) -> bytes:
    """Parse AES key from various formats used by iLink CDN.

    Supports 3 encoding formats:
    1. base64-encoded raw bytes (16 bytes after decode)
    2. base64-encoded hex string (32 hex chars → 16 bytes)
    3. direct hex string (32 hex chars → 16 bytes)
    """
    try:
        decoded = base64.b64decode(raw_key)
        if len(decoded) == 16:
            return decoded
        hex_str = decoded.decode("ascii")
        if len(hex_str) == 32:
            return bytes.fromhex(hex_str)
    except (ValueError, UnicodeDecodeError, base64.binascii.Error):
        pass

    if len(raw_key) == 32:
        try:
            return bytes.fromhex(raw_key)
        except ValueError:
            pass

    raise ValueError(f"Cannot parse AES key: length={len(raw_key)}")


def _pkcs7_pad(data: bytes, block_size: int = 16) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def _pkcs7_unpad(data: bytes) -> bytes:
    pad_len = data[-1]
    if pad_len < 1 or pad_len > 16:
        raise ValueError("Invalid PKCS7 padding")
    if data[-pad_len:] != bytes([pad_len] * pad_len):
        raise ValueError("Corrupt PKCS7 padding")
    return data[:-pad_len]


def encrypt_media(data: bytes, aes_key_raw: str) -> bytes:
    """Encrypt media data with AES-128-ECB + PKCS7.

    SECURITY NOTE: AES-ECB is a weak mode (identical plaintext blocks produce
    identical ciphertext). This is mandated by the iLink CDN protocol and cannot
    be changed unilaterally. The risk is mitigated by:
    - Media files have high entropy (images/video), reducing ECB pattern leakage
    - Transport layer uses HTTPS, providing an additional encryption layer
    - Keys are per-upload, limiting the scope of any single key compromise
    """
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key = _parse_aes_key(aes_key_raw)
    padded = _pkcs7_pad(data)
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    encryptor = cipher.encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def decrypt_media(data: bytes, aes_key_raw: str) -> bytes:
    """Decrypt media data with AES-128-ECB + PKCS7."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    key = _parse_aes_key(aes_key_raw)
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    decryptor = cipher.decryptor()
    decrypted = decryptor.update(data) + decryptor.finalize()
    return _pkcs7_unpad(decrypted)


# ---------------------------------------------------------------------------
# Message construction helpers
# ---------------------------------------------------------------------------

# iLink message item types
ITEM_TYPE_NONE = 0
ITEM_TYPE_TEXT = 1
ITEM_TYPE_IMAGE = 2
ITEM_TYPE_VOICE = 3
ITEM_TYPE_FILE = 4
ITEM_TYPE_VIDEO = 5

MSG_TYPE_BOT = 2
MSG_STATE_FINISH = 2


def build_text_message(
    *,
    to_user_id: str,
    text: str,
    context_token: str,
    client_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a text reply message payload."""
    if not client_id:
        client_id = f"tabtin:{int(time.time() * 1000)}-{os.urandom(4).hex()}"

    return {
        "to_user_id": to_user_id,
        "client_id": client_id,
        "message_type": MSG_TYPE_BOT,
        "message_state": MSG_STATE_FINISH,
        "context_token": context_token,
        "item_list": [
            {
                "type": ITEM_TYPE_TEXT,
                "text_item": {"text": text},
            }
        ],
    }

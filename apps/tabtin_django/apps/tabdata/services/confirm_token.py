"""
A3 update-by-filter confirm_token HMAC 服务

W0-5 设计稿实施：HMAC-SHA256 签名 / 校验 / nonce 占位（Redis）。
token 格式：payload_b64url.signature_b64url
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import secrets
import time
from dataclasses import asdict, dataclass, fields
from typing import Any, Dict, Optional
from uuid import UUID

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

from apps.tabdata.exceptions import (
    ConfirmTokenBadSignature,
    ConfirmTokenDriftTooLarge,
    ConfirmTokenExpired,
    ConfirmTokenMalformed,
    ConfirmTokenReplayDetected,
    ConfirmTokenSchemaUnknown,
)

logger = logging.getLogger(__name__)


# ── canonical JSON + hash ─────────────────────────────────────────

def canonical_json(obj: Any) -> bytes:
    """规范化 JSON 序列化，保证同一逻辑结构总是产生同一字节串。"""
    return json.dumps(
        obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'),
        allow_nan=False,
    ).encode('utf-8')


def sha256_hex(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj)).hexdigest()


# ── secret 来源 ───────────────────────────────────────────────────

def _get_confirm_token_secret() -> str:
    secret = getattr(settings, 'TABDATA_CONFIRM_TOKEN_SECRET', '') or ''
    if secret:
        return secret
    if not getattr(settings, 'DEBUG', False) and not getattr(settings, 'RUNNING_TESTS', False):
        raise ImproperlyConfigured(
            "TABDATA_CONFIRM_TOKEN_SECRET must be explicitly configured in production."
        )
    logger.warning(
        "[ConfirmToken] TABDATA_CONFIRM_TOKEN_SECRET not set — falling back to SECRET_KEY (DEBUG only)."
    )
    return settings.SECRET_KEY


# ── base64url ─────────────────────────────────────────────────────

def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    if padding != 4:
        s += '=' * padding
    return base64.urlsafe_b64decode(s)


# ── payload dataclass ─────────────────────────────────────────────

@dataclass(frozen=True)
class ConfirmTokenPayload:
    """A3 update-by-filter 防 TOCTOU 的 HMAC token 载荷。"""

    v: int
    nonce: str
    user_id: str
    space_id: str
    table_id: str
    table_version: int
    filter_hash: str
    patch_hash: str
    matched_total: int
    rls_context_hash: str
    requires_checkpoint_anchor: bool
    auto_anchor_checkpoint: bool
    issued_at: int
    expires_at: int

    def to_canonical_dict(self) -> Dict[str, Any]:
        return {k: asdict(self)[k] for k in sorted(asdict(self).keys())}


# ── 签名 / 校验 ──────────────────────────────────────────────────

def sign_confirm_token(payload: ConfirmTokenPayload) -> str:
    body = _b64url_encode(canonical_json(payload.to_canonical_dict()))
    sig = hmac.new(
        _get_confirm_token_secret().encode('utf-8'),
        body.encode('ascii'),
        hashlib.sha256,
    ).digest()
    return f"{body}.{_b64url_encode(sig)}"


def verify_confirm_token_signature(token: str) -> ConfirmTokenPayload:
    """签名 + 格式 + 过期校验。返回 payload 供调用方继续做业务校验。"""
    parts = token.split('.')
    if len(parts) != 2:
        raise ConfirmTokenMalformed("token format invalid")

    body_b64, sig_b64 = parts
    try:
        expected_sig = hmac.new(
            _get_confirm_token_secret().encode('utf-8'),
            body_b64.encode('ascii'),
            hashlib.sha256,
        ).digest()
        actual_sig = _b64url_decode(sig_b64)
    except (binascii.Error, ValueError) as exc:
        raise ConfirmTokenMalformed("signature decode failed") from exc

    if not hmac.compare_digest(expected_sig, actual_sig):
        raise ConfirmTokenBadSignature("HMAC mismatch")

    try:
        body_json = json.loads(_b64url_decode(body_b64))
    except (json.JSONDecodeError, ValueError, binascii.Error) as exc:
        raise ConfirmTokenMalformed("payload decode failed") from exc

    v = body_json.get('v')
    if v != 1:
        raise ConfirmTokenSchemaUnknown(f"unsupported schema version: {v}")

    expected_fields = {f.name for f in fields(ConfirmTokenPayload)}
    if set(body_json.keys()) != expected_fields:
        raise ConfirmTokenMalformed(
            f"payload field set mismatch: missing={expected_fields - body_json.keys()},"
            f" extra={body_json.keys() - expected_fields}"
        )
    try:
        payload = ConfirmTokenPayload(**body_json)
    except TypeError as exc:
        raise ConfirmTokenMalformed(f"payload construction failed: {exc}") from exc

    if int(time.time()) >= payload.expires_at:
        raise ConfirmTokenExpired(
            issued_at=payload.issued_at, expires_at=payload.expires_at
        )

    return payload


# ── preflight token 签发 ──────────────────────────────────────────

def issue_confirm_token(
    *,
    user_id: str,
    space_id: str,
    table_id: str,
    table_version: int,
    filter_clause: Any,
    patch: Any,
    matched_total: int,
    rls_context_hash: str = "",
    is_agent: bool = False,
) -> tuple[str, ConfirmTokenPayload]:
    """签发 confirm_token，返回 (token_str, payload)。"""
    now = int(time.time())
    ttl = getattr(settings, 'TABDATA_CONFIRM_TOKEN_TTL_SECONDS', 300)
    threshold_hint = getattr(settings, 'TABDATA_A3_THRESHOLD_REQUIRE_CHECKPOINT_HINT', 200)
    threshold_auto = getattr(settings, 'TABDATA_A3_THRESHOLD_AUTO_CHECKPOINT', 1000)
    agent_force = getattr(settings, 'TABDATA_A3_AGENT_FORCE_CHECKPOINT', True)

    requires_hint = matched_total >= threshold_hint or is_agent
    auto_anchor = matched_total >= threshold_auto or (is_agent and agent_force)

    payload = ConfirmTokenPayload(
        v=1,
        nonce=secrets.token_hex(16),
        user_id=user_id,
        space_id=space_id,
        table_id=table_id,
        table_version=table_version,
        filter_hash=sha256_hex(filter_clause),
        patch_hash=sha256_hex(patch),
        matched_total=matched_total,
        rls_context_hash=rls_context_hash,
        requires_checkpoint_anchor=requires_hint,
        auto_anchor_checkpoint=auto_anchor,
        issued_at=now,
        expires_at=now + ttl,
    )
    token_str = sign_confirm_token(payload)
    return token_str, payload


# ── nonce 占位（Redis）────────────────────────────────────────────

NONCE_KEY_FMT = "confirm_token:nonce:{}"


def _get_redis():
    from django.core.cache import caches
    return caches['default'].client.get_client()


def reserve_nonce(nonce: str, ttl_seconds: int = 0) -> bool:
    """SETNX 占位。True = 占位成功；False = 已被占位（重放）。"""
    if not ttl_seconds:
        ttl_seconds = getattr(settings, 'TABDATA_CONFIRM_TOKEN_NONCE_RESERVE_TTL_SECONDS', 420)
    try:
        redis = _get_redis()
        return redis.set(
            NONCE_KEY_FMT.format(nonce),
            "reserved",
            nx=True,
            ex=ttl_seconds,
        ) is True
    except Exception:
        logger.error("[ConfirmToken] Redis unavailable for nonce reservation", exc_info=True)
        from apps.tabdata.exceptions import ConfirmTokenRedisUnavailable
        raise ConfirmTokenRedisUnavailable()


def get_nonce_state(nonce: str) -> Optional[str]:
    try:
        redis = _get_redis()
        val = redis.get(NONCE_KEY_FMT.format(nonce))
        if isinstance(val, bytes):
            return val.decode('utf-8')
        return val
    except Exception:
        return None


def mark_nonce_used(nonce: str, commit_response: dict, ttl_seconds: int = 0) -> None:
    if not ttl_seconds:
        ttl_seconds = getattr(settings, 'TABDATA_CONFIRM_TOKEN_NONCE_RESERVE_TTL_SECONDS', 420)
    try:
        redis = _get_redis()
        redis.set(
            NONCE_KEY_FMT.format(nonce),
            "used:" + json.dumps(commit_response, ensure_ascii=False, default=str),
            xx=True,
            ex=ttl_seconds,
        )
    except Exception:
        logger.warning("[ConfirmToken] Failed to mark nonce as used", exc_info=True)


def mark_nonce_failed(nonce: str, error_code: str, ttl_seconds: int = 0) -> None:
    if not ttl_seconds:
        ttl_seconds = getattr(settings, 'TABDATA_CONFIRM_TOKEN_NONCE_RESERVE_TTL_SECONDS', 420)
    try:
        redis = _get_redis()
        redis.set(
            NONCE_KEY_FMT.format(nonce),
            "failed:" + error_code,
            xx=True,
            ex=ttl_seconds,
        )
    except Exception:
        logger.warning("[ConfirmToken] Failed to mark nonce as failed", exc_info=True)

"""
DaemonTokenService — Daemon 安装 Token 生成与设备激活

负责：
1. 生成短期 install token（JWT 格式，scope=device_register）
2. 验证 token 并激活设备（注册 Device + 签发长期 access_token）
"""
import json
import logging
import base64
import binascii
import hmac
import hashlib
import time
import uuid as _uuid
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List
from uuid import UUID

import jwt as _pyjwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver

from apps.services.common.device_capability_registry import (
    infer_device_role,
    normalize_device_capabilities,
    normalize_device_type,
)
from apps.tabtinspace.models import Organization, Device
from .base import BaseService

logger = logging.getLogger(__name__)
User = get_user_model()


class DeviceFingerprintConflictError(Exception):
    """设备指纹已绑定其他身份或安装令牌，路由层应返回 409。"""


_ACTIVATION_TOKEN_DIGEST_KEY = "daemon_activation_token_sha256"


# ---------------------------------------------------------------------------
# DE-07: 非 DEBUG 强制独立 DAEMON_TOKEN_SECRET
# ---------------------------------------------------------------------------

def _get_token_secret() -> str:
    """获取 install token 签名密钥；非 DEBUG 强制要求独立配置 DAEMON_TOKEN_SECRET。"""
    secret = getattr(settings, 'DAEMON_TOKEN_SECRET', None)
    if secret:
        return secret
    if not getattr(settings, 'DEBUG', False):
        from django.core.exceptions import ImproperlyConfigured
        raise ImproperlyConfigured(
            "DAEMON_TOKEN_SECRET must be explicitly configured in production. "
            "Falling back to SECRET_KEY is forbidden outside DEBUG mode."
        )
    logger.warning(
        "[DaemonToken] DAEMON_TOKEN_SECRET not set — falling back to SECRET_KEY (DEBUG only)."
    )
    return settings.SECRET_KEY


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64url_decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    if padding != 4:
        s += '=' * padding
    return base64.urlsafe_b64decode(s)


def _sign_token(payload: dict) -> str:
    """简单 HMAC-SHA256 签名的 JWT-like token: header.payload.signature"""
    header = _b64url_encode(json.dumps({"alg": "HS256", "typ": "DIT"}).encode())
    body = _b64url_encode(json.dumps(payload).encode())
    msg = f"{header}.{body}"
    sig = hmac.new(_get_token_secret().encode(), msg.encode(), hashlib.sha256).digest()
    return f"{msg}.{_b64url_encode(sig)}"


def _verify_token(token: str) -> Optional[dict]:
    """验证并解析 token，返回 payload 或 None"""
    parts = token.split('.')
    if len(parts) != 3:
        return None
    header_b64, body_b64, sig_b64 = parts
    try:
        msg = f"{header_b64}.{body_b64}"
        expected_sig = hmac.new(_get_token_secret().encode(), msg.encode(), hashlib.sha256).digest()
        actual_sig = _b64url_decode(sig_b64)
    except (binascii.Error, ValueError, TypeError):
        return None

    if not hmac.compare_digest(expected_sig, actual_sig):
        return None

    try:
        payload = json.loads(_b64url_decode(body_b64))
    except (json.JSONDecodeError, ValueError, TypeError, binascii.Error):
        return None

    if payload.get('scope') != 'device_register':
        return None

    required_fields = ('organization_id', 'user_id', 'server_url', 'ws_url', 'device_name')
    if any(not payload.get(field) for field in required_fields):
        return None

    expires_at = payload.get('expires_at')
    if not expires_at:
        logger.warning("[DaemonToken] token rejected: missing required expires_at field")
        return None
    try:
        exp = datetime.fromisoformat(expires_at)
    except (TypeError, ValueError):
        return None
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > exp:
        return None
    return payload


# ---------------------------------------------------------------------------
# Redis 辅助
# ---------------------------------------------------------------------------

def _get_redis_client():
    """获取 Redis 客户端（复用 _claim_token 连接参数）。"""
    import redis as _redis
    return _redis.Redis(
        host=getattr(settings, "REDIS_HOST", "localhost"),
        port=getattr(settings, "REDIS_PORT", 6379),
        db=getattr(settings, "REDIS_DB", 0),
        decode_responses=True,
    )


# ---------------------------------------------------------------------------
# DE-06 / DE-08: Daemon access token — 24h 有效期 + jti + device_id
# ---------------------------------------------------------------------------

def _generate_daemon_access_token(user, device_fingerprint: str, expire_hours: int = 24) -> str:
    """签发含 jti + device_id 的 daemon access token，返回 token 字符串。

    jti 注册在函数内部完成，调用方无需感知。
    """
    from django.utils import timezone as dj_tz

    jti = str(_uuid.uuid4())
    now = dj_tz.now()
    payload = {
        'user_id': str(user.id),
        'token_type': 'daemon',
        'device_id': device_fingerprint,
        'jti': jti,
        'exp': now + timedelta(hours=expire_hours),
        'iat': now,
    }

    token = _pyjwt.encode(payload, settings.JWT_SECRET_KEY, algorithm='HS256')
    if isinstance(token, bytes):
        token = token.decode('utf-8')

    _register_daemon_jti(jti, device_fingerprint, expire_hours * 3600)
    return token


def _register_daemon_jti(jti: str, device_fingerprint: str, ttl_seconds: int) -> None:
    """将 jti 注册到 Redis，支持按设备批量吊销。"""
    try:
        client = _get_redis_client()
        pipe = client.pipeline()
        pipe.setex(f"daemon:jti:{jti}", ttl_seconds + 60, str(time.time()))
        pipe.sadd(f"daemon:device_jtis:{device_fingerprint}", jti)
        pipe.expire(f"daemon:device_jtis:{device_fingerprint}", ttl_seconds + 60)
        pipe.execute()
    except Exception as exc:
        logger.warning("[DaemonToken] Failed to register jti for revocation tracking: %s", exc)


def revoke_device_tokens(device_fingerprint: str) -> int:
    """吊销指定设备的所有 daemon access token。

    将设备关联的所有 jti 加入黑名单，供 is_daemon_token_revoked() 查询。
    """
    try:
        client = _get_redis_client()
        jtis_key = f"daemon:device_jtis:{device_fingerprint}"
        jtis = client.smembers(jtis_key)
        if not jtis:
            return 0
        pipe = client.pipeline()
        for jti in jtis:
            pipe.setex(f"daemon:revoked:{jti}", 25 * 3600, "1")
            pipe.delete(f"daemon:jti:{jti}")
        pipe.delete(jtis_key)
        pipe.execute()
        revoked = len(jtis)
        logger.info("[DaemonToken] Revoked %d token(s) for device fingerprint=%s", revoked, device_fingerprint)
        return revoked
    except Exception as exc:
        logger.error("[DaemonToken] Failed to revoke tokens for device %s: %s", device_fingerprint, exc)
        return 0


def _revoke_jtis_before(device_fingerprint: str, issued_before: float) -> int:
    """吊销指定设备在 issued_before 之前注册的所有 jti。

    由 Celery 延迟任务 revoke_stale_daemon_jtis 调用，
    使用时间戳过滤避免快速连续续期时误吊销后续签发的有效 token。
    """
    client = _get_redis_client()
    jtis_key = f"daemon:device_jtis:{device_fingerprint}"
    jtis = client.smembers(jtis_key)
    if not jtis:
        return 0

    to_revoke = []
    stale_jtis = []

    for jti in jtis:
        ts_str = client.get(f"daemon:jti:{jti}")
        if ts_str is None:
            stale_jtis.append(jti)
            continue
        try:
            reg_ts = float(ts_str)
        except (ValueError, TypeError):
            to_revoke.append(jti)
            continue
        if reg_ts < issued_before:
            to_revoke.append(jti)

    if not to_revoke and not stale_jtis:
        return 0

    pipe = client.pipeline()
    for jti in to_revoke:
        pipe.setex(f"daemon:revoked:{jti}", 25 * 3600, "1")
        pipe.delete(f"daemon:jti:{jti}")
        pipe.srem(jtis_key, jti)
    for jti in stale_jtis:
        pipe.srem(jtis_key, jti)
    pipe.execute()
    return len(to_revoke)


def is_daemon_token_revoked(jti: str) -> bool:
    """检查 daemon token 是否已被吊销。供 JWT 认证中间件调用。"""
    if not jti:
        return False
    try:
        client = _get_redis_client()
        return client.exists(f"daemon:revoked:{jti}") > 0
    except Exception:
        return False


def verify_daemon_device_claim(token_payload: dict, expected_fingerprint: str) -> bool:
    """校验 JWT 中的 device_id claim 与请求设备指纹一致（DE-08 / DS-007）。

    供心跳等设备认证端点调用。
    不含 device_id 的旧 token 一律拒绝（产品未上线，无兼容包袱）。
    """
    device_id = token_payload.get('device_id')
    if device_id is None:
        logger.warning(
            "[DaemonToken] Rejected daemon token without device_id claim (user=%s)",
            token_payload.get('user_id'),
        )
        return False
    return hmac.compare_digest(str(device_id), str(expected_fingerprint))


# ---------------------------------------------------------------------------
# DE-06: 设备删除时自动吊销 token（signal）
# ---------------------------------------------------------------------------

@receiver(post_delete, sender=Device)
def _on_device_deleted(sender, instance, **kwargs):
    """设备删除时自动吊销其所有 daemon access token。"""
    fp = getattr(instance, 'fingerprint', None)
    if fp:
        revoke_device_tokens(fp)


def renew_daemon_token(user, device_fingerprint: str, expire_hours: int = 24) -> Optional[str]:
    """为已激活的 daemon 设备续期 access token。

    验证设备归属后先签发新 token，再延迟 60s 吊销旧 token，
    避免并发请求在新旧 token 交接窗口被 401。
    返回新 token 字符串，失败返回 None。
    """
    try:
        device = Device.objects.get(
            fingerprint=device_fingerprint,
            user_id=user.id,
            device_type__in=('daemon', 'cloud'),
            control_status='active',
        )
    except Device.DoesNotExist:
        logger.warning(
            "[DaemonToken] renew rejected: device not found (fingerprint=%s, user=%s)",
            device_fingerprint, user.id,
        )
        return None

    issued_before = time.time()
    new_token = _generate_daemon_access_token(user, device_fingerprint, expire_hours=expire_hours)

    from apps.tabtinspace.tasks import revoke_stale_daemon_jtis
    revoke_stale_daemon_jtis.apply_async(
        kwargs={'device_fingerprint': device_fingerprint, 'issued_before': issued_before},
        countdown=60,
    )

    logger.info(
        "[DaemonToken] token renewed: device=%s, fingerprint=%s, user=%s, expires_in=%dh",
        device.id, device_fingerprint, user.id, expire_hours,
    )
    return new_token


class DaemonTokenService(BaseService):
    """Daemon 安装 Token 服务"""

    def create_install_token(
        self,
        organization_id: UUID,
        device_name: str,
        expires_minutes: int = 60,
    ) -> Optional[Dict[str, Any]]:
        """生成 install token — 需要用户已认证且有 organization 权限"""
        if not self.user:
            return None
        if not self.check_organization_permission(str(organization_id), 'editor'):
            return None

        expires_at = datetime.now(timezone.utc) + timedelta(minutes=expires_minutes)
        ws_url = settings.DAEMON_WS_URL
        server_url = settings.DAEMON_SERVER_URL

        payload = {
            'organization_id': str(organization_id),
            'user_id': str(self.user.id),
            'device_name': device_name,
            'expires_at': expires_at.isoformat(),
            'scope': 'device_register',
            'server_url': server_url,
            'ws_url': ws_url,
        }

        token = _sign_token(payload)
        logger.info(
            "[DaemonToken] install token created: organization=%s, device=%s, user=%s, expires=%s",
            organization_id, device_name, self.user.id, expires_at.isoformat(),
        )

        return {
            'token': token,
            'expires_at': expires_at.isoformat(),
        }

    def activate_device(
        self,
        token: str,
        fingerprint: str,
        device_type: str = 'daemon',
        device_name: str = '',
        os_info: Optional[Dict[str, Any]] = None,
        capabilities: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        """验证 install token 并注册设备 — 无需预认证（Token 自带授权信息）"""
        payload = _verify_token(token)
        if not payload:
            logger.warning("[DaemonToken] invalid or expired token")
            return None

        if not self._claim_token(token, fingerprint, payload):
            logger.warning("[DaemonToken] token already used by another device (replay attempt)")
            return None

        organization_id = payload['organization_id']
        user_id = payload['user_id']
        name = device_name or payload.get('device_name', 'Daemon')

        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            logger.warning("[DaemonToken] user not found: %s", user_id)
            return None

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            logger.warning("[DaemonToken] organization not found: %s", organization_id)
            return None

        control_enabled = bool(
            getattr(settings, 'DAEMON_CONTROL_ENABLED', False)
        )
        normalized_device_type = normalize_device_type(device_type, default='daemon')
        if control_enabled and normalized_device_type not in {'daemon', 'cloud'}:
            logger.warning(
                "[DaemonToken] activation rejected for non-daemon type=%s",
                normalized_device_type,
            )
            return None
        normalized_capabilities = normalize_device_capabilities(
            capabilities or ['terminal_execute', 'file'],
            device_type=normalized_device_type,
        )
        token_digest = hashlib.sha256(token.encode()).hexdigest()
        defaults = {
            'organization': organization,
            'name': name,
            'device_type': normalized_device_type,
            'role': infer_device_role(normalized_device_type),
            'os_info': os_info or {},
            'capabilities': normalized_capabilities,
            'status': 'online',
        }
        try:
            if not control_enabled:
                device, created = Device.objects.update_or_create(
                    fingerprint=fingerprint,
                    user_id=user.id,
                    defaults=defaults,
                )
            else:
                with transaction.atomic():
                    device = (
                        Device.objects.select_for_update()
                        .filter(fingerprint=fingerprint)
                        .first()
                    )
                    if device is None:
                        device = Device.objects.create(
                            fingerprint=fingerprint,
                            user_id=user.id,
                            metadata_json={_ACTIVATION_TOKEN_DIGEST_KEY: token_digest},
                            **defaults,
                        )
                        created = True
                    else:
                        stored_digest = str(
                            (device.metadata_json or {}).get(_ACTIVATION_TOKEN_DIGEST_KEY)
                            or ""
                        )
                        if (
                            device.user_id != user.id
                            or device.device_type != normalized_device_type
                            or device.control_status != 'active'
                            or (
                                stored_digest
                                and not hmac.compare_digest(stored_digest, token_digest)
                            )
                            or not stored_digest
                        ):
                            raise DeviceFingerprintConflictError(
                                f"Device fingerprint {fingerprint} is already registered"
                            )
                        for field, value in defaults.items():
                            setattr(device, field, value)
                        device.save(update_fields=[*defaults, 'updated_at'])
                        created = False
        except IntegrityError:
            logger.warning(
                "[DaemonToken] fingerprint conflict: fingerprint=%s is already registered (requesting user=%s)",
                fingerprint, user_id,
            )
            raise DeviceFingerprintConflictError(
                f"Device fingerprint {fingerprint} is already registered"
            )

        access_token = _generate_daemon_access_token(user, fingerprint, expire_hours=24)

        logger.info(
            "[DaemonToken] device activated: id=%s, fingerprint=%s, name=%s, user=%s, organization=%s (created=%s)",
            device.id, fingerprint, name, user_id, organization_id, created,
        )

        # device_id here is the Device model UUID (primary key), used by the
        # Daemon for config storage and display.  WS auth and topic subscription
        # use the locally-generated fingerprint (daemon-{uuid}), not this UUID.
        return {
            'device_id': str(device.id),
            'access_token': access_token,
            'organization_id': organization_id,
        }

    @staticmethod
    def _claim_token(token: str, fingerprint: str, payload: dict) -> bool:
        """原子性标记 token 为已使用（按 fingerprint 幂等）。

        同一 fingerprint 可重复激活同一 token（网络中断重试场景），
        但不同 fingerprint 不能重放同一 token。
        """
        try:
            import redis as _redis
            from django.conf import settings as _settings

            client = _redis.Redis(
                host=getattr(_settings, "REDIS_HOST", "localhost"),
                port=getattr(_settings, "REDIS_PORT", 6379),
                db=getattr(_settings, "REDIS_DB", 0),
                decode_responses=True,
            )

            token_hash = hashlib.sha256(token.encode()).hexdigest()[:32]
            key = f"daemon:token:used:{token_hash}"

            expires_at = payload.get('expires_at', '')
            ttl = 3600
            if expires_at:
                try:
                    exp = datetime.fromisoformat(expires_at)
                except (TypeError, ValueError):
                    logger.warning("[DaemonToken] invalid expires_at in claimed token payload")
                    return False
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                remaining = (exp - datetime.now(timezone.utc)).total_seconds()
                ttl = max(int(remaining) + 60, 120)

            was_set = client.set(key, fingerprint, nx=True, ex=ttl)
            if was_set:
                return True
            # Token 已被 claim — 检查是否是同一 fingerprint 的幂等重试
            claimed_by = client.get(key)
            if claimed_by == fingerprint:
                logger.info("[DaemonToken] idempotent re-activation for fingerprint=%s", fingerprint)
                return True
            return False
        except Exception as exc:
            logger.error("[DaemonToken] _claim_token Redis unavailable, rejecting activation for safety: %s", exc)
            return False

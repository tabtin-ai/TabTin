"""分享页协作 token 签发与验签。

view/comment 分享签发只读 collab permission；edit 分享签发 edit permission（须登录）。
token 短时效 + 签名，collab_auth 重验时复用 get_share_by_id 做撤销/过期踢人。
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from django.core.signing import BadSignature, SignatureExpired, TimestampSigner

from .exceptions import (
    ShareExpiredError,
    ShareNotFoundError,
    SharePermissionDeniedError,
)

logger = logging.getLogger("services.public_share.collab_token")

SHARE_COLLAB_TOKEN_PREFIX = "sct_"
SHARE_COLLAB_TOKEN_SALT = "tabtin-share-collab-v1"
SHARE_COLLAB_TOKEN_MAX_AGE_SECONDS = 15 * 60

_signer = TimestampSigner(salt=SHARE_COLLAB_TOKEN_SALT)

# share.permission → collab permission
_SHARE_PERM_TO_COLLAB_PERM = {
    "view": "view",
    "comment": "view",
    "edit": "edit",
}


@dataclass(frozen=True)
class ShareCollabClaims:
    share_id: str
    resource_type: str
    resource_id: str
    permission: str
    guest_id: str


@dataclass(frozen=True)
class ShareCollabPrincipal:
    """collab_auth 双轨鉴权中 share token 路径的主体。"""

    claims: ShareCollabClaims

    @property
    def id(self) -> str:
        return self.claims.guest_id

    @property
    def nickname(self) -> str:
        return "访客"


def build_share_guest_id(share_id: str, user: Any | None) -> str:
    if user and getattr(user, "id", None):
        return f"share:{share_id}:{user.id}"
    return f"share:{share_id}:guest"


def parse_share_guest_id(guest_id: str) -> tuple[str, str | None]:
    """解析 ``share:{share_id}:{user_id|guest}``，返回 (share_id, user_id 或 None)。"""
    if not guest_id or not guest_id.startswith("share:"):
        return "", None
    parts = guest_id.split(":", 2)
    if len(parts) != 3:
        return "", None
    _, share_id, user_part = parts
    if not share_id:
        return "", None
    if user_part == "guest":
        return share_id, None
    return share_id, user_part


def issue_share_collab_token(
    *,
    share_id: str,
    resource_type: str,
    resource_id: str,
    share_permission: str,
    guest_id: str,
) -> str:
    collab_permission = _SHARE_PERM_TO_COLLAB_PERM.get(share_permission)
    if collab_permission is None:
        raise SharePermissionDeniedError("Share permission does not support collab")

    if share_permission == "edit":
        _, user_id = parse_share_guest_id(guest_id)
        if not user_id:
            raise SharePermissionDeniedError("Edit share collab requires authenticated user")

    payload = {
        "sid": share_id,
        "rt": resource_type,
        "rid": str(resource_id),
        "perm": collab_permission,
        "gid": guest_id,
    }
    signed = _signer.sign(json.dumps(payload, separators=(",", ":")))
    return f"{SHARE_COLLAB_TOKEN_PREFIX}{signed}"


def verify_share_collab_token(token: str) -> ShareCollabClaims | None:
    if not token or not token.startswith(SHARE_COLLAB_TOKEN_PREFIX):
        return None
    raw_signed = token[len(SHARE_COLLAB_TOKEN_PREFIX):]
    try:
        raw = _signer.unsign(raw_signed, max_age=SHARE_COLLAB_TOKEN_MAX_AGE_SECONDS)
        data = json.loads(raw)
        return ShareCollabClaims(
            share_id=str(data["sid"]),
            resource_type=str(data["rt"]),
            resource_id=str(data["rid"]),
            permission=str(data["perm"]),
            guest_id=str(data["gid"]),
        )
    except (BadSignature, SignatureExpired, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


def resolve_share_collab_auth(
    claims: ShareCollabClaims,
    resource_type: str,
    resource_id: str,
    *,
    share_service_cls: type,
) -> dict | None:
    """重验 share token 并确认资源仍可通过分享访问。

    Returns:
        collab_auth 响应 data 字段；校验失败返回 None。
    """
    if claims.resource_type != resource_type:
        return None
    if str(claims.resource_id) != str(resource_id):
        return None

    try:
        share = share_service_cls.get_share_by_id(claims.share_id)
    except (ShareNotFoundError, ShareExpiredError):
        return None

    resource = share_service_cls._resource_from_share(share)
    if str(resource.id) != str(resource_id):
        return None

    share_permission = getattr(share, "permission", "view")
    collab_permission = _SHARE_PERM_TO_COLLAB_PERM.get(share_permission)
    if collab_permission is None:
        return None

    user_name = "访客"
    user = None
    _, guest_user_id = parse_share_guest_id(claims.guest_id)
    if guest_user_id:
        try:
            from django.contrib.auth import get_user_model

            user = get_user_model().objects.filter(id=guest_user_id).first()
            if user:
                user_name = (
                    getattr(user, "nickname", None)
                    or getattr(user, "username", None)
                    or getattr(user, "email", None)
                    or user_name
                )
        except Exception:
            logger.debug("Failed to resolve share collab user_name for %s", guest_user_id, exc_info=True)

    # ：表格分享 collab 二次鉴权时，字段可见性受限则拒绝进房（防全量 Y.Doc 泄漏）
    if resource_type == "table":
        from apps.tabdata.services.field_visibility import (
            build_collab_degradation_payload,
            evaluate_collab_access,
        )

        decision = evaluate_collab_access(user, resource, share=share)
        if not decision.get("allowed"):
            payload = build_collab_degradation_payload(
                decision,
                resource_type=resource_type,
                resource_id=str(resource_id),
                permission=collab_permission,
            )
            payload["user_id"] = claims.guest_id
            payload["user_name"] = user_name
            return payload

    return {
        "authorized": True,
        "permission": collab_permission,
        "user_id": claims.guest_id,
        "user_name": user_name,
        "resource_type": resource_type,
        "resource_id": str(resource_id),
        "collab_mode": "full",
        "reason": None,
    }

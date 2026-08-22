"""手机号归一化与等价匹配。

入库口径：中国大陆手机号**不保留** ``+86`` / ``86`` 前缀，统一存 11 位
（``17511610380``）。历史脏数据可能仍是 ``+8617511610380`` / ``8617511610380``，
登录、注册查重、邀请查找按等价字面量互认。
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from django.contrib.auth import get_user_model
from django.db.models import QuerySet

# 中国大陆移动手机号：1[3-9] + 9 位
_CN_MOBILE_NATIONAL_RE = re.compile(r"^1[3-9]\d{9}$")
# +86 / 86 前缀的同一号
_CN_MOBILE_WITH_CC_RE = re.compile(r"^\+?86(1[3-9]\d{9})$")


def canonicalize_phone(phone: Optional[str]) -> str:
    """归一化为入库/比较用的规范形式。

    - 中国大陆手机 → 11 位国内号（``1xxxxxxxxxx``）
    - 其它号码 → 去空白与连字符后原样返回（保留可选 ``+``）
    """
    if not phone:
        return ""
    cleaned = phone.strip().replace(" ", "").replace("-", "")
    if not cleaned:
        return ""

    cc_match = _CN_MOBILE_WITH_CC_RE.match(cleaned)
    if cc_match:
        return cc_match.group(1)
    if _CN_MOBILE_NATIONAL_RE.match(cleaned):
        return cleaned
    return cleaned


def phone_lookup_aliases(phone: Optional[str]) -> list[str]:
    """同一逻辑手机号在库中可能出现的全部字面量（去重、保序）。"""
    if not phone:
        return []
    raw = phone.strip()
    canonical = canonicalize_phone(phone)
    aliases: list[str] = []
    for candidate in (raw, canonical):
        if candidate and candidate not in aliases:
            aliases.append(candidate)
    if _CN_MOBILE_NATIONAL_RE.match(canonical):
        for candidate in (f"+86{canonical}", f"86{canonical}"):
            if candidate not in aliases:
                aliases.append(candidate)
    return aliases


def users_with_phone_aliases(
    phone: Optional[str],
    *,
    active_only: bool = False,
) -> QuerySet:
    """按等价手机号过滤 User queryset。"""
    User = get_user_model()
    aliases = phone_lookup_aliases(phone)
    if not aliases:
        return User.objects.none()
    qs = User.objects.filter(phone__in=aliases)
    if active_only:
        qs = qs.filter(is_active=True)
    return qs


def resolve_user_by_phone(
    phone: Optional[str],
    *,
    active_only: bool = True,
):
    """按等价手机号解析唯一用户；历史脏数据多条时按稳定规则择一。

    优先级：输入字面量精确命中 → 规范形式命中 → 最近登录/注册。
    """
    aliases = phone_lookup_aliases(phone)
    if not aliases:
        return None

    qs = users_with_phone_aliases(phone, active_only=active_only)
    users = list(qs)
    if not users:
        return None
    if len(users) == 1:
        return users[0]

    stripped = (phone or "").strip()
    for user in users:
        if user.phone == stripped:
            return user

    canonical = canonicalize_phone(phone)
    for user in users:
        if user.phone == canonical:
            return user

    return max(
        users,
        key=lambda u: (
            u.last_login is not None,
            u.last_login or u.date_joined,
        ),
    )


def phone_alias_exists(
    phone: Optional[str],
    *,
    exclude_user_id=None,
    active_only: bool = False,
) -> bool:
    """是否已有用户占用该逻辑手机号（任一等价字面量）。"""
    qs = users_with_phone_aliases(phone, active_only=active_only)
    if exclude_user_id is not None:
        qs = qs.exclude(id=exclude_user_id)
    return qs.exists()


def maybe_canonicalize_stored_phone(user) -> bool:
    """登录成功后把库内 ``+86`` / ``86`` 前缀收敛为 11 位（无冲突时）。

    Returns:
        是否写入了变更。
    """
    if not user or not user.phone:
        return False
    canonical = canonicalize_phone(user.phone)
    if not canonical or canonical == user.phone:
        return False
    User = get_user_model()
    if User.objects.filter(phone=canonical).exclude(pk=user.pk).exists():
        return False
    user.phone = canonical
    user.save(update_fields=["phone"])
    return True


def iter_phone_alias_values(phones: Iterable[Optional[str]]) -> list[str]:
    """展开多个输入的全部 alias（工具用）。"""
    seen: list[str] = []
    for phone in phones:
        for alias in phone_lookup_aliases(phone):
            if alias not in seen:
                seen.append(alias)
    return seen

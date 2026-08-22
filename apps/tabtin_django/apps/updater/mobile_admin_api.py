"""移动端版本门禁 Admin 接口。

- 读接口：后台 staff 可访问
- 写接口：后台 superuser 可执行（每平台一条策略，PUT 做 upsert）
"""
from __future__ import annotations

import logging

from django.http import HttpRequest
from ninja import Router, Schema
from ninja.errors import HttpError
from pydantic import Field

from apps.i18n.response import success_response
from apps.users.auth.permissions import StaffAuth, SuperuserAuth

from .models import ClientVersionPolicy

logger = logging.getLogger(__name__)
router = Router(auth=StaffAuth())


class MobileVersionPolicyItem(Schema):
    platform: str
    enabled: bool
    soft_prompt_enabled: bool
    min_supported_build: int
    latest_build: int
    min_supported_version: str
    latest_version: str
    store_url: str
    force_title: str
    force_message: str
    soft_title: str
    soft_message: str
    updated_at: str | None = None


class MobileVersionPolicyUpsertRequest(Schema):
    enabled: bool = True
    soft_prompt_enabled: bool = False
    min_supported_build: int = Field(0, ge=0)
    latest_build: int = Field(0, ge=0)
    min_supported_version: str = ""
    latest_version: str = ""
    store_url: str = ""
    force_title: str = ""
    force_message: str = ""
    soft_title: str = ""
    soft_message: str = ""


def _serialize(policy: ClientVersionPolicy) -> dict:
    return MobileVersionPolicyItem(
        platform=policy.platform,
        enabled=policy.enabled,
        soft_prompt_enabled=policy.soft_prompt_enabled,
        min_supported_build=policy.min_supported_build,
        latest_build=policy.latest_build,
        min_supported_version=policy.min_supported_version,
        latest_version=policy.latest_version,
        store_url=policy.store_url,
        force_title=policy.force_title,
        force_message=policy.force_message,
        soft_title=policy.soft_title,
        soft_message=policy.soft_message,
        updated_at=policy.updated_at.isoformat() if policy.updated_at else None,
    ).model_dump()


@router.get("/mobile-version-policies", auth=StaffAuth(), summary="移动端版本门禁列表")
def list_mobile_version_policies(request: HttpRequest):
    """返回所有平台的策略；未配置的平台补一条默认（未启用）占位，便于前端直接编辑。"""
    existing = {p.platform: p for p in ClientVersionPolicy.objects.all()}
    items = []
    for platform, _label in ClientVersionPolicy.PLATFORM_CHOICES:
        policy = existing.get(platform)
        if policy is not None:
            items.append(_serialize(policy))
        else:
            items.append(MobileVersionPolicyItem(
                platform=platform,
                enabled=False,
                soft_prompt_enabled=False,
                min_supported_build=0,
                latest_build=0,
                min_supported_version="",
                latest_version="",
                store_url="",
                force_title="",
                force_message="",
                soft_title="",
                soft_message="",
                updated_at=None,
            ).model_dump())
    return success_response(data={"items": items})


@router.put("/mobile-version-policies/{platform}", auth=SuperuserAuth(), summary="保存移动端版本门禁")
def upsert_mobile_version_policy(
    request: HttpRequest,
    platform: str,
    data: MobileVersionPolicyUpsertRequest,
):
    normalized_platform = (platform or "").strip().lower()
    if normalized_platform not in dict(ClientVersionPolicy.PLATFORM_CHOICES):
        raise HttpError(400, "platform 仅支持 ios / android")

    if data.latest_build and data.latest_build < data.min_supported_build:
        raise HttpError(400, "latest_build 不能小于 min_supported_build")

    # 注：store_url 允许留空——客户端内置各平台默认更新地址（iOS App Store 页 /
    # 安卓落地页）作回退，留空即用默认，配置只作为特殊场景覆盖。

    policy, _created = ClientVersionPolicy.objects.update_or_create(
        platform=normalized_platform,
        defaults={
            "enabled": data.enabled,
            "soft_prompt_enabled": data.soft_prompt_enabled,
            "min_supported_build": data.min_supported_build,
            "latest_build": data.latest_build,
            "min_supported_version": data.min_supported_version.strip(),
            "latest_version": data.latest_version.strip(),
            "store_url": data.store_url.strip(),
            "force_title": data.force_title.strip(),
            "force_message": data.force_message.strip(),
            "soft_title": data.soft_title.strip(),
            "soft_message": data.soft_message.strip(),
            "updated_by": getattr(request, "auth", None),
        },
    )
    return success_response(data={"item": _serialize(policy)}, message="策略已保存")

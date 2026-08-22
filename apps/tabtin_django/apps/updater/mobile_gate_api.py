"""移动端版本门禁公开接口。

匿名可访问（登录前就要能拦），移动端冷启动携带 platform + build 调用，
后端算出 action（force / soft / none）后下发，客户端只执行不自比。
"""
import logging
from typing import Optional

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from apps.i18n.response import success_response, error_response_with_status

from .models import ClientVersionPolicy

logger = logging.getLogger(__name__)
router = Router(tags=["Client Version Gate"])


class VersionGateResponse(Schema):
    """版本门禁决策响应。"""
    action: str = Field(..., description="none / soft / force")
    store_url: str = ""
    title: str = ""
    message: str = ""
    latest_version: str = ""
    latest_build: int = 0
    min_supported_version: str = ""
    min_supported_build: int = 0


@router.get("/version-gate", auth=None, summary="移动端版本门禁检查")
def check_version_gate(request: HttpRequest, platform: str, build: int = 0):
    """检查当前移动端 build 是否被强制/推荐更新。

    Args:
        platform: ios / android
        build: 客户端当前 build 号（Android versionCode / iOS CFBundleVersion）

    未配置策略或平台未知时放行（action=none），保证接口失败不影响客户端使用。
    """
    try:
        normalized_platform = (platform or "").strip().lower()
        if normalized_platform not in dict(ClientVersionPolicy.PLATFORM_CHOICES):
            return success_response(data=VersionGateResponse(
                **ClientVersionPolicy.default_decision()
            ).model_dump())

        normalized_build = max(build, 0)

        policy = ClientVersionPolicy.objects.filter(platform=normalized_platform).first()
        if policy is None:
            return success_response(data=VersionGateResponse(
                **ClientVersionPolicy.default_decision()
            ).model_dump())

        decision = policy.evaluate(normalized_build)
        return success_response(data=VersionGateResponse(**decision).model_dump())
    except Exception as e:
        logger.error(f"[VersionGate] check failed: {e}", exc_info=True)
        return error_response_with_status("INTERNAL_ERROR", message=str(e), status_code=500)

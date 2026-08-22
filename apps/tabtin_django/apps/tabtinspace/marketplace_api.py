"""Marketplace 公共配置 API（PRD §5.4 B3 / N5）。

挂载在 ``/api/marketplace/...``，独立于 ``tabtinspace_router``（后者整体
位于 ``/api/context`` 前缀下）。

**当前 endpoint**：
- ``GET /discovery-patterns`` — 聚合 marketplace App 的 ``embeddedWeb.urlPatterns``，
  供 Electron Renderer 在启动期推送给主进程 ``AppDiscoveryService``，
  替代主仓硬编码 fallback。

**鉴权**：``auth=None``。
- patterns 为公开 manifest 配置数据，不含租户 / 用户隐私；
- AppDiscovery 的设计要求"在 TabWeb 打开任意 URL 时即时识别未安装 App"，
  比登录态生效更早；让本端点匿名可访问可在登录前完成 patterns 推送，
  避免横幅误漏。
"""
from __future__ import annotations

import logging

from django.http import HttpRequest
from ninja import Router

from apps.i18n.response import success_response
from apps.services.common.marketplace_discovery import build_discovery_patterns
from apps.tabtinspace.schemas.common import ErrorResponse

logger = logging.getLogger(__name__)

router = Router(tags=["Marketplace"])

_RESP = {500: ErrorResponse}


@router.get(
    "/discovery-patterns",
    auth=None,
    response={200: dict, **_RESP},
)
def get_discovery_patterns(request: HttpRequest):
    """返回所有 marketplace App 的 ``embeddedWeb.urlPatterns`` 聚合。

    返回结构：
    ```json
    {
      "success": true,
      "data": {
        "patterns": [
          { "appId": "<app_id>", "appName": "<App Name>", "patterns": ["*.example.com", ...] }
        ]
      }
    }
    ```
    异常时返回空 ``patterns`` 列表（fail-safe），日志 WARNING 上报，
    避免 AppDiscovery 因 API 失败而退回硬编码——PRD §5.4 B3 已删除硬编码。
    """
    try:
        entries = build_discovery_patterns()
    except Exception as exc:  # noqa: BLE001 — 任何异常都不应让客户端硬失败
        logger.warning(
            "[MarketplaceDiscoveryAPI] build_discovery_patterns failed: %s",
            exc,
            exc_info=True,
        )
        entries = []
    return success_response({"patterns": entries})


__all__ = ["router"]

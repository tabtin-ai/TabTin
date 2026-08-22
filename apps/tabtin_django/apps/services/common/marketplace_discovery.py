"""Marketplace App URL 发现模式聚合（PRD §5.4 B3 / N5）。

设计要点：
- **复用既有 ``embeddedWeb.urlPatterns``**（manifest 中已有字段，N5 决议
  不新增 ``discoveryPatterns`` 字段，避免双字段不同步的 bug）。
- 聚合范围 = ``MARKETPLACE_APPS`` 中 ``embedded_web_url_patterns`` 非空的全部
  marketplace App；CORE_APPS（builtin）不参与发现（builtin 自动安装，无需横幅）。
- **纯 manifest 数据，不依赖 DB**——可在用户登录前 / Organization 选择前拉取，
  让 TabWeb 在打开任意 URL 时都能即时识别"未安装的 marketplace App"。
- 失败兜底：上游异常时返回空 list（不再硬编码任何具体 App），让 AppDiscovery
  完全静默而非误报，符合 PRD §5.4 B3 "完全 API 化"诉求。
"""
from __future__ import annotations

from typing import TypedDict

from apps.services.common.app_registry import MARKETPLACE_APPS, AppDefinition


class DiscoveryPatternEntry(TypedDict):
    """单个 App 的 URL 发现条目，与 Electron 主进程
    ``AppDiscoveryService.UrlPattern`` 字段 1:1 对齐。"""

    appId: str
    appName: str
    patterns: list[str]


def build_discovery_patterns() -> list[DiscoveryPatternEntry]:
    """从 ``MARKETPLACE_APPS`` 聚合所有声明 ``embeddedWeb.urlPatterns`` 的 App。

    返回顺序 = manifest 的 ``catalog.order`` 升序，便于前端展示稳定；
    跳过 ``embedded_web_url_patterns`` 为空的 App（无 URL 发现需求，例如
    纯 CLI / 纯本地集成型 App）。
    """
    sorted_apps = sorted(
        MARKETPLACE_APPS.values(),
        key=lambda app: (app.order, app.id),
    )
    entries: list[DiscoveryPatternEntry] = []
    for app in sorted_apps:
        if not app.embedded_web_url_patterns:
            continue
        entries.append(_pattern_entry_for(app))
    return entries


def _pattern_entry_for(app: AppDefinition) -> DiscoveryPatternEntry:
    return DiscoveryPatternEntry(
        appId=app.id,
        appName=app.name or app.id,
        patterns=list(app.embedded_web_url_patterns),
    )


__all__ = ["DiscoveryPatternEntry", "build_discovery_patterns"]
